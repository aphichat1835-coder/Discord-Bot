const DEFAULT_AUDIT_SETTINGS = Object.freeze({
    messageCreateEnabled: false,
    reconcilerEnabled: false,
    reconcilerIntervalMs: 5 * 60 * 1000,
    reconcilerLimit: 10,
    retentionDays: 90,
    categories: {
        message: true,
        member: true,
        voice: true,
        server: true,
        security: true,
        moderation: true
    }
});

function settingKey(guildId) {
    return `audit_settings_${guildId}`;
}

function normalizeBool(value, fallback = false) {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
}

function normalizeAuditSettings(input = {}) {
    const mergedCategories = { ...DEFAULT_AUDIT_SETTINGS.categories, ...input.categories };
    const retentionDays = input.retentionDays === 0 || input.retentionDays === "forever"
        ? 0
        : Math.max(1, Number(input.retentionDays || DEFAULT_AUDIT_SETTINGS.retentionDays) || DEFAULT_AUDIT_SETTINGS.retentionDays);

    return {
        messageCreateEnabled: normalizeBool(input.messageCreateEnabled, DEFAULT_AUDIT_SETTINGS.messageCreateEnabled),
        reconcilerEnabled: normalizeBool(input.reconcilerEnabled, DEFAULT_AUDIT_SETTINGS.reconcilerEnabled),
        reconcilerIntervalMs: Math.max(60_000, Number(input.reconcilerIntervalMs || DEFAULT_AUDIT_SETTINGS.reconcilerIntervalMs) || DEFAULT_AUDIT_SETTINGS.reconcilerIntervalMs),
        reconcilerLimit: Math.max(1, Math.min(50, Number(input.reconcilerLimit || DEFAULT_AUDIT_SETTINGS.reconcilerLimit) || DEFAULT_AUDIT_SETTINGS.reconcilerLimit)),
        retentionDays,
        categories: Object.fromEntries(
            Object.entries(mergedCategories).map(([key, value]) => [key, normalizeBool(value, true)])
        )
    };
}

async function getAuditSettings(sessionManager, guildId) {
    const saved = await sessionManager?.getSetting?.(settingKey(guildId), {}).catch(() => ({}));
    return normalizeAuditSettings(saved || {});
}

async function saveAuditSettings(sessionManager, guildId, patch = {}) {
    const current = await getAuditSettings(sessionManager, guildId);
    const next = normalizeAuditSettings({ ...current, ...patch, categories: { ...current.categories, ...patch.categories } });
    await sessionManager?.setSetting?.(settingKey(guildId), next).catch(() => {});
    return next;
}

function categoryEnabled(settings, category) {
    const normalized = normalizeAuditSettings(settings || {});
    return normalized.categories[String(category)] !== false;
}

module.exports = {
    DEFAULT_AUDIT_SETTINGS,
    settingKey,
    normalizeBool,
    normalizeAuditSettings,
    getAuditSettings,
    saveAuditSettings,
    categoryEnabled
};
