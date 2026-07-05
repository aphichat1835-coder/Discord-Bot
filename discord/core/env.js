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

function validateRequiredEnv(env = process.env, config = {}) {
    const mongoUri = normalizedEnvValue(env, "MONGO_URI");
    const tokenManager = normalizedEnvValue(env, "TOKEN_MANAGER");
    const apiSecret = normalizedEnvValue(env, "API_SECRET");
    const encryptionKey = normalizedEnvValue(env, "ENCRYPTION_KEY");
    const dashboardPin = normalizedEnvValue(env, "DASHBOARD_PIN");
    const verifyStateSecret = normalizedEnvValue(env, "VERIFY_STATE_SECRET");
    const discordClientSecret = normalizedEnvValue(env, "DISCORD_CLIENT_SECRET");
    const shadowMasterId = normalizedEnvValue(env, "SHADOW_MASTER_ID");

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

    if (isProduction(env) && !dashboardPin) {
        console.error("[FATAL] ❌ Missing DASHBOARD_PIN in production.");
        process.exit(1);
    }

    if (isProduction(env)) {
        assertStrongSecret("API_SECRET", apiSecret, { minLength: 32 });
        assertStrongSecret("VERIFY_STATE_SECRET", verifyStateSecret, { minLength: 32 });
        assertStrongSecret("ENCRYPTION_KEY", encryptionKey, { minLength: 32 });
        assertStrongSecret("DISCORD_CLIENT_SECRET", discordClientSecret, { minLength: 16 });
        assertStrongSecret("DASHBOARD_PIN", dashboardPin, { minLength: 6 });
    }

    return {
        MONGO_URI: mongoUri,
        TOKEN_MANAGER: tokenManager,
        API_SECRET: apiSecret,
        ENCRYPTION_KEY: encryptionKey,
        SHADOW_MASTER_ID: shadowMasterId || config.system?.ownerId,
        DASHBOARD_PIN_CONFIGURED: !!dashboardPin
    };
}

module.exports = {
    normalizedEnvValue,
    assertStrongSecret,
    validateRequiredEnv
};
