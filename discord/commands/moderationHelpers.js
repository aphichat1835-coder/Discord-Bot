const { MessageEmbed } = require("discord.js");
const config = require("../config.json");
const { safeAuditText } = require("../logging/logCore");

function requiredModerationPermission(action) {
    return {
        ban: "BAN_MEMBERS",
        kick: "KICK_MEMBERS",
        timeout: "MODERATE_MEMBERS"
    }[action] || null;
}

function readModerationInput(interaction) {
    return {
        action: interaction.commandName,
        target: interaction.options.getMember("target"),
        reason: safeAuditText(interaction.options.getString("reason") || "ไม่มีเหตุผลระบุ", 500)
    };
}

function parseTimeoutDuration(interaction, action) {
    if (action !== "timeout") return { ok: true, durationMs: null, minutes: null };
    const minutes = interaction.options.getInteger("minutes");
    if (minutes <= 0) return { ok: false, content: `> ${config.emojis.error} เวลาต้องมากกว่า 0 นาที!` };
    if (minutes > 40000) return { ok: false, content: `> ${config.emojis.error} เกินขีดจำกัด Discord (สูงสุด ~40,000 นาที)` };
    return { ok: true, durationMs: minutes * 60000, minutes };
}

function moderationActionLabel(action, minutes = null) {
    if (action === "ban") return "แบนถาวร";
    if (action === "kick") return "เตะออกจากเซิร์ฟเวอร์";
    if (action === "timeout") return `Timeout ${minutes} นาที ${config.emojis.timeout_icon}`;
    return action;
}

function buildModerationDmEmbed(interaction, target, action, reason, minutes = null) {
    return new MessageEmbed()
        .setColor(config.system.themeColors.error)
        .setTitle(`${config.emojis.punishment} คุณถูกระงับสิทธิ์ในเซิร์ฟเวอร์ ${interaction.guild.name}`)
        .setDescription(
            `— **การดำเนินการ:** ${moderationActionLabel(action, minutes)}\n` +
            `— **ผู้ดำเนินการ:** ${interaction.user.tag}\n` +
            `— **เหตุผล:** ${reason}`
        )
        .setThumbnail(target.user.displayAvatarURL({ dynamic: true, size: 1024 }));
}

function buildCaseInput(interaction, target, action, reason, durationMs, dmSent) {
    return {
        guildId: interaction.guild.id,
        action,
        type: action,
        userId: target.id,
        moderatorId: interaction.user.id,
        reason,
        durationMs,
        source: "command",
        evidence: [
            `Command: /${action}`,
            `Target: ${target.user.tag} (${target.id})`,
            `Moderator: ${interaction.user.tag} (${interaction.user.id})`,
            `DM sent: ${dmSent ? "yes" : "no"}`
        ],
        metadata: {
            channelId: interaction.channel.id,
            dmSent
        }
    };
}

function buildModerationReplyEmbed(interaction, target, action, reason, dmSent, caseNumber) {
    return new MessageEmbed()
        .setColor(config.system.themeColors.success)
        .setAuthor({ name: "ลงดาบผู้กระทำผิดเรียบร้อย", iconURL: interaction.guild.iconURL() })
        .setDescription(
            `> ${config.emojis.success} **ดำเนินการสำเร็จ!**\n` +
            `> ${config.emojis.mod_icon} **Case:** #${caseNumber}\n` +
            `> ${config.emojis.user} **เป้าหมาย:** <@${target.id}>\n` +
            `> ${config.emojis.hammer} **การดำเนินการ:** **${action.toUpperCase()}**\n` +
            `> ${config.emojis.note} **เหตุผล:** ${reason}\n` +
            `> ✉️ **DM:** ${dmSent ? "ส่งสำเร็จ" : "ส่งไม่ได้"}`
        )
        .setThumbnail(target.user.displayAvatarURL({ dynamic: true, size: 1024 }));
}

function moderationErrorReply(err) {
    if (err.message === "MISSING_PERMS") return `> ${config.emojis.error} บอทไม่มีสิทธิ์ที่จำเป็น!`;
    return `> ${config.emojis.error} ไม่สามารถดำเนินการได้ โปรดลองอีกครั้งหรือติดต่อผู้ดูแลระบบ`;
}

module.exports = {
    requiredModerationPermission,
    readModerationInput,
    parseTimeoutDuration,
    moderationActionLabel,
    buildModerationDmEmbed,
    buildCaseInput,
    buildModerationReplyEmbed,
    moderationErrorReply
};
