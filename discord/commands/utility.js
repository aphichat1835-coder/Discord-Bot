/* eslint-disable complexity -- Utility command flows are behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: activeRestores, activeBackups Sets — race condition guards.
DO NOT REMOVE: finally blocks — they MUST unlock Sets after every operation.
DO NOT SIMPLIFY: Restore loop — delay + setImmediate required (เฟส 19+21).
================================================================================
*/

const { MessageEmbed, MessageActionRow, MessageButton } = require("discord.js");
const crypto = require("node:crypto");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
const auditLogger = require("../auditLogger");
const {
    requireMemberPermission,
    requireBotPermission,
    safeDefer,
    sanitizeUserMessage
} = require("../guards/commandGuards");
const { sendLogWebhook } = require("../core/webhooks");

// Race Condition Guards
const activeRestores = new Set();
const activeBackups  = new Set();
const activeEmojiCopies = new Set();

async function sendUtilLog(guild, channelType, description) {
    try {
        const map = await sessionManager.getLogChannelMap(guild.id);
        const chId = map?.[`${channelType}ChannelId`];
        if (!chId) return;
        const ch = guild.channels.cache.get(chId);
        if (ch) ch.send({ embeds: [new MessageEmbed().setColor(config.system.themeColors.info).setDescription(description).setTimestamp()] }).catch(() => {});
    } catch (e) {}
}

async function handle(interaction, client, sessionManager, getLogChannel) {
    const cmd = interaction.commandName;
    if (cmd === "say")        return handleSay(interaction);
    if (cmd === "announce")   return handleAnnounce(interaction);
    if (cmd === "copy-emojis") return handleSteal(interaction);
    if (cmd === "backup")     return handleBackup(interaction);
    if (cmd === "restore")    return handleRestore(interaction);
    if (cmd === "setup-log")  return handleSetupLog(interaction, sessionManager);
}

// ════════════════════════════════════════════════════════════════════════════
//  📢  SAY (Administrator only)
// ════════════════════════════════════════════════════════════════════════════
async function handleSay(interaction) {
    const rawMsg = interaction.options.getString("message");
    const msg    = sanitizeUserMessage(rawMsg, { maxLength: 2000 });

    if (!msg) return interaction.reply({
        content: `> ${config.emojis.error} ข้อความว่างหรือถูกบล็อกทั้งหมด`,
        ephemeral: true
    });

    if (!await requireMemberPermission(interaction, "ADMINISTRATOR", `> ${config.emojis.no_entry} ต้องเป็น Administrator เพื่อใช้คำสั่งนี้`)) return;
    if (!await requireBotPermission(interaction, ["SEND_MESSAGES", "VIEW_CHANNEL"], `> ${config.emojis.error} บอทไม่มีสิทธิ์ส่งข้อความในช่องนี้ (ขาด SEND_MESSAGES หรือ VIEW_CHANNEL)`, interaction.channel)) return;

    if (!await safeDefer(interaction, { ephemeral: true })) return null;
    await interaction.channel.send(msg);
    sendUtilLog(interaction.guild, 'message', `> ${config.emojis.announce_icon} **/say ถูกใช้**\n— **โดย:** <@${interaction.user.id}>\n— **ห้อง:** <#${interaction.channel.id}>\n— **ข้อความ:** ${msg.substring(0, 200)}`).catch(() => {});
    return interaction.editReply({ content: `> ${config.emojis.success} ส่งเรียบร้อย` });
}

// ════════════════════════════════════════════════════════════════════════════
//  📣  ANNOUNCE (เฟส 4 — content field นอก Embed)
// ════════════════════════════════════════════════════════════════════════════
async function handleAnnounce(interaction) {
    if (!await requireMemberPermission(interaction, "MANAGE_MESSAGES", `> ${config.emojis.no_entry} ไม่มีสิทธิ์ใช้งาน`)) return;
    if (!await requireBotPermission(interaction, ["SEND_MESSAGES", "VIEW_CHANNEL", "EMBED_LINKS"], `> ${config.emojis.error} บอทไม่มีสิทธิ์ส่งข้อความในช่องนี้ (ขาด SEND_MESSAGES, VIEW_CHANNEL หรือ EMBED_LINKS)`, interaction.channel)) return;

    const titleText = sanitizeUserMessage(interaction.options.getString("title"), { maxLength: 250 });
    const title = `${config.emojis.announce_icon} ${titleText}`.slice(0, 256);
    const msgStr = sanitizeUserMessage(interaction.options.getString("message"), { maxLength: 4096 });
    const rawContent = interaction.options.getString("content");
    const allowMentions = interaction.options.getBoolean("allow_mentions") === true;

    if (allowMentions && !interaction.member.permissions.has("ADMINISTRATOR") && !interaction.member.permissions.has("MANAGE_GUILD")) {
        return interaction.reply({
            content: `> ${config.emojis.no_entry} การเปิด mention ต้องมี Administrator หรือ Manage Server`,
            ephemeral: true
        });
    }
    const content = rawContent
        ? (allowMentions
            ? sanitizeUserMessage(rawContent, { maxLength: 2000 })
                .replaceAll("@\u200beveryone", "@everyone")
                .replaceAll("@\u200bhere", "@here")
            : sanitizeUserMessage(rawContent, { maxLength: 2000 }))
        : null;
    if (!titleText || !msgStr) {
        return interaction.reply({ content: `> ${config.emojis.error} หัวข้อและข้อความต้องไม่ว่าง`, ephemeral: true });
    }

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
        allowedMentions: allowMentions
            ? { parse: ["users", "roles", "everyone"] }
            : { parse: [], repliedUser: false }
    });
    sendUtilLog(interaction.guild, 'message', `> ${config.emojis.announce_icon} **/announce ถูกใช้**\n— **โดย:** <@${interaction.user.id}>\n— **หัวข้อ:** ${title}\n— **ห้อง:** <#${interaction.channel.id}>`).catch(() => {});
    return interaction.editReply({ content: `> ${config.emojis.success} ประกาศสำเร็จ` });
}

// ════════════════════════════════════════════════════════════════════════════
//  😀  STEAL (เฟส 11 — Pre-check โควตา + delay กัน API ceiling)
// ════════════════════════════════════════════════════════════════════════════
async function handleSteal(interaction) {
    if (!await requireMemberPermission(interaction, "MANAGE_EMOJIS_AND_STICKERS", `> ${config.emojis.no_entry} ไม่มีสิทธิ์จัดการอิโมจิ`)) return;
    if (!await requireBotPermission(interaction, "MANAGE_EMOJIS_AND_STICKERS", `> ${config.emojis.error} บอทไม่มีสิทธิ์จัดการอิโมจิ`)) return;

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
    activeEmojiCopies.add(interaction.guild.id);

    try {

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

    const animatedToSteal = Math.min(matches.filter(m => m[1] === 'a').length, animatedFree);
    const staticToSteal   = Math.min(matches.filter(m => m[1] !== 'a').length, staticFree);
    const toSteal = animatedToSteal + staticToSteal;

    if (!await safeDefer(interaction)) return null;
    let added   = 0;
    let failed  = 0;
    let skipped = 0;

    let staticAdded = 0, animatedAdded = 0;
    for (let i = 0; i < matches.length; i++) {
        const match      = matches[i];
        const isAnimated = match[1] === "a";
        const name       = match[2];
        const id         = match[3];
        const url        = `https://cdn.discordapp.com/emojis/${id}.${isAnimated ? 'gif' : 'png'}`;

        if (isAnimated && animatedAdded >= animatedFree) { skipped++; continue; }
        if (!isAnimated && staticAdded >= staticFree)    { skipped++; continue; }

        try {
            await interaction.guild.emojis.create(url, name);
            if (isAnimated) animatedAdded++; else staticAdded++;
            added++;
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            failed++;
        }

        if (added % 10 === 0 && added > 0) {
            await interaction.editReply({
                embeds: [new MessageEmbed()
                    .setColor(config.system.themeColors.warning)
                    .setDescription(`> ${config.emojis.loading} **กำลังดึงอิโมจิ...** ${added}/${toSteal}`)]
            }).catch(() => {});
        }
    }

    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.success)
        .setDescription(
            `> ${config.emojis.success} **นำเข้าอิโมจิสำเร็จ:** ${added} ตัว` +
            (failed  > 0 ? `\n> ${config.emojis.error} **ล้มเหลว:** ${failed} ตัว` : '') +
            (skipped > 0 ? `\n> ${config.emojis.warning} **ข้ามเพราะโควตาเต็ม:** ${skipped} ตัว` : '')
        );
    if (added > 0) sendUtilLog(interaction.guild, 'server', `> ${config.emojis.emoji_icon} **/copy-emojis ถูกใช้**\n— **โดย:** <@${interaction.user.id}>\n— **เพิ่มสำเร็จ:** ${added} ตัว${failed > 0 ? `\n— **ล้มเหลว:** ${failed} ตัว` : ''}`).catch(() => {});
    return interaction.editReply({ embeds: [embed] });
    } finally {
        activeEmojiCopies.delete(interaction.guild.id);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  💾  BACKUP
// ════════════════════════════════════════════════════════════════════════════
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

function serializeChannelForBackup(channel) {
    const out = {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId,
        position: channel.position,
        rawPosition: channel.rawPosition,
        permissionOverwrites: channel.permissionOverwrites.cache.map(o => ({
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
        type: cData.type,
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

function buildBackupValidationReport(data) {
    const roles = Array.isArray(data.roles) ? data.roles : [];
    const channels = Array.isArray(data.channels) ? data.channels : [];
    const overwritesTotal = channels.reduce((sum, c) => sum + (Array.isArray(c.permissionOverwrites) ? c.permissionOverwrites.length : 0), 0);
    const unsupportedItems = [];
    const warnings = [];

    const managedRoles = roles.filter(role => role.managed).length;
    if (managedRoles) warnings.push(`${managedRoles} managed roles cannot be recreated`);

    const unsupportedChannels = channels.filter(c => !["GUILD_TEXT","GUILD_VOICE","GUILD_CATEGORY","GUILD_NEWS","GUILD_STAGE_VOICE"].includes(c.type));
    for (const channel of unsupportedChannels) unsupportedItems.push(`channel:${channel.type}:${channel.name}`);

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
    if (!data || !Array.isArray(data.roles) || !Array.isArray(data.channels)) return false;
    if (!snowflake(data.guild?.id)) return false;
    if (data.roles.some(role => !role || !snowflake(role.id) || typeof role.name !== "string")) return false;
    return !data.channels.some(channel =>
        !channel || !snowflake(channel.id) || typeof channel.name !== "string" ||
        (channel.parentId != null && !snowflake(channel.parentId)) ||
        (Array.isArray(channel.permissionOverwrites) && channel.permissionOverwrites.some(overwrite => !snowflake(overwrite?.id)))
    );
}

function findExistingChannelForRestore(guild, cData, parentId) {
    let matches = guild.channels.cache.filter(c => c.name === cData.name && c.type === cData.type);

    if (cData.type !== "GUILD_CATEGORY") {
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

    if (!existingRole) plan.rolesToCreate++;
    if (existingRole && roleData.id) roleIdMap.set(roleData.id, existingRole.id);
}

function planRestoreCategory(guild, channelData, categoryIdMap, plan) {
    const found = findExistingChannelForRestore(guild, channelData);

    if (found.ambiguous) {
        plan.channelsAmbiguous++;
    } else if (found.exists) {
        if (channelData.id) categoryIdMap.set(channelData.id, found.exists.id);
    } else {
        plan.channelsToCreate++;
    }
}

function resolveRestoreOverwriteTarget(guild, overwrite, roleIdMap, oldGuildId) {
    let targetId = roleIdMap.get(overwrite.id);
    if (overwrite.id === oldGuildId) targetId = guild.id;
    if (!targetId && overwrite.type === "member" && guild.members.cache.has(overwrite.id)) targetId = overwrite.id;
    if (!targetId && overwrite.type === "role" && guild.roles.cache.has(overwrite.id)) targetId = overwrite.id;
    return targetId;
}

function planRestoreOverwrites(guild, channelData, roleIdMap, oldGuildId, plan) {
    for (const overwrite of channelData.permissionOverwrites || []) {
        const targetId = resolveRestoreOverwriteTarget(guild, overwrite, roleIdMap, oldGuildId);
        if (targetId) plan.overwritesRestored++;
        else if (overwrite.type === "member") plan.overwritesSkippedMemberMissing++;
        else plan.overwritesSkippedRoleMissing++;
    }
}

function planRestoreChannel(guild, channelData, categoryIdMap, roleIdMap, oldGuildId, plan) {
    const parentId = channelData.parentId ? categoryIdMap.get(channelData.parentId) : undefined;
    const found = findExistingChannelForRestore(guild, channelData, parentId);

    if (found.ambiguous) plan.channelsAmbiguous++;
    else if (!found.exists) plan.channelsToCreate++;

    planRestoreOverwrites(guild, channelData, roleIdMap, oldGuildId, plan);
}

function buildRestorePlan(guild, backupData, oldGuildId) {
    const roles = Array.isArray(backupData.roles) ? backupData.roles : [];
    const channels = Array.isArray(backupData.channels) ? backupData.channels : [];
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
        warnings: []
    };

    for (const rData of roles) {
        planRestoreRole(guild, rData, roleIdMap, plan);
    }

    for (const cData of channels.filter(c => c.type === "GUILD_CATEGORY")) {
        planRestoreCategory(guild, cData, categoryIdMap, plan);
    }

    for (const cData of channels.filter(c => c.type !== "GUILD_CATEGORY")) {
        planRestoreChannel(guild, cData, categoryIdMap, roleIdMap, oldGuildId, plan);
    }

    if (plan.rolesAmbiguous || plan.channelsAmbiguous) {
        plan.warnings.push("พบชื่อซ้ำที่ต้องตรวจเองก่อน restore");
    }

    return plan;
}

async function handleBackup(interaction) {
    if (interaction.user.id !== interaction.guild.ownerId &&
        interaction.user.id !== config.system.ownerId) {
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

    try {
        await interaction.deferReply();
        const existing = await sessionManager.SnapshotModel.findOne({ guildId: interaction.guild.id });
        if (existing && interaction.user.id !== config.system.ownerId) {
            const hoursPassed = (Date.now() - existing.createdAt) / 3600000;
            if (hoursPassed < 24) {
                return interaction.editReply({
                    content: `> ${config.emojis.warning} บันทึกไปแล้วเมื่อ <t:${Math.floor(existing.createdAt / 1000)}:R> โปรดรอให้ครบ 24 ชั่วโมง`
                });
            }
        }

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
            roles: interaction.guild.roles.cache
                .sort((a, b) => a.position - b.position)
                .map(serializeRoleForBackup),
            channels: interaction.guild.channels.cache
                .sort((a, b) => (a.rawPosition || 0) - (b.rawPosition || 0))
                .map(serializeChannelForBackup)
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

        await sendLogWebhook({
            content: `${config.emojis.backup_icon} **[BACKUP]** Guild: ${interaction.guild.name}\nBy: ${interaction.user.tag}\nRoles: ${data.roles.length} | Channels: ${data.channels.length}`
        }).catch(() => {});

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
        interaction.user.id !== config.system.ownerId) {
        return interaction.editReply({
            content: `> ${config.emojis.no_entry} คุณต้องเป็น **เจ้าของเซิร์ฟเวอร์** เท่านั้น!`
        });
    }
    if (!interaction.guild.members.me.permissions.has("ADMINISTRATOR")) {
        return interaction.editReply({
            content: `> ${config.emojis.error} บอทต้องมีสิทธิ์ **Administrator** เพื่อกู้คืน!`
        });
    }

    const targetId = interaction.options.getString("server_id");
    const dryRun = interaction.options.getBoolean("dry_run") === true;
    if (!/^\d{17,22}$/.test(String(targetId || ""))) {
        return interaction.editReply({ content: `> ${config.emojis.error} Server ID ไม่ถูกต้อง` });
    }

    const backup = await sessionManager.SnapshotModel.findOne({ guildId: targetId });
    if (!backup) {
        return interaction.editReply({ content: `> ${config.emojis.error} ไม่พบข้อมูล Backup ของไอดีนี้` });
    }
    if (backup.Backup_Owner_ID !== interaction.user.id && interaction.user.id !== config.system.ownerId) {
        return interaction.editReply({
            content: `> ${config.emojis.lock} **ปฏิเสธ!** กุญแจผู้บันทึกไม่ตรงกัน`
        });
    }

    const backupData = await sessionManager.loadSnapshotData(backup);
    if (!isValidSnapshotSchema(backupData)) {
        return interaction.editReply({ content: `> ${config.emojis.error} Backup ไม่ครบหรือ schema ไม่ถูกต้อง จึงไม่สามารถกู้คืนได้` });
    }
    const plan = buildRestorePlan(interaction.guild, backupData, backup.guildId);
    const validation = backupData.validationReport || buildBackupValidationReport(backupData);
    const planText =
        `— จะสร้างยศใหม่: ${plan.rolesToCreate}\n` +
        `— จะสร้างห้องใหม่: ${plan.channelsToCreate}\n` +
        `— ข้าม/ชื่อซ้ำ: ${plan.rolesSkipped + plan.channelsSkipped} ข้าม, ${plan.rolesAmbiguous + plan.channelsAmbiguous} ชื่อซ้ำ\n` +
        `— Permission overwrites: ${plan.overwritesRestored} ใช้ได้, ${plan.overwritesSkippedRoleMissing} role หาย, ${plan.overwritesSkippedMemberMissing} member หาย`;

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
            const isOwner = interaction.user.id === interaction.guild.ownerId || interaction.user.id === config.system.ownerId;
            const ownsBackup = backup?.Backup_Owner_ID === interaction.user.id || interaction.user.id === config.system.ownerId;
            const botIsAdmin = interaction.guild.members.me.permissions.has("ADMINISTRATOR");
            const backupData = await sessionManager.loadSnapshotData(backup);
            if (!isOwner || !ownsBackup || !botIsAdmin) {
                return interaction.followUp({ content: `> ${config.emojis.no_entry} สิทธิ์สำหรับ Restore เปลี่ยนไป กรุณาเริ่มคำสั่งใหม่`, ephemeral: true }).catch(() => {});
            }
            if (!isValidSnapshotSchema(backupData)) {
                return interaction.followUp({ content: `> ${config.emojis.error} ไม่พบข้อมูล Backup`, ephemeral: true }).catch(() => {});
            }

            const guild = interaction.guild;
            const { roles, channels } = backupData;
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
                skippedMemberMissing: 0
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
                                await existingRole.setPosition(Number(rData.position), "Enterprise Restore role position").catch(() => {});
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
                const validTypes = ["GUILD_TEXT","GUILD_VOICE","GUILD_CATEGORY","GUILD_NEWS","GUILD_STAGE_VOICE"];

                function buildOverwrites(cData) {
                    const out = [];
                    if (!Array.isArray(cData.permissionOverwrites)) return out;
                    for (const ow of cData.permissionOverwrites) {
                        let targetId = roleIdMap.get(ow.id);
                        if (ow.id === oldGuildId) targetId = guild.id;
                        if (!targetId && ow.type === "member" && guild.members.cache.has(ow.id)) targetId = ow.id;
                        if (!targetId && ow.type === "role" && guild.roles.cache.has(ow.id)) targetId = ow.id;
                        if (targetId) {
                            overwriteStats.restored++;
                            out.push({ id: targetId, allow: restoreBigInt(ow.allow), deny: restoreBigInt(ow.deny) });
                        } else if (ow.type === "member") {
                            overwriteStats.skippedMemberMissing++;
                        } else {
                            overwriteStats.skippedRoleMissing++;
                        }
                    }
                    return out;
                }

                // Pass 1: สร้าง Category ก่อน → เก็บ old ID → new ID
                for (const cData of channels) {
                    if (cData.type !== 'GUILD_CATEGORY') continue;
                    await new Promise(resolve => setImmediate(resolve));
                    if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }

                    const matches = guild.channels.cache.filter(c => c.name === cData.name && c.type === 'GUILD_CATEGORY');
                    const exists = matches.size === 1 ? matches.first() : null;
                    if (!exists && matches.size > 1) {
                        ambiguousChannels++;
                        continue;
                    }
                    if (exists) {
                        if (cData.id) categoryIdMap.set(cData.id, exists.id);
                    } else {
                        try {
                            const newCat = await guild.channels.create(cData.name, {
                                ...channelCreatePayload(cData, undefined, buildOverwrites(cData)),
                                type: 'GUILD_CATEGORY'
                            });
                            if (cData.id) categoryIdMap.set(cData.id, newCat.id);
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
                        if (!exists) {
                            try {
                                if (validTypes.includes(cData.type)) {
                                    await guild.channels.create(cData.name, channelCreatePayload(cData, parentId, buildOverwrites(cData)));
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
                `\n— Permission overwrites: ${overwriteStats.restored} ใช้ได้, ${overwriteStats.skippedRoleMissing} role หาย, ${overwriteStats.skippedMemberMissing} member หาย` +
                `\n— Error: ${restoreErrors}`;
            const resultState = restoreErrors === 0 && !timeoutHit && ambiguousRoles === 0 && ambiguousChannels === 0
                ? "complete"
                : (restoredRoles + restoredChannels > 0 ? "partial" : "failed");
            const resultIcon = resultState === "complete" ? config.emojis.success : config.emojis.warning;
            const resultMsg = `> ${resultIcon} **ผลการกู้คืน: ${resultState}**\n— สร้างยศใหม่: ${restoredRoles} ยศ\n— สร้างห้องใหม่: ${restoredChannels} ห้อง${detailMsg}${timeMsg}`;
            const sent = await interaction.followUp({ content: resultMsg, ephemeral: true }).catch(() => null);
            if (!sent) {
                const dmSent = await interaction.user.send({ content: `${resultMsg}\n*(แจ้งทาง DM เพราะ interaction หมดอายุ)*` }).catch(() => null);
                if (!dmSent) interaction.channel?.send({ content: resultMsg }).catch(() => {});
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

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  SETUP-LOG
// ════════════════════════════════════════════════════════════════════════════
async function handleSetupLog(interaction, sessionManager) {
    if (!await requireMemberPermission(interaction, "ADMINISTRATOR", `> ${config.emojis.no_entry} ต้องเป็น Administrator`)) return;
    await safeDefer(interaction, { ephemeral: true });

    const categories = ['message', 'member', 'voice', 'server', 'security'];
    const created = [];

    // U-8: สร้าง/หา Category สำหรับ Audit Log + permission Admin only
    let auditCategory = interaction.guild.channels.cache.find(
        c => c.type === 'GUILD_CATEGORY' && c.name === config.audit_channels.categoryName
    );
    if (!auditCategory) {
        try {
            const overwrites = [
                { id: interaction.guild.id, deny: ['VIEW_CHANNEL'] },
                { id: interaction.guild.members.me.id, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'] }
            ];
            if (interaction.guild.roles.cache.has(config.roles.fallbackAdminId)) {
                overwrites.push({ id: config.roles.fallbackAdminId, allow: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'] });
            }
            auditCategory = await interaction.guild.channels.create(config.audit_channels.categoryName, {
                type: 'GUILD_CATEGORY',
                permissionOverwrites: overwrites,
                reason: 'Enterprise /setup-log'
            });
            created.push(`${config.emojis.category} **หมวดหมู่:** ${auditCategory.name}`);
        } catch (e) {
            created.push(`${config.emojis.error} **หมวดหมู่** — ล้มเหลว: ${e.message}`);
        }
    }

    // U-7: แสดง progress เริ่มต้น
    await interaction.editReply({ content: `${config.emojis.loading} **กำลังสร้าง Audit Log channels...**` });

    for (const cat of categories) {
        try {
            const existing = await sessionManager.getLogChannelMap(interaction.guild.id);
            const key = `${cat}ChannelId`;
            if (existing && existing[key]) {
                const channelStillExists = interaction.guild.channels.cache.has(existing[key]);
                if (channelStillExists) {
                    created.push(`${config.emojis.warning} \`${cat}\` — มีอยู่แล้ว (<#${existing[key]}>)`);
                    continue;
                }
                await sessionManager.setLogChannelMap(interaction.guild.id, cat, null).catch(() => {});
            }

            const createOptions = {
                type: 'GUILD_TEXT',
                topic: `Enterprise Audit Log — ${cat}`,
                reason: 'Enterprise /setup-log'
            };
            if (auditCategory) createOptions.parent = auditCategory.id;

            const ch = await interaction.guild.channels.create(`log-${cat}`, createOptions);
            await sessionManager.setLogChannelMap(interaction.guild.id, cat, ch.id);
            created.push(`${config.emojis.success} \`${cat}\` → <#${ch.id}>`);

            // U-7: อัปเดต progress + delay 1500ms กัน rate limit
            await interaction.editReply({
                content: `${config.emojis.loading} **กำลังติดตั้ง...**\n${created.join('\n')}`
            });
            await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
            created.push(`${config.emojis.error} \`${cat}\` — ล้มเหลว: ${e.message}`);
        }
    }

    auditLogger.invalidateAuditCache(interaction.guild.id);
    return interaction.editReply({
        content: `${config.emojis.settings_icon} **ติดตั้ง Audit Log เรียบร้อย:**\n${created.join('\n')}`
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
    _test: { handleSay, isValidSnapshotSchema, buildBackupValidationReport }
};
