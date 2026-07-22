"use strict";

const { MessageEmbed } = require("discord.js");

const COLORS = Object.freeze({
    success: "#57F287",
    info: "#5865F2",
    warning: "#FEE75C",
    action: "#F59E0B",
    danger: "#ED4245",
    neutral: "#747F8D"
});

function safeText(value, fallback = "ไม่ทราบ", max = 1024) {
    const cleaned = String(value ?? "")
        .replaceAll("@", "＠")
        .replaceAll("\r", "")
        .replaceAll(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ")
        .split("\n")
        .map(line => line.replaceAll(/\s+/g, " ").trim())
        .join("\n")
        .trim()
        .slice(0, Math.max(1, Number(max) || 1024));
    return cleaned || fallback;
}

function code(value, fallback = "ไม่ทราบ") {
    return `\`${safeText(value, fallback, 180).replaceAll("`", "ˋ")}\``;
}

function markdownText(value, fallback = "ไม่ทราบ", max = 1024) {
    return safeText(value, fallback, max)
        .replaceAll("\\", "＼")
        .replaceAll("`", "ˋ")
        .replaceAll("*", "＊")
        .replaceAll("_", "＿")
        .replaceAll("~", "～")
        .replaceAll("|", "｜")
        .replaceAll(">", "＞");
}

function profileFromUser(user, fallback = {}) {
    const id = safeText(user?.id || fallback.id, "ไม่ทราบ", 32);
    const username = safeText(user?.username || fallback.username, "ไม่ทราบชื่อ", 80);
    const globalName = safeText(user?.globalName || fallback.globalName || fallback.displayName, username, 80);
    const discriminator = safeText(user?.discriminator || fallback.discriminator, "0", 8);
    const tag = discriminator && discriminator !== "0" ? `${username}#${discriminator}` : `@${username}`;
    let avatarUrl = fallback.avatarUrl || fallback.avatar || null;
    if (typeof user?.displayAvatarURL === "function") {
        avatarUrl = user.displayAvatarURL({ dynamic: true, size: 256 });
    }
    return { id, username, globalName, tag, avatarUrl };
}

function profileField(profile) {
    return {
        name: "👤 บัญชีที่เกี่ยวข้อง",
        value: `**${markdownText(profile.globalName, "ไม่ทราบชื่อ", 80)}**\n${markdownText(profile.tag, "ไม่ทราบ", 100)}\n${code(profile.id)}`,
        inline: true
    };
}

function normalizeFields(fields = []) {
    return fields.slice(0, 20).map(field => ({
        name: safeText(field.name, "รายละเอียด", 256),
        value: safeText(field.value, "-", 1024),
        inline: field.inline === true
    }));
}

function fitFields(fields, baseLength, maxLength = 5800) {
    let used = Math.max(0, Number(baseLength) || 0);
    const fitted = [];
    for (const field of fields.slice(0, 25)) {
        const name = safeText(field.name, "รายละเอียด", 256);
        const remaining = maxLength - used - name.length;
        if (remaining < 1) break;
        const value = safeText(field.value, "-", Math.min(1024, remaining));
        fitted.push({ name, value, inline: field.inline === true });
        used += name.length + value.length;
    }
    return fitted;
}

function buildDmEmbed(options = {}) {
    const timestamp = Number(options.timestamp || Date.now());
    const profile = options.profile || profileFromUser(null);
    const title = safeText(options.title, "🔔 การแจ้งเตือน", 256);
    const summary = safeText(options.summary, "มีการเปลี่ยนแปลงที่ควรตรวจสอบ", 2048);
    const footer = safeText(options.footer, "Phomueangtai • แจ้งเตือนส่วนตัว", 2048);
    const fieldCandidates = [profileField(profile), ...normalizeFields(options.fields)];
    if (options.details) fieldCandidates.push({ name: "📋 รายละเอียด", value: markdownText(options.details, "-", 1024) });
    if (options.nextAction) fieldCandidates.push({ name: "💡 สิ่งที่ควรทำ", value: safeText(options.nextAction, "-", 1024) });
    fieldCandidates.push(
        { name: "🧾 รหัสอ้างอิง", value: code(options.referenceId || "ไม่มี"), inline: true },
        { name: "🕒 เวลา", value: `<t:${Math.floor(timestamp / 1000)}:F>`, inline: true }
    );
    const fields = fitFields(fieldCandidates, title.length + summary.length + footer.length);

    const embed = new MessageEmbed()
        .setColor(COLORS[options.tone] || COLORS.info)
        .setTitle(title)
        .setDescription(summary)
        .addFields(fields)
        .setTimestamp(timestamp)
        .setFooter({ text: footer });

    if (profile.avatarUrl) embed.setThumbnail(profile.avatarUrl);
    return embed;
}

module.exports = {
    COLORS,
    safeText,
    markdownText,
    code,
    profileFromUser,
    profileField,
    fitFields,
    buildDmEmbed
};
