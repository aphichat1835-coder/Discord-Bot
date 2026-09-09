const crypto = require("node:crypto");
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionFlagsBits
} = require("discord.js");
const config = require("../config.json");
const { isConfiguredOwner } = require("../core/env");
const {
    requireBotPermission,
    safeDefer,
    markCommandAccepted
} = require("../guards/commandGuards");

const CONFIRMATION_TEXT = "ยืนยัน";
const CONFIRMATION_TIMEOUT_MS = 60_000;
const ROLE_ID_PATTERN = /^\d{17,22}$/;
const ROLE_MENTION_PATTERN = /^<@&?(\d{17,22})>$/;
const pendingByGuild = new Map();
const activeByGuild = new Map();
const previewingByGuild = new Map();

/** Returns the values from a Discord collection, array, or plain object. */
function valuesOf(collection) {
    if (!collection) return [];
    if (typeof collection.values === "function") return Array.from(collection.values());
    if (Array.isArray(collection)) return collection;
    return Object.values(collection);
}

/** Returns the guild's cached roles as an array. */
function getRoleValues(guild) {
    return valuesOf(guild?.roles?.cache);
}

/** Returns a member's cached roles as an array. */
function getMemberRoles(member) {
    return valuesOf(member?.roles?.cache);
}

/** Determines whether an actor is the guild owner or the configured bot owner. */
function isGuildOwner(actorId, guild) {
    return String(actorId || "") === String(guild?.ownerId || "") ||
        isConfiguredOwner(config, actorId);
}

/** Matches the everyone role without relying on name comparison alone. */
function isEveryoneRole(role, guild) {
    if (!role) return false;
    return role.id === guild?.id || role.id === guild?.roles?.everyone?.id;
}

/** Normalizes and deduplicates an array of role IDs. */
function dedupeRoleIds(roleIds = []) {
    if (!Array.isArray(roleIds)) return [];
    return Array.from(new Set(roleIds.map(id => String(id || "").trim()).filter(Boolean)));
}

/** Formats a list of exempted role IDs into a readable bulleted mention string. */
function formatExceptRoles(exceptRoleIds = []) {
    const ids = dedupeRoleIds(exceptRoleIds);
    if (!ids.length) return "• (ไม่มีการยกเว้นยศ — ถอดยศที่บอทจัดการได้ทั้งหมด)";
    return ids.map(id => `• <@&${id}>`).join("\n");
}

/** Parses the //รียศ shortcut and its optional role IDs or mentions separated by spaces, commas, or newlines. */
function parseShortcutRoleIds(content) {
    const shortcut = "//รียศ";
    const input = String(content || "").trim();
    if (!input.startsWith(shortcut)) return { matched: false, roleIds: [] };
    const remainder = input.slice(shortcut.length);
    if (remainder.trimStart() === remainder && remainder !== "") return { matched: false, roleIds: [] };
    const raw = remainder.trim();
    if (!raw) return { matched: true, roleIds: [] };
    const tokens = raw.split(/[\s,]+/u).filter(Boolean);
    const cleanedIds = [];
    for (const token of tokens) {
        const mentionMatch = ROLE_MENTION_PATTERN.exec(token);
        const id = mentionMatch ? mentionMatch[1] : token;
        if (!ROLE_ID_PATTERN.test(id)) {
            return { matched: true, error: "รูปแบบ Role ID ไม่ถูกต้อง" };
        }
        cleanedIds.push(id);
    }
    return { matched: true, roleIds: dedupeRoleIds(cleanedIds) };
}

const REMOVE_SHORTCUT = "//ถอดยศ";

/** Parses the //ถอดยศ shortcut to extract the single target role ID or mention. */
function parseTargetRoleShortcut(content) {
    const input = String(content || "").trim();
    if (!input.startsWith(REMOVE_SHORTCUT)) return { matched: false, targetRoleId: null };
    const remainder = input.slice(REMOVE_SHORTCUT.length);
    if (remainder.trimStart() === remainder && remainder !== "") return { matched: false, targetRoleId: null };
    const raw = remainder.trim();
    if (!raw) return { matched: true, error: "กรุณาระบุ Role ID หรือ Mention ยศที่ต้องการถอด เช่น //ถอดยศ @Member" };
    const tokens = raw.split(/[\s,]+/u).filter(Boolean);
    if (tokens.length > 1) {
        return { matched: true, error: "คำสั่ง //ถอดยศ รองรับการระบุยศเป้าหมายครั้งละ 1 ยศเท่านั้น" };
    }
    const mentionMatch = ROLE_MENTION_PATTERN.exec(tokens[0]);
    const id = mentionMatch ? mentionMatch[1] : tokens[0];
    if (!ROLE_ID_PATTERN.test(id)) {
        return { matched: true, error: "รูปแบบ Role ID ไม่ถูกต้อง" };
    }
    return { matched: true, targetRoleId: id };
}

/** Produces a stable, alphabetically sorted representation of the guild role catalog. */
function roleCatalogFingerprint(guild) {
    return getRoleValues(guild)
        .filter(role => !isEveryoneRole(role, guild))
        .map(role => `${role.id}:${Number(role.position || 0)}:${role.managed === true ? 1 : 0}`)
        .sort((left, right) => left.localeCompare(right));
}

/** Hashes role assignments and hierarchy inputs used to validate a pending sweep. */
function roleAssignmentFingerprint(guild, members) {
    const roleCatalog = roleCatalogFingerprint(guild);
    const assignments = valuesOf(members)
        .filter(member => !member?.user?.bot)
        .map(member => {
            const roles = getMemberRoles(member)
                .filter(role => !isEveryoneRole(role, guild))
                .map(role => String(role.id))
                .sort((left, right) => left.localeCompare(right));
            return roles.length > 0 ? `${member.id}:${roles.join(",")}` : null;
        })
        .filter(Boolean)
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

/** Checks whether the bot can manage a member below its highest role. */
function memberIsManageable(member, guild, botPosition) {
    if (!member || String(member.id) === String(guild?.ownerId || "")) return false;
    if (member.manageable === false) return false;
    return Number(member?.roles?.highest?.position || 0) < botPosition;
}

/** Scans members to calculate preview counts and removals allowed by the sweep rules. */
function scanGuildRoles(guild, members, actorId, exceptRoleIds = [], targetRoleId = null) {
    const roles = getRoleValues(guild);
    const humans = valuesOf(members).filter(member => !member?.user?.bot);
    const botPosition = Number(guild?.members?.me?.roles?.highest?.position || -1);
    const exceptions = new Set(dedupeRoleIds(exceptRoleIds));
    const normalizedTargetId = targetRoleId ? String(targetRoleId).trim() : null;
    const targets = [];

    for (const member of humans) {
        if (String(member.id) === String(actorId)) continue;
        if (!memberIsManageable(member, guild, botPosition)) continue;

        let roleIds;
        if (normalizedTargetId) {
            const hasTarget = getMemberRoles(member).some(role => String(role.id) === normalizedTargetId);
            roleIds = hasTarget ? [normalizedTargetId] : [];
        } else {
            roleIds = getMemberRoles(member)
                .filter(role => !isEveryoneRole(role, guild))
                .filter(role => role.managed !== true)
                .filter(role => Number(role.position || 0) < botPosition)
                .filter(role => !exceptions.has(String(role.id)))
                .map(role => String(role.id));
        }
        if (roleIds.length > 0) targets.push({ member, roleIds });
    }

    return {
        stats: {
            totalRoles: roles.filter(role => !isEveryoneRole(role, guild)).length,
            totalAssignments: humans.reduce((total, member) => total + getMemberRoles(member)
                .filter(role => !isEveryoneRole(role, guild)).length, 0),
            targetHolders: normalizedTargetId ? targets.length : null
        },
        targets,
        targetRoleId: normalizedTargetId,
        fingerprint: roleAssignmentFingerprint(guild, members)
    };
}

/** Fetches guild members and rejects unavailable, malformed, or empty member collections. */
async function fetchAllMembers(guild) {
    if (typeof guild?.members?.fetch !== "function") throw new Error("GUILD_MEMBER_FETCH_UNAVAILABLE");
    const members = await guild.members.fetch();
    if (!members || typeof members.values !== "function" || !Number.isSafeInteger(members.size) || members.size <= 0) {
        throw new Error("GUILD_MEMBER_FETCH_INCOMPLETE");
    }
    return members;
}

/** Checks that the bot has the channel and role permissions required for a sweep. */
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

/** Builds the action row containing confirmation and cancellation buttons. */
function buildConfirmationRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("rolesweep:confirm")
            .setLabel("ยืนยันการกวาดยศ")
            .setStyle(ButtonStyle.Danger)
            .setEmoji("🧹")
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId("rolesweep:cancel")
            .setLabel("ยกเลิก")
            .setStyle(ButtonStyle.Secondary)
            .setEmoji("❌")
            .setDisabled(disabled)
    );
}

/** Builds the rich embed preview with server icon thumbnail and exempted roles in Modern Enterprise style. */
function buildPreviewEmbed(guild, stats, exceptRoleIds = [], actorId = null, targetRoleId = null) {
    const embed = new EmbedBuilder()
        .setColor(config.system?.themeColors?.warning || 0xFEE75C)
        .setTitle("🧹 ตรวจสอบข้อมูลก่อนกวาดยศ (Role Sweep Preview)");

    if (targetRoleId) {
        embed.setDescription(
            `⚠️ **โปรดตรวจสอบรายละเอียดก่อนดำเนินการ:**\n` +
            `ระบบจะถอดยศเป้าหมาย **<@&${targetRoleId}>** ออกจากสมาชิกทุกคนที่ถือยศนี้ (ไม่กระทบยศอื่น)\n` +
            `*การดำเนินการนี้ไม่สามารถย้อนกลับได้ (No Undo)*`
        );
        embed.addFields(
            {
                name: "🎯 ข้อมูลยศเป้าหมาย (Target Role)",
                value: `• ยศที่จะถูกถอด: <@&${targetRoleId}>\n` +
                       `• 👥 สมาชิกที่จะถูกถอดยศนี้: **${stats.targetHolders ?? 0}** คน`,
                inline: false
            },
            {
                name: "🛡️ ขอบเขตการดำเนินการ (Scope)",
                value: `• ถอดเฉพาะยศเป้าหมายเพียงยศเดียว ยศอื่น ๆ ของสมาชิกจะไม่ได้รับผลกระทบ`,
                inline: false
            }
        );
    } else {
        embed.setDescription(
            `⚠️ **โปรดตรวจสอบรายละเอียดก่อนดำเนินการ:**\n` +
            `ระบบจะถอดยศของสมาชิกทุกคนที่บอทมีสิทธิ์จัดการ (ยกเว้นยศที่ระบุไว้)\n` +
            `*การดำเนินการนี้ไม่สามารถย้อนกลับได้ (No Undo)*`
        );
        embed.addFields(
            {
                name: "📊 ข้อมูลและสถิติ (Statistics)",
                value: `• 👥 ยศทั้งหมด (ไม่รวม @everyone): **${stats.totalRoles}** ยศ\n` +
                       `• 📋 ยศที่สมาชิกถือรวมแบบนับซ้ำ: **${stats.totalAssignments}** รายการ`,
                inline: false
            },
            {
                name: "🛡️ ยศที่ได้รับการคุ้มครอง (Protected Roles)",
                value: formatExceptRoles(exceptRoleIds),
                inline: false
            }
        );
    }

    embed.addFields(
        {
            name: "👤 ผู้สั่งการ (Initiator)",
            value: actorId ? `<@${actorId}>` : "เจ้าของเซิร์ฟเวอร์ / Owner",
            inline: true
        },
        {
            name: "⏳ ระยะเวลายืนยัน (Timeout)",
            value: `ภายใน **60 วินาที**`,
            inline: true
        },
        {
            name: "⚡ วิธีการยืนยัน (How to Confirm)",
            value: `คลิกปุ่ม **[ 🧹 ยืนยันการกวาดยศ ]** ด้านล่าง หรือพิมพ์ **${CONFIRMATION_TEXT}** ในห้องนี้`,
            inline: false
        }
    )
    .setFooter({ text: "Phomueangtai Personal Multi-Tool • Role Sweep" })
    .setTimestamp();

    const iconUrl = guild?.iconURL?.({ forceStatic: false, size: 256 }) || guild?.iconURL?.();
    if (iconUrl) embed.setThumbnail(iconUrl);
    return embed;
}

/** Builds the rich embed summary with server icon thumbnail and sweep statistics. */
function buildSummaryEmbed(guild, { changedMembers, removedAssignments, failedAssignments, cancelled, exceptRoleIds = [], actorId = null, targetRoleId = null }) {
    const isSuccess = !cancelled && failedAssignments === 0;
    let color = config.system?.themeColors?.error || 0xED4245;
    let title = "🧹 สรุปผลการกวาดยศ (มีบางรายการไม่สำเร็จ)";
    let statusBanner = "⚠️ **กวาดยศเสร็จสิ้น (มีบางรายการไม่สำเร็จ)**";

    if (cancelled) {
        color = config.system?.themeColors?.warning || 0xFEE75C;
        title = "⚠️ สรุปผลการกวาดยศ (ยกเลิก / Cancelled)";
        statusBanner = "🛑 **หยุดงานกวาดยศแล้ว ไม่มีการเปลี่ยนแปลงยศเพิ่มเติม**";
    } else if (isSuccess) {
        color = config.system?.themeColors?.success || 0x57F287;
        title = "🧹 สรุปผลการกวาดยศเสร็จสมบูรณ์ (Role Sweep Summary)";
        statusBanner = "✅ **กวาดยศเสร็จสมบูรณ์**";
    }

    const targetDesc = targetRoleId
        ? `\n\n🎯 **ยศเป้าหมายที่ถอด:** <@&${targetRoleId}>`
        : `\n\n🛡️ **ยศที่ได้รับการยกเว้น (ไม่ถูกลบ):**\n${formatExceptRoles(exceptRoleIds)}`;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(`${statusBanner}${targetDesc}`)
        .addFields(
            {
                name: "📊 รายละเอียดการดำเนินการ (Execution Details)",
                value: `• 👥 สมาชิกที่เปลี่ยนแปลง: **${changedMembers}** คน\n` +
                       `• 🧹 ยศที่ถอดสำเร็จ: **${removedAssignments}** รายการ\n` +
                       `• ❌ ยศที่ถอดไม่สำเร็จ: **${failedAssignments}** รายการ`,
                inline: false
            }
        )
        .setFooter({ text: "Phomueangtai Personal Multi-Tool • Role Sweep Summary" })
        .setTimestamp();

    if (targetRoleId) {
        embed.addFields({
            name: "🎯 ยศเป้าหมาย (Target Role)",
            value: `<@&${targetRoleId}>`,
            inline: false
        });
    }

    if (actorId) {
        embed.addFields({
            name: "👤 ผู้สั่งการ (Executed by)",
            value: `<@${actorId}>`,
            inline: true
        });
    }

    const iconUrl = guild?.iconURL?.({ forceStatic: false, size: 256 }) || guild?.iconURL?.();
    if (iconUrl) embed.setThumbnail(iconUrl);
    return embed;
}

/** Builds the rich embed for a cancelled role sweep. */
function buildCancelEmbed(guild, actorId = null) {
    const embed = new EmbedBuilder()
        .setColor(config.system?.themeColors?.warning || 0xFEE75C)
        .setTitle("❌ ยกเลิกการกวาดยศแล้ว (Role Sweep Cancelled)")
        .setDescription("> งานกวาดยศถูกยกเลิกเรียบร้อยแล้ว ไม่มีการเปลี่ยนแปลงยศใด ๆ ในเซิร์ฟเวอร์")
        .setFooter({ text: "Phomueangtai Personal Multi-Tool • Role Sweep Cancelled" })
        .setTimestamp();

    if (actorId) {
        embed.addFields({
            name: "👤 ผู้สั่งยกเลิก (Cancelled by)",
            value: `<@${actorId}>`,
            inline: true
        });
    }

    const iconUrl = guild?.iconURL?.({ forceStatic: false, size: 256 }) || guild?.iconURL?.();
    if (iconUrl) embed.setThumbnail(iconUrl);
    return embed;
}

/** Builds the rich embed for an expired role sweep. */
function buildExpiredEmbed(guild) {
    const embed = new EmbedBuilder()
        .setColor(config.system?.themeColors?.error || 0xED4245)
        .setTitle("⌛ หมดเวลายืนยันการกวาดยศ (Role Sweep Expired)")
        .setDescription(
            `> ⚠️ คำขอกวาดยศหมดเวลาแล้ว (เกิน 60 วินาที)\n` +
            `> ระบบยกเลิกงานโดยอัตโนมัติเพื่อความปลอดภัย และไม่มีการเปลี่ยนแปลงยศใด ๆ`
        )
        .setFooter({ text: "Phomueangtai Personal Multi-Tool • Role Sweep Expired" })
        .setTimestamp();

    const iconUrl = guild?.iconURL?.({ forceStatic: false, size: 256 }) || guild?.iconURL?.();
    if (iconUrl) embed.setThumbnail(iconUrl);
    return embed;
}

/** Builds the backward-compatible text summary displayed before confirmation. */
function previewText(stats, exceptRoleIds = [], targetRoleId = null) {
    if (targetRoleId) {
        return `> ⚠️ **ตรวจพบข้อมูลก่อนกวาดยศ (ถอดยศเป้าหมาย)**\n` +
            `> 🎯 ยศเป้าหมาย: <@&${targetRoleId}>\n` +
            `> 👥 สมาชิกที่จะถูกถอดยศนี้: **${stats.targetHolders ?? 0}** คน\n` +
            `> พิมพ์ **${CONFIRMATION_TEXT}** ในห้องนี้ หรือกดปุ่มยืนยันภายใน 60 วินาทีเพื่อเริ่มดำเนินการ`;
    }
    const ids = dedupeRoleIds(exceptRoleIds);
    const formattedExceptList = ids.map(id => `<@&${id}>`).join(" ");
    const exemptLine = ids.length > 0
        ? `\n> 🛡️ **ยศที่ยกเว้น:** ${formattedExceptList}`
        : "";
    return `> ⚠️ **ตรวจพบข้อมูลก่อนกวาดยศ**\n` +
        `> ยศทั้งหมด (ไม่รวม @everyone): **${stats.totalRoles}**\n` +
        `> ยศที่สมาชิกถือรวมแบบนับซ้ำ: **${stats.totalAssignments}**${exemptLine}\n` +
        `> พิมพ์ **${CONFIRMATION_TEXT}** ในห้องนี้ หรือกดปุ่มยืนยันภายใน 60 วินาทีเพื่อเริ่มดำเนินการ`;
}

/** Builds the complete preview payload including embed and interactive buttons. */
function buildPreviewPayload(guild, stats, exceptRoleIds = [], actorId = null, targetRoleId = null) {
    return {
        content: previewText(stats, exceptRoleIds, targetRoleId),
        embeds: [buildPreviewEmbed(guild, stats, exceptRoleIds, actorId, targetRoleId)],
        components: [buildConfirmationRow()]
    };
}

/** Replies safely to a message without parsing or notifying mentions. */
async function replyMessage(message, payload) {
    const formatted = typeof payload === "string"
        ? { content: payload, allowedMentions: { parse: [], repliedUser: false }, failIfNotExists: false }
        : { allowedMentions: { parse: [], repliedUser: false }, failIfNotExists: false, ...payload };
    return message.reply(formatted).catch(() => message?.channel?.send?.(formatted).catch(() => null));
}

/** Delivers the sweep outcome to either a message reply or a button interaction edit. */
async function deliverSweepResult(target, payload) {
    const formatted = typeof payload === "string"
        ? { content: payload, allowedMentions: { parse: [], repliedUser: false } }
        : { allowedMentions: { parse: [], repliedUser: false }, ...payload };

    if (typeof target?.editReply === "function" && target?.isButton?.()) {
        return target.editReply(formatted).catch(() => target?.channel?.send?.(formatted).catch(() => null));
    }
    if (typeof target?.reply === "function") {
        return replyMessage(target, formatted);
    }
    if (typeof target?.channel?.send === "function") {
        return target.channel.send(formatted).catch(() => null);
    }
    return null;
}

/** Removes a pending sweep, optionally only when it still matches an expected job. */
function clearPending(guildId, expectedPending = null) {
    const pending = pendingByGuild.get(String(guildId));
    if (!pending || (expectedPending && pending !== expectedPending)) return null;
    clearTimeout(pending.timeout);
    pendingByGuild.delete(String(guildId));
    return pending;
}

/** Normalizes a confirmation timeout to a positive millisecond value. */
function getConfirmationTimeout(timeoutMs) {
    const parsed = Number(timeoutMs);
    if (!Number.isFinite(parsed) || parsed <= 0) return CONFIRMATION_TIMEOUT_MS;
    return Math.max(1, Math.floor(parsed));
}

/** Reports whether a preview controller was cancelled or superseded. */
function previewWasCancelled(guildId, controller) {
    return controller.cancelled || previewingByGuild.get(String(guildId)) !== controller;
}

/** Fetches, scans, and publishes a confirmation-bound role-sweep preview. */
async function startPreview({ guild, channel, actorId, exceptRoleIds, targetRoleId = null, respond, timeoutMs = CONFIRMATION_TIMEOUT_MS }) {
    const guildId = String(guild?.id || "");
    if (!guildId) return false;
    if (pendingByGuild.has(guildId) || activeByGuild.has(guildId) || previewingByGuild.has(guildId)) {
        await respond(`> ⚠️ เซิร์ฟเวอร์นี้มีงานกวาดยศที่รอยืนยันหรือกำลังทำงานอยู่`);
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
            await respond(`> ❌ ดึงรายชื่อสมาชิกไม่ครบ จึงยังไม่ถอดยศใด ๆ`);
            return false;
        }
        if (previewWasCancelled(guildId, controller)) return false;

        const scan = scanGuildRoles(guild, members, actorId, exceptRoleIds, targetRoleId);
        if (scan.targets.length === 0) {
            if (previewWasCancelled(guildId, controller)) return false;
            const msg = targetRoleId
                ? `> ⚠️ ไม่พบสมาชิกที่ถือยศ <@&${targetRoleId}> ที่บอทสามารถจัดการได้ จึงไม่สร้างงานรอยืนยัน`
                : `${previewText(scan.stats, exceptRoleIds)}\n> ⚠️ ไม่พบยศที่ถอดได้ตามเงื่อนไข จึงไม่สร้างงานรอยืนยัน`;
            await respond(msg);
            return false;
        }

        const confirmationTimeout = getConfirmationTimeout(timeoutMs);
        const expiresAt = Date.now() + confirmationTimeout;
        let pending;
        const timeout = setTimeout(() => {
            const expired = clearPending(guildId, pending);
            if (expired) {
                expired.previewMessage?.edit?.({ components: [] }).catch(() => {});
                Promise.resolve(
                    expired.respond({
                        content: `> ⚠️ งานกวาดยศหมดเวลายืนยันแล้ว`,
                        embeds: [buildExpiredEmbed(guild)],
                        components: []
                    })
                ).catch(() => {});
            }
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
            targetRoleId: targetRoleId ? String(targetRoleId) : null,
            fingerprint: scan.fingerprint,
            respond,
            timeout,
            expiresAt,
            previewMessage: null
        };
        pendingByGuild.set(guildId, pending);
        try {
            const previewPayload = buildPreviewPayload(guild, scan.stats, exceptRoleIds, actorId, targetRoleId);
            const sent = await respond(previewPayload);
            if (sent && typeof sent.edit === "function") {
                pending.previewMessage = sent;
            }
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

/** Revalidates a confirmed preview and removes eligible roles sequentially. */
async function executeSweep(pending, messageOrInteraction) {
    const controller = { cancelled: false };
    activeByGuild.set(pending.guildId, controller);
    try {
        if (!botCanOperate(pending.guild, messageOrInteraction?.channel)) {
            return await deliverSweepResult(messageOrInteraction, `> ❌ บอทต้องมี VIEW_CHANNEL, SEND_MESSAGES และ MANAGE_ROLES ก่อนเริ่มกวาดยศ`);
        }
        let members;
        try {
            members = await fetchAllMembers(pending.guild);
        } catch {
            return await deliverSweepResult(messageOrInteraction, `> ❌ ดึงรายชื่อสมาชิกใหม่ไม่สำเร็จ จึงไม่ถอดยศใด ๆ`);
        }
        const scan = scanGuildRoles(pending.guild, members, pending.actorId, pending.exceptRoleIds, pending.targetRoleId);
        if (scan.fingerprint !== pending.fingerprint) {
            return await deliverSweepResult(messageOrInteraction, `> ⚠️ ข้อมูลยศเปลี่ยนหลังพรีวิว กรุณาเรียกคำสั่งใหม่เพื่อคำนวณอีกครั้ง`);
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
        const formattedPendingExcept = pending.exceptRoleIds?.map(id => `<@&${id}>`).join(" ") || "";
        const exemptTagLine = pending.exceptRoleIds?.length > 0
            ? `\n> 🛡️ **ยศที่เว้นไว้:** ${formattedPendingExcept}`
            : "";
        const targetLine = pending.targetRoleId ? `\n> 🎯 **ยศเป้าหมาย:** <@&${pending.targetRoleId}>` : "";

        const summaryContent = `> ${cancelled ? "⚠️" : "✅"} ${cancelled ? "หยุดงานกวาดยศแล้ว" : "กวาดยศเสร็จแล้ว"}\n` +
            `> สมาชิกที่เปลี่ยนแปลง: **${changedMembers}**\n` +
            `> ยศที่ถอดสำเร็จ: **${removedAssignments}**\n` +
            `> ยศที่ถอดไม่สำเร็จ: **${failedAssignments}**${exemptTagLine}${targetLine}`;

        const summaryEmbed = buildSummaryEmbed(pending.guild, {
            changedMembers,
            removedAssignments,
            failedAssignments,
            cancelled,
            exceptRoleIds: pending.exceptRoleIds,
            actorId: pending.actorId,
            targetRoleId: pending.targetRoleId
        });

        return await deliverSweepResult(
            messageOrInteraction,
            { content: summaryContent, embeds: [summaryEmbed], components: [] }
        );
    } finally {
        if (activeByGuild.get(pending.guildId) === controller) activeByGuild.delete(pending.guildId);
    }
}

/** Handles an exact confirmation message from the owner and original channel. */
async function handleConfirmation(message) {
    const pending = pendingByGuild.get(String(message?.guild?.id || ""));
    if (!pending || message?.content !== CONFIRMATION_TEXT) return false;
    if (String(message.author?.id || "") !== pending.actorId || String(message.channel?.id || "") !== pending.channelId) {
        return false;
    }
    await message.delete?.().catch(() => {});
    if (Date.now() >= pending.expiresAt) {
        if (clearPending(pending.guildId, pending)) {
            pending.previewMessage?.edit?.({ components: [] }).catch(() => {});
            await replyMessage(message, {
                content: `> ⚠️ งานกวาดยศหมดเวลายืนยันแล้ว`,
                embeds: [buildExpiredEmbed(pending.guild)],
                components: []
            });
        }
        return true;
    }
    clearPending(pending.guildId, pending);
    pending.previewMessage?.edit?.({ components: [] }).catch(() => {});
    await executeSweep(pending, message);
    return true;
}

/** Handles the //ถอดยศ shortcut after validating ownership and bot permissions. */
async function handleTargetShortcut(message) {
    const parsed = parseTargetRoleShortcut(message?.content);
    if (!parsed.matched) return false;
    await message.delete?.().catch(() => {});
    if (!isGuildOwner(message.author?.id, message.guild)) {
        await replyMessage(message, `> ⛔ คำสั่งนี้สงวนไว้สำหรับเจ้าของเซิร์ฟเวอร์หรือ Owner ของบอท`);
        return true;
    }
    if (parsed.error) {
        await replyMessage(message, `> ❌ ${parsed.error}`);
        return true;
    }
    const roleMap = message.guild?.roles?.cache;
    const targetRole = roleMap?.get?.(parsed.targetRoleId);
    if (!targetRole) {
        await replyMessage(message, `> ❌ ไม่พบ Role ID นี้ในเซิร์ฟเวอร์`);
        return true;
    }
    if (isEveryoneRole(targetRole, message.guild)) {
        await replyMessage(message, `> ❌ ไม่สามารถถอดยศ @everyone ได้`);
        return true;
    }
    if (targetRole.managed === true) {
        await replyMessage(message, `> ❌ ไม่สามารถถอดยศที่จัดการโดยระบบภายนอก (Managed Role) ได้`);
        return true;
    }
    const botPosition = Number(message.guild?.members?.me?.roles?.highest?.position || -1);
    if (Number(targetRole.position || 0) >= botPosition) {
        await replyMessage(message, `> ❌ ยศเป้าหมายอยู่สูงกว่าหรือเท่ากับยศของบอท บอทไม่มีสิทธิ์จัดการยศนี้`);
        return true;
    }
    if (!botCanOperate(message.guild, message.channel)) {
        await replyMessage(message, `> ❌ บอทต้องมี VIEW_CHANNEL, SEND_MESSAGES และ MANAGE_ROLES`);
        return true;
    }
    await startPreview({
        guild: message.guild,
        channel: message.channel,
        actorId: message.author.id,
        exceptRoleIds: [],
        targetRoleId: parsed.targetRoleId,
        respond: payload => replyMessage(message, payload)
    });
    return true;
}

/** Handles the //รียศ shortcut after validating ownership and bot permissions. */
async function handleShortcut(message) {
    const parsed = parseShortcutRoleIds(message?.content);
    if (!parsed.matched) return false;
    await message.delete?.().catch(() => {});
    if (!isGuildOwner(message.author?.id, message.guild)) {
        await replyMessage(message, `> ⛔ คำสั่งนี้สงวนไว้สำหรับเจ้าของเซิร์ฟเวอร์หรือ Owner ของบอท`);
        return true;
    }
    if (parsed.error) {
        await replyMessage(message, `> ❌ ${parsed.error}`);
        return true;
    }
    const roleMap = message.guild?.roles?.cache;
    if (parsed.roleIds.some(roleId => !roleMap?.get?.(roleId))) {
        await replyMessage(message, `> ❌ พบ Role ID ที่ไม่มีอยู่ในเซิร์ฟเวอร์`);
        return true;
    }
    if (!botCanOperate(message.guild, message.channel)) {
        await replyMessage(message, `> ❌ บอทต้องมี VIEW_CHANNEL, SEND_MESSAGES และ MANAGE_ROLES`);
        return true;
    }
    await startPreview({
        guild: message.guild,
        channel: message.channel,
        actorId: message.author.id,
        exceptRoleIds: parsed.roleIds,
        targetRoleId: null,
        respond: payload => replyMessage(message, payload)
    });
    return true;
}

/** Routes guild messages to confirmation handling or the role-sweep shortcut. */
async function handleMessage(message) {
    if (!message?.guild || message.author?.bot) return false;
    if (await handleConfirmation(message)) return true;
    if (await handleTargetShortcut(message)) return true;
    return await handleShortcut(message);
}

/** Reads and deduplicates the five optional role exceptions from a slash command. */
function readSlashExceptions(interaction) {
    return dedupeRoleIds([1, 2, 3, 4, 5]
        .map(index => interaction.options?.getRole?.(`role_${index}`)?.id || interaction.options?.getRole?.(`except_role_${index}`)?.id)
        .filter(Boolean));
}

/** Starts a role-sweep preview from the owner-only /rerole slash command. */
async function handleSlashCommand(interaction) {
    if (!isGuildOwner(interaction.user?.id, interaction.guild)) {
        return interaction.reply({
            content: `> ⛔ คำสั่งนี้สงวนไว้สำหรับเจ้าของเซิร์ฟเวอร์หรือ Owner ของบอท`,
            ephemeral: true
        });
    }
    if (!await requireBotPermission(
        interaction,
        [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        `> ❌ บอทต้องมี VIEW_CHANNEL, SEND_MESSAGES และ MANAGE_ROLES`,
        interaction.channel
    )) return null;

    markCommandAccepted(interaction);
    if (!await safeDefer(interaction, { ephemeral: true })) return null;
    const exceptRoleIds = readSlashExceptions(interaction);
    if (exceptRoleIds.some(roleId => !interaction.guild?.roles?.cache?.get?.(roleId))) {
        return interaction.editReply({ content: `> ❌ พบยศยกเว้นที่ไม่มีอยู่ในเซิร์ฟเวอร์` });
    }

    const targetRole = interaction.options?.getRole?.("target_role");
    let targetRoleId = null;
    if (targetRole) {
        targetRoleId = String(targetRole.id);
        if (!interaction.guild?.roles?.cache?.get?.(targetRoleId)) {
            return interaction.editReply({ content: `> ❌ ไม่พบยศเป้าหมายในเซิร์ฟเวอร์` });
        }
        if (isEveryoneRole(targetRole, interaction.guild)) {
            return interaction.editReply({ content: `> ❌ ไม่สามารถถอดยศ @everyone ได้` });
        }
        if (targetRole.managed === true) {
            return interaction.editReply({ content: `> ❌ ไม่สามารถถอดยศที่จัดการโดยระบบภายนอก (Managed Role) ได้` });
        }
        const botPosition = Number(interaction.guild?.members?.me?.roles?.highest?.position || -1);
        if (Number(targetRole.position || 0) >= botPosition) {
            return interaction.editReply({ content: `> ❌ ยศเป้าหมายอยู่สูงกว่าหรือเท่ากับยศของบอท บอทไม่มีสิทธิ์จัดการยศนี้` });
        }
        if (exceptRoleIds.includes(targetRoleId)) {
            return interaction.editReply({ content: `> ❌ ยศเป้าหมายไม่สามารถอยู่ในรายการยศยกเว้นพร้อมกันได้` });
        }
    }

    return await startPreview({
        guild: interaction.guild,
        channel: interaction.channel,
        actorId: interaction.user.id,
        exceptRoleIds,
        targetRoleId,
        respond: payload => interaction.editReply(typeof payload === "string" ? { content: payload } : payload)
    });
}

/** Checks whether a button custom ID belongs to the role sweep subsystem. */
function isRoleSweepButton(customId) {
    return typeof customId === "string" && (customId === "rolesweep:confirm" || customId === "rolesweep:cancel");
}

/** Handles confirmation and cancellation button interactions for role sweeps. */
async function handleRoleSweepButton(interaction) {
    if (!interaction?.isButton?.()) return false;
    const guildId = String(interaction.guild?.id || "");
    const pending = pendingByGuild.get(guildId);

    if (!pending) {
        return interaction.reply({
            content: "> ⚠️ ไม่พบงานกวาดยศที่รอยืนยัน หรือคำขอนี้หมดอายุแล้ว",
            embeds: [buildExpiredEmbed(interaction.guild)],
            ephemeral: true
        }).catch(() => null);
    }

    if (String(interaction.user?.id || "") !== pending.actorId) {
        return interaction.reply({
            content: "> ⛔ เฉพาะผู้ที่เรียกคำสั่งเท่านั้นที่สามารถกดยืนยันหรือยกเลิกได้",
            ephemeral: true
        }).catch(() => null);
    }

    if (interaction.customId === "rolesweep:cancel") {
        clearPending(guildId, pending);
        const cancelEmbed = buildCancelEmbed(interaction.guild, interaction.user.id);
        return interaction.update({
            content: "> ❌ ยกเลิกการกวาดยศแล้ว",
            embeds: [cancelEmbed],
            components: []
        }).catch(() => null);
    }

    if (interaction.customId === "rolesweep:confirm") {
        if (Date.now() >= pending.expiresAt) {
            clearPending(guildId, pending);
            return interaction.update({
                content: "> ⚠️ งานกวาดยศหมดเวลายืนยันแล้ว",
                embeds: [buildExpiredEmbed(interaction.guild)],
                components: []
            }).catch(() => null);
        }

        clearPending(guildId, pending);
        await interaction.update({
            content: "> ⚡ กำลังเริ่มกวาดยศ กรุณารอสักครู่...",
            embeds: [],
            components: []
        }).catch(() => null);

        await executeSweep(pending, interaction);
        return true;
    }

    return false;
}

/** Cancels and clears every role-sweep state associated with a departed guild. */
function cleanupGuild(guildId) {
    clearPending(guildId);
    const preview = previewingByGuild.get(String(guildId));
    if (preview) preview.cancelled = true;
    previewingByGuild.delete(String(guildId));
    const active = activeByGuild.get(String(guildId));
    if (active) active.cancelled = true;
}

/** Exposes bounded role-sweep state counts for runtime diagnostics. */
function getRuntimeDiagnostics() {
    return { previewing: previewingByGuild.size, pending: pendingByGuild.size, active: activeByGuild.size };
}

/** Clears in-memory role-sweep state between unit tests. */
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
    isRoleSweepButton,
    handleRoleSweepButton,
    _test: {
        CONFIRMATION_TEXT,
        CONFIRMATION_TIMEOUT_MS,
        REMOVE_SHORTCUT,
        parseTargetRoleShortcut,
        handleTargetShortcut,
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
        resetForTests,
        buildConfirmationRow,
        buildPreviewEmbed,
        buildSummaryEmbed,
        buildCancelEmbed,
        buildExpiredEmbed,
        buildPreviewPayload,
        previewText,
        formatExceptRoles,
        readSlashExceptions,
        isRoleSweepButton,
        handleRoleSweepButton
    }
};
