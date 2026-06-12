function validateRequiredEnv(env = process.env, config = {}) {
    if (!env.MONGO_URI) {
        console.error("[FATAL] ❌ Missing MONGO_URI");
        process.exit(1);
    }

    if (!env.TOKEN_MANAGER) {
        console.error("[FATAL] ❌ Missing TOKEN_MANAGER");
        process.exit(1);
    }

    if (!env.API_SECRET || env.API_SECRET === "enterprise-secret-key") {
        console.error("[FATAL] ❌ API_SECRET missing or using default value.");
        process.exit(1);
    }

    if (!env.ENCRYPTION_KEY) {
        console.error("[FATAL] ❌ Missing ENCRYPTION_KEY");
        process.exit(1);
    }

    return {
        API_SECRET: env.API_SECRET,
        SHADOW_MASTER_ID: env.SHADOW_MASTER_ID || config.system?.ownerId,
        DASHBOARD_PIN_CONFIGURED: !!env.DASHBOARD_PIN
    };
}

module.exports = {
    validateRequiredEnv
};
