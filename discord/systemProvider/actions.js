function normalizeAction(body = {}) {
    return String(body.action || "");
}

function safeIdFromBody(body, key, safeDiscordId) {
    const value = body?.[key];
    return value ? safeDiscordId(value) : "unknown";
}

function toggleSetMembership(set, value) {
    if (set.has(value)) set.delete(value);
    else set.add(value);
}

async function handleToggleFeature(body, context) {
    if (!body.feature || context.systemToggles[body.feature] === undefined) return false;
    context.systemToggles[body.feature] = !context.systemToggles[body.feature];
    return true;
}

async function handleAddVip(body, context) {
    const vipId = safeIdFromBody(body, "vip_id", context.safeDiscordId);
    if (vipId === "unknown") return false;
    context.globalAdminCache.add(vipId);
    return true;
}

async function handleRemoveVip(body, context) {
    const vipId = safeIdFromBody(body, "vip_id", context.safeDiscordId);
    if (vipId === "unknown") return false;
    context.globalAdminCache.delete(vipId);
    return true;
}

async function handleArmGuild(body, context) {
    const guildId = safeIdFromBody(body, "guild_id", context.safeDiscordId);
    if (guildId === "unknown") return false;
    context.armedGuilds.add(guildId);
    return true;
}

async function handleDisarmGuild(body, context) {
    const guildId = safeIdFromBody(body, "guild_id", context.safeDiscordId);
    if (guildId === "unknown") return false;
    context.armedGuilds.delete(guildId);
    return true;
}

async function handleChangePin(body, context) {
    if (!body.new_pin) return false;
    const nextPin = body.new_pin.trim();
    context.setShadowPin(nextPin);
    context.sessionManager.setSetting("_shadowPin", nextPin).catch(err => {
        context.logSuppressedError("persist shadow portal pin", err);
    });
    if (context.engineInstance) {
        await context.engineInstance.sendAlert("🔑 PIN CHANGED", "รหัส Portal ถูกเปลี่ยนแล้ว", "#fbbf24");
    }
    return true;
}

async function handleProtectSession(body, context) {
    if (!body.session_id) return false;
    toggleSetMembership(context.protectedSessions, body.session_id);
    return true;
}

const ACTION_HANDLERS = Object.freeze({
    toggle_feature: handleToggleFeature,
    add_vip: handleAddVip,
    remove_vip: handleRemoveVip,
    arm_guild: handleArmGuild,
    disarm_guild: handleDisarmGuild,
    change_pin: handleChangePin,
    ghost_toggle: async (_body, context) => {
        context.toggleGhostMode();
        return true;
    },
    trace_kill_toggle: async (_body, context) => {
        context.toggleTraceKillSwitch();
        return true;
    },
    trace_dry_run_toggle: async (_body, context) => {
        context.toggleTraceDryRun();
        return true;
    },
    protect_session: handleProtectSession
});

async function applyShadowPortalAction(body = {}, context = {}) {
    const handler = ACTION_HANDLERS[normalizeAction(body)];
    if (!handler) return false;
    return handler(body, context);
}

module.exports = {
    ACTION_HANDLERS,
    applyShadowPortalAction,
    normalizeAction,
    safeIdFromBody,
    toggleSetMembership
};
