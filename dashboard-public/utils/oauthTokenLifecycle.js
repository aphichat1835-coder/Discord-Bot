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
        redirectUri: getVerificationRedirectUri(env)
    };
}

function buildRefreshQuery(now, marginMs, failMax) {
    return {
        'oauth.encryptedRefreshToken': { $exists: true, $ne: '' },
        'oauth.revokedAt': { $in: [null] },
        'oauth.expiresAt': { $lte: now + marginMs },
        $or: [
            { 'oauth.refreshFailCount': { $exists: false } },
            { 'oauth.refreshFailCount': { $lt: failMax } }
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

async function refreshOneOAuthUser(doc, { discordApi, redirectUri, now, prepareTokenStorage }) {
    const tokenData = await discordApi.refreshToken(doc.oauth.encryptedRefreshToken, redirectUri);
    const oauth = buildStoredOAuthUpdate(tokenData, now, prepareTokenStorage);
    await doc.updateOne({
        $set: {
            oauth,
            updatedAt: now
        }
    });
    return { ok: true, userId: doc.discord?.userId || doc.id };
}

async function markRefreshFailure(doc, err, { now, failMax }) {
    const nextFailCount = Number(doc.oauth?.refreshFailCount || 0) + 1;
    const set = {
        'oauth.refreshFailCount': nextFailCount,
        'oauth.lastRefreshError': safeError(err),
        updatedAt: now
    };
    if (nextFailCount >= failMax) set['oauth.revokedAt'] = now;

    await doc.updateOne({ $set: set }).catch(() => {});
    return {
        ok: false,
        userId: doc.discord?.userId || doc.id,
        revoked: nextFailCount >= failMax,
        error: safeError(err)
    };
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
    const query = buildRefreshQuery(now, config.marginMs, config.failMax);
    const docs = await model.find(query)
        .sort({ 'oauth.expiresAt': 1, updatedAt: 1 })
        .limit(config.scanLimit);

    const summary = {
        skipped: false,
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
                redirectUri: config.redirectUri,
                now,
                prepareTokenStorage
            });
            summary.refreshed++;
        } catch (err) {
            const failure = await markRefreshFailure(doc, err, { now, failMax: config.failMax });
            summary.failed++;
            if (failure.revoked) summary.revoked++;
            if (summary.errors.length < 10) summary.errors.push(failure);
        }
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
    getOAuthRefreshConfig,
    buildRefreshQuery,
    buildStoredOAuthUpdate,
    refreshPersistedOAuthTokens,
    _test: {
        readBooleanDefaultTrue,
        readPositiveNumber,
        refreshOneOAuthUser,
        markRefreshFailure
    }
};
