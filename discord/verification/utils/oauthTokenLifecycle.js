const OAuthUser = require('../models/OAuthUser');
const discord = require('./discordAPI');
const { safeError } = require('./safeLogger');
const { resolvePublicBaseUrl } = require('../../core/publicUrl');

const DEFAULT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_SCAN_LIMIT = 100;
const DEFAULT_REFRESH_FAIL_MAX = 5;
const refreshLocks = new Map();

function readBooleanDefaultTrue(value) {
    if (value === undefined || value === null || value === '') return true;
    return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function shouldStoreOAuthTokens(env = process.env, guildConfig = null) {
    const globalEnabled = readBooleanDefaultTrue(env.STORE_OAUTH_TOKENS);
    const guildSetting = guildConfig?.security?.storeOAuthTokens;
    if (guildSetting === false) return false;
    return globalEnabled && guildSetting !== false;
}

function getPublicBaseUrl(env = process.env) {
    return resolvePublicBaseUrl(env, 'http://localhost:3000');
}

function getVerificationRedirectUri(env = process.env) {
    return `${getPublicBaseUrl(env)}/auth/callback`;
}

function getAdminRedirectUri(env = process.env) {
    // No route creates new admin grants. This override preserves refresh
    // compatibility for historical tokens issued by the retired service.
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
        enabled: shouldStoreOAuthTokens(env),
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
        revokedAt: null
    };
}

async function refreshOneOAuthUser(doc, { model, discordApi, redirectUri, now, prepareTokenStorage, tokenField = 'oauth' }) {
    const userId = doc.discord?.userId || String(doc._id);
    return withRefreshLock(`${userId}:${tokenField}`, async () => {
        const tokenState = doc[tokenField] || {};
        const previousRefreshToken = tokenState.encryptedRefreshToken;
        const previousVersion = Number(tokenState.version || 0);
        const tokenData = await discordApi.refreshToken(previousRefreshToken, redirectUri);
        const oauth = {
            ...buildStoredOAuthUpdate(tokenData, now, prepareTokenStorage),
            version: previousVersion + 1
        };
        const versionCondition = previousVersion > 0
            ? { [tokenPath(tokenField, 'version')]: previousVersion }
            : {
                $or: [
                    { [tokenPath(tokenField, 'version')]: 0 },
                    { [tokenPath(tokenField, 'version')]: { $exists: false } }
                ]
            };
        const result = await model.updateOne(
            {
                _id: doc._id,
                [tokenPath(tokenField, 'encryptedRefreshToken')]: previousRefreshToken,
                ...versionCondition
            },
            {
                $set: {
                    [tokenField]: oauth,
                    updatedAt: now
                }
            }
        );
        const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
        if (modified !== 1) {
            const conflict = new Error('OAuth refresh state changed before persistence');
            conflict.code = 'TOKEN_REFRESH_CONFLICT';
            throw conflict;
        }
        return { ok: true, tokenField, userId, version: oauth.version };
    });
}

async function markRefreshFailure(doc, err, { now, failMax, tokenField = 'oauth' }) {
    const tokenState = doc[tokenField] || {};
    const nextFailCount = Number(tokenState.refreshFailCount || 0) + 1;
    const set = {
        [tokenPath(tokenField, 'refreshFailCount')]: nextFailCount,
        [tokenPath(tokenField, 'lastRefreshError')]: safeError(err),
        updatedAt: now
    };
    if (nextFailCount >= failMax) set[tokenPath(tokenField, 'revokedAt')] = now;

    let persistenceError = null;
    try {
        await doc.updateOne({ $set: set });
    } catch (writeErr) {
        persistenceError = safeError(writeErr);
    }

    return {
        ok: false,
        tokenField,
        userId: doc.discord?.userId || doc.id,
        revoked: nextFailCount >= failMax,
        error: safeError(err),
        persisted: !persistenceError,
        persistenceError
    };
}

async function refreshTokenField({ model, tokenField, redirectUri, now, config, discordApi, prepareTokenStorage }) {
    const query = buildRefreshQuery(now, config.marginMs, config.failMax, tokenField);
    const docs = await model.find(query)
        .sort({ [tokenPath(tokenField, 'expiresAt')]: 1, updatedAt: 1 })
        .limit(config.scanLimit);

    const summary = {
        scanned: docs.length,
        refreshed: 0,
        failed: 0,
        revoked: 0,
        persistenceFailed: 0,
        errors: []
    };

    for (const doc of docs) {
        try {
            await refreshOneOAuthUser(doc, {
                model,
                discordApi,
                redirectUri,
                now,
                prepareTokenStorage,
                tokenField
            });
            summary.refreshed++;
        } catch (err) {
            const failure = await markRefreshFailure(doc, err, {
                now,
                failMax: config.failMax,
                tokenField
            });
            summary.failed++;
            if (failure.revoked) summary.revoked++;
            if (failure.persisted === false) summary.persistenceFailed++;
            if (summary.errors.length < 10) summary.errors.push(failure);
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
        readBooleanDefaultTrue,
        readPositiveNumber,
        refreshOneOAuthUser,
        markRefreshFailure,
        refreshTokenField,
        withRefreshLock,
        refreshLocks
    }
};
