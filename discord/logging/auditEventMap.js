const { LOG_CHANNEL_TYPES } = require("./logCore");

const EVENT_CATEGORY_PREFIXES = Object.freeze([
    ["MESSAGE_", LOG_CHANNEL_TYPES.MESSAGE],
    ["MEMBER_MOVE", LOG_CHANNEL_TYPES.VOICE],
    ["MEMBER_DISCONNECT", LOG_CHANNEL_TYPES.VOICE],
    ["MEMBER_", LOG_CHANNEL_TYPES.MEMBER],
    ["VOICE_", LOG_CHANNEL_TYPES.VOICE],
    ["WEBHOOK_", LOG_CHANNEL_TYPES.SECURITY],
    ["AUTO_MODERATION_", LOG_CHANNEL_TYPES.SECURITY],
    ["APPLICATION_COMMAND_", LOG_CHANNEL_TYPES.SECURITY],
    ["BOT_", LOG_CHANNEL_TYPES.SECURITY],
    ["ROLE_", LOG_CHANNEL_TYPES.SERVER],
    ["CHANNEL_", LOG_CHANNEL_TYPES.SERVER],
    ["GUILD_", LOG_CHANNEL_TYPES.SERVER],
    ["INVITE_", LOG_CHANNEL_TYPES.SERVER],
    ["THREAD_", LOG_CHANNEL_TYPES.SERVER],
    ["STAGE_", LOG_CHANNEL_TYPES.SERVER],
    ["STICKER_", LOG_CHANNEL_TYPES.SERVER],
    ["EMOJI_", LOG_CHANNEL_TYPES.SERVER],
    ["SOUNDBOARD_", LOG_CHANNEL_TYPES.SERVER],
    ["ONBOARDING_", LOG_CHANNEL_TYPES.SERVER],
    ["HOME_", LOG_CHANNEL_TYPES.SERVER]
]);

function normalizeEventName(value) {
    return String(value || "UNKNOWN_AUDIT_EVENT").toUpperCase();
}

function categoryForAuditEvent(value) {
    const eventName = normalizeEventName(value);
    const found = EVENT_CATEGORY_PREFIXES.find(([prefix]) => eventName.startsWith(prefix));
    return found ? found[1] : LOG_CHANNEL_TYPES.SERVER;
}

function severityForAuditEvent(value) {
    const eventName = normalizeEventName(value);
    if (eventName.includes("DELETE") || eventName.includes("BAN") || eventName.includes("KICK")) return "danger";
    if (eventName.includes("CREATE") || eventName.includes("ADD")) return "success";
    if (eventName.includes("UPDATE") || eventName.includes("MOVE") || eventName.includes("DISCONNECT")) return "warning";
    return "info";
}

module.exports = {
    EVENT_CATEGORY_PREFIXES,
    normalizeEventName,
    categoryForAuditEvent,
    severityForAuditEvent
};
