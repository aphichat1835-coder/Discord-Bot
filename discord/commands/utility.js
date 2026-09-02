/* eslint-disable complexity -- Utility command flows are behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: activeRestores, activeBackups Sets — race condition guards.
DO NOT REMOVE: finally blocks — they MUST unlock Sets after every operation.
DO NOT SIMPLIFY: Restore loop — delay + setImmediate required (เฟส 19+21).
================================================================================
*/

const {
    MessageEmbed,
    MessageActionRow,
    MessageButton,
    getLegacyChannelType,
    resolveChannelType
} = require("../core/discordCompat");
const { PermissionFlagsBits } = require("discord.js");
const crypto = require("node:crypto");
const config = require("../config.json");
const { isConfiguredOwner } = require("../core/env");
const sessionManager = require("../sessionManager");
const {
    requireMemberPermission,
    requireBotPermission,
    safeDefer,
    sanitizeUserMessage,
    markCommandAccepted
} = require("../guards/commandGuards");
const dmService = require("../dm");
const { safeError } = require("../core/safeLogger");
const {
    sendWebhookEvent,
    getDiscordAvatarUrl,
    getDiscordGuildIconUrl
} = require("../core/webhooks");

// Race Condition Guards
const activeRestores = new Set();
const activeBackups  = new Set();
const activeEmojiCopies = new Set();

function restoreStateLabel(state) {
    if (state === "complete") return "สำเร็จครบถ้วน";
    if (state === "partial") return "สำเร็จบางส่วน";
    return "ไม่สำเร็จ";
}

function restoreTone(state) {
    if (state === "complete") return "success";
    if (state === "partial") return "warning";
    return "danger";
}

function buildRestoreResultDmEmbed(input) {
    const stateLabel = restoreStateLabel(input.resultState);
    const tone = restoreTone(input.resultState);
    return dmService.design.buildDmEmbed({
        tone,
        title: input.resultState === "complete" ? "✅ กู้คืนเซิร์ฟเวอร์เสร็จแล้ว" : "⚠️ ผลการกู้คืนต้องตรวจสอบ",
        summary: `งานกู้คืนสิ้นสุดด้วยสถานะ “${stateLabel}” รายละเอียดนี้ส่งเฉพาะผู้สั่งงาน`,
        profile: dmService.design.profileFromUser(input.interaction.user),
        fields: [
            { name: "🏠 เซิร์ฟเวอร์", value: `${dmService.design.markdownText(input.interaction.guild.name, "ไม่ทราบเซิร์ฟเวอร์", 100)}\n${dmService.design.code(input.interaction.guild.id)}`, inline: true },
            { name: "🎖️ ยศที่สร้าง", value: `${input.restoredRoles} ยศ`, inline: true },
            { name: "🗂️ ห้องที่สร้าง", value: `${input.restoredChannels} ห้อง`, inline: true },
            { name: "⏭️ รายการที่ข้าม", value: `${input.skippedRoles} ยศ / ${input.skippedChannels} ห้อง`, inline: true },
            { name: "❓ ชื่อซ้ำหรือไม่แน่ชัด", value: `${input.ambiguousRoles} ยศ / ${input.ambiguousChannels} ห้อง`, inline: true },
            { name: "🔐 สิทธิ์ห้อง", value: `${input.overwriteStats.restored} สำเร็จ / ${input.overwriteStats.skippedRoleMissing + input.overwriteStats.skippedMemberMissing} หาย / ${Number(input.overwriteStats.skippedMemberUnresolved || 0)} ตรวจไม่ได้`, inline: true },
            { name: "⚠️ ข้อผิดพลาด", value: String(input.restoreErrors), inline: true },
            { name: "⏱️ หมดเวลาระหว่างทำงาน", value: input.timeoutHit ? "ใช่" : "ไม่", inline: true }
        ],
        nextAction: input.resultState === "complete"
            ? "ตรวจสอบยศ ห้อง และสิทธิ์สำคัญใน Discord อีกครั้งก่อนเปิดใช้งานเต็มรูปแบบ"
            : "ตรวจสอบรายการที่ข้ามและข้อผิดพลาด แล้วกู้คืนเฉพาะส่วนที่ยังขาด",
        referenceId: input.interaction.id || `restore-${input.interaction.guild.id}`,
        footer: "Phomueangtai • กู้คืนเซิร์ฟเวอร์"
    });
}

function buildRestoreDeliveryFailureEvent(interaction) {
    const guildId = String(interaction.guild?.id || "unknown");
    const userId = String(interaction.user?.id || "unknown");
    return {
        target: "LOG",
        severity: "WARNING",
        category: "BACKUP",
        code: "restore.result.private_delivery_failed",
        title: "ส่งผลการกู้คืนแบบส่วนตัวไม่สำเร็จ",
        description: "ระบบแสดงผลใน Interaction และส่งข้อความส่วนตัวไม่ได้",
        impact: "ผู้สั่งงานอาจไม่เห็นรายละเอียดผลลัพธ์หลัง Interaction หมดอายุ",
        action: "ตรวจสอบสิทธิ์รับข้อความส่วนตัวและสถานะการส่ง DM ของผู้สั่งงาน",
        context: {
            "Guild ID": guildId,
            "User ID": userId,
            "Interaction ID": String(interaction.id || "unknown")
        },
        sourceIconUrl: getDiscordGuildIconUrl(interaction.guild),
        thumbnailUrl: getDiscordAvatarUrl(interaction.user),
        dedupeKey: `restore-private-delivery:${guildId}:${userId}`,
        dedupeMs: 5 * 60 * 1000,
        summaryLabel: "ส่งผลการกู้คืนแบบส่วนตัวไม่สำเร็จ"
    };
}

async function handle(interaction) {
    const cmd = interaction.commandName;
    if (cmd === "say")        return handleSay(interaction);
    if (cmd === "announce")   return handleAnnounce(interaction);
    if (cmd === "copy-emojis") return handleSteal(interaction);
    if (cmd === "backup")     return handleBackup(interaction);
    if (cmd === "restore")    return handleRestore(interaction);
}

// ════════════════════════════════════════════════════════════════════════════
//  📢  SAY (Administrator only)
// ════════════════════════════════════════════════════════════════════════════
async function handleSay(interaction) {
    if (!await requireMemberPermission(interaction, PermissionFlagsBits.Administrator, `> ${config.emojis.no_entry} ต้องเป็น Administrator เพื่อใช้คำสั่งนี้`)) return;
    if (!await requireBotPermission(interaction, [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel], `> ${config.emojis.error} บอทไม่มีสิทธิ์ส่งข้อความในช่องนี้ (ขาด SEND_MESSAGES หรือ VIEW_CHANNEL)`, interaction.channel)) return;

    const rawMsg = interaction.options.getString("message");
    const msg = sanitizeUserMessage(rawMsg, { maxLength: 2000 });
    if (!msg) return interaction.reply({
        content: `> ${config.emojis.error} ข้อความว่างหรือถูกบล็อกทั้งหมด`,
        ephemeral: true
    });

    markCommandAccepted(interaction);

    if (!await safeDefer(interaction, { ephemeral: true })) return null;
    await interaction.channel.send({
        content: msg,
        allowedMentions: { parse: ["users", "roles", "everyone"], repliedUser: false }
    });
    return interaction.editReply({ content: `> ${config.emojis.success} ส่งเรียบร้อย` });
}

// ════════════════════════════════════════════════════════════════════════════
//  📣  ANNOUNCE (เฟส 4 — content field นอก Embed)
// ════════════════════════════════════════════════════════════════════════════
async function handleAnnounce(interaction) {
    if (!await requireMemberPermission(interaction, PermissionFlagsBits.ManageMessages, `> ${config.emojis.no_entry} ไม่มีสิทธิ์ใช้งาน`)) return;
    if (!await requireBotPermission(interaction, [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks], `> ${config.emojis.error} บอทไม่มีสิทธิ์ส่งข้อความในช่องนี้ (ขาด SEND_MESSAGES, VIEW_CHANNEL หรือ EMBED_LINKS)`, interaction.channel)) return;

    const titleText = sanitizeUserMessage(interaction.options.getString("title"), { maxLength: 250 });
    const title = `${config.emojis.announce_icon} ${titleText}`.slice(0, 256);
    const msgStr = sanitizeUserMessage(interaction.options.getString("message"), { maxLength: 4096 });
    const rawContent = interaction.options.getString("content");
    const content = rawContent ? sanitizeUserMessage(rawContent, { maxLength: 2000 }) : null;
    if (!titleText || !msgStr) {
        return interaction.reply({ content: `> ${config.emojis.error} หัวข้อและข้อความต้องไม่ว่าง`, ephemeral: true });
    }
    markCommandAccepted(interaction);

    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.primary)
        .setTitle(title)
        .setDescription(msgStr)
        .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL() })
        .setTimestamp();

    if (!await safeDefer(interaction, { ephemeral: true })) return null;
    await interaction.channel.send({
        content: content || undefined,
        embeds: [embed],
        allowedMentions: { parse: ["users", "roles", "everyone"], repliedUser: false }
    });
    return interaction.editReply({ content: `> ${config.emojis.success} ประกาศสำเร็จ` });
}

// ════════════════════════════════════════════════════════════════════════════
//  😀  STEAL (เฟส 11 — Pre-check โควตา + delay กัน API ceiling)
// ════════════════════════════════════════════════════════════════════════════
async function handleSteal(interaction) {
    if (!await requireMemberPermission(interaction, PermissionFlagsBits.ManageGuildExpressions, `> ${config.emojis.no_entry} ไม่มีสิทธิ์จัดการอิโมจิ`)) return;
    if (!await requireBotPermission(interaction, PermissionFlagsBits.ManageGuildExpressions, `> ${config.emojis.error} บอทไม่มีสิทธิ์จัดการอิโมจิ`)) return;

    const text = interaction.options.getString("emojis");
    const regex = /<(a?):([a-zA-Z0-9_]+):(\d+)>/g;
    const seenEmojiIds = new Set();
    const matches = [...text.matchAll(regex)].filter(match => {
        if (seenEmojiIds.has(match[3])) return false;
        seenEmojiIds.add(match[3]);
        return true;
    });

    if (matches.length === 0) {
        return interaction.reply({ content: `> ${config.emojis.warning} ไม่พบอิโมจิ Custom ในข้อความที่ระบุ`, ephemeral: true });
    }
    if (matches.length > 50) {
        return interaction.reply({
            content: `> ${config.emojis.error} ไม่สามารถดึงเกิน 50 ตัวในครั้งเดียว`,
            ephemeral: true
        });
    }
    if (activeEmojiCopies.has(interaction.guild.id)) {
        return interaction.reply({ content: `> ${config.emojis.warning} เซิร์ฟเวอร์นี้กำลังคัดลอกอิโมจิอยู่ กรุณารอ`, ephemeral: true });
    }
    const emojiManager  = interaction.guild.emojis;
    const tier          = interaction.guild.premiumTier || 0;
    const maxPerType    = tier === 3 ? 250 : tier === 2 ? 150 : tier === 1 ? 100 : 50;
    const staticCount   = emojiManager.cache.filter(e => !e.animated).size;
    const animatedCount = emojiManager.cache.filter(e => e.animated).size;
    const staticFree    = Math.max(0, maxPerType - staticCount);
    const animatedFree  = Math.max(0, maxPerType - animatedCount);

    if (staticFree === 0 && animatedFree === 0) {
        return interaction.reply({
            content: `> ${config.emojis.error} **เซิร์ฟเวอร์อิโมจิเต็มทั้งหมด!** (สถิต ${staticCount}/${maxPerType}, แอนิเมต ${animatedCount}/${maxPerType})`,
            ephemeral: true
        });
    }

    markCommandAccepted(interaction);
    activeEmojiCopies.add(interaction.guild.id);

    try {

    const animatedToSteal = Math.min(matches.filter(m => m[1] === 'a').length, animatedFree);
    const staticToSteal   = Math.min(matches.filter(m => m[1] !== 'a').length, staticFree);
    const toSteal = animatedToSteal + staticToSteal;

    if (!await safeDefer(interaction)) return null;
    let added   = 0;
    let failed  = 0;
    let skipped = 0;

    let staticAdded = 0, animatedAdded = 0;
    let processed = 0;
    let lastReported = 0;
    for (let i = 0; i < matches.length; i++) {
        const match      = matches[i];
        const isAnimated = match[1] === "a";
        const name       = match[2];
        const id         = match[3];
        const url        = `https://cdn.discordapp.com/emojis/${id}.${isAnimated ? 'gif' : 'png'}`;

        if (isAnimated && animatedAdded >= animatedFree) { skipped++; processed++; continue; }
        if (!isAnimated && staticAdded >= staticFree)    { skipped++; processed++; continue; }

        try {
            await interaction.guild.emojis.create({ attachment: url, name });
            if (isAnimated) animatedAdded++; else staticAdded++;
            added++;
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            failed++;
        }
        processed++;

        if (processed - lastReported >= 10 || processed === matches.length) {
            lastReported = processed;
            await interaction.editReply({
                embeds: [new MessageEmbed()
                    .setColor(config.system.themeColors.warning)
                    .setDescription(`> ${config.emojis.loading} **กำลังดึงอิโมจิ...** ${processed}/${matches.length} (สำเร็จ ${added}/${toSteal})`)]
            }).catch(() => {});
        }
    }

    let resultState = "failed";
    if (added === matches.length) resultState = "complete";
    else if (added > 0) resultState = "partial";
    let resultColor = config.system.themeColors.error;
    if (resultState === "complete") resultColor = config.system.themeColors.success;
    else if (resultState === "partial") resultColor = config.system.themeColors.warning;
    const embed = new MessageEmbed()
        .setColor(resultColor)
        .setDescription(
            `> **ผลการนำเข้า: ${resultState}**\n> ${config.emojis.success} **นำเข้าอิโมจิสำเร็จ:** ${added} ตัว` +
            (failed  > 0 ? `\n> ${config.emojis.error} **ล้มเหลว:** ${failed} ตัว` : '') +
            (skipped > 0 ? `\n> ${config.emojis.warning} **ข้ามเพราะโควตาเต็ม:** ${skipped} ตัว` : '')
        );
    return interaction.editReply({ embeds: [embed] });
    } finally {
        activeEmojiCopies.delete(interaction.guild.id);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  💾  BACKUP
// ════════════════════════════════════════════════════════════════════════════
function sortedCollectionValues(collection, compareFn) {
    return Array.from(collection?.values?.() || []).sort(compareFn);
}

function serializeRoleForBackup(role) {
    return {
        id: role.id,
        name: role.name,
        color: role.color,
        hexColor: role.hexColor,
        permissions: role.permissions.bitfield.toString(),
        hoist: !!role.hoist,
        mentionable: !!role.mentionable,
        position: role.position,
        managed: !!role.managed,
        createdTimestamp: role.createdTimestamp || null
    };
}

const SUPPORTED_BACKUP_CHANNEL_TYPES = new Set([
    "GUILD_TEXT",
    "GUILD_VOICE",
    "GUILD_CATEGORY",
    "GUILD_NEWS",
    "GUILD_STAGE_VOICE"
]);

function serializeChannelForBackup(channel) {
    if (!channel || channel.isThread?.() === true) return null;
    const legacyType = getLegacyChannelType(channel.type);
    if (!SUPPORTED_BACKUP_CHANNEL_TYPES.has(legacyType)) return null;
    const overwriteCache = channel.permissionOverwrites?.cache;
    if (!overwriteCache?.map) return null;

    const out = {
        id: channel.id,
        name: channel.name,
        type: legacyType,
        parentId: channel.parentId,
        position: channel.position,
        rawPosition: channel.rawPosition,
        permissionOverwrites: overwriteCache.map(o => ({
            id: o.id,
            type: o.type,
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString()
        }))
    };

    for (const key of [
        "topic", "nsfw", "rateLimitPerUser", "bitrate", "userLimit",
        "rtcRegion", "videoQualityMode", "defaultAutoArchiveDuration"
    ]) {
        if (channel[key] !== undefined) out[key] = channel[key];
    }

    return out;
}

function restoreBigInt(value) {
    try { return BigInt(value || "0"); } catch { return BigInt(0); }
}

function findUniqueByName(collection, predicate) {
    const found = collection.filter(predicate);
    return found.size === 1 ? found.first() : null;
}

function roleCreatePayload(rData) {
    return {
        name: rData.name,
        color: rData.color || rData.hexColor || undefined,
        permissions: restoreBigInt(rData.permissions),
        hoist: !!rData.hoist,
        mentionable: !!rData.mentionable,
        reason: "Enterprise Restore"
    };
}

function channelCreatePayload(cData, parentId, permissionOverwrites) {
    const payload = {
        type: resolveChannelType(cData.type),
        parent: parentId,
        permissionOverwrites,
        reason: "Enterprise Restore"
    };

    for (const key of [
        "topic", "nsfw", "rateLimitPerUser", "bitrate", "userLimit",
        "rtcRegion", "videoQualityMode", "defaultAutoArchiveDuration"
    ]) {
        if (cData[key] !== undefined && cData[key] !== null) payload[key] = cData[key];
    }

    return payload;
}

function normalizeSnapshotChannelType(type) {
    return Number.isInteger(type) ? getLegacyChannelType(type) : type;
}

function normalizeSnapshotChannels(channels) {
    if (!Array.isArray(channels)) return [];
    return channels.map(channel => ({
        ...channel,
        type: normalizeSnapshotChannelType(channel?.type)
    }));
}

function buildBackupValidationReport(data) {
    const roles = Array.isArray(data.roles) ? data.roles : [];
    const channels = Array.isArray(data.channels) ? data.channels : [];
    const overwritesTotal = channels.reduce((sum, c) => sum + (Array.isArray(c.permissionOverwrites) ? c.permissionOverwrites.length : 0), 0);
    const unsupportedItems = [];
    const warnings = [];

    const managedRoles = roles.filter(role => role.managed).length;
    if (managedRoles) warnings.push(`${managedRoles} managed roles cannot be recreated`);

    const unsupportedChannels = channels.filter(c => !SUPPORTED_BACKUP_CHANNEL_TYPES
        .has(normalizeSnapshotChannelType(c.type)));
    for (const channel of unsupportedChannels) {
        unsupportedItems.push(`channel:${normalizeSnapshotChannelType(channel.type)}:${channel.name}`);
    }

    return {
        schemaVersion: data.schemaVersion || 1,
        rolesTotal: roles.length,
        channelsTotal: channels.length,
        overwritesTotal,
        unsupportedItems,
        warnings
    };
}

function isValidSnapshotSchema(data) {
    const snowflake = value => /^\d{17,22}$/.test(String(value || ""));
    const permissionBits = value => (
        (typeof value === "string" && /^\d+$/.test(value)) ||
        (Number.isSafeInteger(value) && value >= 0)
    );
    const overwriteType = value => [0, 1, "0", "1", "role", "member"].includes(value);
    const validOverwrite = overwrite => (
        !!overwrite &&
        snowflake(overwrite.id) &&
        overwriteType(overwrite.type) &&
        permissionBits(overwrite.allow) &&
        permissionBits(overwrite.deny)
    );
    if (!data || !Array.isArray(data.roles) || !Array.isArray(data.channels)) return false;
    if (!snowflake(data.guild?.id)) return false;
    if (data.roles.some(role => !role || !snowflake(role.id) || typeof role.name !== "string")) return false;
    return !data.channels.some(channel =>
        !channel || !snowflake(channel.id) || typeof channel.name !== "string" ||
        (channel.parentId != null && !snowflake(channel.parentId)) ||
        (channel.permissionOverwrites != null && !Array.isArray(channel.permissionOverwrites)) ||
        (Array.isArray(channel.permissionOverwrites) && channel.permissionOverwrites.some(overwrite => !validOverwrite(overwrite)))
    );
}

function snapshotIdentityMatches(backup, backupData, expectedGuildId = null) {
    const metadataGuildId = String(backup?.guildId || "");
    const payloadGuildId = String(backupData?.guild?.id || "");
    if (!metadataGuildId || payloadGuildId !== metadataGuildId) return false;
    return expectedGuildId === null || metadataGuildId === String(expectedGuildId || "");
}

function normalizeOverwriteType(value) {
    if (value === 0 || value === "0") return "role";
    if (value === 1 || value === "1") return "member";
    return value;
}

function findExistingChannelForRestore(guild, cData, parentId) {
    const channelType = normalizeSnapshotChannelType(cData.type);
    let matches = guild.channels.cache.filter(c =>
        c.name === cData.name && getLegacyChannelType(c.type) === channelType
    );

    if (channelType !== "GUILD_CATEGORY") {
        if (cData.parentId && parentId) {
            matches = matches.filter(c => c.parentId === parentId);
        } else if (cData.parentId && !parentId) {
            return { exists: null, ambiguous: matches.size > 0 };
        } else {
            matches = matches.filter(c => !c.parentId);
        }
    }

    return {
        exists: matches.size === 1 ? matches.first() : null,
        ambiguous: matches.size > 1
    };
}

function shouldSkipRestoreRole(roleData) {
    return roleData.managed || roleData.name === config.roles.adminName || roleData.name === config.roles.userName;
}

function planRestoreRole(guild, roleData, roleIdMap, plan) {
    if (shouldSkipRestoreRole(roleData)) {
        plan.rolesSkipped++;
        return;
    }

    let existingRole = findUniqueByName(guild.roles.cache, r => r.name === roleData.name);
    if (roleData.name === "@everyone") existingRole = guild.roles.everyone;

    if (!existingRole && guild.roles.cache.filter(r => r.name === roleData.name).size > 1) {
        plan.rolesAmbiguous++;
        return;
    }

    if (!existingRole) {
        plan.rolesToCreate++;
        if (roleData.id) roleIdMap.set(roleData.id, `planned-role:${roleData.id}`);
    }
    if (existingRole && roleData.id) roleIdMap.set(roleData.id, existingRole.id);
}

function planRestoreCategory(guild, channelData, categoryIdMap, plan) {
    if (!SUPPORTED_BACKUP_CHANNEL_TYPES.has(channelData.type)) {
        plan.channelsSkipped++;
        return;
    }
    const found = findExistingChannelForRestore(guild, channelData);

    if (found.ambiguous) {
        plan.channelsAmbiguous++;
    } else if (found.exists) {
        plan.channelsSkipped++;
        if (channelData.id) categoryIdMap.set(channelData.id, found.exists.id);
    } else {
        plan.channelsToCreate++;
        if (channelData.id) categoryIdMap.set(channelData.id, `planned-category:${channelData.id}`);
    }
}

const RESTORE_MEMBER_FETCH_CONCURRENCY = 4;
const RESTORE_MEMBER_FETCH_TIMEOUT_MS = 5000;

function collectRestoreMemberIds(channels) {
    const memberIds = new Set();
    for (const channelData of channels || []) {
        for (const overwrite of channelData.permissionOverwrites || []) {
            if (normalizeOverwriteType(overwrite.type) === "member") memberIds.add(overwrite.id);
        }
    }
    return [...memberIds];
}

function isMissingRestoreMemberError(error) {
    const code = Number(error?.code ?? error?.rawError?.code);
    return code === 10007 || Number(error?.status) === 404;
}

async function fetchRestoreMemberWithTimeout(guild, memberId, timeoutMs) {
    let timeout;
    try {
        return await Promise.race([
            Promise.resolve().then(() => guild.members.fetch(memberId)),
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    const error = new Error(`RESTORE_MEMBER_FETCH_TIMEOUT:${memberId}`);
                    error.code = "RESTORE_MEMBER_FETCH_TIMEOUT";
                    reject(error);
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function resolveRestoreMemberTargets(guild, channels, options = {}) {
    const states = new Map();
    const pending = [];
    for (const memberId of collectRestoreMemberIds(channels)) {
        if (guild.members.cache.has(memberId)) states.set(memberId, "resolved");
        else pending.push(memberId);
    }

    if (pending.length === 0) return states;
    if (typeof guild.members.fetch !== "function") {
        for (const memberId of pending) states.set(memberId, "unresolved");
        return states;
    }

    const requestedConcurrency = Number(options.memberFetchConcurrency);
    const requestedTimeoutMs = Number(options.memberFetchTimeoutMs);
    const concurrency = Number.isFinite(requestedConcurrency)
        ? Math.max(1, Math.min(10, Math.trunc(requestedConcurrency)))
        : RESTORE_MEMBER_FETCH_CONCURRENCY;
    const timeoutMs = Number.isFinite(requestedTimeoutMs)
        ? Math.max(100, Math.min(30000, Math.trunc(requestedTimeoutMs)))
        : RESTORE_MEMBER_FETCH_TIMEOUT_MS;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
        while (cursor < pending.length) {
            const memberId = pending[cursor++];
            try {
                const member = await fetchRestoreMemberWithTimeout(guild, memberId, timeoutMs);
                states.set(memberId, member ? "resolved" : "missing");
            } catch (error) {
                states.set(memberId, isMissingRestoreMemberError(error) ? "missing" : "unresolved");
            }
        }
    });
    await Promise.all(workers);
    return states;
}

function resolveRestoreOverwriteTarget(guild, overwrite, roleIdMap, oldGuildId, memberTargetStates = new Map()) {
    const overwriteType = normalizeOverwriteType(overwrite.type);
    let targetId = roleIdMap.get(overwrite.id);
    if (overwrite.id === oldGuildId) targetId = guild.id;
    if (!targetId && overwriteType === "member" && guild.members.cache.has(overwrite.id)) targetId = overwrite.id;
    if (!targetId && overwriteType === "member" && memberTargetStates.get(overwrite.id) === "resolved") targetId = overwrite.id;
    if (!targetId && overwriteType === "role" && guild.roles.cache.has(overwrite.id)) targetId = overwrite.id;
    return targetId;
}

function buildResolvedOverwrites(guild, channelData, roleIdMap, oldGuildId, memberTargetStates = new Map()) {
    const stats = {
        restored: 0,
        skippedRoleMissing: 0,
        skippedMemberMissing: 0,
        skippedMemberUnresolved: 0
    };
    const overwrites = [];
    for (const overwrite of channelData.permissionOverwrites || []) {
        const overwriteType = normalizeOverwriteType(overwrite.type);
        const targetId = resolveRestoreOverwriteTarget(
            guild, overwrite, roleIdMap, oldGuildId, memberTargetStates
        );
        if (targetId) {
            stats.restored++;
            overwrites.push({
                id: targetId,
                allow: restoreBigInt(overwrite.allow),
                deny: restoreBigInt(overwrite.deny)
            });
        } else if (overwriteType === "member") {
            if (memberTargetStates.get(overwrite.id) === "unresolved") stats.skippedMemberUnresolved++;
            else stats.skippedMemberMissing++;
        } else {
            stats.skippedRoleMissing++;
        }
    }
    return { overwrites, stats };
}

function addOverwriteStats(target, source, { includeRestored = true } = {}) {
    if (includeRestored) target.restored += Number(source.restored || 0);
    target.skippedRoleMissing += Number(source.skippedRoleMissing || 0);
    target.skippedMemberMissing += Number(source.skippedMemberMissing || 0);
    target.skippedMemberUnresolved = Number(target.skippedMemberUnresolved || 0) +
        Number(source.skippedMemberUnresolved || 0);
}

function planRestoreOverwrites(guild, channelData, roleIdMap, oldGuildId, plan, memberTargetStates) {
    const resolved = buildResolvedOverwrites(
        guild, channelData, roleIdMap, oldGuildId, memberTargetStates
    );
    plan.overwritesRestored += resolved.stats.restored;
    plan.overwritesSkippedRoleMissing += resolved.stats.skippedRoleMissing;
    plan.overwritesSkippedMemberMissing += resolved.stats.skippedMemberMissing;
    plan.overwritesSkippedMemberUnresolved += resolved.stats.skippedMemberUnresolved;
}

function planRestoreChannel(
    guild, channelData, categoryIdMap, roleIdMap, oldGuildId, plan, memberTargetStates
) {
    if (!SUPPORTED_BACKUP_CHANNEL_TYPES.has(channelData.type)) {
        plan.channelsSkipped++;
        return;
    }
    const parentId = channelData.parentId ? categoryIdMap.get(channelData.parentId) : undefined;
    const found = findExistingChannelForRestore(guild, channelData, parentId);

    if (found.ambiguous) {
        plan.channelsAmbiguous++;
        return;
    }
    if (found.exists) {
        plan.channelsSkipped++;
        return;
    }
    plan.channelsToCreate++;
    planRestoreOverwrites(
        guild, channelData, roleIdMap, oldGuildId, plan, memberTargetStates
    );
}

async function buildRestorePlan(guild, backupData, oldGuildId, options = {}) {
    const roles = Array.isArray(backupData.roles) ? backupData.roles : [];
    const channels = normalizeSnapshotChannels(backupData.channels);
    const memberTargetStates = options.memberTargetStates instanceof Map
        ? options.memberTargetStates
        : await resolveRestoreMemberTargets(guild, channels, options);
    const roleIdMap = new Map();
    const categoryIdMap = new Map();
    const plan = {
        rolesToCreate: 0,
        rolesSkipped: 0,
        rolesAmbiguous: 0,
        channelsToCreate: 0,
        channelsSkipped: 0,
        channelsAmbiguous: 0,
        overwritesRestored: 0,
        overwritesSkippedRoleMissing: 0,
        overwritesSkippedMemberMissing: 0,
        overwritesSkippedMemberUnresolved: 0,
        warnings: []
    };

    for (const rData of roles) {
        planRestoreRole(guild, rData, roleIdMap, plan);
    }

    for (const cData of channels.filter(c => c.type === "GUILD_CATEGORY")) {
        planRestoreCategory(guild, cData, categoryIdMap, plan);
    }

    for (const cData of channels.filter(c => c.type !== "GUILD_CATEGORY")) {
        planRestoreChannel(
            guild, cData, categoryIdMap, roleIdMap, oldGuildId, plan, memberTargetStates
        );
    }

    if (plan.rolesAmbiguous || plan.channelsAmbiguous) {
        plan.warnings.push("พบชื่อซ้ำที่ต้องตรวจเองก่อน restore");
    }

    return plan;
}

function buildBackupCreatedEvent(interaction, snapshotId, data, durationMs) {
    return {
        target: "LOG", severity: "SUCCESS", category: "BACKUP", code: "backup.created",
        title: "สร้างข้อมูลสำรองเซิร์ฟเวอร์สำเร็จ",
        context: {
  "Guild ID": String(interaction.guild?.id || "unknown"),
  "User ID": String(interaction.user?.id || "unknown"),
  "Snapshot ID": String(snapshotId || "unknown"),
  "Schema": `v${data?.schemaVersion || 1}`,
  "Roles": Number(data?.roles?.length || 0),
  "Channels": Number(data?.channels?.length || 0),
  "ระยะเวลา": `${Math.max(0, Number(durationMs || 0))} ms`
        },
        sourceIconUrl: getDiscordGuildIconUrl(interaction.guild),
        thumbnailUrl: getDiscordAvatarUrl(interaction.user)
    };
}

function buildBackupFailedEvent(interaction, error, durationMs) {
    const guildId = String(interaction.guild?.id || "unknown");
    return {
        target: "ALERT", severity: "ERROR", category: "BACKUP", code: "backup.failed", state: "OPEN",
        title: "สร้างข้อมูลสำรองเซิร์ฟเวอร์ไม่สำเร็จ", description: safeError(error),
        impact: "ไม่มีการสลับไปใช้ snapshot ที่บันทึกไม่ครบ",
        action: "ตรวจ Runtime Log, MongoDB และสิทธิ์อ่านโครงสร้างเซิร์ฟเวอร์ก่อนลองใหม่",
        context: {
  "Guild ID": guildId,
  "User ID": String(interaction.user?.id || "unknown"),
  "ระยะเวลา": `${Math.max(0, Number(durationMs || 0))} ms`
        },
        sourceIconUrl: getDiscordGuildIconUrl(interaction.guild),
        thumbnailUrl: getDiscordAvatarUrl(interaction.user),
        dedupeKey: `backup-failed:${guildId}`, dedupeMs: 5 * 60 * 1000
    };
}

async function handleBackup(interaction) {
    if (interaction.user.id !== interaction.guild.ownerId &&
        !isConfiguredOwner(config, interaction.user.id)) {
        return interaction.reply({
            content: `> ${config.emojis.no_entry} คำสั่งนี้สงวนไว้สำหรับ **เจ้าของเซิร์ฟเวอร์** เท่านั้น!`,
            ephemeral: true
        });
    }

    if (activeBackups.has(interaction.guild.id)) {
        return interaction.reply({
            content: `> ${config.emojis.warning} ระบบกำลังสำรองข้อมูลอยู่ โปรดรอ`,
            ephemeral: true
        });
    }
    activeBackups.add(interaction.guild.id);
    const backupStartedAt = Date.now();

    try {
        await interaction.deferReply();
        const existing = await sessionManager.getLatestSnapshotForGuild(interaction.guild.id);
        if (existing && !isConfiguredOwner(config, interaction.user.id)) {
            const hoursPassed = (Date.now() - existing.createdAt) / 3600000;
            if (hoursPassed < 24) {
                return interaction.editReply({
                    content: `> ${config.emojis.warning} บันทึกไปแล้วเมื่อ <t:${Math.floor(existing.createdAt / 1000)}:R> โปรดรอให้ครบ 24 ชั่วโมง`
                });
            }
        }
        markCommandAccepted(interaction);

        const data = {
            schemaVersion: 2,
            createdAt: Date.now(),
            guild: {
                id: interaction.guild.id,
                name: interaction.guild.name,
                ownerId: interaction.guild.ownerId,
                icon: interaction.guild.icon || null
            },
            limitations: [
                "restore_creates_missing_only",
                "managed_roles_not_recreated",
                "webhooks_invites_threads_messages_not_restored"
            ],
            roles: sortedCollectionValues(
                interaction.guild.roles.cache,
                (a, b) => a.position - b.position
            ).map(serializeRoleForBackup),
            channels: sortedCollectionValues(
                interaction.guild.channels.cache,
                (a, b) => (a.rawPosition || 0) - (b.rawPosition || 0)
            ).map(serializeChannelForBackup).filter(Boolean)
        };
        data.validationReport = buildBackupValidationReport(data);

        const snapshotId = crypto.randomUUID();
        const stored = await sessionManager.saveChunkedSnapshot(
            snapshotId,
            interaction.guild.id,
            interaction.user.id,
            data
        );
        if (!stored) throw new Error("SNAPSHOT_SAVE_FAILED");

        sendWebhookEvent(buildBackupCreatedEvent(
            interaction, snapshotId, data, Date.now() - backupStartedAt
        )).catch(() => {});

        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setDescription(
                `> ${config.emojis.backup_icon} **บันทึกโครงสร้างสำเร็จ!**\n` +
                `— **ผู้บันทึก:** <@${interaction.user.id}>\n` +
                `— **ยศ:** ${data.roles.length} ยศ\n` +
                `— **ห้อง:** ${data.channels.length} ห้อง`
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error("[BACKUP] Failed:", err.message);
        sendWebhookEvent(buildBackupFailedEvent(
            interaction, err, Date.now() - backupStartedAt
        )).catch(() => {});
        return interaction.editReply({ content: `> ${config.emojis.error} สำรองข้อมูลไม่สำเร็จ และไม่ได้สลับไปใช้ snapshot ที่บันทึกไม่ครบ` });
    } finally {
        activeBackups.delete(interaction.guild.id);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔄  RESTORE
// ════════════════════════════════════════════════════════════════════════════
async function handleRestore(interaction) {
    await interaction.deferReply({ ephemeral: true });

    if (interaction.user.id !== interaction.guild.ownerId &&
        !isConfiguredOwner(config, interaction.user.id)) {
        return interaction.editReply({
            content: `> ${config.emojis.no_entry} คุณต้องเป็น **เจ้าของเซิร์ฟเวอร์** เท่านั้น!`
        });
    }
    if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.editReply({
            content: `> ${config.emojis.error} บอทต้องมีสิทธิ์ **Administrator** เพื่อกู้คืน!`
        });
    }

    const targetId = interaction.options.getString("server_id");
    const dryRun = interaction.options.getBoolean("dry_run") === true;
    if (!/^\d{17,22}$/.test(String(targetId || ""))) {
        return interaction.editReply({ content: `> ${config.emojis.error} Server ID ไม่ถูกต้อง` });
    }

    const backup = await sessionManager.getLatestSnapshotForGuild(targetId);
    if (!backup) {
        return interaction.editReply({ content: `> ${config.emojis.error} ไม่พบข้อมูล Backup ของไอดีนี้` });
    }
    if (backup.Backup_Owner_ID !== interaction.user.id && !isConfiguredOwner(config, interaction.user.id)) {
        return interaction.editReply({
            content: `> ${config.emojis.lock} **ปฏิเสธ!** กุญแจผู้บันทึกไม่ตรงกัน`
        });
    }

    const backupData = await sessionManager.loadSnapshotData(backup);
    if (!isValidSnapshotSchema(backupData) || !snapshotIdentityMatches(backup, backupData, targetId)) {
        return interaction.editReply({ content: `> ${config.emojis.error} Backup ไม่ครบหรือ schema ไม่ถูกต้อง จึงไม่สามารถกู้คืนได้` });
    }
    markCommandAccepted(interaction);
    const plan = await buildRestorePlan(interaction.guild, backupData, backup.guildId);
    const validation = backupData.validationReport || buildBackupValidationReport(backupData);
    const planText =
        `— จะสร้างยศใหม่: ${plan.rolesToCreate}\n` +
        `— จะสร้างห้องใหม่: ${plan.channelsToCreate}\n` +
        `— ข้าม/ชื่อซ้ำ: ${plan.rolesSkipped + plan.channelsSkipped} ข้าม, ${plan.rolesAmbiguous + plan.channelsAmbiguous} ชื่อซ้ำ\n` +
        `— Permission overwrites: ${plan.overwritesRestored} ใช้ได้, ${plan.overwritesSkippedRoleMissing} role หาย, ${plan.overwritesSkippedMemberMissing} member หาย, ${plan.overwritesSkippedMemberUnresolved} member ตรวจไม่ได้`;

    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.error)
        .setTitle(dryRun ? `${config.emojis.restore_icon} Restore Dry Run` : `${config.emojis.warning} ยืนยันการกู้คืนเซิร์ฟเวอร์`)
        .setDescription(
            `${config.emojis.folder} **ข้อมูล Backup:**\n` +
            `— บันทึกโดย: <@${backup.Backup_Owner_ID}>\n` +
            `— เวลา: <t:${Math.floor(backup.createdAt / 1000)}:F>\n` +
            `— Schema: v${backupData.schemaVersion || 1}\n` +
            `— ข้อมูล: ${backupData.roles.length} ยศ, ${backupData.channels.length} ห้อง\n` +
            `— Report: ${validation.rolesTotal} roles, ${validation.channelsTotal} channels, ${validation.overwritesTotal} overwrites\n\n` +
            `${config.emojis.signal} **แผน Restore:**\n${planText}\n\n` +
            `*กระบวนการนี้จะสร้างสิ่งที่หายไปกลับมา และจะไม่กู้คืนข้อความ, thread, webhook หรือ invite*`
        );

    if (dryRun) {
        return interaction.editReply({ embeds: [embed], components: [] });
    }

    const row = new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(`btn_restore_confirm_${interaction.guild.id}_${backup.snapshotId}`)
            .setLabel("ยืนยันกู้คืน").setStyle("SUCCESS"),
        new MessageButton()
            .setCustomId("btn_restore_cancel")
            .setLabel("ยกเลิก").setStyle("DANGER")
    );
    return interaction.editReply({ embeds: [embed], components: [row] });
}

// ════════════════════════════════════════════════════════════════════════════
//  ✅  RESTORE CONFIRM (Button Handler — ถูกเรียกจาก commands.js Router)
// ════════════════════════════════════════════════════════════════════════════
async function handleRestoreConfirm(interaction, sessionManager) {
    if (activeRestores.has(interaction.guild.id)) {
        return interaction.reply({
            content: `> ${config.emojis.warning} กำลังกู้คืนอยู่ โปรดรอ`,
            ephemeral: true
        });
    }
    activeRestores.add(interaction.guild.id);

    const confirmParts = interaction.customId.replace("btn_restore_confirm_", "").split("_");
    const boundGuildId = confirmParts[0];
    const snapshotId = confirmParts[1];
    if (boundGuildId !== interaction.guild.id) {
        activeRestores.delete(interaction.guild.id);
        return interaction.reply({ content: `> ${config.emojis.no_entry} ปุ่ม Restore นี้ไม่ได้สร้างสำหรับเซิร์ฟเวอร์นี้`, ephemeral: true });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotId)) {
        activeRestores.delete(interaction.guild.id);
        return interaction.reply({ content: `> ${config.emojis.error} รหัส Backup ไม่ถูกต้อง`, ephemeral: true });
    }

    try {
        await interaction.update({
            components: [],
            embeds: [new MessageEmbed()
                .setColor(config.system.themeColors.warning)
                .setDescription(`> ${config.emojis.signal} **กำลังกู้คืน กรุณารอสักครู่...**`)]
        });
    } catch {
        activeRestores.delete(interaction.guild.id);
        return null;
    }

    (async () => {
        try {
            const backup = await sessionManager.SnapshotModel.findOne({ snapshotId });
            const isOwner = interaction.user.id === interaction.guild.ownerId || isConfiguredOwner(config, interaction.user.id);
            const ownsBackup = backup?.Backup_Owner_ID === interaction.user.id || isConfiguredOwner(config, interaction.user.id);
            const botIsAdmin = interaction.guild.members.me.permissions.has(PermissionFlagsBits.Administrator);
            const backupData = await sessionManager.loadSnapshotData(backup);
            if (!isOwner || !ownsBackup || !botIsAdmin) {
                return interaction.followUp({ content: `> ${config.emojis.no_entry} สิทธิ์สำหรับ Restore เปลี่ยนไป กรุณาเริ่มคำสั่งใหม่`, ephemeral: true }).catch(() => {});
            }
            if (!isValidSnapshotSchema(backupData) || !snapshotIdentityMatches(backup, backupData)) {
                return interaction.followUp({ content: `> ${config.emojis.error} ไม่พบข้อมูล Backup`, ephemeral: true }).catch(() => {});
            }

            const guild = interaction.guild;
            const roles = backupData.roles;
            const channels = normalizeSnapshotChannels(backupData.channels);
            const memberTargetStates = await resolveRestoreMemberTargets(guild, channels);
            const oldGuildId = backup.guildId;
            const roleIdMap  = new Map();
            let restoredRoles    = 0;
            let restoredChannels = 0;
            let skippedRoles     = 0;
            let skippedChannels  = 0;
            let ambiguousRoles   = 0;
            let ambiguousChannels = 0;
            let restoreErrors    = 0;
            const overwriteStats = {
                restored: 0,
                skippedRoleMissing: 0,
                skippedMemberMissing: 0,
                skippedMemberUnresolved: 0
            };
            const startTime      = Date.now();
            const MAX_DUR        = 14 * 60 * 1000;
            let timeoutHit       = false;

            if (Array.isArray(roles)) {
                for (const rData of roles) {
                    await new Promise(resolve => setImmediate(resolve));

                    if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }
                    if (
                        rData.managed ||
                        rData.name === config.roles.adminName ||
                        rData.name === config.roles.userName
                    ) {
                        skippedRoles++;
                        continue;
                    }

                    let existingRole = findUniqueByName(guild.roles.cache, r => r.name === rData.name);
                    if (rData.name === "@everyone") existingRole = guild.roles.everyone;
                    if (!existingRole && guild.roles.cache.filter(r => r.name === rData.name).size > 1) {
                        ambiguousRoles++;
                        continue;
                    }

                    if (!existingRole) {
                        try {
                            existingRole = await guild.roles.create(roleCreatePayload(rData));
                            if (Number.isFinite(Number(rData.position))) {
                                try {
                                    await existingRole.setPosition(Number(rData.position), "Enterprise Restore role position");
                                } catch {
                                    restoreErrors++;
                                }
                            }
                            restoredRoles++;
                            await new Promise(r => setTimeout(r, 600));
                        } catch (e) {
                            console.error("[RESTORE] Role error:", e.message);
                            restoreErrors++;
                        }
                    }
                    if (existingRole && rData.id) roleIdMap.set(rData.id, existingRole.id);
                }
            }

            if (Array.isArray(channels)) {
                const categoryIdMap = new Map();
                const validTypes = new Set(SUPPORTED_BACKUP_CHANNEL_TYPES);



                // Pass 1: สร้าง Category ก่อน → เก็บ old ID → new ID
                for (const cData of channels) {
                    if (cData.type !== 'GUILD_CATEGORY') continue;
                    await new Promise(resolve => setImmediate(resolve));
                    if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }

                    const matches = guild.channels.cache.filter(c =>
                        c.name === cData.name && getLegacyChannelType(c.type) === "GUILD_CATEGORY"
                    );
                    const exists = matches.size === 1 ? matches.first() : null;
                    if (!exists && matches.size > 1) {
                        ambiguousChannels++;
                        continue;
                    }
                    if (exists) {
                        skippedChannels++;
                        if (cData.id) categoryIdMap.set(cData.id, exists.id);
                    } else {
                        try {
                            const resolvedOverwrites = buildResolvedOverwrites(guild, cData, roleIdMap, oldGuildId, memberTargetStates);
                            const newCat = await guild.channels.create({
                                name: cData.name,
                                ...channelCreatePayload(cData, undefined, resolvedOverwrites.overwrites),
                                type: resolveChannelType("GUILD_CATEGORY")
                            });
                            if (cData.id) categoryIdMap.set(cData.id, newCat.id);
                            addOverwriteStats(overwriteStats, resolvedOverwrites.stats);
                            restoredChannels++;
                            await new Promise(r => setTimeout(r, 600));
                        } catch (e) {
                            console.error("[RESTORE] Category error:", e.message);
                            restoreErrors++;
                        }
                    }
                }

                // Pass 2: สร้างห้องที่เหลือพร้อม parent ที่ถูกต้อง
                if (!timeoutHit) {
                    for (const cData of channels) {
                        if (cData.type === 'GUILD_CATEGORY') continue;
                        await new Promise(resolve => setImmediate(resolve));
                        if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }

                        const parentId = cData.parentId ? (categoryIdMap.get(cData.parentId) || undefined) : undefined;
                        const found = findExistingChannelForRestore(guild, cData, parentId);
                        const exists = found.exists;
                        if (!exists && found.ambiguous) {
                            ambiguousChannels++;
                            continue;
                        }
                        if (exists) {
                            skippedChannels++;
                            continue;
                        }
                        if (!exists) {
                            try {
                                if (validTypes.has(cData.type)) {
                                    const resolvedOverwrites = buildResolvedOverwrites(guild, cData, roleIdMap, oldGuildId, memberTargetStates);
                                    await guild.channels.create({
                                        name: cData.name,
                                        ...channelCreatePayload(cData, parentId, resolvedOverwrites.overwrites)
                                    });
                                    addOverwriteStats(overwriteStats, resolvedOverwrites.stats);
                                    restoredChannels++;
                                    await new Promise(r => setTimeout(r, 600));
                                } else {
                                    skippedChannels++;
                                }
                            } catch (e) {
                                console.error("[RESTORE] Channel error:", e.message);
                                restoreErrors++;
                            }
                        }
                    }
                }
            }

            const timeMsg = timeoutHit ? `\n> ${config.emojis.warning} หยุดอัตโนมัติ: เกิน 14 นาที` : "";
            const detailMsg =
                `\n— ข้าม: ${skippedRoles} ยศ, ${skippedChannels} ห้อง` +
                `\n— ชื่อซ้ำ/ไม่แน่ชัด: ${ambiguousRoles} ยศ, ${ambiguousChannels} ห้อง` +
                `\n— Permission overwrites: ${overwriteStats.restored} ใช้ได้, ${overwriteStats.skippedRoleMissing} role หาย, ${overwriteStats.skippedMemberMissing} member หาย, ${overwriteStats.skippedMemberUnresolved} member ตรวจไม่ได้` +
                `\n— Error: ${restoreErrors}`;
            const incompleteItems = skippedChannels + ambiguousRoles + ambiguousChannels +
                overwriteStats.skippedRoleMissing + overwriteStats.skippedMemberMissing +
                overwriteStats.skippedMemberUnresolved;
            let resultState = "failed";
            if (restoreErrors === 0 && !timeoutHit && incompleteItems === 0) resultState = "complete";
            else if (restoredRoles + restoredChannels > 0) resultState = "partial";
            const resultIcon = resultState === "complete" ? config.emojis.success : config.emojis.warning;
            const resultMsg = `> ${resultIcon} **ผลการกู้คืน: ${restoreStateLabel(resultState)}**\n— สร้างยศใหม่: ${restoredRoles} ยศ\n— สร้างห้องใหม่: ${restoredChannels} ห้อง${detailMsg}${timeMsg}`;
            const sent = await interaction.followUp({ content: resultMsg, ephemeral: true }).catch(() => null);
            if (!sent) {
                const embed = buildRestoreResultDmEmbed({
                    interaction,
                    resultState,
                    restoredRoles,
                    restoredChannels,
                    skippedRoles,
                    skippedChannels,
                    ambiguousRoles,
                    ambiguousChannels,
                    overwriteStats,
                    restoreErrors,
                    timeoutHit
                });
                const delivery = await dmService.send({
                    eventKey: `restore:${interaction.guild.id}:${interaction.id || startTime}`,
                    recipientId: interaction.user.id,
                    category: "restore",
                    priority: resultState === "complete" ? "normal" : "high",
                    payload: { embeds: [embed] }
                });
                if (!["sent", "retrying"].includes(delivery?.status)) {
                    console.warn(
                        `[RESTORE] Private result delivery unavailable | guild=${interaction.guild.id} | ref=${interaction.id || "unknown"}`
                    );
                    await sendWebhookEvent(buildRestoreDeliveryFailureEvent(interaction)).catch(() => false);
                }
            }

        } catch (err) {
            console.error("[RESTORE] Error:", err.message);
            await interaction.followUp({
                content: `> ${config.emojis.error} กู้คืนไม่สำเร็จ กรุณาตรวจสิทธิ์และลองใหม่`,
                ephemeral: true
            }).catch(() => {});
        } finally {
            activeRestores.delete(interaction.guild.id);
        }
    })().catch(err => {
        activeRestores.delete(interaction.guild.id);
        console.error('[RESTORE] ❌ Fatal IIFE error:', err.message);
    });
}

function getRuntimeDiagnostics() {
    return {
        activeRestores: activeRestores.size,
        activeBackups: activeBackups.size,
        activeEmojiCopies: activeEmojiCopies.size
    };
}

module.exports = {
    handle,
    handleRestoreConfirm,
    getRuntimeDiagnostics,
    _test: {
        handleSay,
        isValidSnapshotSchema,
        snapshotIdentityMatches,
        buildBackupValidationReport,
        buildRestorePlan,
        collectRestoreMemberIds,
        resolveRestoreMemberTargets,
        buildResolvedOverwrites,
        addOverwriteStats,
        normalizeOverwriteType,
        normalizeSnapshotChannelType,
        normalizeSnapshotChannels,
        buildRestoreDeliveryFailureEvent,
        buildBackupCreatedEvent,
        buildBackupFailedEvent,
        sortedCollectionValues,
        restoreStateLabel,
        restoreTone,
        buildRestoreResultDmEmbed
    }
};
