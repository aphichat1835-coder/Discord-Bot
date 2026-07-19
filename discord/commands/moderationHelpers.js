const { MessageEmbed } = require("discord.js");
const config = require("../config.json");
const { sanitizeLogText } = require("../core/safeLogger");
const { design } = require("../dm");

function safeText(value, max = 500) {
    return sanitizeLogText(String(value ?? "")).slice(0, Math.max(1, Number(max) || 500)) || "-";
}

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

function moderationActionLabel(action, minutes = null) {
    if (action === "ban") return "แบนถาวร";
    if (action === "kick") return "เตะออกจากเซิร์ฟเวอร์";
    if (action === "timeout") return `หมดเวลา ${minutes} นาที ${config.emojis.timeout_icon}`;
    return action;
}

function moderationTitle(action, state) {
    const labels = {
        ban: "การแบน",
        kick: "การเตะออก",
        timeout: "การหมดเวลา"
    };
    const label = labels[action] || "การลงโทษ";
    if (state === "pending") return `⏳ กำลังดำเนิน${label}`;
    if (state === "failed") return `⚠️ ยกเลิก${label}`;
    return `🛡️ ${label}มีผลแล้ว`;
}

function moderationSummary(state, actionLabel) {
    if (state === "pending") {
        return `เซิร์ฟเวอร์ได้รับคำสั่ง ${actionLabel} แล้ว แต่ยังไม่ยืนยันผลจาก Discord`;
    }
    if (state === "failed") {
        return `Discord ไม่ได้ดำเนินการ ${actionLabel} คำสั่งครั้งนี้จึงไม่มีผล`;
    }
    return `Discord ยืนยันแล้วว่าการดำเนินการ ${actionLabel} สำเร็จ`;
}

function moderationTone(state) {
    if (state === "failed") return "warning";
    if (state === "pending") return "action";
    return "danger";
}

function buildModerationDmEmbed(interaction, target, action, reason, minutes = null, options = {}) {
    const state = options.state || "succeeded";
    const caseNumber = options.caseNumber || "กำลังสร้าง";
    const actionLabel = moderationActionLabel(action, minutes);
    const endsAt = action === "timeout" && options.endsAt
        ? `<t:${Math.floor(Number(options.endsAt) / 1000)}:F>`
        : null;
    const summary = moderationSummary(state, actionLabel);
    let nextAction = "หากต้องการสอบถามเหตุผลหรืออุทธรณ์ โปรดติดต่อผู้ดูแลเซิร์ฟเวอร์โดยตรง";
    if (state === "pending") {
        nextAction = "รอข้อความอัปเดตผล ข้อความนี้ยังไม่ใช่การยืนยันว่าคุณถูกลงโทษ";
    } else if (state === "failed") {
        nextAction = "คุณไม่ถูกลงโทษจากคำสั่งครั้งนี้ หากพบสถานะไม่ตรงกันให้ติดต่อผู้ดูแลเซิร์ฟเวอร์";
    }

    return design.buildDmEmbed({
        tone: moderationTone(state),
        title: moderationTitle(action, state),
        summary,
        profile: design.profileFromUser(target.user, { id: target.id }),
        fields: [
            { name: "🏠 เซิร์ฟเวอร์", value: `${design.markdownText(interaction.guild.name, "ไม่ทราบเซิร์ฟเวอร์", 100)}\n${design.code(interaction.guild.id)}`, inline: true },
            { name: "🛡️ การดำเนินการ", value: actionLabel, inline: true },
            { name: "👮 ผู้ดำเนินการ", value: `${design.markdownText(interaction.user.tag, "ผู้ดูแล", 100)}\n${design.code(interaction.user.id)}`, inline: true },
            ...(endsAt ? [{ name: "⏰ สิ้นสุดการหมดเวลา", value: endsAt, inline: true }] : [])
        ],
        details: reason,
        nextAction,
        referenceId: `CASE-${caseNumber}`,
        footer: "Phomueangtai • การดูแลเซิร์ฟเวอร์"
    });
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
    moderationTitle,
    moderationSummary,
    moderationTone,
    buildModerationDmEmbed,
    buildCaseInput,
    buildModerationReplyEmbed,
    moderationErrorReply
};
