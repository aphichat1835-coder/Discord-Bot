const { normalizeDiscordSnowflake } = require("./snowflakes");

function normalizedEnvValue(env, key) {
    const value = env[key];
    if (value == null) return "";
    const trimmed = String(value).trim();
    env[key] = trimmed;
    return trimmed;
}

const WEAK_SECRET_VALUES = new Set([
    "1234",
    "0000",
    "admin",
    "password",
    "changeme",
    "secret",
    "enterprise-secret-key"
]);

const OWNER_MAINTAINED_PRODUCTION_ENV = Object.freeze([
    "NODE_ENV",
    "MONGO_URI",
    "TOKEN_MANAGER",
    "OWNER_ID",
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "ENCRYPTION_KEY",
    "API_SECRET",
    "VERIFY_STATE_SECRET",
    "DASHBOARD_PIN",
    "SHADOW_SESSION_SECRET",
    "SHADOW_PORTAL_PIN",
    "PUBLIC_BASE_URL",
    "WEBHOOK_LOG_URL",
    "ALERT_WEBHOOK_URL",
    "TRUST_PROXY"
]);

function isProduction(env = process.env) {
    return String(env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function assertStrongSecret(name, value, { minLength = 32, allowMissing = false } = {}) {
    const normalized = String(value || "").trim();
    if (!normalized) {
        if (allowMissing) return;
        console.error(`[FATAL] ❌ Missing ${name}`);
        process.exit(1);
    }
    if (normalized.length < minLength || WEAK_SECRET_VALUES.has(normalized.toLowerCase())) {
        console.error(`[FATAL] ❌ ${name} is too weak for production.`);
        process.exit(1);
    }
}

function assertRequiredProductionValue(name, value) {
    if (!String(value || "").trim()) {
        console.error(`[FATAL] ❌ Missing ${name} in production.`);
        process.exit(1);
    }
}

function assertHttpsUrl(name, value) {
    const normalized = String(value || "").trim();
    try {
        const url = new URL(normalized);
        if (url.protocol !== "https:" || !url.hostname) throw new Error("invalid https url");
    } catch {
        console.error(`[FATAL] ❌ ${name} must be a valid https:// URL in production.`);
        process.exit(1);
    }
}

function parseOwnerIds(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];

    const parts = raw.split(",").map(ownerId => ownerId.trim());
    if (parts.some(ownerId => !ownerId)) return null;
    const ownerIds = parts.map(normalizeDiscordSnowflake);
    if (ownerIds.some(ownerId => !ownerId)) return null;
    return [...new Set(ownerIds)];
}

function getConfiguredOwnerIds(config = {}) {
    const configured = Array.isArray(config?.system?.ownerIds)
        ? config.system.ownerIds
        : [config?.system?.ownerId];
    return [...new Set(configured
        .map(ownerId => String(ownerId || "").trim())
        .filter(Boolean))];
}

function isConfiguredOwner(config, userId) {
    const actorId = String(userId || "").trim();
    return Boolean(actorId && getConfiguredOwnerIds(config).includes(actorId));
}

function resolveOwnerIds(env, config) {
    const configuredOwnerIds = normalizedEnvValue(env, "OWNER_ID");
    if (!configuredOwnerIds) {
        if (isProduction(env)) {
            console.error("[FATAL] ❌ Missing OWNER_ID in production.");
            process.exit(1);
        }
        return getConfiguredOwnerIds(config);
    }

    const ownerIds = parseOwnerIds(configuredOwnerIds);
    if (!ownerIds?.length) {
        console.error("[FATAL] ❌ OWNER_ID must be one or more comma-separated Discord User IDs with 17 to 22 digits.");
        process.exit(1);
    }

    if (config?.system) {
        config.system.ownerIds = ownerIds;
        config.system.ownerId = ownerIds[0];
    }
    return ownerIds;
}

function resolveOwnerId(env, config) {
    return resolveOwnerIds(env, config)[0] || "";
}

function validateRequiredEnv(env = process.env, config = {}) {
    const { assertConsistentPublicOrigins, resolvePublicBaseUrl } = require("./publicUrl");
    const mongoUri = normalizedEnvValue(env, "MONGO_URI");
    const tokenManager = normalizedEnvValue(env, "TOKEN_MANAGER");
    const ownerIds = resolveOwnerIds(env, config);
    const ownerId = ownerIds[0] || "";
    const apiSecret = normalizedEnvValue(env, "API_SECRET");
    const encryptionKey = normalizedEnvValue(env, "ENCRYPTION_KEY");
    const dashboardPin = normalizedEnvValue(env, "DASHBOARD_PIN");
    const discordClientId = normalizedEnvValue(env, "DISCORD_CLIENT_ID");
    const verifyStateSecret = normalizedEnvValue(env, "VERIFY_STATE_SECRET");
    const discordClientSecret = normalizedEnvValue(env, "DISCORD_CLIENT_SECRET");
    const webhookLogUrl = normalizedEnvValue(env, "WEBHOOK_LOG_URL");
    const alertWebhookUrl = normalizedEnvValue(env, "ALERT_WEBHOOK_URL");
    const trustProxy = normalizedEnvValue(env, "TRUST_PROXY");
    const runtimePublicUrl = resolvePublicBaseUrl(env);
    const shadowMasterId = normalizedEnvValue(env, "SHADOW_MASTER_ID");
    const shadowSessionSecret = normalizedEnvValue(env, "SHADOW_SESSION_SECRET");

    if (!mongoUri) {
        console.error("[FATAL] ❌ Missing MONGO_URI");
        process.exit(1);
    }

    if (!tokenManager) {
        console.error("[FATAL] ❌ Missing TOKEN_MANAGER");
        process.exit(1);
    }

    if (!apiSecret || apiSecret === "enterprise-secret-key") {
        console.error("[FATAL] ❌ API_SECRET missing or using default value.");
        process.exit(1);
    }

    if (!encryptionKey) {
        console.error("[FATAL] ❌ Missing ENCRYPTION_KEY");
        process.exit(1);
    }

    if (isProduction(env)) {
        try {
            assertConsistentPublicOrigins(env);
        } catch (err) {
            console.error(`[FATAL] ❌ ${err.message}`);
            process.exit(1);
        }
        assertRequiredProductionValue("DISCORD_CLIENT_ID", discordClientId);
        assertHttpsUrl("PUBLIC_BASE_URL/DASHBOARD_URL", runtimePublicUrl);
        assertStrongSecret("API_SECRET", apiSecret, { minLength: 32 });
        assertStrongSecret("VERIFY_STATE_SECRET", verifyStateSecret, { minLength: 32 });
        assertStrongSecret("ENCRYPTION_KEY", encryptionKey, { minLength: 32 });
        assertStrongSecret("DISCORD_CLIENT_SECRET", discordClientSecret, { minLength: 16 });
        if (shadowSessionSecret) assertStrongSecret("SHADOW_SESSION_SECRET", shadowSessionSecret, { minLength: 32 });
        // The Owner explicitly controls the dashboard credential policy. Keep
        // production fail-closed when it is missing, but do not impose a
        // length or composition rule that could lock the Owner out.
        assertRequiredProductionValue("DASHBOARD_PIN", dashboardPin);
        assertRequiredProductionValue("WEBHOOK_LOG_URL", webhookLogUrl);
        assertRequiredProductionValue("ALERT_WEBHOOK_URL", alertWebhookUrl);
        assertHttpsUrl("WEBHOOK_LOG_URL", webhookLogUrl);
        assertHttpsUrl("ALERT_WEBHOOK_URL", alertWebhookUrl);
        if (trustProxy.toLowerCase() !== "true") {
            console.error("[FATAL] ❌ TRUST_PROXY=true is required for the managed production host.");
            process.exit(1);
        }
    }

    return {
        MONGO_URI: mongoUri,
        TOKEN_MANAGER: tokenManager,
        OWNER_ID: ownerId,
        OWNER_IDS: ownerIds,
        API_SECRET: apiSecret,
        ENCRYPTION_KEY: encryptionKey,
        DISCORD_CLIENT_ID_CONFIGURED: !!discordClientId,
        PUBLIC_BASE_URL_CONFIGURED: !!runtimePublicUrl,
        SHADOW_MASTER_ID: shadowMasterId || ownerId,
        DASHBOARD_PIN_CONFIGURED: !!dashboardPin
    };
}

module.exports = {
    OWNER_MAINTAINED_PRODUCTION_ENV,
    normalizedEnvValue,
    assertStrongSecret,
    assertRequiredProductionValue,
    assertHttpsUrl,
    parseOwnerIds,
    getConfiguredOwnerIds,
    isConfiguredOwner,
    resolveOwnerIds,
    resolveOwnerId,
    validateRequiredEnv
};
