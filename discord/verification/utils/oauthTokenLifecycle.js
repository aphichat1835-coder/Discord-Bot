const OAuthUser = require('../models/OAuthUser');
const discord = require('./discordAPI');
const { safeError } = require('./safeLogger');
const { resolvePublicBaseUrl } = require('../../core/publicUrl');

const DEFAULT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_SCAN_LIMIT = 100;
const DEFAULT_REFRESH_FAIL_MAX = 5;
const refreshLocks = new Map();

function shouldStoreOAuthTokens() {
    return true;
}

function getPublicBaseUrl(env = process.env) {
    return resolvePublicBaseUrl(env, 'http://localhost:3000');
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

function readPositiveNumber(value, fallback, min = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
}

function getOAuthRefreshConfig(env = process.env) {
    return {
        enabled: true,
        marginMs: readPositiveNumber(env.OAUTH_TOKEN_REFRESH_MARGIN_MS, DEFAULT_REFRESH_MARGIN_MS, 60 * 1000),
        scanLimit: Math.max(1, Math.min(1000, readPositiveNumber(env.OAUTH_TOKEN_REFRESH_SCAN_LIMIT, DEFAULT_REFRESH_SCAN_LIMIT, 1))),
        failMax: Math.max(1, Math.min(50, readPositiveNumber(env.OAUTH_TOKEN_REFRESH_FAIL_MAX, DEFAULT_REFRESH_FAIL_MAX, 1))),
        redirectUri: getVerificationRedirectUri(env),
        verificationRedirectUri: getVerificationRedirectUri(env),
        adminRedirectUri: getAdminRedirectUri(env)
    };
}

async function withRefreshLock(key, fn) {
    const previous = refreshLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const current = previous.catch(() => {}).then(() => gate);
    refreshLocks.set(key, current);
    await previous.catch(() => {});
    try {
        return await fn();
    } finally {
        release();
        if (refreshLocks.get(key) === current) refreshLocks.delete(key);
    }
}

function tokenPath(tokenField, key) {
    return `${tokenField}.${key}`;
}

function buildRefreshQuery(now, marginMs, failMax, tokenField = 'oauth') {
    return {
        [tokenPath(tokenField, 'encryptedRefreshToken')]: { $exists: true, $ne: '' },
        [tokenPath(tokenField, 'revokedAt')]: { $in: [null] },
        $or: [
            { [tokenPath(tokenField, 'expiresAt')]: { $lte: now + marginMs } },
            { [tokenPath(tokenField, 'expiresAt')]: { $exists: false } },
            { [tokenPath(tokenField, 'expiresAt')]: null }
        ],
        $and: [{ $or: [
            { [tokenPath(tokenField, 'refreshFailCount')]: { $exists: false } },
            { [tokenPath(tokenField, 'refreshFailCount')]: { $lt: failMax } }
        ] }]
    };
}

function buildStoredOAuthUpdate(tokenData, now, prepareTokenStorage = discord.prepareTokenStorage) {
    const oauth = prepareTokenStorage(tokenData);
    return {
        ...oauth,
        lastRefreshAt: now,
        refreshFailCount: 0,
        lastRefreshError: null,
        revokedAt: null
    };
}

function versionCondition(tokenField, version) {
    const previousVersion = Number(version || 0);
    if (previousVersion > 0) return { [tokenPath(tokenField, 'version')]: previousVersion };
    return {
        $or: [
            { [tokenPath(tokenField, 'version')]: 0 },
            { [tokenPath(tokenField, 'version')]: { $exists: false } }
        ]
    };
}

function refreshStateIsDue(tokenState, { now, marginMs, failMax }) {
    if (!tokenState || typeof tokenState !== 'object') return false;
    if (!tokenState.encryptedRefreshToken || tokenState.revokedAt) return false;
    if (Number(tokenState.refreshFailCount || 0) >= failMax) return false;
    const expiresAt = Number(tokenState.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= now + marginMs;
}

async function readFreshOAuthDocument(model, doc, tokenField) {
    if (!model || typeof model.findById !== 'function') {
        const error = new Error('OAuth model cannot re-read refresh state');
        error.code = 'OAUTH_REFRESH_FRESH_READ_UNAVAILABLE';
        throw error;
    }
    let query = model.findById(doc._id);
    if (query && typeof query.select === 'function') {
        query = query.select({ discord: 1, [tokenField]: 1 });
    }
    if (query && typeof query.lean === 'function') query = query.lean();
    return await query;
}

function conflictOutcome(tokenField, userId, reason = 'state_changed') {
    return {
        ok: true,
        skipped: true,
        reason,
        tokenField,
        userId
    };
}

async function markRefreshFailure(doc, err, { model, now, failMax, tokenField = 'oauth' }) {
    const tokenState = doc[tokenField] || {};
    const userId = doc.discord?.userId || String(doc._id || doc.id || 'unknown');
    const previousRefreshToken = tokenState.encryptedRefreshToken;
    const previousVersion = Number(tokenState.version || 0);
    const nextFailCount = Number(tokenState.refreshFailCount || 0) + 1;
    const set = {
        [tokenPath(tokenField, 'refreshFailCount')]: nextFailCount,
        [tokenPath(tokenField, 'lastRefreshError')]: safeError(err),
        updatedAt: now
    };
    if (nextFailCount >= failMax) set[tokenPath(tokenField, 'revokedAt')] = now;

    try {
        const result = await model.updateOne(
            {
                _id: doc._id,
                [tokenPath(tokenField, 'encryptedRefreshToken')]: previousRefreshToken,
                ...versionCondition(tokenField, previousVersion)
            },
            { $set: set }
        );
        const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
        if (modified !== 1) return conflictOutcome(tokenField, userId, 'failure_state_changed');
        return {
            ok: false,
            failed: true,
            tokenField,
            userId,
            revoked: nextFailCount >= failMax,
            error: safeError(err),
            persisted: true,
            persistenceError: null
        };
    } catch (writeErr) {
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

async function refreshOneOAuthUser(doc, {
    model,
    discordApi,
    redirectUri,
    now,
    marginMs,
    failMax,
    prepareTokenStorage,
    tokenField = 'oauth'
}) {
    const lockUserId = doc.discord?.userId || String(doc._id);
    return withRefreshLock(`${lockUserId}:${tokenField}`, async () => {
        const fresh = await readFreshOAuthDocument(model, doc, tokenField);
        if (!fresh) return conflictOutcome(tokenField, lockUserId, 'document_missing');

        const userId = fresh.discord?.userId || lockUserId;
        const tokenState = fresh[tokenField] || {};
        if (!refreshStateIsDue(tokenState, { now, marginMs, failMax })) {
            return conflictOutcome(tokenField, userId, 'not_due');
        }

        const previousRefreshToken = tokenState.encryptedRefreshToken;
        const previousVersion = Number(tokenState.version || 0);
        let tokenData;
        try {
            tokenData = await discordApi.refreshToken(previousRefreshToken, redirectUri);
        } catch (error) {
            return markRefreshFailure(fresh, error, { model, now, failMax, tokenField });
        }

        const oauth = {
            ...buildStoredOAuthUpdate(tokenData, now, prepareTokenStorage),
            version: previousVersion + 1
        };
        const result = await model.updateOne(
            {
                _id: fresh._id,
                [tokenPath(tokenField, 'encryptedRefreshToken')]: previousRefreshToken,
                ...versionCondition(tokenField, previousVersion)
            },
            {
                $set: {
                    [tokenField]: oauth,
                    updatedAt: now
                }
            }
        );
        const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
        if (modified !== 1) return conflictOutcome(tokenField, userId, 'refresh_state_changed');
        return { ok: true, refreshed: true, tokenField, userId, version: oauth.version };
    });
}

async function refreshTokenField({ model, tokenField, redirectUri, now, config, discordApi, prepareTokenStorage }) {
    const query = buildRefreshQuery(now, config.marginMs, config.failMax, tokenField);
    const docs = await model.find(query)
        .sort({ [tokenPath(tokenField, 'expiresAt')]: 1, updatedAt: 1 })
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
        try {
            const outcome = await refreshOneOAuthUser(doc, {
                model,
                discordApi,
                redirectUri,
                now,
                marginMs: config.marginMs,
                failMax: config.failMax,
                prepareTokenStorage,
                tokenField
            });
            if (outcome?.refreshed) {
                summary.refreshed++;
                continue;
            }
            if (outcome?.skipped) {
                summary.skipped++;
                if (String(outcome.reason || '').includes('changed')) summary.conflicts++;
                continue;
            }
            if (outcome?.failed) {
                summary.failed++;
                if (outcome.revoked) summary.revoked++;
                if (outcome.persisted === false) summary.persistenceFailed++;
                if (summary.errors.length < 10) summary.errors.push(outcome);
            }
        } catch (err) {
            summary.failed++;
            summary.persistenceFailed++;
            if (summary.errors.length < 10) {
                summary.errors.push({
                    ok: false,
                    tokenField,
                    userId: doc.discord?.userId || doc.id,
                    error: safeError(err),
                    persisted: false
                });
            }
        }
    }

    return summary;
}

async function refreshPersistedOAuthTokens(options = {}) {
    const env = options.env || process.env;
    const config = {
        ...getOAuthRefreshConfig(env),
        ...options
    };

    if (!config.enabled) {
        return { skipped: true, reason: 'oauth_token_storage_disabled', refreshed: 0, failed: 0, revoked: 0 };
    }

    const now = Number(config.now || Date.now());
    const model = config.OAuthUserModel || OAuthUser;
    const discordApi = config.discordApi || discord;
    const prepareTokenStorage = config.prepareTokenStorage || discord.prepareTokenStorage;
    const tokenFields = config.tokenFields || [
        { tokenField: 'oauth', redirectUri: config.verificationRedirectUri || config.redirectUri },
        { tokenField: 'adminOAuth', redirectUri: config.adminRedirectUri }
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
        const tokenField = fieldConfig.tokenField || fieldConfig.field || 'oauth';
        const fieldSummary = await refreshTokenField({
            model,
            tokenField,
            redirectUri: fieldConfig.redirectUri || config.redirectUri,
            now,
            config,
            discordApi,
            prepareTokenStorage
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

    return summary;
}

module.exports = {
    DEFAULT_REFRESH_MARGIN_MS,
    DEFAULT_REFRESH_SCAN_LIMIT,
    DEFAULT_REFRESH_FAIL_MAX,
    shouldStoreOAuthTokens,
    getPublicBaseUrl,
    getVerificationRedirectUri,
    getAdminRedirectUri,
    getOAuthRefreshConfig,
    tokenPath,
    buildRefreshQuery,
    buildStoredOAuthUpdate,
    refreshPersistedOAuthTokens,
    _test: {
        readPositiveNumber,
        refreshOneOAuthUser,
        markRefreshFailure,
        refreshTokenField,
        withRefreshLock,
        refreshLocks,
        readFreshOAuthDocument,
        refreshStateIsDue,
        versionCondition
    }
};