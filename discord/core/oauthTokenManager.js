"use strict";

const OAuthUser = require("../verification/models/OAuthUser");
const discordApi = require("../verification/utils/discordAPI");
const {
    encryptToken,
    decryptToken,
    decryptTokenForMigration
} = require("../verification/utils/crypto");
const { safeError } = require("./safeLogger");
const { resolvePublicBaseUrl } = require("./publicUrl");

const DEFAULT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_SCAN_LIMIT = 100;
const DEFAULT_REFRESH_FAIL_MAX = 5;
const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_ON_DEMAND_MARGIN_MS = 5 * 60 * 1000;

const REQUIRED_USER_SCOPES = Object.freeze([
    "identify", "email", "connections", "guilds", "guilds.members.read", "guilds.join"
]);
const TOKEN_FIELDS = Object.freeze(["oauth", "adminOAuth"]);

function assertValidTokenField(tokenField) {
    if (!tokenField || typeof tokenField !== "string" || !TOKEN_FIELDS.includes(tokenField)) {
        const error = new Error(`Invalid tokenField "${tokenField}". Allowed values: ${TOKEN_FIELDS.join(", ")}`);
        error.code = "oauth_invalid_token_field";
        throw error;
    }
    return tokenField;
}

const refreshLocks = new Map();

let backgroundTimer = null;
let backgroundIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;
let isStarted = false;
let startPromise = null;
let refreshInFlight = false;
let inFlightRefreshPromise = null;

const diagnosticStats = {
    startedAt: null,
    stoppedAt: null,
    totalRefreshes: 0,
    successfulRefreshes: 0,
    failedRefreshes: 0,
    revokedCount: 0,
    conflictCount: 0,
    lastRefreshAt: null,
    lastRefreshSummary: null,
    lastError: null
};

function dispatchOAuthAlert(event, options = {}) {
    try {
        const { sendWebhookEvent } = require("./webhooks");
        if (typeof sendWebhookEvent === "function") {
            sendWebhookEvent({
                target: "ALERT",
                category: "TOKEN",
                ...event
            }, options).catch(() => {});
        }
    } catch {
        // webhooks module may not be present in isolated test runners
    }
}

function readPositiveNumber(value, fallback, min = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
}

function getPublicBaseUrl(env = process.env) {
    return resolvePublicBaseUrl(env, "http://localhost:3000");
}

function getVerificationRedirectUri(env = process.env) {
    return `${getPublicBaseUrl(env)}/auth/callback`;
}

function getAdminRedirectUri(env = process.env) {
    return String(
        env.LEGACY_ADMIN_OAUTH_REDIRECT_URI ||
        `${getPublicBaseUrl(env)}/auth/admin-callback`
    ).trim();
}

function getOAuthRefreshConfig(env = process.env) {
    return {
        enabled: true,
        marginMs: readPositiveNumber(env.OAUTH_TOKEN_REFRESH_MARGIN_MS, DEFAULT_REFRESH_MARGIN_MS, 60 * 1000),
        scanLimit: Math.max(1, Math.min(1000, readPositiveNumber(env.OAUTH_TOKEN_REFRESH_SCAN_LIMIT, DEFAULT_REFRESH_SCAN_LIMIT, 1))),
        failMax: Math.max(1, Math.min(50, readPositiveNumber(env.OAUTH_TOKEN_REFRESH_FAIL_MAX, DEFAULT_REFRESH_FAIL_MAX, 1))),
        intervalMs: readPositiveNumber(env.OAUTH_TOKEN_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_INTERVAL_MS, 60 * 1000),
        redirectUri: getVerificationRedirectUri(env),
        verificationRedirectUri: getVerificationRedirectUri(env),
        adminRedirectUri: getAdminRedirectUri(env)
    };
}

function resolveFailMax(failMax, env = process.env) {
    if (failMax !== undefined && failMax !== null) {
        return Math.max(1, Math.min(50, readPositiveNumber(failMax, DEFAULT_REFRESH_FAIL_MAX, 1)));
    }
    return getOAuthRefreshConfig(env).failMax;
}

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

function validateTokenData(tokenData) {
    if (!tokenData || typeof tokenData !== "object") {
        const error = new Error("Invalid token payload: expected an object");
        error.code = "oauth_token_invalid_payload";
        throw error;
    }
    const accessToken = String(tokenData.access_token || "").trim();
    if (!accessToken || typeof tokenData.access_token !== "string") {
        const error = new Error("Invalid token payload: missing or invalid access_token");
        error.code = "oauth_token_missing_access_token";
        throw error;
    }
    const refreshToken = String(tokenData.refresh_token || "").trim();
    if (!refreshToken || typeof tokenData.refresh_token !== "string") {
        const error = new Error("Invalid token payload: missing or invalid refresh_token");
        error.code = "oauth_token_missing_refresh_token";
        throw error;
    }
    const expiresIn = Number(tokenData.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
        const error = new Error("Invalid token payload: expires_in must be a positive number");
        error.code = "oauth_token_invalid_expires_in";
        throw error;
    }
    if (tokenData.scope !== undefined && typeof tokenData.scope !== "string") {
        const error = new Error("Invalid token payload: scope must be a string");
        error.code = "oauth_token_invalid_scope";
        throw error;
    }
    if (tokenData.token_type !== undefined && tokenData.token_type !== null && typeof tokenData.token_type !== "string") {
        const error = new Error("Invalid token payload: token_type must be a string");
        error.code = "oauth_token_invalid_token_type";
        throw error;
    }
    return true;
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

function raceWithSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
        let onAbort;
        onAbort = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(promise).then(
            val => {
                signal.removeEventListener("abort", onAbort);
                resolve(val);
            },
            err => {
                signal.removeEventListener("abort", onAbort);
                reject(err);
            }
        );
    });
}

async function withTokenRefreshLock(key, fn, signal = null) {
    if (signal?.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
    }

    const previous = refreshLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const current = previous.catch(() => {}).then(() => gate);
    refreshLocks.set(key, current);

    try {
        if (signal) {
            let abortListener;
            const abortPromise = new Promise((_, reject) => {
                abortListener = () => {
                    const err = new Error("The operation was aborted");
                    err.name = "AbortError";
                    reject(err);
                };
                signal.addEventListener("abort", abortListener, { once: true });
            });
            try {
                await Promise.race([previous.catch(() => {}), abortPromise]);
            } finally {
                if (abortListener) signal.removeEventListener("abort", abortListener);
            }
        } else {
            await previous.catch(() => {});
        }

        if (signal?.aborted) {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            throw err;
        }

        return await fn();
    } finally {
        release();
        if (refreshLocks.get(key) === current) refreshLocks.delete(key);
    }
}

function resolveRedirectUriForField(tokenField, env = process.env) {
    return tokenField === "adminOAuth"
        ? getAdminRedirectUri(env)
        : getVerificationRedirectUri(env);
}

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

    if (!fresh) return conflictOutcome(tokenField, lockUserId, "document_missing");
    if (fresh.deletedAt) {
        return { ok: false, code: "user_deleted", reason: "User is soft-deleted", userId: lockUserId, tokenField };
    }

    const userId = fresh.discord?.userId || lockUserId;
    const tokenState = fresh[tokenField] || {};

    if (tokenState.revokedAt) {
        return { ok: false, code: "token_revoked", reason: "Token is revoked", userId, tokenField };
    }

    if (Number(tokenState.refreshFailCount || 0) >= effectiveFailMax) {
        return { ok: false, code: "oauth_refresh_exhausted", reason: "Token refresh attempts exhausted", userId, tokenField };
    }

    const previousRefreshTokenEncrypted = tokenState.encryptedRefreshToken;
    if (!previousRefreshTokenEncrypted) {
        return { ok: false, code: "oauth_reauth_required", reason: "Missing refresh token", userId, tokenField };
    }

    const previousVersion = Number(tokenState.version || 0);

    if (!force) {
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
    }

    if (signal?.aborted) {
        return { ok: false, code: "aborted", reason: "Operation aborted", userId, tokenField };
    }

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
        return markRefreshFailure(fresh, decryptError, { model, now, failMax: effectiveFailMax, env, tokenField });
    }

    let tokenData;
    try {
        const refreshArgs = [rawRefreshToken, redirectUri || resolveRedirectUriForField(tokenField)];
        if (signal) refreshArgs.push({ signal });
        tokenData = await discord.refreshToken(...refreshArgs);
    } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") {
            return {
                ok: false,
                code: "aborted",
                error,
                reason: "Token refresh was aborted",
                userId,
                tokenField
            };
        }
        return markRefreshFailure(fresh, error, { model, now, failMax: effectiveFailMax, env, tokenField });
    }

    try {
        validateTokenData(tokenData);
    } catch (valErr) {
        return markRefreshFailure(fresh, valErr, { model, now, failMax: effectiveFailMax, env, tokenField });
    }

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

    if (!doc || doc.deletedAt) {
        return { ok: false, code: doc ? "user_deleted" : "user_not_found", reason: doc ? "User is soft-deleted" : "User not found in OAuth registry", userId, tokenField };
    }

    const tokenState = doc[tokenField] || {};
    if (tokenState.revokedAt) {
        return { ok: false, code: "token_revoked", reason: "Token is marked revoked", userId, tokenField };
    }

    const failMax = getOAuthRefreshConfig(env).failMax;
    if (Number(tokenState.refreshFailCount || 0) >= failMax) {
        return { ok: false, code: "oauth_refresh_exhausted", reason: "Token refresh attempts exhausted", userId, tokenField };
    }

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
                failMax: getOAuthRefreshConfig(env).failMax,
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

    for (const doc of docs) {
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

    return summary;
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
        { tokenField: "oauth", redirectUri: config.verificationRedirectUri || config.redirectUri },
        { tokenField: "adminOAuth", redirectUri: config.adminRedirectUri }
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

    for (const fieldConfig of tokenFields) {
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
    }

    diagnosticStats.lastRefreshAt = now;
    diagnosticStats.lastRefreshSummary = summary;
    return summary;
}

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
        byTokenField: { oauth: 0, adminOAuth: 0 }
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

    const filter = { $and: andConditions };
    const docs = await model.find(filter)
        .select("discord.userId oauth adminOAuth lastVerify updatedAt _id")
        .sort({ _id: 1 })
        .limit(limit)
        .lean();

    const normalizedRequired = new Set(requiredScopes.map(s => String(s || "").trim()).filter(Boolean));
    const candidates = [];
    const batchUsers = new Set();
    let newUniqueUsers = 0;
    let usableUsersCount = 0;
    let missingUserId = 0;
    let missingScope = 0;
    let revoked = 0;
    let exhausted = 0;
    const byTokenField = { oauth: 0, adminOAuth: 0 };

    for (const doc of docs) {
        if (effectiveGuildId) {
            if (
                String(doc.lastVerify?.guildId || "").trim() !== effectiveGuildId ||
                doc.lastVerify?.result !== "success"
            ) {
                continue;
            }
        }
        const userId = String(doc.discord?.userId || "").trim();
        if (!userId) {
            missingUserId++;
            continue;
        }

        if (seenUsers instanceof Set && seenUsers.has(userId)) {
            continue;
        }

        const isNewUser = !batchUsers.has(userId);
        if (isNewUser) {
            batchUsers.add(userId);
            newUniqueUsers++;
        }

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
            if (Number(tokenState.refreshFailCount || 0) >= config.failMax) {
                docIsExhausted = true;
                continue;
            }

            const scopes = new Set(String(tokenState.scope || "").split(/\s+/).filter(Boolean));
            let matchesAll = true;
            for (const req of normalizedRequired) {
                if (!scopes.has(req)) {
                    matchesAll = false;
                    break;
                }
            }
            if (matchesAll) {
                chosenField = tokenField;
                chosenScope = tokenState.scope || "";
                break;
            } else {
                docHasMissingScope = true;
            }
        }

        if (chosenField) {
            if (isNewUser) {
                usableUsersCount++;
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
            missingScope++;
        } else if (docIsRevoked) {
            revoked++;
        } else if (docIsExhausted) {
            exhausted++;
        }
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
            uniqueUsers: newUniqueUsers,
            usableUsers: usableUsersCount,
            missingScope,
            missingUserId,
            revoked,
            exhausted,
            byTokenField
        }
    });
}

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

async function getOwnerTokenState(userId, { model = OAuthUser, tokenFields = TOKEN_FIELDS, includeDeleted = false } = {}) {
    if (!userId) {
        const error = new Error("User ID is required for owner token reveal");
        error.code = "oauth_user_id_required";
        throw error;
    }

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
        return { oauth: null, adminOAuth: null };
    }

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

    const result = {};
    for (const field of fields) {
        result[field] = tokenMetadataState(doc?.[field] || {});
    }
    return result;
}

function checkTokenCryptoReasons(token, now, failMax = null, env = process.env) {
    const effectiveFailMax = resolveFailMax(failMax, env);
    const reasons = [];
    const accessToken = token.encryptedAccessToken ? decryptToken(token.encryptedAccessToken) : null;
    const refreshToken = token.encryptedRefreshToken ? decryptToken(token.encryptedRefreshToken) : null;

    if (!token.encryptedAccessToken) reasons.push("missing_access_token");
    else if (!accessToken) reasons.push("access_token_decrypt_failed");

    if (!token.encryptedRefreshToken) reasons.push("missing_refresh_token");
    else if (!refreshToken) reasons.push("refresh_token_decrypt_failed");

    if (token.revokedAt) reasons.push("token_revoked");

    if (Number(token.refreshFailCount || 0) >= effectiveFailMax) {
        reasons.push("refresh_exhausted");
    }

    const isExpired = Number(token.expiresAt || 0) > 0 && Number(token.expiresAt) <= now;
    if (isExpired && !refreshToken) {
        reasons.push("access_token_expired_without_refresh");
    }
    return reasons;
}

function collectMissingScopeReasons(tokenScope, requiredScopes = REQUIRED_USER_SCOPES) {
    const scopes = new Set(String(tokenScope || "").split(/\s+/).filter(Boolean));
    const missing = [];
    for (const scope of requiredScopes) {
        if (!scopes.has(scope)) missing.push(`missing_scope:${scope}`);
    }
    return missing;
}

function recoveryReasonLabel(reason) {
    const labels = {
        missing_access_token: "ไม่มี Access Token",
        access_token_decrypt_failed: "ถอดรหัส Access Token ไม่สำเร็จ",
        missing_refresh_token: "ไม่มี Refresh Token",
        refresh_token_decrypt_failed: "ถอดรหัส Refresh Token ไม่สำเร็จ",
        token_revoked: "Token ถูกยกเลิก",
        refresh_exhausted: "Refresh ล้มเหลวถึงจำนวนสูงสุด",
        record_missing: "ไม่พบข้อมูลผู้ใช้ในระบบ",
        user_deleted: "ข้อมูลผู้ใช้ถูกลบ",
        access_token_expired_without_refresh: "Access Token หมดอายุและต่ออายุไม่ได้"
    };
    if (String(reason).startsWith("missing_scope:")) return `ขาด Scope ${String(reason).slice(14)}`;
    return labels[reason] || String(reason);
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
            reasonLabels: uniqueReasons.map(recoveryReasonLabel)
        });
    }

    return resultMap;
}

function tokenRecoveryReasons(token = {}, now = Date.now(), requiredScopes = REQUIRED_USER_SCOPES, failMax = null, env = process.env) {
    let resolvedNow = now;
    let resolvedScopes = requiredScopes;
    let resolvedFailMax = failMax;
    let resolvedEnv = env;

    if (now && typeof now === "object" && !(now instanceof Date)) {
        resolvedNow = now.now !== undefined ? now.now : Date.now();
        resolvedScopes = now.requiredScopes !== undefined ? now.requiredScopes : REQUIRED_USER_SCOPES;
        resolvedFailMax = now.failMax !== undefined ? now.failMax : null;
        resolvedEnv = now.env !== undefined ? now.env : process.env;
    }

    const effectiveFailMax = resolveFailMax(resolvedFailMax, resolvedEnv);
    const reasons = [
        ...checkTokenCryptoReasons(token, resolvedNow, effectiveFailMax, resolvedEnv),
        ...collectMissingScopeReasons(token?.scope, resolvedScopes)
    ];
    return [...new Set(reasons)];
}

function legacyValueFilter() {
    return {
        $exists: true,
        $type: "string",
        $ne: "",
        $not: /^v3:gcm:/
    };
}

function modelLegacyFilter(fields, afterId = null) {
    const filter = { $or: fields.map(field => ({ [field]: legacyValueFilter() })) };
    if (afterId) filter._id = { $gt: afterId };
    return filter;
}

async function migrateStoredTokenEncryption({
    dryRun = false,
    scanMax = 200,
    limit = scanMax,
    countRemaining = true,
    model = OAuthUser,
    afterId = null
} = {}) {
    const targetFields = [
        "oauth.encryptedAccessToken",
        "oauth.encryptedRefreshToken",
        "adminOAuth.encryptedAccessToken",
        "adminOAuth.encryptedRefreshToken"
    ];

    let queryFilter = modelLegacyFilter(targetFields, afterId);
    let query = model.find(queryFilter);
    if (typeof query.select === "function") {
        query = query.select(["_id", ...targetFields].join(" "));
    }
    if (typeof query.sort === "function") query = query.sort({ _id: 1 });
    if (typeof query.limit === "function") query = query.limit(limit);
    if (typeof query.lean === "function") query = query.lean();

    let docs = await query;
    let cursorWrapped = false;

    if (docs.length === 0 && afterId) {
        cursorWrapped = true;
        queryFilter = modelLegacyFilter(targetFields);
        let retryQuery = model.find(queryFilter);
        if (typeof retryQuery.select === "function") {
            retryQuery = retryQuery.select(["_id", ...targetFields].join(" "));
        }
        if (typeof retryQuery.sort === "function") retryQuery = retryQuery.sort({ _id: 1 });
        if (typeof retryQuery.limit === "function") retryQuery = retryQuery.limit(limit);
        if (typeof retryQuery.lean === "function") retryQuery = retryQuery.lean();
        docs = await retryQuery;
    }

    let eligibleFields = 0;
    let migratedFields = 0;
    let failedFields = 0;

    for (const doc of docs) {
        for (const field of targetFields) {
            const parts = field.split(".");
            const currentVal = doc[parts[0]]?.[parts[1]];
            if (typeof currentVal !== "string" || currentVal.length === 0 || currentVal.startsWith("v3:gcm:")) {
                continue;
            }

            eligibleFields++;
            let decrypted;
            try {
                decrypted = decryptTokenForMigration(currentVal);
            } catch {
                failedFields++;
                continue;
            }

            if (!decrypted?.plaintext || decrypted.needsMigration !== true) {
                failedFields++;
                continue;
            }

            if (dryRun) {
                continue;
            }

            try {
                const replacement = encryptToken(decrypted.plaintext);
                const result = await model.updateOne(
                    { _id: doc._id, [field]: currentVal },
                    { $set: { [field]: replacement } }
                );
                const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
                if (modified === 1) {
                    migratedFields++;
                } else {
                    failedFields++;
                }
            } catch {
                failedFields++;
            }
        }
    }

    let remainingDocuments = null;
    if (countRemaining && typeof model.countDocuments === "function") {
        remainingDocuments = await model.countDocuments(modelLegacyFilter(targetFields));
    }

    const nextCursor = docs.length > 0 ? (docs.at(-1)?._id || null) : null;

    return {
        name: "oauth_tokens",
        scannedDocuments: docs.length,
        eligibleFields,
        migratedFields,
        failedFields,
        remainingDocuments,
        cursorWrapped,
        nextCursor,
        scanned: docs.length,
        updated: migratedFields,
        errors: failedFields
    };
}

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

function getDiagnostics() {
    return {
        running: isStarted,
        timerActive: !!backgroundTimer,
        inFlight: refreshInFlight,
        backgroundIntervalMs,
        activeRefreshLocks: refreshLocks.size,
        ...diagnosticStats
    };
}

let backgroundOptions = {};

async function runScheduledSweep() {
    if (refreshInFlight) return;
    const model = backgroundOptions.OAuthUserModel || OAuthUser;
    if (model?.db && typeof model.db.readyState === "number" && model.db.readyState !== 1 && !backgroundOptions.forceSweep) {
        return;
    }
    refreshInFlight = true;
    try {
        inFlightRefreshPromise = refreshDueTokens(backgroundOptions);
        await inFlightRefreshPromise;
    } catch (err) {
        diagnosticStats.lastError = safeError(err);
        console.error("[OAUTH_MANAGER] background sweep error:", safeError(err));
        dispatchOAuthAlert({
            code: "oauth.background_sweep_error",
            severity: "CRITICAL",
            state: "OPEN",
            title: "OAUTH BACKGROUND SWEEP FAILED",
            description: "ตรวจพบข้อผิดพลาดร้ายแรงระหว่างการรัน Background Sweep สำหรับต่ออายุ OAuth Token อัตโนมัติ",
            fields: [
                { name: "สถานะ", value: "OPEN" },
                { name: "Error Code", value: err?.code || "SWEEP_FAILED" },
                { name: "สาเหตุ", value: safeError(err) || "Unknown sweep error" },
                { name: "ผลกระทบ", value: "การต่ออายุโทเคนเบื้องหลังอาจหยุดชะงัก โทเคนที่ใกล้หมดอายุอาจไม่ได้รับการรีเฟรชทันเวลา" },
                { name: "สิ่งที่ควรทำ", value: "ตรวจสอบการเชื่อมต่อฐานข้อมูล MongoDB หรือตรวจสอบ Error Log ในเซิร์ฟเวอร์" }
            ],
            dedupeKey: "oauth-sweep-error",
            dedupeMs: 15 * 60 * 1000
        });
    } finally {
        refreshInFlight = false;
        inFlightRefreshPromise = null;
    }
}

async function start(options = {}) {
    if (startPromise) return startPromise;
    if (isStarted) return getDiagnostics();

    backgroundOptions = { ...options };
    const env = options.env || process.env;
    const config = getOAuthRefreshConfig(env);
    backgroundIntervalMs = options.intervalMs || config.intervalMs || DEFAULT_REFRESH_INTERVAL_MS;

    startPromise = (async () => {
        isStarted = true;
        diagnosticStats.startedAt = Date.now();
        diagnosticStats.stoppedAt = null;

        try {
            await runScheduledSweep();
        } catch (err) {
            diagnosticStats.lastError = safeError(err);
        }

        if (!isStarted) {
            return getDiagnostics();
        }

        if (!backgroundTimer) {
            backgroundTimer = setInterval(() => {
                runScheduledSweep().catch(err => {
                    diagnosticStats.lastError = safeError(err);
                });
            }, backgroundIntervalMs);
            if (typeof backgroundTimer.unref === "function") backgroundTimer.unref();
        }

        return getDiagnostics();
    })();

    return startPromise;
}

async function stop() {
    isStarted = false;
    startPromise = null;
    if (backgroundTimer) {
        clearInterval(backgroundTimer);
        backgroundTimer = null;
    }
    if (inFlightRefreshPromise) {
        try {
            await inFlightRefreshPromise;
        } catch {}
    }
    diagnosticStats.stoppedAt = Date.now();
    return getDiagnostics();
}

function resetInternalStateForTesting() {
    if (backgroundTimer) {
        clearInterval(backgroundTimer);
        backgroundTimer = null;
    }
    isStarted = false;
    startPromise = null;
    refreshInFlight = false;
    inFlightRefreshPromise = null;
    refreshLocks.clear();
    diagnosticStats.totalRefreshes = 0;
    diagnosticStats.successfulRefreshes = 0;
    diagnosticStats.failedRefreshes = 0;
    diagnosticStats.revokedCount = 0;
    diagnosticStats.conflictCount = 0;
    diagnosticStats.lastRefreshAt = null;
    diagnosticStats.lastRefreshSummary = null;
    diagnosticStats.lastError = null;
}

module.exports = {
    DEFAULT_REFRESH_MARGIN_MS,
    DEFAULT_REFRESH_SCAN_LIMIT,
    DEFAULT_REFRESH_FAIL_MAX,
    DEFAULT_REFRESH_INTERVAL_MS,
    DEFAULT_ON_DEMAND_MARGIN_MS,
    REQUIRED_USER_SCOPES,
    TOKEN_FIELDS,

    getPublicBaseUrl,
    getVerificationRedirectUri,
    getAdminRedirectUri,
    getOAuthRefreshConfig,
    validateTokenData,
    prepareStoredToken,
    exchangeAuthorizationCode,
    commitVerificationActivation,
    withTokenRefreshLock,
    withOAuthTokenStateLock: withTokenRefreshLock,
    getAccessToken,
    refreshDueTokens,
    listAccessTokenCandidates,
    getOwnerTokenState,
    getOwnerTokenMetadata,
    getRecoveryStatuses,
    recoveryReasonLabel,
    tokenRecoveryReasons,
    migrateStoredTokenEncryption,
    revokeToken,
    start,
    stop,
    getDiagnostics,

    _test: {
        dispatchOAuthAlert,
        resolveFailMax,
        isInvalidGrantError,
        assertValidTokenField,
        validateTokenData,
        tokenPath,
        versionCondition,
        conflictOutcome,
        readFreshOAuthDocument,
        markRefreshFailure,
        performTokenRefreshUnderLock,
        buildRefreshQuery,
        refreshStateIsDue,
        applyRefreshOutcome,
        refreshTokenField,
        revealTokenStateForOwner,
        tokenMetadataState,
        checkTokenCryptoReasons,
        collectMissingScopeReasons,
        resetInternalStateForTesting,
        refreshLocks,
        encryptToken,
        decryptToken,
        decryptTokenForMigration
    }
};
