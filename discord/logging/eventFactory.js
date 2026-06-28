/*
 * Structured Audit Event Factory
 * Turns raw Discord/moderation/protection data into normalized event objects.
 * This is the bridge between auditLogger.js events and future protection systems.
 */

const { LOG_TYPES, LOG_CHANNEL_TYPES, buildLogEvent, safeAuditText } = require("./logCore");

const SEVERITY_BY_TYPE = Object.freeze({
    [LOG_TYPES.MESSAGE_DELETE]: "warning",
    [LOG_TYPES.MESSAGE_EDIT]: "info",
    [LOG_TYPES.MESSAGE_BULK_DELETE]: "warning",
    [LOG_TYPES.MEMBER_JOIN]: "success",
    [LOG_TYPES.MEMBER_LEAVE]: "warning",
    [LOG_TYPES.MEMBER_KICK]: "danger",
    [LOG_TYPES.MEMBER_BAN]: "danger",
    [LOG_TYPES.MEMBER_UNBAN]: "success",
    [LOG_TYPES.MEMBER_TIMEOUT_UPDATE]: "danger",
    [LOG_TYPES.CHANNEL_CREATE]: "success",
    [LOG_TYPES.CHANNEL_DELETE]: "danger",
    [LOG_TYPES.CHANNEL_UPDATE]: "warning",
    [LOG_TYPES.CHANNEL_PERMISSION_UPDATE]: "warning",
    [LOG_TYPES.ROLE_CREATE]: "success",
    [LOG_TYPES.ROLE_DELETE]: "danger",
    [LOG_TYPES.ROLE_UPDATE]: "warning",
    [LOG_TYPES.ROLE_PERMISSION_UPDATE]: "warning",
    [LOG_TYPES.MOD_CASE_CREATE]: "danger",
    [LOG_TYPES.PROTECTION_TRIGGER]: "danger",
    [LOG_TYPES.PROTECTION_ACTION_FAILED]: "critical",
    [LOG_TYPES.BOT_ADDED]: "warning"
});

function severityFor(type, fallback = "info") {
    return SEVERITY_BY_TYPE[type] || fallback;
}

function messageToEvent(message, type = LOG_TYPES.MESSAGE_DELETE, patch = {}) {
    return buildLogEvent({
        type,
        category: LOG_CHANNEL_TYPES.MESSAGE,
        severity: severityFor(type),
        guildId: message?.guild?.id || message?.channel?.guild?.id,
        actorId: message?.author?.id,
        targetId: message?.author?.id,
        channelId: message?.channel?.id,
        messageId: message?.id,
        source: "discord_event",
        metadata: {
            authorTag: message?.author?.tag || message?.author?.username || null,
            content: safeAuditText(message?.content || "", 1800),
            attachments: Array.from(message?.attachments?.values?.() || []).map(a => ({
                id: a.id || null,
                name: a.name || a.filename || null,
                url: a.url || null,
                size: a.size || null,
                contentType: a.contentType || null
            })),
            createdTimestamp: message?.createdTimestamp || null,
            editedTimestamp: message?.editedTimestamp || null,
            ...patch.metadata
        },
        ...patch
    });
}

function memberToEvent(member, type, patch = {}) {
    return buildLogEvent({
        type,
        category: type === LOG_TYPES.MEMBER_BAN || type === LOG_TYPES.MEMBER_KICK || type === LOG_TYPES.MEMBER_TIMEOUT_UPDATE
            ? LOG_CHANNEL_TYPES.MODERATION
            : LOG_CHANNEL_TYPES.MEMBER,
        severity: severityFor(type),
        guildId: member?.guild?.id,
        actorId: patch.actorId || null,
        targetId: member?.id || member?.user?.id,
        source: patch.source || "discord_event",
        metadata: {
            userTag: member?.user?.tag || member?.user?.username || null,
            joinedTimestamp: member?.joinedTimestamp || null,
            createdTimestamp: member?.user?.createdTimestamp || null,
            nickname: member?.nickname || null,
            bot: !!member?.user?.bot,
            ...patch.metadata
        },
        ...patch
    });
}

function voiceToEvent(oldState, newState, type, patch = {}) {
    const state = newState || oldState;
    const member = state?.member;
    return buildLogEvent({
        type,
        category: LOG_CHANNEL_TYPES.VOICE,
        severity: severityFor(type),
        guildId: state?.guild?.id,
        targetId: member?.id,
        channelId: newState?.channelId || oldState?.channelId,
        source: "discord_event",
        metadata: {
            oldChannelId: oldState?.channelId || null,
            newChannelId: newState?.channelId || null,
            userTag: member?.user?.tag || member?.user?.username || null,
            serverMute: newState?.serverMute,
            serverDeaf: newState?.serverDeaf,
            selfMute: newState?.selfMute,
            selfDeaf: newState?.selfDeaf,
            streaming: newState?.streaming,
            selfVideo: newState?.selfVideo,
            ...patch.metadata
        },
        ...patch
    });
}

function channelToEvent(channel, type, patch = {}) {
    return buildLogEvent({
        type,
        category: LOG_CHANNEL_TYPES.SERVER,
        severity: severityFor(type),
        guildId: channel?.guild?.id,
        actorId: patch.actorId || null,
        targetId: channel?.id,
        channelId: channel?.id,
        source: patch.source || "discord_event",
        metadata: {
            name: channel?.name || null,
            channelType: channel?.type || null,
            parentId: channel?.parentId || null,
            position: channel?.position ?? null,
            ...patch.metadata
        },
        ...patch
    });
}

function roleToEvent(role, type, patch = {}) {
    return buildLogEvent({
        type,
        category: LOG_CHANNEL_TYPES.SERVER,
        severity: severityFor(type),
        guildId: role?.guild?.id,
        actorId: patch.actorId || null,
        targetId: role?.id,
        roleId: role?.id,
        source: patch.source || "discord_event",
        metadata: {
            name: role?.name || null,
            color: role?.hexColor || null,
            position: role?.position ?? null,
            hoist: role?.hoist,
            mentionable: role?.mentionable,
            managed: role?.managed,
            ...patch.metadata
        },
        ...patch
    });
}

function moderationToEvent(caseDoc, patch = {}) {
    return buildLogEvent({
        type: LOG_TYPES.MOD_CASE_CREATE,
        category: LOG_CHANNEL_TYPES.MODERATION,
        severity: "danger",
        guildId: caseDoc?.guildId,
        actorId: caseDoc?.moderatorId,
        targetId: caseDoc?.userId,
        source: caseDoc?.source || "command",
        reason: caseDoc?.reason,
        evidence: caseDoc?.evidence || [],
        metadata: {
            caseNumber: caseDoc?.caseNumber,
            action: caseDoc?.action,
            status: caseDoc?.status,
            expiresAt: caseDoc?.expiresAt || null,
            ...patch.metadata
        },
        ...patch
    });
}

function eventSummary(event = {}) {
    const parts = [event.type || "UNKNOWN"];
    if (event.actorId) parts.push(`actor=${event.actorId}`);
    if (event.targetId) parts.push(`target=${event.targetId}`);
    if (event.channelId) parts.push(`channel=${event.channelId}`);
    if (event.reason) parts.push(`reason=${safeAuditText(event.reason, 120)}`);
    return parts.join(" ");
}

module.exports = {
    SEVERITY_BY_TYPE,
    severityFor,
    messageToEvent,
    memberToEvent,
    voiceToEvent,
    channelToEvent,
    roleToEvent,
    moderationToEvent,
    eventSummary
};
