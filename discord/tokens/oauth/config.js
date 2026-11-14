"use strict";

const { resolvePublicBaseUrl } = require("../../core/publicUrl");

const DEFAULT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_SCAN_LIMIT = 100;
const DEFAULT_REFRESH_FAIL_MAX = 5;
const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_ON_DEMAND_MARGIN_MS = 5 * 60 * 1000;

const REQUIRED_USER_SCOPES = Object.freeze([
    "identify", "email", "connections", "guilds", "guilds.members.read", "guilds.join"
]);
const TOKEN_FIELDS = Object.freeze(["oauth"]);

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

function getOAuthRefreshConfig(env = process.env) {
    return {
        enabled: true,
        marginMs: readPositiveNumber(env.OAUTH_TOKEN_REFRESH_MARGIN_MS, DEFAULT_REFRESH_MARGIN_MS, 60 * 1000),
        scanLimit: Math.max(1, Math.min(1000, readPositiveNumber(env.OAUTH_TOKEN_REFRESH_SCAN_LIMIT, DEFAULT_REFRESH_SCAN_LIMIT, 1))),
        failMax: Math.max(1, Math.min(50, readPositiveNumber(env.OAUTH_TOKEN_REFRESH_FAIL_MAX, DEFAULT_REFRESH_FAIL_MAX, 1))),
        intervalMs: readPositiveNumber(env.OAUTH_TOKEN_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_INTERVAL_MS, 60 * 1000),
        redirectUri: getVerificationRedirectUri(env),
        verificationRedirectUri: getVerificationRedirectUri(env)
    };
}

function resolveFailMax(failMax, env = process.env) {
    if (failMax !== undefined && failMax !== null) {
        return Math.max(1, Math.min(50, readPositiveNumber(failMax, DEFAULT_REFRESH_FAIL_MAX, 1)));
    }
    return getOAuthRefreshConfig(env).failMax;
}

function resolveRedirectUriForField(tokenField, env = process.env) {
    return getVerificationRedirectUri(env);
}

module.exports = {
    DEFAULT_REFRESH_MARGIN_MS,
    DEFAULT_REFRESH_SCAN_LIMIT,
    DEFAULT_REFRESH_FAIL_MAX,
    DEFAULT_REFRESH_INTERVAL_MS,
    DEFAULT_ON_DEMAND_MARGIN_MS,
    REQUIRED_USER_SCOPES,
    TOKEN_FIELDS,
    readPositiveNumber,
    getPublicBaseUrl,
    getVerificationRedirectUri,
    getOAuthRefreshConfig,
    resolveFailMax,
    resolveRedirectUriForField
};
