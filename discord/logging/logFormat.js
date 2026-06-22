/*
 * Koya-style audit embed formatting helpers.
 * This file should stay presentation-focused; routing/queueing lives in logCore.js.
 */

const { MessageEmbed } = require("discord.js");
const config = require("../config.json");
const { safeAuditText, LOG_CHANNEL_TYPES } = require("./logCore");

const DISCORD_FIELD_VALUE_LIMIT = 1024;
const DISCORD_FIELD_NAME_LIMIT = 256;
const MAX_FIELDS = 25;
const MAX_DESCRIPTION = 3900;
const MAX_TITLE = 256;

const CATEGORY_COLORS = Object.freeze({
    [LOG_CHANNEL_TYPES.MESSAGE]: config.system.themeColors.info,
    [LOG_CHANNEL_TYPES.MEMBER]: config.system.themeColors.primary,
    [LOG_CHANNEL_TYPES.VOICE]: config.system.themeColors.info,
    [LOG_CHANNEL_TYPES.SERVER]: config.system.themeColors.warning,
    [LOG_CHANNEL_TYPES.SECURITY]: config.system.themeColors.error,
    [LOG_CHANNEL_TYPES.MODERATION]: config.system.themeColors.error
});

const SEVERITY_COLORS = Object.freeze({
    info: config.system.themeColors.info,
    success: config.system.themeColors.success,
    warning: config.system.themeColors.warning,
    danger: config.system.themeColors.error,
    critical: config.system.themeColors.error,
    error: config.system.themeColors.error
});

function field(name, value, inline = false) {
    return {
        name: safeAuditText(name, DISCORD_FIELD_NAME_LIMIT),
        value: safeAuditText(value, DISCORD_FIELD_VALUE_LIMIT),
        inline: !!inline
    };
}

function mentionUser(userId) {
    return userId ? `<@${userId}>` : "ไม่ทราบ";
}

function mentionChannel(channelId) {
    return channelId ? `<#${channelId}>` : "ไม่ทราบ";
}

function idLine(label, id) {
    return `${label}: ${id ? `\`${safeAuditText(id, 64)}\`` : "ไม่ทราบ"}`;
}

function buildIdBlock(ids = {}) {
    const lines = [];
    if (ids.userId) lines.push(idLine("User ID", ids.userId));
    if (ids.actorId) lines.push(idLine("Actor ID", ids.actorId));
    if (ids.targetId) lines.push(idLine("Target ID", ids.targetId));
    if (ids.channelId) lines.push(idLine("Channel ID", ids.channelId));
    if (ids.messageId) lines.push(idLine("Message ID", ids.messageId));
    if (ids.roleId) lines.push(idLine("Role ID", ids.roleId));
    if (ids.caseNumber) lines.push(idLine("Case", `#${ids.caseNumber}`));
    return lines.length ? lines.join("\n") : null;
}

function userDisplay(user) {
    if (!user) return "ไม่ทราบ";
    const tag = user.tag || user.username || user.globalName || user.id || "Unknown";
    return `${mentionUser(user.id)} (\`${safeAuditText(tag, 80)}\`)`;
}

function memberDisplay(member) {
    if (!member) return "ไม่ทราบ";
    return userDisplay(member.user || member);
}

function jumpLink(guildId, channelId, messageId) {
    if (!guildId || !channelId || !messageId) return null;
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function timestampUnix(ms) {
    const raw = Number(ms);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.floor(raw / 1000);
}

function formatDiscordTime(ms, style = "F") {
    const unix = timestampUnix(ms);
    return unix ? `<t:${unix}:${style}>` : "ไม่ทราบ";
}

function beforeAfterFields(before, after, beforeName = "ก่อน", afterName = "หลัง") {
    const out = [];
    if (before !== undefined) out.push(field(beforeName, before || "-", false));
    if (after !== undefined) out.push(field(afterName, after || "-", false));
    return out;
}

function attachmentFields(attachments = []) {
    const list = Array.isArray(attachments)
        ? attachments
        : Array.from(attachments?.values?.() || []);

    if (list.length === 0) return { fields: [], image: null };

    const previewable = list.find(a => {
        const url = String(a.url || a.proxyURL || "");
        return /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url);
    });

    const lines = list.slice(0, 8).map((a, index) => {
        const name = a.name || a.filename || `attachment-${index + 1}`;
        const url = a.url || a.proxyURL || "";
        return url ? `• [${safeAuditText(name, 80)}](${url})` : `• ${safeAuditText(name, 80)}`;
    });

    if (list.length > 8) lines.push(`... และอีก ${list.length - 8} ไฟล์`);

    return {
        fields: [field("📎 ไฟล์แนบ", lines.join("\n"), false)],
        image: previewable?.url || previewable?.proxyURL || null
    };
}

function normalizeFields(fields = []) {
    return fields
        .filter(Boolean)
        .slice(0, MAX_FIELDS)
        .map(f => field(f.name, f.value, f.inline));
}

function getColor({ color, severity, category } = {}) {
    if (color) return color;
    if (severity && SEVERITY_COLORS[severity]) return SEVERITY_COLORS[severity];
    if (category && CATEGORY_COLORS[category]) return CATEGORY_COLORS[category];
    return config.system.themeColors.info;
}

function buildLogEmbed(options = {}) {
    const embed = new MessageEmbed()
        .setColor(getColor(options))
        .setTitle(safeAuditText(options.title || "Audit Log", MAX_TITLE))
        .setTimestamp(options.timestamp ? new Date(options.timestamp) : new Date());

    if (options.description) {
        embed.setDescription(safeAuditText(options.description, MAX_DESCRIPTION));
    }

    const authorUser = options.author || options.user || options.actor || null;
    if (authorUser?.displayAvatarURL) {
        embed.setAuthor({
            name: safeAuditText(options.authorName || authorUser.tag || authorUser.username || "Audit Event", 256),
            iconURL: authorUser.displayAvatarURL({ dynamic: true, size: 128 })
        });
    } else if (options.authorName) {
        embed.setAuthor({ name: safeAuditText(options.authorName, 256) });
    }

    const thumbUser = options.thumbnailUser || options.targetUser || options.user || null;
    if (!options.noThumbnail && thumbUser?.displayAvatarURL) {
        embed.setThumbnail(thumbUser.displayAvatarURL({ dynamic: true, size: 256 }));
    } else if (options.thumbnail) {
        embed.setThumbnail(options.thumbnail);
    }

    const fields = [];

    if (options.actor || options.actorId) {
        fields.push(field("👮 ผู้ดำเนินการ", options.actor ? userDisplay(options.actor) : mentionUser(options.actorId), true));
    }
    if (options.target || options.targetId) {
        fields.push(field("🎯 เป้าหมาย", options.target ? memberDisplay(options.target) : mentionUser(options.targetId), true));
    }
    if (options.channel || options.channelId) {
        fields.push(field("📌 ห้อง", options.channel ? `${options.channel} (\`${options.channel.id}\`)` : mentionChannel(options.channelId), true));
    }

    if (options.reason) fields.push(field("📋 เหตุผล", options.reason, false));
    if (options.before !== undefined || options.after !== undefined) {
        fields.push(...beforeAfterFields(options.before, options.after));
    }

    const idBlock = buildIdBlock(options.ids || {});
    if (idBlock) fields.push(field("🧾 IDs", idBlock, false));

    const link = options.jumpLink || jumpLink(options.guildId, options.channelId, options.messageId);
    if (link) fields.push(field("🔗 Jump", `[เปิดข้อความ](${link})`, true));

    if (options.messageCreatedAt) {
        fields.push(field("🕒 Message Date", formatDiscordTime(options.messageCreatedAt), true));
    }

    const attachmentData = attachmentFields(options.attachments);
    fields.push(...attachmentData.fields);

    if (Array.isArray(options.fields)) fields.push(...options.fields);
    embed.addFields(normalizeFields(fields));

    if (attachmentData.image && !options.image) embed.setImage(attachmentData.image);
    if (options.image) embed.setImage(options.image);

    embed.setFooter({
        text: safeAuditText(options.footer || `${config.system?.name || "Phomueangtai"} Audit System`, 2048),
        iconURL: options.footerIcon || undefined
    });

    return embed;
}

function buildCaseEmbed(caseDoc = {}, options = {}) {
    return buildLogEmbed({
        category: LOG_CHANNEL_TYPES.MODERATION,
        severity: options.severity || "danger",
        title: options.title || `🛡️ Moderation Case #${caseDoc.caseNumber || "?"}`,
        targetId: caseDoc.userId,
        actorId: caseDoc.moderatorId,
        reason: caseDoc.reason,
        ids: {
            caseNumber: caseDoc.caseNumber,
            userId: caseDoc.userId,
            actorId: caseDoc.moderatorId
        },
        fields: [
            field("⚖️ Action", String(caseDoc.action || caseDoc.type || "UNKNOWN").toUpperCase(), true),
            field("📌 Status", caseDoc.status || "active", true),
            ...(caseDoc.durationMs ? [field("⏳ Duration", `${Math.round(caseDoc.durationMs / 60000)} นาที`, true)] : []),
            ...(caseDoc.expiresAt ? [field("⏰ Expires", formatDiscordTime(caseDoc.expiresAt, "R"), true)] : []),
            ...(caseDoc.source ? [field("📡 Source", caseDoc.source, true)] : []),
            ...(Array.isArray(caseDoc.evidence) && caseDoc.evidence.length
                ? [field("🧩 Evidence", caseDoc.evidence.slice(0, 8).map(e => `• ${safeAuditText(e, 180)}`).join("\n"), false)]
                : [])
        ]
    });
}

module.exports = {
    CATEGORY_COLORS,
    SEVERITY_COLORS,
    field,
    mentionUser,
    mentionChannel,
    userDisplay,
    memberDisplay,
    jumpLink,
    formatDiscordTime,
    beforeAfterFields,
    attachmentFields,
    normalizeFields,
    buildIdBlock,
    buildLogEmbed,
    buildCaseEmbed
};
