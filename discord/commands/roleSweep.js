const crypto = require("node:crypto");
const { PermissionFlagsBits } = require("discord.js");
const config = require("../config.json");
const {
    requireBotPermission,
    safeDefer,
    markCommandAccepted
} = require("../guards/commandGuards");

const CONFIRMATION_TEXT = "ยืนยัน";
const CONFIRMATION_TIMEOUT_MS = 60_000;
const ROLE_ID_PATTERN = /^\d{17,22}$/;
const pendingByGuild = new Map();
const activeByGuild = new Map();
const previewingByGuild = new Map();

function valuesOf(collection) {
    if (!collection) return [];
    if (typeof collection.values === "function") return Array.from(collection.values());
    if (Array.isArray(collection)) return collection;
    return Object.values(collection);
}

function getRoleValues(guild) {
    return valuesOf(guild?.roles?.cache);
}

function getMemberRoles(member) {
    return valuesOf(member?.roles?.cache);
}

function isGuildOwner(actorId, guild) {
    return String(actorId || "") === String(guild?.ownerId || "") ||
        String(actorId || "") === String(config.system.ownerId || "");
}

function isEveryoneRole(role, guild) {
    return String(role?.id || "") === String(guild?.id || "");
}

function dedupeRoleIds(roleIds = []) {
    return [...new Set(roleIds.map(roleId => String(roleId || "")).filter(Boolean))];
}

function parseShortcutRoleIds(content) {
    const shortcut = "//รียศ";
    const input = String(content || "").trim();
    if (!input.startsWith(shortcut)) return { matched: false, roleIds: [] };
    const remainder = input.slice(shortcut.length);
    if (remainder && remainder.trimStart() === remainder) return { matched: false, roleIds: [] };
    const raw = remainder.trim();
    if (!raw) return { matched: true, roleIds: [] };
    const roleIdInput = raw.split(/\s+/u);
    if (roleIdInput.some(roleId => !ROLE_ID_PATTERN.test(roleId))) {
        return { matched: true, error: "รูปแบบ Role ID ไม่ถูกต้อง" };
    }
    return { matched: true, roleIds: dedupeRoleIds(roleIdInput) };
}

function roleCatalogFingerprint(guild) {
    return getRoleValues(guild)
        .filter(role => !isEveryoneRole(role, guild))
        .map(role => `${role.id}:${Number(role.position || 0)}:${role.managed === true ? 1 : 0}`)
        .sort((left, right) => left.localeCompare(right));
}

function roleAssignmentFingerprint(guild, members) {
    const roleCatalog = roleCatalogFingerprint(guild);
    const assignments = valuesOf(members)
        .filter(member => !member?.user?.bot)
        .map(member => `${member.id}:${getMemberRoles(member)
            .filter(role => !isEveryoneRole(role, guild))
            .map(role => String(role.id))
            .sort((left, right) => left.localeCompare(right))
            .join(",")}`)
        .sort((left, right) => left.localeCompare(right));
    const botMember = guild?.members?.me;
    const botRoles = getMemberRoles(botMember)
        .filter(role => !isEveryoneRole(role, guild))
        .map(role => String(role.id))
        .sort((left, right) => left.localeCompare(right));
    const botHighestRole = botMember?.roles?.highest;
    return crypto.createHash("sha256")
        .update(JSON.stringify({
            guildOwnerId: String(guild?.ownerId || ""),
            roleCatalog,
            assignments,
            bot: {
                id: String(botMember?.id || ""),
                roles: botRoles,
                highestRoleId: String(botHighestRole?.id || ""),
                highestRolePosition: Number(botHighestRole?.position || 0)
            }
        }))
        .digest("hex");
}

function memberIsManageable(member, guild, botPosition) {
    if (!member || String(member.id) === String(guild?.ownerId || "")) return false;
    if (member.manageable === false) return false;
    return Number(member?.roles?.highest?.position || 0) < botPosition;
}

function scanGuildRoles(guild, members, actorId, exceptRoleIds = []) {
    const roles = getRoleValues(guild);
    const humans = valuesOf(members).filter(member => !member?.user?.bot);
    const botPosition = Number(guild?.members?.me?.roles?.highest?.position || -1);
    const exceptions = new Set(dedupeRoleIds(exceptRoleIds));
    const targets = [];

    for (const member of humans) {
        if (String(member.id) === String(actorId)) continue;
        if (!memberIsManageable(member, guild, botPosition)) continue;
        const roleIds = getMemberRoles(member)
            .filter(role => !isEveryoneRole(role, guild))
            .filter(role => role.managed !== true)
            .filter(role => Number(role.position || 0) < botPosition)
            .filter(role => !exceptions.has(String(role.id)))
            .map(role => String(role.id));
        if (roleIds.length > 0) targets.push({ member, roleIds });
    }

    return {
        stats: {
            totalRoles: roles.filter(role => !isEveryoneRole(role, guild)).length,
            totalAssignments: humans.reduce((total, member) => total + getMemberRoles(member)
                .filter(role => !isEveryoneRole(role, guild)).length, 0)
        },
        targets,
        fingerprint: roleAssignmentFingerprint(guild, members)
    };
}

async function fetchAllMembers(guild) {
    if (typeof guild?.members?.fetch !== "function") throw new Error("GUILD_MEMBER_FETCH_UNAVAILABLE");
    const beforeCount = Number(guild.memberCount);
    if (!Number.isSafeInteger(beforeCount) || beforeCount < 0) {
        throw new Error("GUILD_MEMBER_COUNT_UNAVAILABLE");
    }
    const members = await guild.members.fetch();
    const afterCount = Number(guild.memberCount);
    if (!members || typeof members.values !== "function" || !Number.isSafeInteger(members.size) ||
        !Number.isSafeInteger(afterCount) || afterCount < 0 ||
        beforeCount !== afterCount || members.size !== afterCount) {
        throw new Error("GUILD_MEMBER_FETCH_INCOMPLETE");
    }
    return members;
}

function botCanOperate(guild, channel) {
    const botMember = guild?.members?.me;
    const permissionTarget = channel && typeof botMember?.permissionsIn === "function"
        ? botMember.permissionsIn(channel)
        : botMember?.permissions;
    return permissionTarget?.has?.([
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages
    ]) === true;
}

async function replyMessage(message, content) {
    return message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }).catch(() => null);
}

function previewText(stats) {
    return `> ${config.emojis.warning} **ตรวจพบข้อมูลก่อนกวาดยศ**\n` +
        `> ยศทั้งหมด (ไม่รวม @everyone): **${stats.totalRoles}**\n` +
        `> ยศที่สมาชิกถือรวมแบบนับซ้ำ: **${stats.totalAssignments}**\n` +
        `> พิมพ์ **${CONFIRMATION_TEXT}** ในห้องนี้ภายใน 60 วินาทีเพื่อเริ่มดำเนินการ`;
}

function clearPending(guildId, expectedPending = null) {
    const pending = pendingByGuild.get(String(guildId));
    if (!pending || (expectedPending && pending !== expectedPending)) return null;
    clearTimeout(pending.timeout);
    pendingByGuild.delete(String(guildId));
    return pending;
}

function getConfirmationTimeout(timeoutMs) {
    const parsed = Number(timeoutMs);
    if (!Number.isFinite(parsed) || parsed <= 0) return CONFIRMATION_TIMEOUT_MS;
    return Math.max(1, Math.floor(parsed));
}

function previewWasCancelled(guildId, controller) {
    return controller.cancelled || previewingByGuild.get(String(guildId)) !== controller;
}

async function startPreview({ guild, channel, actorId, exceptRoleIds, respond, timeoutMs = CONFIRMATION_TIMEOUT_MS }) {
    const guildId = String(guild?.id || "");
    if (!guildId) return false;
    if (pendingByGuild.has(guildId) || activeByGuild.has(guildId) || previewingByGuild.has(guildId)) {
        await respond(`> ${config.emojis.warning} เซิร์ฟเวอร์นี้มีงานกวาดยศที่รอยืนยันหรือกำลังทำงานอยู่`);
        return false;
    }
    const controller = { cancelled: false };
    previewingByGuild.set(guildId, controller);

    try {
        let members;
        try {
            members = await fetchAllMembers(guild);
        } catch {
            if (previewWasCancelled(guildId, controller)) return false;
            await respond(`> ${config.emojis.error} ดึงรายชื่อสมาชิกไม่ครบ จึงยังไม่ถอดยศใด ๆ`);
            return false;
        }
        if (previewWasCancelled(guildId, controller)) return false;

        const scan = scanGuildRoles(guild, members, actorId, exceptRoleIds);
        if (scan.targets.length === 0) {
            if (previewWasCancelled(guildId, controller)) return false;
            await respond(`${previewText(scan.stats)}\n> ${config.emojis.warning} ไม่พบยศที่ถอดได้ตามเงื่อนไข จึงไม่สร้างงานรอยืนยัน`);
            return false;
        }

        const confirmationTimeout = getConfirmationTimeout(timeoutMs);
        const expiresAt = Date.now() + confirmationTimeout;
        let pending;
        const timeout = setTimeout(() => {
            const expired = clearPending(guildId, pending);
            if (expired) Promise.resolve(
                expired.respond(`> ${config.emojis.warning} งานกวาดยศหมดเวลายืนยันแล้ว`)
            ).catch(() => {});
        }, confirmationTimeout);
        timeout.unref?.();
        if (previewWasCancelled(guildId, controller)) {
            clearTimeout(timeout);
            return false;
        }
        pending = {
            guild,
            guildId,
            channelId: String(channel?.id || ""),
            actorId: String(actorId),
            exceptRoleIds: dedupeRoleIds(exceptRoleIds),
            fingerprint: scan.fingerprint,
            respond,
            timeout,
            expiresAt
        };
        pendingByGuild.set(guildId, pending);
        try {
            await respond(previewText(scan.stats));
            if (previewWasCancelled(guildId, controller)) {
                clearPending(guildId, pending);
                return false;
            }
            return true;
        } catch {
            clearPending(guildId, pending);
            return false;
        }
    } finally {
        if (previewingByGuild.get(guildId) === controller) previewingByGuild.delete(guildId);
    }
}

async function executeSweep(pending, message) {
    const controller = { cancelled: false };
    activeByGuild.set(pending.guildId, controller);
    try {
        if (!botCanOperate(pending.guild, message?.channel)) {
            return await replyMessage(message, `> ${config.emojis.error} บอทต้องมี VIEW_CHANNEL, SEND_MESSAGES และ MANAGE_ROLES ก่อนเริ่มกวาดยศ`);
        }
        let members;
        try {
            members = await fetchAllMembers(pending.guild);
        } catch {
            return await replyMessage(message, `> ${config.emojis.error} ดึงรายชื่อสมาชิกใหม่ไม่สำเร็จ จึงไม่ถอดยศใด ๆ`);
        }
        const scan = scanGuildRoles(pending.guild, members, pending.actorId, pending.exceptRoleIds);
        if (scan.fingerprint !== pending.fingerprint) {
            return await replyMessage(message, `> ${config.emojis.warning} ข้อมูลยศเปลี่ยนหลังพรีวิว กรุณาเรียกคำสั่งใหม่เพื่อคำนวณอีกครั้ง`);
        }

        let changedMembers = 0;
        let removedAssignments = 0;
        let failedAssignments = 0;
        for (const target of scan.targets) {
            if (controller.cancelled) break;
            try {
                await target.member.roles.remove(target.roleIds, `Role sweep requested by ${pending.actorId}`);
                changedMembers++;
                removedAssignments += target.roleIds.length;
            } catch {
                failedAssignments += target.roleIds.length;
            }
        }

        const cancelled = controller.cancelled;
        return await replyMessage(
            message,
            `> ${cancelled ? config.emojis.warning : config.emojis.success} ${cancelled ? "หยุดงานกวาดยศแล้ว" : "กวาดยศเสร็จแล้ว"}\n` +
            `> สมาชิกที่เปลี่ยนแปลง: **${changedMembers}**\n` +
            `> ยศที่ถอดสำเร็จ: **${removedAssignments}**\n` +
            `> ยศที่ถอดไม่สำเร็จ: **${failedAssignments}**`
        );
    } finally {
        if (activeByGuild.get(pending.guildId) === controller) activeByGuild.delete(pending.guildId);
    }
}

async function handleConfirmation(message) {
    const pending = pendingByGuild.get(String(message?.guild?.id || ""));
    if (!pending || message?.content !== CONFIRMATION_TEXT) return false;
    if (String(message.author?.id || "") !== pending.actorId || String(message.channel?.id || "") !== pending.channelId) {
        return false;
    }
    if (Date.now() >= pending.expiresAt) {
        if (clearPending(pending.guildId, pending)) {
            await replyMessage(message, `> ${config.emojis.warning} งานกวาดยศหมดเวลายืนยันแล้ว`);
        }
        return true;
    }
    clearPending(pending.guildId, pending);
    await executeSweep(pending, message);
    return true;
}

async function handleShortcut(message) {
    const parsed = parseShortcutRoleIds(message?.content);
    if (!parsed.matched) return false;
    if (!isGuildOwner(message.author?.id, message.guild)) {
        await replyMessage(message, `> ${config.emojis.no_entry} คำสั่งนี้สงวนไว้สำหรับเจ้าของเซิร์ฟเวอร์หรือ Owner ของบอท`);
        return true;
    }
    if (parsed.error) {
        await replyMessage(message, `> ${config.emojis.error} ${parsed.error}`);
        return true;
    }
    const roleMap = message.guild?.roles?.cache;
    if (parsed.roleIds.some(roleId => !roleMap?.get?.(roleId))) {
        await replyMessage(message, `> ${config.emojis.error} พบ Role ID ที่ไม่มีอยู่ในเซิร์ฟเวอร์`);
        return true;
    }
    if (!botCanOperate(message.guild, message.channel)) {
        await replyMessage(message, `> ${config.emojis.error} บอทต้องมี VIEW_CHANNEL, SEND_MESSAGES และ MANAGE_ROLES`);
        return true;
    }
    await startPreview({
        guild: message.guild,
        channel: message.channel,
        actorId: message.author.id,
        exceptRoleIds: parsed.roleIds,
        respond: content => replyMessage(message, content)
    });
    return true;
}

async function handleMessage(message) {
    if (!message?.guild || message.author?.bot) return false;
    if (await handleConfirmation(message)) return true;
    return await handleShortcut(message);
}

function readSlashExceptions(interaction) {
    return dedupeRoleIds([1, 2, 3, 4, 5]
        .map(index => interaction.options?.getRole?.(`except_role_${index}`)?.id)
        .filter(Boolean));
}

async function handleSlashCommand(interaction) {
    if (!isGuildOwner(interaction.user?.id, interaction.guild)) {
        return interaction.reply({
            content: `> ${config.emojis.no_entry} คำสั่งนี้สงวนไว้สำหรับเจ้าของเซิร์ฟเวอร์หรือ Owner ของบอท`,
            ephemeral: true
        });
    }
    if (!await requireBotPermission(
        interaction,
        [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        `> ${config.emojis.error} บอทต้องมี VIEW_CHANNEL, SEND_MESSAGES และ MANAGE_ROLES`,
        interaction.channel
    )) return null;

    markCommandAccepted(interaction);
    if (!await safeDefer(interaction, { ephemeral: true })) return null;
    const exceptRoleIds = readSlashExceptions(interaction);
    if (exceptRoleIds.some(roleId => !interaction.guild?.roles?.cache?.get?.(roleId))) {
        return interaction.editReply({ content: `> ${config.emojis.error} พบยศยกเว้นที่ไม่มีอยู่ในเซิร์ฟเวอร์` });
    }
    return await startPreview({
        guild: interaction.guild,
        channel: interaction.channel,
        actorId: interaction.user.id,
        exceptRoleIds,
        respond: content => interaction.editReply({ content })
    });
}

function cleanupGuild(guildId) {
    clearPending(guildId);
    const preview = previewingByGuild.get(String(guildId));
    if (preview) preview.cancelled = true;
    previewingByGuild.delete(String(guildId));
    const active = activeByGuild.get(String(guildId));
    if (active) active.cancelled = true;
}

function getRuntimeDiagnostics() {
    return { previewing: previewingByGuild.size, pending: pendingByGuild.size, active: activeByGuild.size };
}

function resetForTests() {
    for (const guildId of pendingByGuild.keys()) clearPending(guildId);
    for (const controller of previewingByGuild.values()) controller.cancelled = true;
    previewingByGuild.clear();
    activeByGuild.clear();
}

module.exports = {
    handleSlashCommand,
    handleMessage,
    cleanupGuild,
    getRuntimeDiagnostics,
    _test: {
        CONFIRMATION_TEXT,
        CONFIRMATION_TIMEOUT_MS,
        parseShortcutRoleIds,
        scanGuildRoles,
        roleAssignmentFingerprint,
        isGuildOwner,
        pendingByGuild,
        activeByGuild,
        previewingByGuild,
        startPreview,
        handleConfirmation,
        executeSweep,
        fetchAllMembers,
        resetForTests
    }
};
