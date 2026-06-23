const { buildLogEmbed, field } = require("./logFormat");
const { LOG_CHANNEL_TYPES, safeAuditText } = require("./logCore");
const formatter = require("./auditGenericFormatter");
const { severityForAuditEvent } = require("./auditEventMap");

function option(entry, key, fallback = null) {
    return entry?.options?.[key] ?? entry?.extra?.[key] ?? fallback;
}

function baseIds(entry) {
    return {
        actorId: formatter.readActorId(entry),
        targetId: formatter.readTargetId(entry),
        channelId: option(entry, "channel_id"),
        messageId: option(entry, "message_id"),
        roleId: option(entry, "role_id")
    };
}

function renderWithFields(entry, title, category, fields, options = {}) {
    const eventName = formatter.readEntryName(entry);
    return buildLogEmbed({
        category,
        severity: options.severity || severityForAuditEvent(eventName),
        title,
        reason: entry.reason || null,
        ids: baseIds(entry),
        fields: [
            field("Entry ID", entry.id || "Unknown", true),
            field("Actor", formatter.readActorId(entry) || "Unknown", true),
            field("Target", formatter.readTargetId(entry) || "Unknown", true),
            ...fields,
            field("Changes", formatter.formatChangeBlock(entry.changes), false)
        ],
        footer: options.footer || "Specialized audit coverage"
    });
}

function renderChannelOverwrite(entry) {
    return renderWithFields(entry, `Channel Permission: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SERVER, [
        field("Channel", option(entry, "channel_id") || "Unknown", true),
        field("Overwrite Target", option(entry, "id") || formatter.readTargetId(entry) || "Unknown", true),
        field("Overwrite Type", option(entry, "type") || "Unknown", true)
    ]);
}

function renderMemberVoiceAudit(entry) {
    return renderWithFields(entry, `Voice Moderation: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.VOICE, [
        field("Channel", option(entry, "channel_id") || "Unknown", true),
        field("Count", option(entry, "count") || "Unknown", true)
    ], { severity: "warning" });
}

function renderMemberPrune(entry) {
    return renderWithFields(entry, "Member Prune", LOG_CHANNEL_TYPES.MODERATION, [
        field("Days", option(entry, "delete_member_days") || "Unknown", true),
        field("Removed", option(entry, "members_removed") || option(entry, "count") || "Unknown", true)
    ], { severity: "danger" });
}

function renderWebhook(entry) {
    return renderWithFields(entry, `Webhook: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SECURITY, [
        field("Channel", option(entry, "channel_id") || "Unknown", true),
        field("Webhook", formatter.readTargetId(entry) || "Unknown", true)
    ]);
}

function renderInvite(entry) {
    return renderWithFields(entry, `Invite: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SERVER, [
        field("Code", formatter.readTargetId(entry) || option(entry, "code") || "Unknown", true),
        field("Channel", option(entry, "channel_id") || "Unknown", true)
    ]);
}

function renderAutomation(entry) {
    return renderWithFields(entry, `Auto Moderation: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SECURITY, [
        field("Rule", option(entry, "rule_name") || formatter.readTargetId(entry) || "Unknown", true),
        field("Channel", option(entry, "channel_id") || "Unknown", true),
        field("Trigger", option(entry, "trigger_type") || "Unknown", true)
    ], { severity: "warning" });
}

function renderScheduledOrStage(entry) {
    return renderWithFields(entry, formatter.readEntryName(entry), LOG_CHANNEL_TYPES.SERVER, [
        field("Channel", option(entry, "channel_id") || "Unknown", true),
        field("Entity", formatter.readTargetId(entry) || "Unknown", true)
    ]);
}

function renderAuditEntry(entry = {}, options = {}) {
    const eventName = formatter.readEntryName(entry);
    if (eventName.startsWith("CHANNEL_OVERWRITE_")) return renderChannelOverwrite(entry, options);
    if (eventName === "MEMBER_MOVE" || eventName === "MEMBER_DISCONNECT") return renderMemberVoiceAudit(entry, options);
    if (eventName === "MEMBER_PRUNE") return renderMemberPrune(entry, options);
    if (eventName.startsWith("WEBHOOK_")) return renderWebhook(entry, options);
    if (eventName.startsWith("INVITE_")) return renderInvite(entry, options);
    if (eventName.startsWith("AUTO_MODERATION_")) return renderAutomation(entry, options);
    if (eventName.startsWith("STAGE_") || eventName.startsWith("GUILD_SCHEDULED_EVENT_")) return renderScheduledOrStage(entry, options);
    return formatter.renderGenericAuditEntry(entry, options);
}

module.exports = {
    option,
    baseIds,
    renderWithFields,
    renderChannelOverwrite,
    renderMemberVoiceAudit,
    renderMemberPrune,
    renderWebhook,
    renderInvite,
    renderAutomation,
    renderScheduledOrStage,
    renderAuditEntry
};
