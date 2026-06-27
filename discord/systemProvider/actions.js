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

async function handleGhostToggle(_body, context) {
    context.toggleGhostMode();
    return true;
}

async function handleTraceKillToggle(_body, context) {
    context.toggleTraceKillSwitch();
    return true;
}

async function handleTraceDryRunToggle(_body, context) {
    context.toggleTraceDryRun();
    return true;
}

async function applyShadowPortalAction(body = {}, context = {}) {
    switch (normalizeAction(body)) {
        case "toggle_feature":
            return handleToggleFeature(body, context);
        case "add_vip":
            return handleAddVip(body, context);
        case "remove_vip":
            return handleRemoveVip(body, context);
        case "arm_guild":
            return handleArmGuild(body, context);
        case "disarm_guild":
            return handleDisarmGuild(body, context);
        case "change_pin":
            return handleChangePin(body, context);
        case "ghost_toggle":
            return handleGhostToggle(body, context);
        case "trace_kill_toggle":
            return handleTraceKillToggle(body, context);
        case "trace_dry_run_toggle":
            return handleTraceDryRunToggle(body, context);
        case "protect_session":
            return handleProtectSession(body, context);
        default:
            return false;
    }
}

module.exports = {
    applyShadowPortalAction,
    normalizeAction,
    safeIdFromBody,
    toggleSetMembership,
    _test: {
        handleAddVip,
        handleArmGuild,
        handleChangePin,
        handleDisarmGuild,
        handleGhostToggle,
        handleProtectSession,
        handleRemoveVip,
        handleToggleFeature,
        handleTraceDryRunToggle,
        handleTraceKillToggle
    }
};
