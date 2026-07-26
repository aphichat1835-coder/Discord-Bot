"use strict";

const crypto = require("node:crypto");
const { isDiscordSnowflake } = require("../core/snowflakes");

const OWNER_ONLY_ACTIONS = new Set([
    "toggle_feature",
    "add_vip",
    "remove_vip",
    "arm_guild",
    "disarm_guild",
    "change_pin",
    "ghost_toggle",
    "trace_kill_toggle",
    "trace_dry_run_toggle",
    "protect_session"
]);

const REASON_REQUIRED_ACTIONS = new Set([
    "toggle_feature",
    "add_vip",
    "remove_vip",
    "arm_guild",
    "change_pin",
    "ghost_toggle",
    "trace_kill_toggle",
    "trace_dry_run_toggle",
    "protect_session"
]);


const PERMANENTLY_DISABLED_FEATURES = new Set([
    "cmdNuke",
    "cmdHostage",
    "cmdMassSpam",
    "cmdRuinRoles",
    "cmdSpamVC",
    "cmdMimic",
    "cmdHaunt",
    "cmdClown",
    "cmdMemClear"
]);

const STEP_UP_ACTIONS = new Set([
    "toggle_feature",
    "add_vip",
    "remove_vip",
    "arm_guild",
    "change_pin",
    "ghost_toggle",
    "trace_kill_toggle",
    "trace_dry_run_toggle"
]);

function normalizeAction(body = {}) {
    return String(body.action || "").trim().toLowerCase();
}

function cleanText(value, maxLength = 300) {
    return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLength);
}

function makeRequestId(value) {
    const supplied = cleanText(value, 100).replace(/[^A-Za-z0-9_.:-]/g, "");
    return supplied || crypto.randomUUID();
}

function result(ok, status, code, extra = {}) {
    return { ok, status, code, ...extra };
}

function success(code, extra = {}) {
    return result(true, 200, code, extra);
}

function failure(status, code, extra = {}) {
    return result(false, status, code, extra);
}

function safeIdFromBody(body, key, safeDiscordId) {
    const raw = body?.[key];
    if (!isDiscordSnowflake(raw)) return null;
    const normalized = typeof safeDiscordId === "function" ? safeDiscordId(raw) : String(raw);
    return normalized && normalized !== "unknown" ? normalized : null;
}

function toggleSetMembership(set, value) {
    if (set.has(value)) {
        set.delete(value);
        return false;
    }
    set.add(value);
    return true;
}

function requireReason(action, body) {
    if (!REASON_REQUIRED_ACTIONS.has(action)) return { ok: true, reason: null };
    const reason = cleanText(body.reason, 300);
    return reason ? { ok: true, reason } : { ok: false, error: failure(400, "reason_required") };
}

function requireOwnerCapability(action, context) {
    if (!OWNER_ONLY_ACTIONS.has(action)) return null;
    return context.actorCapability === "owner_only" ? null : failure(403, "owner_capability_required");
}

function requireStepUp(action, body, context) {
    if (!STEP_UP_ACTIONS.has(action)) return null;
    if (typeof context.verifyStepUpPin !== "function") return failure(503, "step_up_unavailable");
    return context.verifyStepUpPin(body.step_up_pin) ? null : failure(401, "step_up_failed");
}

async function audit(context, payload) {
    if (typeof context.auditOwnerAction !== "function") return false;
    return Boolean(await context.auditOwnerAction(payload));
}

async function handleToggleFeature(body, context) {
    const feature = cleanText(body.feature, 80);
    if (!feature || context.systemToggles[feature] === undefined) return failure(400, "invalid_feature");
    if (PERMANENTLY_DISABLED_FEATURES.has(feature)) return failure(403, "feature_permanently_disabled");
    const before = Boolean(context.systemToggles[feature]);
    context.systemToggles[feature] = !before;
    return success("feature_toggled", { targetId: feature, before, after: !before });
}

async function handleAddVip(body, context) {
    const vipId = safeIdFromBody(body, "vip_id", context.safeDiscordId);
    if (!vipId) return failure(400, "invalid_vip_id");
    if (vipId === String(context.ownerId || "")) return failure(409, "owner_already_has_capability");
    const before = context.globalAdminCache.has(vipId);
    context.globalAdminCache.add(vipId);
    return success("vip_added", { targetId: vipId, before, after: true });
}

async function handleRemoveVip(body, context) {
    const vipId = safeIdFromBody(body, "vip_id", context.safeDiscordId);
    if (!vipId) return failure(400, "invalid_vip_id");
    const before = context.globalAdminCache.has(vipId);
    context.globalAdminCache.delete(vipId);
    return success("vip_removed", { targetId: vipId, before, after: false });
}

async function handleArmGuild(body, context) {
    const guildId = safeIdFromBody(body, "guild_id", context.safeDiscordId);
    if (!guildId) return failure(400, "invalid_guild_id");
    const guild = context.mainClient?.guilds?.cache?.get?.(guildId);
    if (!guild) return failure(404, "guild_not_found");

    const ttlMs = Number(context.armTtlMs);
    if (!Number.isFinite(ttlMs) || ttlMs < 60_000) return failure(503, "arm_ttl_invalid");
    const generation = crypto.randomUUID();
    const expiresAt = Date.now() + ttlMs;
    context.armedGuilds.set(guildId, {
        guildId,
        generation,
        expiresAt,
        actorId: context.actorId,
        reason: cleanText(body.reason, 300)
    });
    context.scheduleArmTimer?.(guildId, generation, expiresAt);
    return success("guild_armed", {
        targetId: guildId,
        before: false,
        after: true,
        generation,
        expiresAt
    });
}

async function handleDisarmGuild(body, context) {
    const guildId = safeIdFromBody(body, "guild_id", context.safeDiscordId);
    if (!guildId) return failure(400, "invalid_guild_id");
    const before = context.armedGuilds.has(guildId);
    context.armedGuilds.delete(guildId);
    context.cancelArmTimer?.(guildId);
    return success("guild_disarmed", { targetId: guildId, before, after: false });
}

async function handleChangePin(body, context) {
    const nextPin = String(body.new_pin || "").trim();
    if (nextPin.length < 8 || nextPin.length > 128) return failure(400, "pin_strength_invalid");
    if (typeof context.getShadowSessionVersion !== "function" || typeof context.setShadowSessionVersion !== "function") {
        return failure(503, "session_rotation_unavailable");
    }

    const nextVersion = context.getShadowSessionVersion() + 1;
    const persisted = await context.sessionManager.setSetting("_shadowPortalAuth", {
        pin: nextPin,
        sessionVersion: nextVersion,
        updatedAt: Date.now()
    });
    if (!persisted) return failure(503, "pin_persistence_failed");

    context.setShadowPin(nextPin);
    context.setShadowSessionVersion(nextVersion);
    context.resetShadowAuth?.();
    if (context.engineInstance) {
        await context.engineInstance.sendAlert("🔑 PIN CHANGED", "รหัส Dashboard ควบคุมบอทถูกเปลี่ยนแล้ว", "#fbbf24");
    }
    return success("pin_changed", { before: "redacted", after: "redacted", sessionVersion: nextVersion });
}

async function handleProtectSession(body, context) {
    const sessionId = cleanText(body.session_id, 200);
    if (!sessionId) return failure(400, "invalid_session_id");
    const session = context.sessionManager?.getSession?.(sessionId) || context.sessionManager?.getAllSessions?.()?.get?.(sessionId);
    if (!session) return failure(404, "session_not_found");
    const after = toggleSetMembership(context.protectedSessions, sessionId);
    return success("session_protection_toggled", { targetId: sessionId, before: !after, after });
}

async function handleGhostToggle(_body, context) {
    const before = Boolean(context.getGhostMode?.());
    context.toggleGhostMode();
    return success("ghost_mode_toggled", { before, after: !before });
}

async function handleTraceKillToggle(_body, context) {
    const before = Boolean(context.getTraceKillSwitch?.());
    context.toggleTraceKillSwitch();
    return success("trace_kill_switch_toggled", { before, after: !before });
}

async function handleTraceDryRunToggle(_body, context) {
    const before = Boolean(context.getTraceDryRun?.());
    context.toggleTraceDryRun();
    return success("trace_dry_run_toggled", { before, after: !before });
}

const ACTION_HANDLERS = Object.freeze({
    toggle_feature: handleToggleFeature,
    add_vip: handleAddVip,
    remove_vip: handleRemoveVip,
    arm_guild: handleArmGuild,
    disarm_guild: handleDisarmGuild,
    change_pin: handleChangePin,
    ghost_toggle: handleGhostToggle,
    trace_kill_toggle: handleTraceKillToggle,
    trace_dry_run_toggle: handleTraceDryRunToggle,
    protect_session: handleProtectSession
});

async function applyShadowPortalAction(body = {}, context = {}) {
    const action = normalizeAction(body);
    const handler = ACTION_HANDLERS[action];
    if (!handler) return failure(400, "invalid_action");

    const capabilityFailure = requireOwnerCapability(action, context);
    if (capabilityFailure) return capabilityFailure;
    const reasonResult = requireReason(action, body);
    if (!reasonResult.ok) return reasonResult.error;
    const stepUpFailure = requireStepUp(action, body, context);
    if (stepUpFailure) return stepUpFailure;

    const requestId = makeRequestId(body.request_id);
    const auditBase = {
        source: "owner_control",
        category: "OWNER",
        severity: "WARNING",
        actionType: action,
        actorId: context.actorId || context.ownerId || null,
        guildId: safeIdFromBody(body, "guild_id", context.safeDiscordId) || null,
        targetId: safeIdFromBody(body, "vip_id", context.safeDiscordId) || cleanText(body.session_id, 200) || cleanText(body.feature, 80) || null,
        reason: reasonResult.reason,
        requestId
    };

    if (!await audit(context, { ...auditBase, phase: "intent", result: "pending" })) {
        return failure(503, "audit_unavailable", { requestId });
    }

    let actionResult;
    try {
        actionResult = await handler(body, context);
    } catch (error) {
        actionResult = failure(500, "action_failed", {
            safeError: cleanText(error?.code || error?.name || "action_failed", 80)
        });
    }

    const resultAudited = await audit(context, {
        ...auditBase,
        phase: "result",
        result: actionResult.ok ? "succeeded" : "failed",
        resultCode: actionResult.code,
        before: actionResult.before,
        after: actionResult.after
    });

    if (!resultAudited) {
        return failure(503, "audit_result_unavailable", {
            requestId,
            actionApplied: actionResult.ok
        });
    }
    return { ...actionResult, requestId };
}

module.exports = {
    applyShadowPortalAction,
    normalizeAction,
    safeIdFromBody,
    toggleSetMembership,
    ACTION_HANDLERS,
    OWNER_ONLY_ACTIONS,
    REASON_REQUIRED_ACTIONS,
    STEP_UP_ACTIONS,
    PERMANENTLY_DISABLED_FEATURES,
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
        handleTraceKillToggle,
        requireReason,
        requireStepUp,
        requireOwnerCapability,
        makeRequestId
    }
};
