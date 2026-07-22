const DEFAULT_FLAGS = {
    voice: true,
    verification: true,
    protection: true,
    backup: true,
    roleButton: true,
    sensitiveAccess: true,
    memoryMonitor: true
};

function envNameFor(flag) {
    return `FEATURE_${String(flag || "").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

function isFeatureEnabled(flag, fallback = true) {
    const key = envNameFor(flag);
    const raw = process.env[key];
    if (raw === undefined || raw === null || raw === "") {
        return Boolean(Object.hasOwn(DEFAULT_FLAGS, flag) ? DEFAULT_FLAGS[flag] : fallback);
    }

    return !["0", "false", "no", "off", "disabled"].includes(String(raw).trim().toLowerCase());
}

function getFeatureFlags() {
    return Object.fromEntries(
        Object.keys(DEFAULT_FLAGS).map(flag => [flag, isFeatureEnabled(flag)])
    );
}

module.exports = {
    DEFAULT_FLAGS,
    envNameFor,
    isFeatureEnabled,
    getFeatureFlags
};
