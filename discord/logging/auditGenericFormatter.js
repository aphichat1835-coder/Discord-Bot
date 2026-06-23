const { buildLogEmbed, field, formatDiscordTime } = require("./logFormat");
const { safeAuditText } = require("./logCore");
const { categoryForAuditEvent, severityForAuditEvent, normalizeEventName } = require("./auditEventMap");

function stringifyValue(value, max = 180) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (["string", "number", "boolean", "bigint"].includes(typeof value)) return safeAuditText(String(value), max);
    try {
        return safeAuditText(JSON.stringify(value), max);
    } catch {
        return safeAuditText(String(value), max);
    }
}

function readEntryName(entry = {}) {
    return normalizeEventName(entry.action || entry.action_type || entry.actionType || entry.type || "UNKNOWN_AUDIT_EVENT");
}

function readActorId(entry = {}) {
    return entry.executor?.id || entry.user?.id || entry.user_id || entry.userId || null;
}

function readTargetId(entry = {}) {
    return entry.target?.id || entry.target_id || entry.targetId || null;
}

function formatChangeLine(change = {}) {
    const key = safeAuditText(change.key || "unknown", 80);
    const before = Object.prototype.hasOwnProperty.call(change, "old_value") ? change.old_value : change.old;
    const after = Object.prototype.hasOwnProperty.call(change, "new_value") ? change.new_value : change.new;
    return `• ${key}: ${stringifyValue(before, 90)} -> ${stringifyValue(after, 90)}`;
}

function formatChangeBlock(changes = []) {
    if (!Array.isArray(changes) || changes.length === 0) return "-";
    const lines = changes.slice(0, 12).map(formatChangeLine);
    if (changes.length > 12) lines.push(`...+${changes.length - 12}`);
    return lines.join("\n");
}

function formatOptionBlock(options = {}) {
    if (!options || typeof options !== "object") return "-";
    const entries = Object.entries(options);
    if (entries.length === 0) return "-";
    const lines = entries.slice(0, 12).map(([key, value]) => `• ${safeAuditText(key, 80)}: ${stringifyValue(value, 140)}`);
    if (entries.length > 12) lines.push(`...+${entries.length - 12}`);
    return lines.join("\n");
}

function renderGenericAuditEntry(entry = {}, options = {}) {
    const eventName = readEntryName(entry);
    const actorId = readActorId(entry);
    const targetId = readTargetId(entry);
    return buildLogEmbed({
        category: options.category || categoryForAuditEvent(eventName),
        severity: options.severity || severityForAuditEvent(eventName),
        title: `Audit: ${eventName}`,
        reason: entry.reason || null,
        ids: {
            actorId,
            targetId,
            channelId: entry.options?.channel_id || null,
            messageId: entry.options?.message_id || null,
            roleId: entry.options?.role_id || null
        },
        fields: [
            field("Entry ID", entry.id || "Unknown", true),
            field("Actor", actorId || "Unknown", true),
            field("Target", targetId || "Unknown", true),
            field("Options", formatOptionBlock(entry.options), false),
            field("Changes", formatChangeBlock(entry.changes), false),
            field("Created", formatDiscordTime(entry.createdTimestamp || entry.created_at || Date.now()), true)
        ],
        footer: options.footer || "Generic audit coverage"
    });
}

module.exports = {
    stringifyValue,
    readEntryName,
    readActorId,
    readTargetId,
    formatChangeLine,
    formatChangeBlock,
    formatOptionBlock,
    renderGenericAuditEntry
};
