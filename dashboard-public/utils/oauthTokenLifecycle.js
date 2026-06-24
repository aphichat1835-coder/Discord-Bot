const OAuthUser = require('../models/OAuthUser');
const discord = require('./discordAPI');
const { safeError } = require('./safeLogger');

const DEFAULT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_SCAN_LIMIT = 100;
const DEFAULT_REFRESH_FAIL_MAX = 5;

function readBooleanDefaultTrue(value) {
    if (value === undefined || value === null || value === '') return true;
    return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function shouldStoreOAuthTokens(env = process.env) {
    return readBooleanDefaultTrue(env.STORE_OAUTH_TOKENS);
}

function getPublicBaseUrl(env = process.env) {
    return (
        env.PUBLIC_DASHBOARD_URL ||
        env.DASHBOARD_URL ||
        env.PUBLIC_BASE_URL ||
        env.DASHBOARD_PUBLIC_URL ||
        'http://localhost:3001'
    ).replace(/\/$/, '');
}

function getVerificationRedirectUri(env = process.env) {
    return `${getPublicBaseUrl(env)}/auth/callback`;
}

function getAdminRedirectUri(env = process.env) {
    return `${getPublicBaseUrl(env)}/auth/admin-callback`;
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

function tokenPath(tokenField, key) {
    return `${tokenField}.${key}`;
}

function buildRefreshQuery(now, marginMs, failMax, tokenField = 'oauth') {
    return {
        [tokenPath(tokenField, 'encryptedRefreshToken')]: { $exists: true, $ne: '' },
        [tokenPath(tokenField, 'revokedAt')]: { $in: [null] },
        [tokenPath(tokenField, 'expiresAt')]: { $lte: now + marginMs },
        $or: [
            { [tokenPath(tokenField, 'refreshFailCount')]: { $exists: false } },
            { [tokenPath(tokenField, 'refreshFailCount')]: { $lt: failMax } }
        ]
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

async function refreshOneOAuthUser(doc, { discordApi, redirectUri, now, prepareTokenStorage, tokenField = 'oauth' }) {
    const tokenState = doc[tokenField] || {};
    const tokenData = await discordApi.refreshToken(tokenState.encryptedRefreshToken, redirectUri);
    const oauth = buildStoredOAuthUpdate(tokenData, now, prepareTokenStorage);
    await doc.updateOne({
        $set: {
            [tokenField]: oauth,
            updatedAt: now
        }
    });
    return { ok: true, tokenField, userId: doc.discord?.userId || doc.id };
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

    await doc.updateOne({ $set: set }).catch(() => {});
    return {
        ok: false,
        tokenField,
        userId: doc.discord?.userId || doc.id,
        revoked: nextFailCount >= failMax,
        error: safeError(err)
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
        errors: []
    };

    for (const doc of docs) {
        try {
            await refreshOneOAuthUser(doc, {
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
        refreshTokenField
    }
};
