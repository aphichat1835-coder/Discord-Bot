"use strict";

const PUBLIC_URL_KEYS = Object.freeze([
    "PUBLIC_BASE_URL",
    "PUBLIC_DASHBOARD_URL",
    "DASHBOARD_URL",
    "DASHBOARD_PUBLIC_URL"
]);

function trimTrailingSlashes(value) {
    let result = String(value || "").trim();
    while (result.endsWith("/")) result = result.slice(0, -1);
    return result;
}

function configuredPublicUrls(env = process.env) {
    return [
        { key: "PUBLIC_BASE_URL", value: trimTrailingSlashes(env.PUBLIC_BASE_URL) },
        { key: "PUBLIC_DASHBOARD_URL", value: trimTrailingSlashes(env.PUBLIC_DASHBOARD_URL) },
        { key: "DASHBOARD_URL", value: trimTrailingSlashes(env.DASHBOARD_URL) },
        { key: "DASHBOARD_PUBLIC_URL", value: trimTrailingSlashes(env.DASHBOARD_PUBLIC_URL) }
    ]
        .filter(entry => entry.value);
}

function resolvePublicBaseUrl(env = process.env, fallback = "") {
    return configuredPublicUrls(env)[0]?.value || trimTrailingSlashes(fallback);
}

function requirePublicBaseUrl(env = process.env, options = {}) {
    const configured = resolvePublicBaseUrl(env);
    if (configured) return configured;

    const production = String(env.NODE_ENV || "").toLowerCase() === "production";
    if (!production && options.allowDevelopmentFallback !== false) {
        return trimTrailingSlashes(options.developmentFallback || "http://localhost:3000");
    }

    const error = new Error("PUBLIC_BASE_URL is required");
    error.code = "public_base_url_required";
    throw error;
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
    requirePublicBaseUrl,
    assertConsistentPublicOrigins
};
