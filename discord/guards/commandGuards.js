const BLOCKED_MESSAGE_PATTERNS = [
    /discord\.gg\/\S+/gi,
    /https?:\/\/\S+\.(exe|bat|cmd|sh|ps1)/gi
];

function hasPermission(target, permissions, mode = "all") {
    const required = Array.isArray(permissions) ? permissions : [permissions];
    if (!target?.permissions?.has) return false;

    if (mode === "any") {
        return required.some(permission => target.permissions.has(permission));
    }

    return required.every(permission => target.permissions.has(permission));
}

async function safeReply(interaction, payload) {
    if (interaction.deferred) return interaction.editReply(payload).catch(() => {});
    if (interaction.replied) return interaction.followUp(payload).catch(() => {});
    return interaction.reply(payload).catch(() => {});
}

async function safeDefer(interaction, options = {}) {
    if (interaction.deferred || interaction.replied) return false;
    try {
        await interaction.deferReply(options);
        return true;
    } catch {
        return false;
    }
}

async function requireMemberPermission(interaction, permissions, content, options = {}) {
    if (hasPermission(interaction.member, permissions, options.mode)) return true;
    await safeReply(interaction, { content, ephemeral: true });
    return false;
}

async function requireBotPermission(interaction, permissions, content, channel = null, options = {}) {
    const botMember = interaction.guild?.members?.me;
    const permissionTarget = channel && botMember?.permissionsIn
        ? botMember.permissionsIn(channel)
        : botMember;

    if (hasPermission(permissionTarget, permissions, options.mode)) return true;
    await safeReply(interaction, { content, ephemeral: true });
    return false;
}

function checkRoleHierarchy({ interaction, target, client, config }) {
    if (!target) {
        return { ok: false, content: `> ${config.emojis.no_entry} ไม่พบเป้าหมาย!` };
    }

    if (target.id === interaction.user.id) {
        return { ok: false, content: `> ${config.emojis.warning} คุณไม่สามารถทำโทษตัวเองได้!` };
    }

    if (target.id === client.user.id) {
        return { ok: false, content: `> ${config.emojis.warning} คุณไม่สามารถทำโทษบอทระบบได้!` };
    }

    if (target.id === interaction.guild.ownerId) {
        return { ok: false, content: `> ${config.emojis.no_entry} ไม่สามารถทำโทษเจ้าของเซิร์ฟเวอร์ได้!` };
    }

    if (
        target.roles.highest.position >= interaction.member.roles.highest.position &&
        interaction.user.id !== interaction.guild.ownerId
    ) {
        return { ok: false, content: `> ${config.emojis.no_entry} คุณไม่สามารถทำโทษผู้ที่มียศสูงกว่าหรือเท่ากับคุณได้!` };
    }

    if (target.roles.highest.position >= interaction.guild.members.me.roles.highest.position) {
        return { ok: false, content: `> ${config.emojis.error} ยศของบอทต่ำกว่าเป้าหมาย ไม่สามารถทำโทษได้!` };
    }

    return { ok: true };
}

function sanitizeUserMessage(msg, options = {}) {
    if (!msg || typeof msg !== "string") return "";

    const maxLength = options.maxLength || 1000;
    const blockedReplacement = options.blockedReplacement || "[ลิงก์ถูกบล็อก]";

    let clean = msg.slice(0, maxLength);
    clean = clean.replaceAll("@everyone", "@\u200beveryone");
    clean = clean.replaceAll("@here", "@\u200bhere");

    for (const pattern of BLOCKED_MESSAGE_PATTERNS) {
        clean = clean.replace(pattern, blockedReplacement);
    }

    return clean.trim();
}

function isVoicePanelControl(customId, ids, prefixes) {
    if (typeof customId !== "string") return false;

    return [
        ids.BTN_START,
        ids.BTN_STATUS,
        ids.BTN_STOP_ALL
    ].includes(customId) ||
        customId.startsWith(prefixes.STATUS_STOP) ||
        customId.startsWith(prefixes.STATUS_PAGE);
}

module.exports = {
    BLOCKED_MESSAGE_PATTERNS,
    hasPermission,
    requireMemberPermission,
    requireBotPermission,
    checkRoleHierarchy,
    safeReply,
    safeDefer,
    sanitizeUserMessage,
    isVoicePanelControl
};
