const { safeAuditText } = require("./logCore");

const POLICY_MODES = Object.freeze({
    AUDIT_ONLY: "audit_only",
    ALERT: "alert",
    ACTION: "action"
});

const DEFAULT_THRESHOLDS = Object.freeze({
    ROLE_DELETE: { count: 3, windowMs: 60_000, severity: "critical" },
    CHANNEL_DELETE: { count: 3, windowMs: 60_000, severity: "critical" },
    WEBHOOK_CREATE: { count: 4, windowMs: 60_000, severity: "danger" },
    WEBHOOK_DELETE: { count: 4, windowMs: 60_000, severity: "danger" },
    MEMBER_BAN_ADD: { count: 5, windowMs: 60_000, severity: "critical" },
    MEMBER_KICK: { count: 5, windowMs: 60_000, severity: "critical" },
    BOT_ADD: { count: 1, windowMs: 60_000, severity: "warning" },
    DANGEROUS_PERMISSION_ADD: { count: 1, windowMs: 60_000, severity: "danger" }
});

function normalizeMode(value) {
    const mode = String(value || POLICY_MODES.AUDIT_ONLY).toLowerCase();
    return Object.values(POLICY_MODES).includes(mode) ? mode : POLICY_MODES.AUDIT_ONLY;
}

function normalizeTrustedList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    return String(value).split(",").map(item => item.trim()).filter(Boolean);
}

function isTrustedActor(actorId, settings = {}) {
    if (!actorId) return false;
    const users = normalizeTrustedList(settings.trustedUsers || settings.trustedUserIds);
    const bots = normalizeTrustedList(settings.trustedBots || settings.trustedBotIds);
    return users.includes(String(actorId)) || bots.includes(String(actorId));
}

function thresholdFor(actionType, settings = {}) {
    const action = String(actionType || "UNKNOWN").toUpperCase();
    return {
        ...(DEFAULT_THRESHOLDS[action] || { count: 1, windowMs: 60_000, severity: "warning" }),
        ...settings.thresholds?.[action]
    };
}

function buildProtectionDecision(event = {}, settings = {}) {
    const actionType = String(event.actionType || event.type || "UNKNOWN").toUpperCase();
    const actorId = event.actorId || event.executorId || event.userId || null;
    const mode = normalizeMode(settings.mode);
    const threshold = thresholdFor(actionType, settings);
    const trusted = isTrustedActor(actorId, settings);
    const count = Number(event.count || 1) || 1;
    const triggered = !trusted && count >= Number(threshold.count || 1);

    return {
        triggered,
        mode,
        actionType,
        actorId: actorId ? String(actorId) : null,
        trusted,
        severity: trusted ? "info" : threshold.severity,
        threshold,
        recommendedAction: triggered && mode === POLICY_MODES.ACTION ? safeAuditText(settings.recommendedAction || "manual_review", 80) : "none",
        auditOnly: mode === POLICY_MODES.AUDIT_ONLY || !triggered,
        evidence: [
            `Action: ${actionType}`,
            `Actor: ${actorId || "unknown"}`,
            `Count: ${count}`,
            `Threshold: ${threshold.count}/${threshold.windowMs}ms`,
            `Trusted: ${trusted ? "yes" : "no"}`,
            `Mode: ${mode}`
        ]
    };
}

module.exports = {
    POLICY_MODES,
    DEFAULT_THRESHOLDS,
    normalizeMode,
    normalizeTrustedList,
    isTrustedActor,
    thresholdFor,
    buildProtectionDecision
};
