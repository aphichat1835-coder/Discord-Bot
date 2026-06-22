/*
 * Security Rule Helpers
 * Shared risk scoring for future personal Discord protection features.
 * No destructive action is performed here; this file only classifies risk.
 */

const { safeAuditText } = require("./logCore");

const DANGEROUS_PERMISSIONS = Object.freeze([
    "ADMINISTRATOR",
    "MANAGE_GUILD",
    "MANAGE_ROLES",
    "MANAGE_CHANNELS",
    "MANAGE_WEBHOOKS",
    "BAN_MEMBERS",
    "KICK_MEMBERS",
    "MENTION_EVERYONE",
    "MODERATE_MEMBERS"
]);

const HIGH_RISK_EVENTS = Object.freeze([
    "CHANNEL_DELETE",
    "CHANNEL_CREATE",
    "ROLE_DELETE",
    "ROLE_CREATE",
    "ROLE_PERMISSION_UPDATE",
    "CHANNEL_PERMISSION_UPDATE",
    "MEMBER_BAN",
    "MEMBER_KICK",
    "WEBHOOK_UPDATE",
    "BOT_ADDED"
]);

function hasDangerousPermission(permissionName) {
    return DANGEROUS_PERMISSIONS.includes(String(permissionName || "").toUpperCase());
}

function dangerousPermissionDiff(diff = {}) {
    const added = Array.isArray(diff.added) ? diff.added : [];
    const removed = Array.isArray(diff.removed) ? diff.removed : [];
    return {
        added: added.filter(hasDangerousPermission),
        removed: removed.filter(hasDangerousPermission)
    };
}

function scorePermissionChange(diff = {}) {
    const dangerous = dangerousPermissionDiff(diff);
    let score = dangerous.added.length * 3;
    score += dangerous.removed.includes("ADMINISTRATOR") ? 1 : 0;
    if (dangerous.added.includes("ADMINISTRATOR")) score += 8;
    if (dangerous.added.includes("MANAGE_ROLES")) score += 4;
    if (dangerous.added.includes("MANAGE_WEBHOOKS")) score += 4;
    return {
        score,
        severity: score >= 8 ? "critical" : score >= 4 ? "danger" : score > 0 ? "warning" : "info",
        dangerous
    };
}

function createThresholdTracker({ windowMs = 10000, threshold = 3, maxEntries = 5000 } = {}) {
    const history = new Map();

    function trim(now = Date.now()) {
        for (const [key, entries] of history.entries()) {
            const next = entries.filter(item => now - item.timestamp <= windowMs);
            if (next.length) history.set(key, next);
            else history.delete(key);
        }

        while (history.size > maxEntries) {
            history.delete(history.keys().next().value);
        }
    }

    function record(key, payload = {}) {
        const now = Date.now();
        trim(now);
        const list = history.get(key) || [];
        list.push({ timestamp: now, payload });
        history.set(key, list);
        return {
            key,
            count: list.length,
            threshold,
            windowMs,
            triggered: list.length >= threshold,
            entries: list.slice(-threshold)
        };
    }

    function clear(key) {
        if (key) history.delete(key);
        else history.clear();
    }

    function stats() {
        return { keys: history.size, threshold, windowMs, maxEntries };
    }

    return { record, trim, clear, stats };
}

function buildRiskEvidence({ eventType, count, threshold, windowMs, targetName, reason, dangerousPermissions } = {}) {
    const evidence = [];
    if (eventType) evidence.push(`Event: ${safeAuditText(eventType, 80)}`);
    if (count != null && threshold != null) evidence.push(`Count: ${count}/${threshold} in ${Math.round((windowMs || 0) / 1000)}s`);
    if (targetName) evidence.push(`Target: ${safeAuditText(targetName, 120)}`);
    if (reason) evidence.push(`Reason: ${safeAuditText(reason, 200)}`);
    if (dangerousPermissions?.length) evidence.push(`Dangerous permissions: ${dangerousPermissions.join(", ")}`);
    return evidence;
}

function shouldFlagHighRiskEvent(type) {
    return HIGH_RISK_EVENTS.includes(String(type || "").toUpperCase());
}

module.exports = {
    DANGEROUS_PERMISSIONS,
    HIGH_RISK_EVENTS,
    hasDangerousPermission,
    dangerousPermissionDiff,
    scorePermissionChange,
    createThresholdTracker,
    buildRiskEvidence,
    shouldFlagHighRiskEvent
};
