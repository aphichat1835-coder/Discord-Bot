'use strict';

/**
 * Guild Lifecycle Event Handler
 * - guildCreate: webhook notice, invite generation, voiceAdmin registration.
 * - guildDelete: state cleanup across commands and features.
 */

const { canCreateInvite } = require('../../core/discordPermissions');
const { sendWebhookEvent, getDiscordGuildIconUrl } = require('../../core/webhooks');
const voiceAdmin = require('../../features/voiceAdmin');

async function resolveGuildInviteString(guild) {
    try {
        const channel = guild.channels.cache
            .filter(ch => canCreateInvite(ch, guild.members.me))
            .first();
        if (channel) {
            const inv = await channel.createInvite({ maxAge: 3600 });
            return inv.url;
        }
    } catch {}
    return "No Permission";
}

async function handleGuildCreateEvent(guild) {
    voiceAdmin.handleGuildCreate(guild.id);
    const inviteStr = await resolveGuildInviteString(guild);

    sendWebhookEvent({
        target: "LOG",
        severity: "INFO",
        category: "GUILD",
        code: "guild.joined",
        title: "BOT JOINED GUILD",
        description: `บอทเข้าร่วมเซิร์ฟเวอร์ใหม่: **${guild.name}**`,
        fields: [
            { name: "ผู้ดำเนินการ", value: "Discord System" },
            { name: "เซิร์ฟเวอร์", value: `${guild.name} (\`${guild.id}\`)` },
            { name: "เป้าหมาย", value: `สมาชิก ${guild.memberCount} คน` },
            { name: "การกระทำ", value: "bot joined guild" },
            { name: "ผลลัพธ์", value: "พร้อมให้บริการ" },
            inviteStr ? { name: "รายละเอียด", value: `ลิงก์เชิญ: ${inviteStr}` } : null
        ].filter(Boolean),
        sourceIconUrl: getDiscordGuildIconUrl(guild)
    }).catch(() => {});
}

async function handleGuildDeleteEvent(guild, commands) {
    if (commands && typeof commands.cleanupGuild === 'function') {
        await commands.cleanupGuild(guild.id);
    }
}

module.exports = {
    handleGuildCreateEvent,
    handleGuildDeleteEvent,
    resolveGuildInviteString
};
