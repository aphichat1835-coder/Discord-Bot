const { LOG_CHANNEL_TYPES } = require("./logCore");

const DEFAULT_CHANNEL_NAMES = Object.freeze({
    [LOG_CHANNEL_TYPES.MESSAGE]: "log-ข้อความ",
    [LOG_CHANNEL_TYPES.MEMBER]: "log-สมาชิก",
    [LOG_CHANNEL_TYPES.VOICE]: "log-เสียง",
    [LOG_CHANNEL_TYPES.SERVER]: "log-เซิร์ฟเวอร์",
    [LOG_CHANNEL_TYPES.SECURITY]: "log-ความปลอดภัย",
    [LOG_CHANNEL_TYPES.MODERATION]: "log-การลงโทษ"
});

function expectedAuditChannels(overrides = {}) {
    return { ...DEFAULT_CHANNEL_NAMES, ...(overrides || {}) };
}

function channelExists(guild, nameOrId) {
    if (!guild?.channels?.cache || !nameOrId) return false;
    return !!guild.channels.cache.find?.(channel => channel.id === nameOrId || channel.name === nameOrId);
}

function buildAuditChannelRepairPlan(guild, configured = {}) {
    const expected = expectedAuditChannels(configured.names || {});
    const categories = Object.values(LOG_CHANNEL_TYPES);
    const missing = [];
    const present = [];

    for (const category of categories) {
        const configuredTarget = configured[category] || expected[category];
        const ok = channelExists(guild, configuredTarget);
        const item = { category, target: configuredTarget, expectedName: expected[category] };
        if (ok) present.push(item);
        else missing.push(item);
    }

    return {
        guildId: guild?.id || null,
        ok: missing.length === 0,
        present,
        missing,
        recommended: missing.map(item => ({
            category: item.category,
            action: "create_or_configure_log_channel",
            channelName: item.expectedName
        }))
    };
}

module.exports = {
    DEFAULT_CHANNEL_NAMES,
    expectedAuditChannels,
    channelExists,
    buildAuditChannelRepairPlan
};
