"use strict";

const OAuthUser = require("../../verification/models/OAuthUser");
const discordApi = require("../../verification/utils/discordAPI");
const { decryptToken } = require("../../verification/utils/crypto");
const { safeError } = require("../../core/safeLogger");
const { assertValidTokenField } = require("./tokenValidation");
const { withTokenRefreshLock } = require("./lockManager");
const { tokenPath, versionCondition } = require("./tokenStorage");
const { diagnosticStats } = require("./state");

async function revokeToken({
    userId,
    tokenField = "oauth",
    tokenType = "refresh_token",
    model = OAuthUser,
    discord = discordApi,
    now = Date.now()
} = {}) {
    if (!userId) {
        const error = new Error("User ID is required for revoke");
        error.code = "oauth_user_id_required";
        throw error;
    }

    assertValidTokenField(tokenField);

    const lockKey = `${userId}:${tokenField}`;
    return withTokenRefreshLock(lockKey, async () => {
        const doc = await model.findOne({ "discord.userId": String(userId) })
            .select({ discord: 1, [tokenField]: 1 });

        if (!doc) {
            return { ok: false, code: "user_not_found", reason: "User not found" };
        }

        const tokenState = doc[tokenField] || {};
        const fieldKey = tokenType === "access_token" ? "encryptedAccessToken" : "encryptedRefreshToken";
        const encryptedVal = tokenState[fieldKey];

        // 1. Mark revoked in database first to atomically block in-flight or upcoming refresh attempts
        const previousVersion = Number(tokenState.version || 0);
        let result = await model.updateOne(
            {
                _id: doc._id,
                ...versionCondition(tokenField, previousVersion)
            },
            {
                $set: {
                    [tokenPath(tokenField, "revokedAt")]: now,
                    updatedAt: now
                },
                $inc: {
                    [tokenPath(tokenField, "version")]: 1
                }
            }
        );

        let modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
        if (modified !== 1) {
            // Concurrent write changed version before revoke CAS:
            // Revocation MUST take precedence over token renewal. Force terminal revoked status on record.
            result = await model.updateOne(
                { _id: doc._id },
                {
                    $set: {
                        [tokenPath(tokenField, "revokedAt")]: now,
                        updatedAt: now
                    },
                    $inc: {
                        [tokenPath(tokenField, "version")]: 1
                    }
                }
            );
            modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
        }

        // 2. Call Discord revocation endpoint if raw token is available
        if (encryptedVal) {
            const raw = decryptToken(encryptedVal);
            if (raw && typeof discord.revokeToken === "function") {
                try {
                    await discord.revokeToken(raw, tokenType);
                } catch (err) {
                    diagnosticStats.lastError = safeError(err);
                }
            }
        }

        diagnosticStats.revokedCount++;
        return {
            ok: true,
            revoked: true,
            userId,
            tokenField,
            updated: modified === 1
        };
    });
}

module.exports = {
    revokeToken
};
