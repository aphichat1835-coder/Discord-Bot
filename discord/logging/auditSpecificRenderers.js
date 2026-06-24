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
    return Object.hasOwn(found, legacyKey) ? found[legacyKey] : found[simpleKey];
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
    const extraFields = Array.isArray(options.fields) ? options.fields : [];
    return buildLogEmbed({
        ...options,
        category: options.category || category,
        severity: options.severity || severityForAuditEvent(eventName),
        title: options.title || title,
        reason: entry.reason || options.reason || null,
        ids: { ...baseIds(entry), ...(options.ids || {}) },
        fields: [
            field("Entry ID", entry.id || "Unknown", true),
            field("Actor", formatter.readActorId(entry) || "Unknown", true),
            field("Target", formatter.readTargetId(entry) || "Unknown", true),
            ...cleanedFields,
            field("Changes", formatter.formatChangeBlock(entry.changes), false),
            ...extraFields
        ],
        footer: options.footer || "Specialized audit coverage"
    });
}

function renderGuildUpdate(entry, options = {}) {
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
    ], { ...options, severity: options.severity || "warning" });
}

function renderChannelAudit(entry, options = {}) {
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
    ], options);
}

function renderRoleAudit(entry, options = {}) {
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
    ], options);
}

function renderChannelOverwrite(entry, options = {}) {
    return renderWithFields(entry, `Channel Permission: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SERVER, [
        compactField("Channel", option(entry, "channel_id"), true),
        compactField("Overwrite Target", option(entry, "id") || formatter.readTargetId(entry), true),
        compactField("Overwrite Type", option(entry, "type"), true),
        changeLine(entry, "Allow", "allow"),
        changeLine(entry, "Deny", "deny")
    ], options);
}

function renderMemberVoiceAudit(entry, options = {}) {
    return renderWithFields(entry, `Voice Moderation: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.VOICE, [
        compactField("Channel", option(entry, "channel_id"), true),
        compactField("Count", option(entry, "count"), true)
    ], { ...options, severity: options.severity || "warning" });
}

function renderMemberPrune(entry, options = {}) {
    return renderWithFields(entry, "Member Prune", LOG_CHANNEL_TYPES.MODERATION, [
        compactField("Days", option(entry, "delete_member_days"), true),
        compactField("Removed", option(entry, "members_removed") || option(entry, "count"), true)
    ], { ...options, severity: options.severity || "danger" });
}

function renderWebhook(entry, options = {}) {
    return renderWithFields(entry, `Webhook: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SECURITY, [
        compactField("Channel", option(entry, "channel_id"), true),
        compactField("Webhook", formatter.readTargetId(entry), true),
        changeLine(entry, "Name", "name"),
        changeLine(entry, "Avatar", "avatar"),
        changeLine(entry, "Application", "application_id")
    ], options);
}

function renderInvite(entry, options = {}) {
    return renderWithFields(entry, `Invite: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SERVER, [
        compactField("Code", formatter.readTargetId(entry) || option(entry, "code"), true),
        compactField("Channel", option(entry, "channel_id"), true),
        changeLine(entry, "Max Uses", "max_uses"),
        changeLine(entry, "Max Age", "max_age"),
        changeLine(entry, "Temporary", "temporary")
    ], options);
}

function renderAutomation(entry, options = {}) {
    return renderWithFields(entry, `Auto Moderation: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SECURITY, [
        compactField("Rule", option(entry, "rule_name") || formatter.readTargetId(entry), true),
        compactField("Channel", option(entry, "channel_id"), true),
        compactField("Trigger", option(entry, "trigger_type"), true),
        changeLine(entry, "Actions", "actions"),
        changeLine(entry, "Exempt Roles", "exempt_roles"),
        changeLine(entry, "Exempt Channels", "exempt_channels"),
        changeLine(entry, "Enabled", "enabled")
    ], { ...options, severity: options.severity || "warning" });
}

function renderScheduledOrStage(entry, options = {}) {
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
    ], options);
}

function renderSoundboard(entry, options = {}) {
    return renderWithFields(entry, `Soundboard: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.SERVER, [
        compactField("Sound", formatter.readTargetId(entry), true),
        changeLine(entry, "Name", "name"),
        changeLine(entry, "Emoji", "emoji_name"),
        changeLine(entry, "Volume", "volume"),
        changeLine(entry, "Available", "available")
    ], options);
}

function renderOnboardingOrHome(entry, options = {}) {
    return renderWithFields(entry, formatter.readEntryName(entry), LOG_CHANNEL_TYPES.SERVER, [
        compactField("Entity", formatter.readTargetId(entry), true),
        changeLine(entry, "Enabled", "enabled"),
        changeLine(entry, "Prompts", "prompts"),
        changeLine(entry, "Options", "options"),
        changeLine(entry, "Default Channel IDs", "default_channel_ids"),
        changeLine(entry, "Resource Channels", "resource_channels")
    ], options);
}

function renderVoiceChannelStatus(entry, options = {}) {
    return renderWithFields(entry, `Voice Status: ${formatter.readEntryName(entry)}`, LOG_CHANNEL_TYPES.VOICE, [
        compactField("Channel", option(entry, "channel_id") || formatter.readTargetId(entry), true),
        changeLine(entry, "Status", "status")
    ], options);
}

const RENDERER_RULES = Object.freeze([
    [eventName => eventName === "GUILD_UPDATE", renderGuildUpdate],
    [eventName => eventName.startsWith("CHANNEL_") && !eventName.startsWith("CHANNEL_OVERWRITE_"), renderChannelAudit],
    [eventName => eventName.startsWith("ROLE_"), renderRoleAudit],
    [eventName => eventName.startsWith("CHANNEL_OVERWRITE_"), renderChannelOverwrite],
    [eventName => eventName === "MEMBER_MOVE" || eventName === "MEMBER_DISCONNECT", renderMemberVoiceAudit],
    [eventName => eventName === "MEMBER_PRUNE", renderMemberPrune],
    [eventName => eventName.startsWith("WEBHOOK_"), renderWebhook],
    [eventName => eventName.startsWith("INVITE_"), renderInvite],
    [eventName => eventName.startsWith("AUTO_MODERATION_"), renderAutomation],
    [eventName => eventName.startsWith("STAGE_") || eventName.startsWith("GUILD_SCHEDULED_EVENT_"), renderScheduledOrStage],
    [eventName => eventName.startsWith("SOUNDBOARD_"), renderSoundboard],
    [eventName => eventName.startsWith("ONBOARDING_") || eventName.startsWith("HOME_SETTINGS_"), renderOnboardingOrHome],
    [eventName => eventName.startsWith("VOICE_CHANNEL_STATUS_"), renderVoiceChannelStatus]
]);

function rendererFor(eventName) {
    const rule = RENDERER_RULES.find(([matches]) => matches(eventName));
    return rule?.[1] || null;
}

function renderAuditEntry(entry = {}, options = {}) {
    const eventName = formatter.readEntryName(entry);
    const renderer = rendererFor(eventName);
    return renderer ? renderer(entry, options) : formatter.renderGenericAuditEntry(entry, options);
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
    RENDERER_RULES,
    rendererFor,
    renderAuditEntry
};
