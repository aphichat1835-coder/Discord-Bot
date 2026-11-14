"use strict";

const OAuthUser = require("../../verification/models/OAuthUser");
const discordApi = require("../../verification/utils/discordAPI");
const { safeError } = require("../../core/safeLogger");
const { resolveFailMax } = require("./config");
const { tokenPath, versionCondition } = require("./tokenStorage");
const { diagnosticStats, dispatchOAuthAlert } = require("./state");

function conflictOutcome(tokenField, userId, reason = "state_changed") {
    diagnosticStats.conflictCount++;
    return {
        ok: true,
        skipped: true,
        reason,
        tokenField,
        userId
    };
}

async function readFreshOAuthDocument(model, docOrId, tokenField) {
    if (!model || typeof model.findById !== "function") {
        const error = new Error("OAuth model cannot re-read refresh state");
        error.code = "OAUTH_REFRESH_FRESH_READ_UNAVAILABLE";
        throw error;
    }
    const id = docOrId?._id || docOrId;
    let query = model.findById(id);
    if (query && typeof query.select === "function") {
        query = query.select({ discord: 1, deletedAt: 1, [tokenField]: 1 });
    }
    if (query && typeof query.lean === "function") query = query.lean();
    return await query;
}

function isInvalidGrantError(err) {
    if (typeof discordApi?.isOAuthInvalidGrantError === "function") {
        if (discordApi.isOAuthInvalidGrantError(err)) return true;
    }
    return (
        err?.providerCode === "invalid_grant" ||
        err?.code === "invalid_grant" ||
        (Number(err?.status) === 400 && String(err?.message || "").includes("invalid_grant")) ||
        String(err?.message || "").includes("invalid_grant")
    );
}

async function markRefreshFailure(doc, err, { model = OAuthUser, now = Date.now(), failMax = null, env = process.env, tokenField = "oauth" } = {}) {
    const effectiveFailMax = resolveFailMax(failMax, env);
    const tokenState = doc?.[tokenField] || {};
    const userId = doc?.discord?.userId || String(doc?._id || doc?.id || "unknown");
    const previousRefreshToken = tokenState.encryptedRefreshToken;
    const previousVersion = Number(tokenState.version || 0);
    const nextFailCount = Number(tokenState.refreshFailCount || 0) + 1;
    const isFatalGrant = isInvalidGrantError(err);

    const set = {
        [tokenPath(tokenField, "refreshFailCount")]: nextFailCount,
        [tokenPath(tokenField, "lastRefreshError")]: safeError(err),
        updatedAt: now
    };

    const shouldRevoke = nextFailCount >= effectiveFailMax || isFatalGrant;
    if (shouldRevoke) {
        set[tokenPath(tokenField, "revokedAt")] = now;
    }

    try {
        const result = await model.updateOne(
            {
                _id: doc._id,
                [tokenPath(tokenField, "encryptedRefreshToken")]: previousRefreshToken,
                [tokenPath(tokenField, "revokedAt")]: { $in: [null] },
                ...versionCondition(tokenField, previousVersion)
            },
            { $set: set }
        );
        const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
        if (modified !== 1) return conflictOutcome(tokenField, userId, "failure_state_changed");

        diagnosticStats.failedRefreshes++;
        if (shouldRevoke) {
            diagnosticStats.revokedCount++;

            if (nextFailCount >= effectiveFailMax) {
                dispatchOAuthAlert({
                    code: "oauth.token_exhausted",
                    severity: "ERROR",
                    state: "OPEN",
                    title: "OAUTH REFRESH EXHAUSTED",
                    description: "การรีเฟรช OAuth Token ล้มเหลวจนครบขีดจำกัดสูงสุด ระบบได้ตัดสิทธิ์และหยุดการต่ออายุเพื่อความปลอดภัย",
                    fields: [
                        { name: "สถานะ", value: "OPEN" },
                        { name: "User ID", value: String(userId) },
                        { name: "Token Field", value: String(tokenField) },
                        { name: "รอบที่ล้มเหลว", value: `${nextFailCount}/${effectiveFailMax}` },
                        { name: "สาเหตุ", value: safeError(err) || "Unknown refresh error" },
                        { name: "ผลกระทบ", value: "ผู้ใช้จะไม่สามารถใช้งานฟังก์ชันที่ต้องพึ่งพา OAuth Token ได้จนกว่าจะยืนยันตัวตนใหม่" },
                        { name: "สิ่งที่ควรทำ", value: "แจ้งให้ผู้ใช้ยืนยันตัวตนใหม่ หรือตรวจสอบใน Owner Recovery Center" }
                    ],
                    dedupeKey: `oauth-exhausted:${userId}:${tokenField}`,
                    dedupeMs: 15 * 60 * 1000
                });
            }
        }
        return {
            ok: false,
            failed: true,
            tokenField,
            userId,
            revoked: shouldRevoke,
            error: safeError(err),
            persisted: true,
            persistenceError: null
        };
    } catch (writeErr) {
        diagnosticStats.failedRefreshes++;
        return {
            ok: false,
            failed: true,
            tokenField,
            userId,
            revoked: false,
            error: safeError(err),
            persisted: false,
            persistenceError: safeError(writeErr)
        };
    }
}

function buildRefreshQuery(now, marginMs, failMax, tokenField = "oauth") {
    return {
        $or: [
            { [tokenPath(tokenField, "expiresAt")]: { $lte: now + marginMs } },
            { [tokenPath(tokenField, "expiresAt")]: { $exists: false } },
            { [tokenPath(tokenField, "expiresAt")]: null }
        ],
        $and: [
            {
                $or: [
                    { [tokenPath(tokenField, "refreshFailCount")]: { $exists: false } },
                    { [tokenPath(tokenField, "refreshFailCount")]: { $lt: failMax } }
                ]
            },
            {
                $or: [
                    { deletedAt: { $exists: false } },
                    { deletedAt: null }
                ]
            }
        ],
        [tokenPath(tokenField, "encryptedRefreshToken")]: { $exists: true, $ne: "" },
        [tokenPath(tokenField, "revokedAt")]: { $in: [null] }
    };
}

function refreshStateIsDue(tokenState, { now, marginMs, failMax }) {
    if (!tokenState || typeof tokenState !== "object") return false;
    if (!tokenState.encryptedRefreshToken || tokenState.revokedAt) return false;
    if (Number(tokenState.refreshFailCount || 0) >= failMax) return false;
    const expiresAt = Number(tokenState.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= now + marginMs;
}

function applyRefreshOutcome(summary, outcome) {
    if (outcome?.refreshed) {
        summary.refreshed++;
        return;
    }
    if (outcome?.skipped) {
        summary.skipped++;
        if (String(outcome.reason || "").includes("changed")) summary.conflicts++;
        return;
    }
    if (!outcome?.failed) return;
    summary.failed++;
    if (outcome.revoked) summary.revoked++;
    if (outcome.persisted === false) summary.persistenceFailed++;
    if (summary.errors.length < 10) summary.errors.push(outcome);
}

function recordRefreshException(summary, tokenField, doc, error) {
    summary.failed++;
    summary.persistenceFailed++;
    if (summary.errors.length >= 10) return;
    summary.errors.push({
        ok: false,
        tokenField,
        userId: doc.discord?.userId || doc.id,
        error: safeError(error),
        persisted: false
    });
}

module.exports = {
    conflictOutcome,
    readFreshOAuthDocument,
    isInvalidGrantError,
    markRefreshFailure,
    buildRefreshQuery,
    refreshStateIsDue,
    applyRefreshOutcome,
    recordRefreshException
};
