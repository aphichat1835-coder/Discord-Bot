"use strict";

const OAuthUser = require("../../verification/models/OAuthUser");
const { decryptToken } = require("../../verification/utils/crypto");
const { TOKEN_FIELDS, REQUIRED_USER_SCOPES, resolveFailMax } = require("./config");
const {
    assertValidTokenField,
    checkTokenCryptoReasons,
    collectMissingScopeReasons,
    recoveryReasonLabel
} = require("./tokenValidation");

function revealTokenStateForOwner(token = {}) {
    const issuedAt = Number(token.rawTokenMeta?.receivedAt || 0) || null;
    const expiresAt = Number(token.expiresAt || 0) || null;
    return {
        accessToken: token.encryptedAccessToken ? decryptToken(token.encryptedAccessToken) : null,
        refreshToken: token.encryptedRefreshToken ? decryptToken(token.encryptedRefreshToken) : null,
        scope: token.scope || "",
        tokenType: token.tokenType || "",
        issuedAt,
        expiresAt,
        lifetimeMs: issuedAt && expiresAt ? Math.max(0, expiresAt - issuedAt) : null,
        lastRefreshAt: token.lastRefreshAt || null,
        refreshFailCount: Number(token.refreshFailCount || 0),
        revokedAt: token.revokedAt || null
    };
}

async function findUserTokenDoc(model, userId, tokenFields, includeDeleted) {
    const fields = Array.isArray(tokenFields) ? tokenFields : [tokenFields];
    for (const f of fields) assertValidTokenField(f);

    const filter = { "discord.userId": String(userId) };
    if (!includeDeleted) {
        filter.$or = [
            { deletedAt: { $exists: false } },
            { deletedAt: null }
        ];
    }

    const doc = await model.findOne(filter)
        .select(`discord.userId ${fields.join(" ")}`)
        .lean();

    return { doc, fields };
}

async function getOwnerTokenState(userId, { model = OAuthUser, tokenFields = TOKEN_FIELDS, includeDeleted = false } = {}) {
    if (!userId) {
        const error = new Error("User ID is required for owner token reveal");
        error.code = "oauth_user_id_required";
        throw error;
    }

    const { doc, fields } = await findUserTokenDoc(model, userId, tokenFields, includeDeleted);

    const result = {};
    for (const field of fields) {
        result[field] = revealTokenStateForOwner(doc?.[field] || {});
    }
    return result;
}

function tokenMetadataState(token = {}) {
    const issuedAt = Number(token.rawTokenMeta?.receivedAt || 0) || null;
    const expiresAt = Number(token.expiresAt || 0) || null;
    return {
        hasAccessToken: !!token.encryptedAccessToken,
        hasRefreshToken: !!token.encryptedRefreshToken,
        scope: token.scope || "",
        tokenType: token.tokenType || "",
        issuedAt,
        expiresAt,
        lifetimeMs: issuedAt && expiresAt ? Math.max(0, expiresAt - issuedAt) : null,
        lastRefreshAt: token.lastRefreshAt || null,
        refreshFailCount: Number(token.refreshFailCount || 0),
        lastRefreshError: token.lastRefreshError || null,
        revokedAt: token.revokedAt || null
    };
}

async function getOwnerTokenMetadata(userId, { model = OAuthUser, tokenFields = TOKEN_FIELDS, includeDeleted = false } = {}) {
    if (!userId) {
        return { oauth: null };
    }

    const { doc, fields } = await findUserTokenDoc(model, userId, tokenFields, includeDeleted);

    const result = {};
    for (const field of fields) {
        result[field] = tokenMetadataState(doc?.[field] || {});
    }
    return result;
}

async function getRecoveryStatuses(userIds, {
    model = OAuthUser,
    requiredScopes = REQUIRED_USER_SCOPES,
    tokenField = "oauth",
    now = Date.now(),
    failMax = null,
    includeDeleted = false,
    env = process.env
} = {}) {
    assertValidTokenField(tokenField);
    if (!Array.isArray(userIds) || userIds.length === 0) {
        return new Map();
    }

    const effectiveFailMax = resolveFailMax(failMax, env);
    const safeIds = userIds.map(id => String(id || "")).filter(Boolean);
    const filter = { "discord.userId": { $in: safeIds } };
    if (!includeDeleted) {
        filter.$or = [
            { deletedAt: { $exists: false } },
            { deletedAt: null }
        ];
    }
    const docs = await model.find(filter)
        .select(`discord.userId ${tokenField}`)
        .lean();

    const docMap = new Map(docs.map(d => [String(d.discord?.userId || ""), d]));
    const resultMap = new Map();

    for (const userId of safeIds) {
        const doc = docMap.get(userId);
        if (!doc) {
            resultMap.set(userId, {
                status: "missing",
                reasons: ["record_missing"],
                reasonLabels: [recoveryReasonLabel("record_missing")]
            });
            continue;
        }

        const tokenState = doc[tokenField] || {};
        const reasons = [
            ...checkTokenCryptoReasons(tokenState, now, effectiveFailMax, env),
            ...collectMissingScopeReasons(tokenState.scope, requiredScopes)
        ];
        const uniqueReasons = [...new Set(reasons)];
        resultMap.set(userId, {
            status: uniqueReasons.length === 0 ? "healthy" : "recovery_required",
            reasons: uniqueReasons,
            reasonLabels: uniqueReasons.map((reason) => recoveryReasonLabel(reason))
        });
    }

    return resultMap;
}

module.exports = {
    revealTokenStateForOwner,
    findUserTokenDoc,
    getOwnerTokenState,
    tokenMetadataState,
    getOwnerTokenMetadata,
    getRecoveryStatuses
};
