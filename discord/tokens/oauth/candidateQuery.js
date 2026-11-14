"use strict";

const OAuthUser = require("../../verification/models/OAuthUser");
const { TOKEN_FIELDS, getOAuthRefreshConfig } = require("./config");
const { hasAllRequiredScopes } = require("./tokenValidation");

function buildCandidatePageResult({
    candidates = [],
    nextCursor = null,
    hasMore = false,
    scanned = 0,
    statistics = null
} = {}) {
    const stats = statistics || {
        scannedRecords: scanned,
        uniqueUsers: 0,
        usableUsers: 0,
        missingScope: 0,
        missingUserId: 0,
        revoked: 0,
        exhausted: 0,
        byTokenField: { oauth: 0 }
    };

    const result = {
        candidates,
        nextCursor,
        hasMore,
        scanned,
        statistics: stats,
        get length() {
            return candidates.length;
        }
    };

    result[Symbol.iterator] = function* () {
        yield* candidates;
    };

    return result;
}

function buildCandidateMongoQuery({ effectiveGuildId, config, additionalFilter, afterId }) {
    const tokenBranches = TOKEN_FIELDS.map(tokenField => ({
        $and: [
            {
                $or: [
                    { [`${tokenField}.encryptedRefreshToken`]: { $exists: true, $ne: "" } },
                    { [`${tokenField}.encryptedAccessToken`]: { $exists: true, $ne: "" } }
                ]
            },
            {
                $or: [
                    { [`${tokenField}.refreshFailCount`]: { $exists: false } },
                    { [`${tokenField}.refreshFailCount`]: { $lt: config.failMax } }
                ]
            }
        ],
        [`${tokenField}.revokedAt`]: { $in: [null] }
    }));

    const andConditions = [
        {
            $or: [
                { deletedAt: { $exists: false } },
                { deletedAt: null }
            ]
        },
        { $or: tokenBranches }
    ];

    if (additionalFilter && typeof additionalFilter === "object" && Object.keys(additionalFilter).length > 0) {
        andConditions.push(additionalFilter);
    }

    if (effectiveGuildId) {
        andConditions.push(
            { "lastVerify.guildId": effectiveGuildId },
            { "lastVerify.result": "success" }
        );
    }

    if (afterId) {
        andConditions.push({ _id: { $gt: afterId } });
    }

    return { $and: andConditions };
}

function evaluateDocTokens(doc, { normalizedRequired, failMax }) {
    let chosenField = null;
    let chosenScope = "";
    let docHasMissingScope = false;
    let docIsRevoked = false;
    let docIsExhausted = false;

    for (const tokenField of TOKEN_FIELDS) {
        const tokenState = doc[tokenField] || {};
        const hasToken = Boolean(tokenState.encryptedRefreshToken || tokenState.encryptedAccessToken);
        if (!hasToken) continue;
        if (tokenState.revokedAt) {
            docIsRevoked = true;
            continue;
        }
        if (Number(tokenState.refreshFailCount || 0) >= failMax) {
            docIsExhausted = true;
            continue;
        }

        if (hasAllRequiredScopes(tokenState.scope, normalizedRequired)) {
            chosenField = tokenField;
            chosenScope = tokenState.scope || "";
            break;
        } else {
            docHasMissingScope = true;
        }
    }

    return { chosenField, chosenScope, docHasMissingScope, docIsRevoked, docIsExhausted };
}

function isDocGuildEligible(doc, effectiveGuildId) {
    if (!effectiveGuildId) return true;
    return String(doc.lastVerify?.guildId || "").trim() === effectiveGuildId &&
        doc.lastVerify?.result === "success";
}

function processCandidateDoc(doc, {
    effectiveGuildId,
    seenUsers,
    batchUsers,
    normalizedRequired,
    config,
    candidates,
    byTokenField,
    stats
}) {
    if (!isDocGuildEligible(doc, effectiveGuildId)) {
        return;
    }
    const userId = String(doc.discord?.userId || "").trim();
    if (!userId) {
        stats.missingUserId++;
        return;
    }

    if (seenUsers instanceof Set && seenUsers.has(userId)) {
        return;
    }

    const isNewUser = !batchUsers.has(userId);
    if (isNewUser) {
        batchUsers.add(userId);
        stats.newUniqueUsers++;
    }

    const {
        chosenField,
        chosenScope,
        docHasMissingScope,
        docIsRevoked,
        docIsExhausted
    } = evaluateDocTokens(doc, { normalizedRequired, failMax: config.failMax });

    if (chosenField) {
        if (isNewUser) {
            stats.usableUsersCount++;
            byTokenField[chosenField] = (byTokenField[chosenField] || 0) + 1;
        }
        candidates.push({
            userId,
            tokenField: chosenField,
            scope: chosenScope,
            recordId: doc._id,
            lastVerify: {
                guildId: doc.lastVerify?.guildId || null,
                result: doc.lastVerify?.result || null
            }
        });
    } else if (docHasMissingScope) {
        stats.missingScope++;
    } else if (docIsRevoked) {
        stats.revoked++;
    } else if (docIsExhausted) {
        stats.exhausted++;
    }
}

async function listAccessTokenCandidates({
    requiredScopes = ["guilds.join"],
    sourceGuildId = null,
    targetGuildId = null,
    allowAllGuilds = false,
    limit = 500,
    afterId = null,
    model = OAuthUser,
    env = process.env,
    seenUsers = null,
    additionalFilter = null
} = {}) {
    const effectiveGuildId = String(sourceGuildId || (!allowAllGuilds ? targetGuildId : "") || "").trim();
    if (!allowAllGuilds && !effectiveGuildId) {
        return buildCandidatePageResult();
    }

    const config = getOAuthRefreshConfig(env);
    const filter = buildCandidateMongoQuery({ effectiveGuildId, config, additionalFilter, afterId });
    const docs = await model.find(filter)
        .select("discord.userId oauth lastVerify updatedAt _id")
        .sort({ _id: 1 })
        .limit(limit)
        .lean();

    const normalizedRequired = new Set(requiredScopes.map(s => String(s || "").trim()).filter(Boolean));
    const candidates = [];
    const batchUsers = new Set();
    const stats = {
        newUniqueUsers: 0,
        usableUsersCount: 0,
        missingUserId: 0,
        missingScope: 0,
        revoked: 0,
        exhausted: 0
    };
    const byTokenField = { oauth: 0 };

    for (const doc of docs) {
        processCandidateDoc(doc, {
            effectiveGuildId,
            seenUsers,
            batchUsers,
            normalizedRequired,
            config,
            candidates,
            byTokenField,
            stats
        });
    }

    const lastScanned = docs.length > 0 ? docs[docs.length - 1] : null;
    const nextCursor = lastScanned ? (lastScanned._id || lastScanned.id) : null;
    const hasMore = docs.length >= limit && nextCursor !== null;

    return buildCandidatePageResult({
        candidates,
        nextCursor,
        hasMore,
        scanned: docs.length,
        statistics: {
            scannedRecords: docs.length,
            uniqueUsers: stats.newUniqueUsers,
            usableUsers: stats.usableUsersCount,
            missingScope: stats.missingScope,
            missingUserId: stats.missingUserId,
            revoked: stats.revoked,
            exhausted: stats.exhausted,
            byTokenField
        }
    });
}

module.exports = {
    buildCandidatePageResult,
    buildCandidateMongoQuery,
    evaluateDocTokens,
    isDocGuildEligible,
    processCandidateDoc,
    listAccessTokenCandidates
};
