const { PermissionFlagsBits } = require("discord.js");
const { MessageEmbed } = require("../core/discordCompat");
const config = require("../config.json");
const { sanitizeLogText } = require("../core/safeLogger");

function safeText(value, max = 500) {
    return sanitizeLogText(String(value ?? "")).slice(0, Math.max(1, Number(max) || 500)) || "-";
}

function requiredModerationPermission(action) {
    return {
        ban: PermissionFlagsBits.BanMembers,
        kick: PermissionFlagsBits.KickMembers,
        timeout: PermissionFlagsBits.ModerateMembers
    }[action] || null;
}

function readModerationInput(interaction) {
    return {
        action: interaction.commandName,
        target: interaction.options.getMember("target"),
        reason: safeText(interaction.options.getString("reason") || "ไม่มีเหตุผลระบุ", 500)
    };
}

function parseTimeoutDuration(interaction, action) {
    if (action !== "timeout") return { ok: true, durationMs: null, minutes: null };
    const minutes = interaction.options.getInteger("minutes");
    if (minutes <= 0) return { ok: false, content: `> ${config.emojis.error} เวลาต้องมากกว่า 0 นาที!` };
    if (minutes > 40000) return { ok: false, content: `> ${config.emojis.error} เกินขีดจำกัด Discord (สูงสุด ~40,000 นาที)` };
    return { ok: true, durationMs: minutes * 60000, minutes };
}

function buildCaseInput(interaction, target, action, reason, durationMs) {
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
            `Moderator: ${interaction.user.tag} (${interaction.user.id})`
        ],
        metadata: {
            channelId: interaction.channel.id
        }
    };
}

function buildModerationReplyEmbed(interaction, target, action, reason, caseNumber) {
    return new MessageEmbed()
        .setColor(config.system.themeColors.success)
        .setAuthor({ name: "ลงดาบผู้กระทำผิดเรียบร้อย", iconURL: interaction.guild.iconURL() })
        .setDescription(
            `> ${config.emojis.success} **ดำเนินการสำเร็จ!**\n` +
            `> ${config.emojis.mod_icon} **Case:** #${caseNumber}\n` +
            `> ${config.emojis.user} **เป้าหมาย:** <@${target.id}>\n` +
            `> ${config.emojis.hammer} **การดำเนินการ:** **${action.toUpperCase()}**\n` +
            `> ${config.emojis.note} **เหตุผล:** ${reason}`
        )
        .setThumbnail(target.user.displayAvatarURL({ forceStatic: false, size: 1024 }));
}

function moderationErrorReply(err) {
    if (err.message === "MISSING_PERMS") return `> ${config.emojis.error} บอทไม่มีสิทธิ์ที่จำเป็น!`;
    return `> ${config.emojis.error} ไม่สามารถดำเนินการได้ โปรดลองอีกครั้งหรือติดต่อผู้ดูแลระบบ`;
}

module.exports = {
    requiredModerationPermission,
    readModerationInput,
    parseTimeoutDuration,
    buildCaseInput,
    buildModerationReplyEmbed,
    moderationErrorReply
};
