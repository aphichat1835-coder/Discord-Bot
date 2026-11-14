"use strict";

const OAuthUser = require("../../verification/models/OAuthUser");
const discordApi = require("../../verification/utils/discordAPI");
const { decryptToken } = require("../../verification/utils/crypto");
const { safeError } = require("../../core/safeLogger");
const {
    DEFAULT_ON_DEMAND_MARGIN_MS,
    getOAuthRefreshConfig,
    resolveFailMax,
    resolveRedirectUriForField
} = require("./config");
const { diagnosticStats, dispatchOAuthAlert } = require("./state");
const { assertValidTokenField, validateTokenData } = require("./tokenValidation");
const { raceWithSignal, withTokenRefreshLock } = require("./lockManager");
const { prepareStoredToken, tokenPath, versionCondition } = require("./tokenStorage");
const {
    conflictOutcome,
    readFreshOAuthDocument,
    markRefreshFailure,
    buildRefreshQuery,
    refreshStateIsDue,
    applyRefreshOutcome,
    recordRefreshException
} = require("./refreshState");

function _validateFreshTokenState(fresh, tokenField, lockUserId, effectiveFailMax) {
    if (!fresh) return { earlyExit: true, result: conflictOutcome(tokenField, lockUserId, "document_missing") };
    if (fresh.deletedAt) {
        return { earlyExit: true, result: { ok: false, code: "user_deleted", reason: "User is soft-deleted", userId: lockUserId, tokenField } };
    }

    const userId = fresh.discord?.userId || lockUserId;
    const tokenState = fresh[tokenField] || {};

    if (tokenState.revokedAt) {
        return { earlyExit: true, result: { ok: false, code: "token_revoked", reason: "Token is revoked", userId, tokenField } };
    }

    if (Number(tokenState.refreshFailCount || 0) >= effectiveFailMax) {
        return { earlyExit: true, result: { ok: false, code: "oauth_refresh_exhausted", reason: "Token refresh attempts exhausted", userId, tokenField } };
    }

    const previousRefreshTokenEncrypted = tokenState.encryptedRefreshToken;
    if (!previousRefreshTokenEncrypted) {
        return { earlyExit: true, result: { ok: false, code: "oauth_reauth_required", reason: "Missing refresh token", userId, tokenField } };
    }

    const previousVersion = Number(tokenState.version || 0);
    return {
        earlyExit: false,
        userId,
        tokenState,
        previousRefreshTokenEncrypted,
        previousVersion
    };
}

function _checkUnexpiredToken(tokenState, force, marginMs, now, tokenField, userId) {
    if (force) return null;
    const expiresAt = Number(tokenState.expiresAt || 0);
    const margin = Number.isFinite(Number(marginMs)) ? Number(marginMs) : DEFAULT_ON_DEMAND_MARGIN_MS;
    if (expiresAt > now + margin && tokenState.encryptedAccessToken) {
        const rawAccess = decryptToken(tokenState.encryptedAccessToken);
        if (rawAccess) {
            return {
                ok: true,
                refreshed: false,
                accessToken: rawAccess,
                expiresAt,
                tokenField,
                userId
            };
        }
    }
    return null;
}

async function _resolveAndDecryptRefreshToken({ fresh, previousRefreshTokenEncrypted, userId, tokenField, model, now, effectiveFailMax, env }) {
    let rawRefreshToken;
    try {
        rawRefreshToken = decryptToken(previousRefreshTokenEncrypted);
    } catch {
        rawRefreshToken = null;
    }
    if (!rawRefreshToken) {
        const decryptError = new Error("Failed to decrypt stored refresh token");
        decryptError.code = "oauth_refresh_token_decrypt_failed";
        dispatchOAuthAlert({
            code: "oauth.token_decrypt_failed",
            severity: "CRITICAL",
            state: "OPEN",
            title: "OAUTH TOKEN DECRYPT FAILED",
            description: "ตรวจพบโทเคนในฐานข้อมูลไม่สามารถถอดรหัสได้ อาจเกิดจาก ENCRYPTION_KEY ไม่ตรงกับตอนเข้ารหัส หรือข้อมูลเสียหาย",
            fields: [
                { name: "สถานะ", value: "OPEN" },
                { name: "User ID", value: String(userId) },
                { name: "Token Field", value: String(tokenField) },
                { name: "ผลกระทบ", value: "ไม่สามารถนำโทเคนไปใช้งานหรือต่ออายุได้" },
                { name: "สิ่งที่ควรทำ", value: "ตรวจสอบความถูกต้องของ ENCRYPTION_KEY หรือให้ผู้ใช้ยืนยันตัวตนใหม่เพื่อบันทึกโทเคนชุดใหม่" }
            ],
            dedupeKey: `oauth-decrypt-failed:${userId}:${tokenField}`,
            dedupeMs: 30 * 60 * 1000
        });
        const failureResult = await markRefreshFailure(fresh, decryptError, { model, now, failMax: effectiveFailMax, env, tokenField });
        return { ok: false, result: failureResult };
    }
    return { ok: true, rawRefreshToken };
}

async function _fetchAndValidateRefreshedToken({ discord, rawRefreshToken, redirectUri, tokenField, signal, fresh, model, now, effectiveFailMax, env, userId }) {
    let tokenData;
    try {
        const refreshArgs = [rawRefreshToken, redirectUri || resolveRedirectUriForField(tokenField)];
        if (signal) refreshArgs.push({ signal });
        tokenData = await discord.refreshToken(...refreshArgs);
    } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") {
            return {
                ok: false,
                result: {
                    ok: false,
                    code: "aborted",
                    error,
                    reason: "Token refresh was aborted",
                    userId,
                    tokenField
                }
            };
        }
        const failureResult = await markRefreshFailure(fresh, error, { model, now, failMax: effectiveFailMax, env, tokenField });
        return { ok: false, result: failureResult };
    }

    try {
        validateTokenData(tokenData);
    } catch (valErr) {
        const failureResult = await markRefreshFailure(fresh, valErr, { model, now, failMax: effectiveFailMax, env, tokenField });
        return { ok: false, result: failureResult };
    }

    return { ok: true, tokenData };
}

async function performTokenRefreshUnderLock({
    doc,
    model = OAuthUser,
    discord = discordApi,
    tokenField = "oauth",
    now = Date.now(),
    failMax = null,
    env = process.env,
    redirectUri,
    force = false,
    marginMs = DEFAULT_ON_DEMAND_MARGIN_MS,
    signal = null
}) {
    assertValidTokenField(tokenField);
    const effectiveFailMax = resolveFailMax(failMax, env);
    const lockUserId = doc.discord?.userId || String(doc._id);

    if (signal?.aborted) {
        return { ok: false, code: "aborted", reason: "Operation aborted", userId: lockUserId, tokenField };
    }

    let fresh;
    try {
        fresh = await raceWithSignal(readFreshOAuthDocument(model, doc, tokenField), signal);
    } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") {
            return { ok: false, code: "aborted", error: err, reason: "Operation aborted", userId: lockUserId, tokenField };
        }
        throw err;
    }

    const stateValidation = _validateFreshTokenState(fresh, tokenField, lockUserId, effectiveFailMax);
    if (stateValidation.earlyExit) {
        return stateValidation.result;
    }

    const { userId, tokenState, previousRefreshTokenEncrypted, previousVersion } = stateValidation;

    const unexpiredResult = _checkUnexpiredToken(tokenState, force, marginMs, now, tokenField, userId);
    if (unexpiredResult) {
        return unexpiredResult;
    }

    if (signal?.aborted) {
        return { ok: false, code: "aborted", reason: "Operation aborted", userId, tokenField };
    }

    const decryptRes = await _resolveAndDecryptRefreshToken({ fresh, previousRefreshTokenEncrypted, userId, tokenField, model, now, effectiveFailMax, env });
    if (!decryptRes.ok) {
        return decryptRes.result;
    }

    const refreshRes = await _fetchAndValidateRefreshedToken({
        discord,
        rawRefreshToken: decryptRes.rawRefreshToken,
        redirectUri,
        tokenField,
        signal,
        fresh,
        model,
        now,
        effectiveFailMax,
        env,
        userId
    });
    if (!refreshRes.ok) {
        return refreshRes.result;
    }

    const tokenData = refreshRes.tokenData;
    const nextPayload = prepareStoredToken(tokenData, { now, previousVersion, isRefresh: true });
    const result = await model.updateOne(
        {
            _id: fresh._id,
            [tokenPath(tokenField, "encryptedRefreshToken")]: previousRefreshTokenEncrypted,
            [tokenPath(tokenField, "revokedAt")]: { $in: [null] },
            ...versionCondition(tokenField, previousVersion)
        },
        {
            $set: {
                [tokenField]: nextPayload,
                updatedAt: now
            }
        }
    );

    const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
    if (modified !== 1) {
        return conflictOutcome(tokenField, userId, "refresh_state_changed");
    }

    diagnosticStats.totalRefreshes++;
    diagnosticStats.successfulRefreshes++;
    diagnosticStats.lastRefreshAt = now;

    return {
        ok: true,
        refreshed: true,
        accessToken: tokenData.access_token,
        expiresAt: nextPayload.expiresAt,
        tokenField,
        userId,
        version: nextPayload.version
    };
}

function checkTokenEligibility(doc, tokenField, failMax) {
    if (!doc || doc.deletedAt) {
        return { ok: false, code: doc ? "user_deleted" : "user_not_found", reason: doc ? "User is soft-deleted" : "User not found in OAuth registry" };
    }
    const tokenState = doc[tokenField] || {};
    if (tokenState.revokedAt) {
        return { ok: false, code: "token_revoked", reason: "Token is marked revoked" };
    }
    if (Number(tokenState.refreshFailCount || 0) >= failMax) {
        return { ok: false, code: "oauth_refresh_exhausted", reason: "Token refresh attempts exhausted" };
    }
    return null;
}

function tryGetCachedAccessToken({ tokenState, forceRefresh, now, marginMs, userId, tokenField }) {
    const expiresAt = Number(tokenState.expiresAt || 0);
    const isDue = expiresAt <= (now + marginMs);

    if (!forceRefresh && !isDue && tokenState.encryptedAccessToken) {
        const decrypted = decryptToken(tokenState.encryptedAccessToken);
        if (decrypted) {
            return {
                ok: true,
                accessToken: decrypted,
                refreshed: false,
                expiresAt,
                tokenField,
                userId
            };
        }
    }
    return null;
}

async function getAccessToken({
    userId,
    tokenField = "oauth",
    forceRefresh = false,
    model = OAuthUser,
    discord = discordApi,
    env = process.env,
    now = Date.now(),
    marginMs = DEFAULT_ON_DEMAND_MARGIN_MS,
    signal = null
} = {}) {
    if (!userId) {
        const error = new Error("userId is required to get access token");
        error.code = "oauth_user_id_required";
        throw error;
    }

    assertValidTokenField(tokenField);

    if (signal?.aborted) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        return { ok: false, code: "aborted", error, reason: "Operation aborted", userId, tokenField };
    }

    let doc;
    try {
        doc = await raceWithSignal(
            model.findOne({
                "discord.userId": String(userId),
                $or: [
                    { deletedAt: { $exists: false } },
                    { deletedAt: null }
                ]
            })
                .select({ discord: 1, deletedAt: 1, [tokenField]: 1 })
                .lean(),
            signal
        );
    } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") {
            return { ok: false, code: "aborted", error: err, reason: "Operation aborted", userId, tokenField };
        }
        throw err;
    }

    if (signal?.aborted) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        return { ok: false, code: "aborted", error, reason: "Operation aborted", userId, tokenField };
    }

    const failMax = getOAuthRefreshConfig(env).failMax;
    const eligibilityError = checkTokenEligibility(doc, tokenField, failMax);
    if (eligibilityError) {
        return { ...eligibilityError, userId, tokenField };
    }

    const tokenState = doc[tokenField] || {};
    const cachedResult = tryGetCachedAccessToken({ tokenState, forceRefresh, now, marginMs, userId, tokenField });
    if (cachedResult) {
        return cachedResult;
    }

    const redirectUri = resolveRedirectUriForField(tokenField, env);
    const lockKey = `${userId}:${tokenField}`;

    try {
        return await withTokenRefreshLock(lockKey, async () => {
            return performTokenRefreshUnderLock({
                doc,
                model,
                discord,
                tokenField,
                now,
                marginMs,
                failMax,
                env,
                redirectUri,
                force: forceRefresh,
                signal
            });
        }, signal);
    } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") {
            return { ok: false, code: "aborted", error: err, reason: "Operation aborted", userId, tokenField };
        }
        throw err;
    }
}

async function refreshSingleOAuthDoc(doc, { model, tokenField, redirectUri, now, config, discordApiInstance, summary }) {
    const lockUserId = doc.discord?.userId || String(doc._id);
    const lockKey = `${lockUserId}:${tokenField}`;
    try {
        const outcome = await withTokenRefreshLock(lockKey, async () => {
            const fresh = await readFreshOAuthDocument(model, doc, tokenField);
            if (!fresh) return conflictOutcome(tokenField, lockUserId, "document_missing");

            const userId = fresh.discord?.userId || lockUserId;
            const tokenState = fresh[tokenField] || {};
            if (!refreshStateIsDue(tokenState, { now, marginMs: config.marginMs, failMax: config.failMax })) {
                return conflictOutcome(tokenField, userId, "not_due");
            }

            return performTokenRefreshUnderLock({
                doc: fresh,
                model,
                discord: discordApiInstance,
                tokenField,
                now,
                failMax: config.failMax,
                redirectUri,
                force: true
            });
        });
        applyRefreshOutcome(summary, outcome);
    } catch (error) {
        recordRefreshException(summary, tokenField, doc, error);
    }
}

async function refreshTokenField({
    model,
    tokenField,
    redirectUri,
    now,
    config,
    discordApiInstance
}) {
    assertValidTokenField(tokenField);
    const query = buildRefreshQuery(now, config.marginMs, config.failMax, tokenField);
    const docs = await model.find(query)
        .sort({ [tokenPath(tokenField, "expiresAt")]: 1, updatedAt: 1 })
        .limit(config.scanLimit);

    const summary = {
        scanned: docs.length,
        refreshed: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        revoked: 0,
        persistenceFailed: 0,
        errors: []
    };

    const processDocs = async (index) => {
        if (index >= docs.length) return summary;
        await refreshSingleOAuthDoc(docs[index], {
            model,
            tokenField,
            redirectUri,
            now,
            config,
            discordApiInstance,
            summary
        });
        return processDocs(index + 1);
    };

    return await processDocs(0);
}

async function refreshDueTokens(options = {}) {
    const env = options.env || process.env;
    const config = {
        ...getOAuthRefreshConfig(env),
        ...options
    };

    if (!config.enabled) {
        return { skipped: true, reason: "oauth_token_storage_disabled", refreshed: 0, failed: 0, revoked: 0 };
    }

    const now = Number(config.now || Date.now());
    const model = config.OAuthUserModel || OAuthUser;
    const discordApiInstance = config.discordApi || discordApi;
    const tokenFields = config.tokenFields || [
        { tokenField: "oauth", redirectUri: config.verificationRedirectUri || config.redirectUri }
    ];

    const summary = {
        skipped: false,
        scanned: 0,
        refreshed: 0,
        conflicts: 0,
        failed: 0,
        revoked: 0,
        persistenceFailed: 0,
        byField: {},
        errors: []
    };

    async function processFieldConfig(index) {
        if (index >= tokenFields.length) return;
        const fieldConfig = tokenFields[index];
        const tokenField = fieldConfig.tokenField || fieldConfig.field || "oauth";
        const fieldSummary = await refreshTokenField({
            model,
            tokenField,
            redirectUri: fieldConfig.redirectUri || config.redirectUri,
            now,
            config,
            discordApiInstance
        });

        summary.byField[tokenField] = fieldSummary;
        summary.scanned += fieldSummary.scanned;
        summary.refreshed += fieldSummary.refreshed;
        summary.conflicts += fieldSummary.conflicts;
        summary.failed += fieldSummary.failed;
        summary.revoked += fieldSummary.revoked;
        summary.persistenceFailed += fieldSummary.persistenceFailed || 0;
        summary.errors.push(...fieldSummary.errors.slice(0, Math.max(0, 10 - summary.errors.length)));

        await processFieldConfig(index + 1);
    }

    await processFieldConfig(0);

    diagnosticStats.lastRefreshAt = now;
    diagnosticStats.lastRefreshSummary = summary;
    return summary;
}

module.exports = {
    _validateFreshTokenState,
    _checkUnexpiredToken,
    _resolveAndDecryptRefreshToken,
    _fetchAndValidateRefreshedToken,
    performTokenRefreshUnderLock,
    checkTokenEligibility,
    tryGetCachedAccessToken,
    getAccessToken,
    refreshSingleOAuthDoc,
    refreshTokenField,
    refreshDueTokens
};
