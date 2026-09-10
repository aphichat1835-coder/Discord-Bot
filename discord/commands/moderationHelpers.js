const { PermissionFlagsBits } = require("discord.js");
const { MessageEmbed } = require("../core/discordCompat");
const config = require("../config.json");
const { sanitizeLogText } = require("../core/safeLogger");

const TIMEOUT_UNIT_MULTIPLIERS = Object.freeze({
    seconds: 1000,
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000
});

const TIMEOUT_UNIT_LABELS = Object.freeze({
    seconds: "วินาที",
    minutes: "นาที",
    hours: "ชั่วโมง",
    days: "วัน"
});

const MAX_DISCORD_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // 28 days

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

function formatDeleteSeconds(seconds) {
    const s = Number(seconds) || 0;
    if (s <= 0) return "ไม่ลบข้อความ";
    if (s < 3600) return `${Math.round(s / 60)} นาที`;
    if (s < 86400) return `${Math.round(s / 3600)} ชั่วโมง`;
    return `${Math.round(s / 86400)} วัน`;
}

function getMemberOption(options, name) {
    if (!options || typeof options.getMember !== "function") return undefined;
    try {
        return options.getMember(name);
    } catch {
        return undefined;
    }
}

function getStringOption(options, name) {
    if (!options || typeof options.getString !== "function") return undefined;
    try {
        return options.getString(name);
    } catch {
        return undefined;
    }
}

function getIntegerOption(options, name) {
    if (!options || typeof options.getInteger !== "function") return undefined;
    try {
        return options.getInteger(name);
    } catch {
        return undefined;
    }
}

function readModerationInput(interaction) {
    const isBan = interaction?.commandName === "ban";
    const deleteSeconds = isBan ? (getIntegerOption(interaction?.options, "delete_messages") ?? 0) : 0;
    return {
        action: interaction.commandName,
        target: getMemberOption(interaction?.options, "target"),
        reason: safeText(getStringOption(interaction?.options, "reason") || "ไม่มีเหตุผลระบุ", 500),
        deleteMessageSeconds: Math.max(0, Number(deleteSeconds) || 0)
    };
}

function parseTimeoutDuration(interaction, action) {
    if (action !== "timeout") {
        return { ok: true, durationMs: null, minutes: null, formatted: null, isUntimeout: false, clamped: false };
    }
    let rawVal = getIntegerOption(interaction?.options, "duration");
    if (rawVal === null || rawVal === undefined) {
        rawVal = getIntegerOption(interaction?.options, "minutes");
    }
    if (rawVal === null || rawVal === undefined) {
        return { ok: false, content: `> ${config.emojis.error} กรุณาระบุระยะเวลา` };
    }
    const num = Number(rawVal);
    if (!Number.isFinite(num) || num < 0) {
        return { ok: false, content: `> ${config.emojis.error} เวลาต้องไม่ติดลบ!` };
    }
    if (num === 0) {
        return {
            ok: true,
            durationMs: null,
            minutes: 0,
            formatted: "ปลด Timeout",
            isUntimeout: true,
            clamped: false
        };
    }

    const unit = getStringOption(interaction?.options, "unit") || "minutes";
    const mult = TIMEOUT_UNIT_MULTIPLIERS[unit] || TIMEOUT_UNIT_MULTIPLIERS.minutes;
    let durationMs = num * mult;
    let clamped = false;
    if (durationMs > MAX_DISCORD_TIMEOUT_MS) {
        durationMs = MAX_DISCORD_TIMEOUT_MS;
        clamped = true;
    }

    const label = TIMEOUT_UNIT_LABELS[unit] || "นาที";
    const formatted = `${num.toLocaleString()} ${label}`;
    const minutes = Math.round(durationMs / 60000);

    return {
        ok: true,
        durationMs,
        minutes,
        formatted,
        isUntimeout: false,
        clamped
    };
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
            `Target: ${target.user?.tag || target.id} (${target.id})`,
            `Moderator: ${interaction.user.tag} (${interaction.user.id})`
        ],
        metadata: {
            channelId: interaction.channel.id
        }
    };
}

function resolveModerationMeta(action, extra = {}) {
    const isUntimeout = Boolean(extra.isUntimeout || extra.duration?.isUntimeout);
    if (action === "ban") {
        return {
            color: config.system.themeColors.error || "#ED4245",
            title: "🔨 แบนสมาชิกเรียบร้อย",
            label: "BAN"
        };
    }
    if (action === "kick") {
        return {
            color: config.system.themeColors.warning || "#FEE75C",
            title: "👢 เตะสมาชิกเรียบร้อย",
            label: "KICK"
        };
    }
    if (isUntimeout) {
        return {
            color: config.system.themeColors.success || "#57F287",
            title: "🕊️ ปลดระงับการใช้งาน (Untimeout) เรียบร้อย",
            label: "UNTIMEOUT"
        };
    }
    return {
        color: config.system.themeColors.primary || "#5865F2",
        title: "⏳ ระงับการใช้งานสมาชิกชั่วคราว (Timeout) เรียบร้อย",
        label: "TIMEOUT"
    };
}

function buildModerationActionDetailLines(action, extra = {}) {
    const lines = [];
    if (action === "timeout") {
        const durFormatted = extra.duration?.formatted || (extra.duration?.minutes ? `${extra.duration.minutes} นาที` : null);
        if (durFormatted) {
            lines.push(`> ⏱️ **ระยะเวลา:** ${durFormatted}`);
        }
        if (extra.duration?.clamped) {
            lines.push(`> ⚠️ *ปรับลดเวลาลงมาที่ขีดจำกัดสูงสุดของ Discord (28 วัน) โดยอัตโนมัติ*`);
        }
    } else if (action === "ban" && extra.deleteMessageSeconds !== undefined) {
        lines.push(`> 🗑️ **ลบข้อความ:** ${formatDeleteSeconds(extra.deleteMessageSeconds)}`);
    }
    return lines;
}

function buildModerationReplyEmbed(interaction, target, action, reason, caseNumber, extra = {}) {
    const meta = resolveModerationMeta(action, extra);
    const targetTag = target.user?.tag ? ` (\`${target.user.tag}\`)` : "";
    const detailLines = buildModerationActionDetailLines(action, extra);
    const lines = [
        `> ${config.emojis.success || "✅"} **ดำเนินการสำเร็จ!**`,
        `> ${config.emojis.mod_icon || "📋"} **Case:** #${caseNumber}`,
        `> ${config.emojis.user || "👤"} **เป้าหมาย:** <@${target.id}>${targetTag}`,
        `> ${config.emojis.hammer || "⚖️"} **การดำเนินการ:** **${meta.label}**`,
        ...detailLines,
        `> 👮 **ผู้ลงโทษ:** <@${interaction.user.id}>`,
        `> ${config.emojis.note || "📝"} **เหตุผล:** ${reason}`
    ];

    const embed = new MessageEmbed()
        .setColor(meta.color)
        .setAuthor({
            name: meta.title,
            iconURL: interaction.guild?.iconURL?.() || undefined
        })
        .setDescription(lines.join("\n"));

    const avatarUrl = target.user?.displayAvatarURL?.({ forceStatic: false, size: 1024 });
    if (avatarUrl) {
        embed.setThumbnail(avatarUrl);
    }

    embed.setFooter({
        text: `เซิร์ฟเวอร์: ${interaction.guild?.name || "-"} • ผู้สั่งการ: ${interaction.user.tag}`,
        iconURL: interaction.user?.displayAvatarURL?.() || undefined
    });
    embed.setTimestamp();

    return embed;
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
    moderationErrorReply,
    formatDeleteSeconds
};
