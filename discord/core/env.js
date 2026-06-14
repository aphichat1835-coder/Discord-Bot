function normalizedEnvValue(env, key) {
    const value = env[key];
    if (value == null) return "";
    const trimmed = String(value).trim();
    env[key] = trimmed;
    return trimmed;
}

function validateRequiredEnv(env = process.env, config = {}) {
    const mongoUri = normalizedEnvValue(env, "MONGO_URI");
    const tokenManager = normalizedEnvValue(env, "TOKEN_MANAGER");
    const apiSecret = normalizedEnvValue(env, "API_SECRET");
    const encryptionKey = normalizedEnvValue(env, "ENCRYPTION_KEY");
    const dashboardPin = normalizedEnvValue(env, "DASHBOARD_PIN");
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

    if (env.NODE_ENV === "production" && !dashboardPin) {
        console.error("[FATAL] ❌ Missing DASHBOARD_PIN in production.");
        process.exit(1);
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
    validateRequiredEnv
};
