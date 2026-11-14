"use strict";

const OAuthUser = require("../../verification/models/OAuthUser");
const discordApi = require("../../verification/utils/discordAPI");
const { encryptToken } = require("../../verification/utils/crypto");
const { assertValidTokenField, validateTokenData } = require("./tokenValidation");
const { withTokenRefreshLock } = require("./lockManager");

function tokenPath(tokenField, key) {
    return `${tokenField}.${key}`;
}

function versionCondition(tokenField, version) {
    const previousVersion = Number(version || 0);
    if (previousVersion > 0) return { [tokenPath(tokenField, "version")]: previousVersion };
    return {
        $or: [
            { [tokenPath(tokenField, "version")]: 0 },
            { [tokenPath(tokenField, "version")]: { $exists: false } }
        ]
    };
}

function prepareStoredToken(tokenData = {}, { now = Date.now(), previousVersion = 0, isRefresh = false } = {}) {
    const rawAccess = String(tokenData?.access_token || "").trim();
    const rawRefresh = String(tokenData?.refresh_token || "").trim();
    const expiresIn = Number(tokenData?.expires_in || 0);
    const rawTokenType = String(tokenData?.token_type || "").trim();

    return {
        encryptedAccessToken: rawAccess ? encryptToken(rawAccess) : "",
        encryptedRefreshToken: rawRefresh ? encryptToken(rawRefresh) : "",
        expiresAt: expiresIn > 0 ? now + (expiresIn * 1000) : null,
        scope: String(tokenData?.scope || ""),
        tokenType: rawTokenType || "Bearer",
        lastRefreshAt: isRefresh ? now : null,
        refreshFailCount: 0,
        lastRefreshError: null,
        revokedAt: null,
        version: Number(previousVersion || 0) + 1,
        rawTokenMeta: {
            expiresIn: expiresIn > 0 ? expiresIn : null,
            receivedAt: now
        }
    };
}

async function exchangeAuthorizationCode(code, redirectUri, discord = discordApi) {
    if (!code || typeof code !== "string") {
        const error = new Error("Authorization code is required");
        error.code = "oauth_code_required";
        throw error;
    }
    const tokenData = await discord.exchangeCode(code, redirectUri);
    validateTokenData(tokenData);
    return tokenData;
}

async function commitVerificationActivation({
    profileUserId,
    tokenData,
    updateSet,
    safeAttemptStartedAt,
    existing,
    storedSnapshots,
    tokenField = "oauth",
    model = OAuthUser,
    now = Date.now()
} = {}) {
    if (!profileUserId) {
        const error = new Error("User ID is required for activation");
        error.code = "oauth_user_id_required";
        throw error;
    }

    assertValidTokenField(tokenField);
    validateTokenData(tokenData);

    const lockKey = `${profileUserId}:${tokenField}`;
    return withTokenRefreshLock(lockKey, async () => {
        let currentDoc = null;
        if (typeof model?.findOne === "function") {
            try {
                const query = model.findOne({ "discord.userId": profileUserId });
                currentDoc = typeof query?.select === "function"
                    ? await query.select(`${tokenField}.version`).lean()
                    : await query;
            } catch (err) {
                const readError = new Error(`Failed to read current OAuthUser state before activation: ${err.message}`);
                readError.code = "activation_read_failed";
                readError.cause = err;
                throw readError;
            }
        } else if (existing) {
            currentDoc = existing;
        }

        const previousVersion = Number(currentDoc?.[tokenField]?.version ?? existing?.[tokenField]?.version ?? 0);
        const tokenPayload = prepareStoredToken(tokenData, { now, previousVersion, isRefresh: false });

        const finalUpdateSet = {
            ...updateSet,
            [tokenField]: tokenPayload
        };

        const activationFilter = {
            "discord.userId": profileUserId,
            $or: [
                { "snapshotMeta.activation.attemptStartedAt": { $exists: false } },
                { "snapshotMeta.activation.attemptStartedAt": { $lte: safeAttemptStartedAt } }
            ]
        };

        const hasExisting = Boolean(currentDoc || existing);
        const activated = await model.findOneAndUpdate(
            activationFilter,
            {
                $set: finalUpdateSet,
                $setOnInsert: { createdAt: now }
            },
            {
                upsert: !hasExisting,
                returnDocument: "after"
            }
        );

        if (!activated) {
            const stale = new Error("A newer OAuth snapshot attempt is already active");
            stale.code = "snapshot_activation_stale";
            throw stale;
        }

        return { ok: true, activated };
    });
}

module.exports = {
    tokenPath,
    versionCondition,
    prepareStoredToken,
    exchangeAuthorizationCode,
    commitVerificationActivation
};
