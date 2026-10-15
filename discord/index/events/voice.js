'use strict';

/**
 * Voice Admin Event Attachments
 * - voiceStateUpdate, guildAuditLogEntryCreate, guildMemberUpdate, guildMemberRemove
 * - Bounded listener registration and clean teardown detachment
 */

const voiceAdmin = require('../../features/voiceAdmin');

function attachVoiceAdminListeners(client) {
    const onVoiceStateUpdate = (oldState, newState) => voiceAdmin.handleVoiceStateUpdate(oldState, newState, client);
    const onAuditLogEntry = (entry, guild) => voiceAdmin.handleAuditLogEntry(entry, guild, client);
    const onGuildMemberUpdate = (oldMember, member) => voiceAdmin.handleMemberUpdate(oldMember, member);
    const onGuildMemberRemove = member => voiceAdmin.handleMemberRemove(member);

    client.on("voiceStateUpdate", onVoiceStateUpdate);
    client.on("guildAuditLogEntryCreate", onAuditLogEntry);
    client.on("guildMemberUpdate", onGuildMemberUpdate);
    client.on("guildMemberRemove", onGuildMemberRemove);

    return () => {
        client.off("voiceStateUpdate", onVoiceStateUpdate);
        client.off("guildAuditLogEntryCreate", onAuditLogEntry);
        client.off("guildMemberUpdate", onGuildMemberUpdate);
        client.off("guildMemberRemove", onGuildMemberRemove);
    };
}

module.exports = {
    attachVoiceAdminListeners
};
