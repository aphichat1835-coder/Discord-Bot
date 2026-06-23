const { buildLogEmbed, field } = require("./logFormat");
const { LOG_CHANNEL_TYPES, safeAuditText } = require("./logCore");
const formatter = require("./auditGenericFormatter");
const { severityForAuditEvent } = require("./auditEventMap");

function option(entry, key, fallback = null) {
    return entry?.options?.[key] ?? entry?.extra?.[key] ?? fallback;
}

function changeValue(entry, key, side = "new") {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    const found = changes.find(change => change.key === key);
    if (!found) return null;
    const legacyKey = side === "old" ? "old_value" : "new_value";
    const simpleKey = side === "old" ? "old" : "new";
    return Object.prototype.hasOwnProperty.call(found, legacyKey) ? found[legacyKey] : found[simpleKey];
}

function changeLine(entry, label, key) {
    const before = changeValue(entry, key, "old");
    const after = changeValue(entry, key, "new");
    if (before === null && after === null) return null;
    return field(label, `${formatter.stringifyValue(before, 120)} -> ${formatter.stringifyValue(after, 120)}`, false);
}

function compactField(label, value, inline = true) {
    return field(label, value === null || value === undefined || value === "" ? "Unknown" : safeAuditText(value, 300), inline);
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
    const cleanedFields = fields.filter(Boolean);
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
            ...cleanedFields,
            field("Changes", formatter.formatChangeBlock(entry.changes), false)
        ],
        footer: options.footer || "Specialized audit coverage"
    });
}

function renderGuildUpdate(entry) {
    return renderWithFields(entry, "Guild Settings Updated", LOG_CHANNEL_TYPES.SERVER, [
        changeLine(entry, "Name", "name"),
        changeLine(entry, "Owner", "owner_id"),
        changeLine(entry, "Verification", "verification_level"),
        changeLine(entry, "MFA", "mfa_level"),
        changeLine(entry, "Explicit Filter", "explicit_content_filter"),
        changeLine(entry, "Default Notifications", "default_message_notifications"),
        changeLine(entry, "System Channel", "system_channel_id"),
        changeLine(entry, "Rules Channel", "rules_channel_id"),
        changeLine(entry, "Public Updates Channel", "public_updates_channel_id"),
        changeLine(entry, "Vanity URL", "vanity_url_code"),
        changeLine(entry, "Locale", "preferred_locale")
    ], { severity: "warning" });
}

function renderChannelAudit(entry) {
    return renderWithFields(entry, `Channel: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SERVER, [
        compactField("Channel", option(entry, "channel_id") || formatter.readTargetId(entry), true),
        changeLine(entry, "Name", "name"),
        changeLine(entry, "Topic", "topic"),
        changeLine(entry, "NSFW", "nsfw"),
        changeLine(entry, "Slowmode", "rate_limit_per_user"),
        changeLine(entry, "Bitrate", "bitrate"),
        changeLine(entry, "User Limit", "user_limit"),
        changeLine(entry, "Parent", "parent_id"),
        changeLine(entry, "Default Archive", "default_auto_archive_duration"),
        changeLine(entry, "Forum Tags", "available_tags")
    ]);
}

function renderRoleAudit(entry) {
    return renderWithFields(entry, `Role: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SERVER, [
        compactField("Role", option(entry, "role_id") || formatter.readTargetId(entry), true),
        changeLine(entry, "Name", "name"),
        changeLine(entry, "Color", "color"),
        changeLine(entry, "Hoist", "hoist"),
        changeLine(entry, "Mentionable", "mentionable"),
        changeLine(entry, "Permissions", "permissions"),
        changeLine(entry, "Position", "position"),
        changeLine(entry, "Icon", "icon"),
        changeLine(entry, "Unicode Emoji", "unicode_emoji")
    ]);
}

function renderChannelOverwrite(entry) {
    return renderWithFields(entry, `Channel Permission: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SERVER, [
        compactField("Channel", option(entry, "channel_id"), true),
        compactField("Overwrite Target", option(entry, "id") || formatter.readTargetId(entry), true),
        compactField("Overwrite Type", option(entry, "type"), true),
        changeLine(entry, "Allow", "allow"),
        changeLine(entry, "Deny", "deny")
    ]);
}

function renderMemberVoiceAudit(entry) {
    return renderWithFields(entry, `Voice Moderation: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.VOICE, [
        compactField("Channel", option(entry, "channel_id"), true),
        compactField("Count", option(entry, "count"), true)
    ], { severity: "warning" });
}

function renderMemberPrune(entry) {
    return renderWithFields(entry, "Member Prune", LOG_CHANNEL_TYPES.MODERATION, [
        compactField("Days", option(entry, "delete_member_days"), true),
        compactField("Removed", option(entry, "members_removed") || option(entry, "count"), true)
    ], { severity: "danger" });
}

function renderWebhook(entry) {
    return renderWithFields(entry, `Webhook: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SECURITY, [
        compactField("Channel", option(entry, "channel_id"), true),
        compactField("Webhook", formatter.readTargetId(entry), true),
        changeLine(entry, "Name", "name"),
        changeLine(entry, "Avatar", "avatar"),
        changeLine(entry, "Application", "application_id")
    ]);
}

function renderInvite(entry) {
    return renderWithFields(entry, `Invite: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SERVER, [
        compactField("Code", formatter.readTargetId(entry) || option(entry, "code"), true),
        compactField("Channel", option(entry, "channel_id"), true),
        changeLine(entry, "Max Uses", "max_uses"),
        changeLine(entry, "Max Age", "max_age"),
        changeLine(entry, "Temporary", "temporary")
    ]);
}

function renderAutomation(entry) {
    return renderWithFields(entry, `Auto Moderation: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SECURITY, [
        compactField("Rule", option(entry, "rule_name") || formatter.readTargetId(entry), true),
        compactField("Channel", option(entry, "channel_id"), true),
        compactField("Trigger", option(entry, "trigger_type"), true),
        changeLine(entry, "Actions", "actions"),
        changeLine(entry, "Exempt Roles", "exempt_roles"),
        changeLine(entry, "Exempt Channels", "exempt_channels"),
        changeLine(entry, "Enabled", "enabled")
    ], { severity: "warning" });
}

function renderScheduledOrStage(entry) {
    return renderWithFields(entry, formatter.readEntryName(entry), LOG_CHANNEL_TYPES.SERVER, [
        compactField("Channel", option(entry, "channel_id"), true),
        compactField("Entity", formatter.readTargetId(entry), true),
        changeLine(entry, "Name", "name"),
        changeLine(entry, "Topic", "topic"),
        changeLine(entry, "Status", "status"),
        changeLine(entry, "Privacy", "privacy_level"),
        changeLine(entry, "Start", "scheduled_start_time"),
        changeLine(entry, "End", "scheduled_end_time"),
        changeLine(entry, "Location", "entity_metadata")
    ]);
}

function renderSoundboard(entry) {
    return renderWithFields(entry, `Soundboard: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SERVER, [
        compactField("Sound", formatter.readTargetId(entry), true),
        changeLine(entry, "Name", "name"),
        changeLine(entry, "Emoji", "emoji_name"),
        changeLine(entry, "Volume", "volume"),
        changeLine(entry, "Available", "available")
    ]);
}

function renderOnboardingOrHome(entry) {
    return renderWithFields(entry, formatter.readEntryName(entry), LOG_CHANNEL_TYPES.SERVER, [
        compactField("Entity", formatter.readTargetId(entry), true),
        changeLine(entry, "Enabled", "enabled"),
        changeLine(entry, "Prompts", "prompts"),
        changeLine(entry, "Options", "options"),
        changeLine(entry, "Default Channel IDs", "default_channel_ids"),
        changeLine(entry, "Resource Channels", "resource_channels")
    ]);
}

function renderVoiceChannelStatus(entry) {
    return renderWithFields(entry, `Voice Status: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.VOICE, [
        compactField("Channel", option(entry, "channel_id") || formatter.readTargetId(entry), true),
        changeLine(entry, "Status", "status")
    ]);
}

function renderAuditEntry(entry = {}, options = {}) {
    const eventName = formatter.readEntryName(entry);
    if (eventName === "GUILD_UPDATE") return renderGuildUpdate(entry, options);
    if (eventName.startsWith("CHANNEL_") && !eventName.startsWith("CHANNEL_OVERWRITE_")) return renderChannelAudit(entry, options);
    if (eventName.startsWith("ROLE_")) return renderRoleAudit(entry, options);
    if (eventName.startsWith("CHANNEL_OVERWRITE_")) return renderChannelOverwrite(entry, options);
    if (eventName === "MEMBER_MOVE" || eventName === "MEMBER_DISCONNECT") return renderMemberVoiceAudit(entry, options);
    if (eventName === "MEMBER_PRUNE") return renderMemberPrune(entry, options);
    if (eventName.startsWith("WEBHOOK_")) return renderWebhook(entry, options);
    if (eventName.startsWith("INVITE_")) return renderInvite(entry, options);
    if (eventName.startsWith("AUTO_MODERATION_")) return renderAutomation(entry, options);
    if (eventName.startsWith("STAGE_") || eventName.startsWith("GUILD_SCHEDULED_EVENT_")) return renderScheduledOrStage(entry, options);
    if (eventName.startsWith("SOUNDBOARD_")) return renderSoundboard(entry, options);
    if (eventName.startsWith("ONBOARDING_") || eventName.startsWith("HOME_SETTINGS_")) return renderOnboardingOrHome(entry, options);
    if (eventName.startsWith("VOICE_CHANNEL_STATUS_")) return renderVoiceChannelStatus(entry, options);
    return formatter.renderGenericAuditEntry(entry, options);
}

module.exports = {
    option,
    changeValue,
    changeLine,
    compactField,
    baseIds,
    renderWithFields,
    renderGuildUpdate,
    renderChannelAudit,
    renderRoleAudit,
    renderChannelOverwrite,
    renderMemberVoiceAudit,
    renderMemberPrune,
    renderWebhook,
    renderInvite,
    renderAutomation,
    renderScheduledOrStage,
    renderSoundboard,
    renderOnboardingOrHome,
    renderVoiceChannelStatus,
    renderAuditEntry
};
