"use strict";

const PUBLIC_URL_KEYS = Object.freeze([
    "PUBLIC_BASE_URL",
    "PUBLIC_DASHBOARD_URL",
    "DASHBOARD_URL",
    "DASHBOARD_PUBLIC_URL"
]);

function trimTrailingSlashes(value) {
    return String(value || "").trim().replace(/\/+$/, "");
}

function configuredPublicUrls(env = process.env) {
    return PUBLIC_URL_KEYS
        .map(key => ({ key, value: trimTrailingSlashes(env[key]) }))
        .filter(entry => entry.value);
}

function resolvePublicBaseUrl(env = process.env, fallback = "") {
    return configuredPublicUrls(env)[0]?.value || trimTrailingSlashes(fallback);
}

function assertConsistentPublicOrigins(env = process.env) {
    const configured = configuredPublicUrls(env);
    if (configured.length < 2) return resolvePublicBaseUrl(env);
    const urls = new Set(configured.map(entry => entry.value));
    if (urls.size <= 1) return resolvePublicBaseUrl(env);
    const error = new Error("Public dashboard URL aliases must use the same base URL");
    error.code = "public_url_alias_mismatch";
    throw error;
}

module.exports = {
    PUBLIC_URL_KEYS,
    trimTrailingSlashes,
    configuredPublicUrls,
    resolvePublicBaseUrl,
    assertConsistentPublicOrigins
};
