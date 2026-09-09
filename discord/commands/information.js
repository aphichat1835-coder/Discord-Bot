/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: /ping dashboard — shows Latency, RAM, CPU, Sessions.
DO NOT REMOVE: /userinfo account-age context — new account detection without claiming certainty.
DO NOT SIMPLIFY: /serverinfo member fetch — bot/human split required.
================================================================================
*/

const os = require("node:os");
const mongoose = require("mongoose");
const { PermissionFlagsBits, UserFlagsBitField } = require("discord.js");
const { MessageEmbed, MessageActionRow, MessageButton, getLegacyChannelType } = require("../core/discordCompat");
const config = require("../config.json");
const { isConfiguredOwner } = require("../core/env");
const { markCommandAccepted } = require("../guards/commandGuards");
const { code, markdownText, safeText } = require("../dm/design");
const SERVERINFO_CACHE_TTL_MS = 60 * 1000;
const SERVERINFO_FETCH_TIMEOUT_MS = 5 * 1000;
const SERVERINFO_FULL_FETCH_MAX_MEMBERS = 2500;
const serverInfoCounts = new Map();
const serverInfoInFlight = new Map();

function isVerifiedBotUser(user) {
    if (!user?.bot) return false;
    if (user.flags && typeof user.flags.has === "function") {
        return user.flags.has(UserFlagsBitField.Flags.VerifiedBot);
    }
    const bitfield = Number(user.flags?.bitfield ?? user.flags ?? 0);
    return (bitfield & 65536) === 65536;
}

function toMemberList(members) {
    if (Array.isArray(members)) return members;
    if (typeof members?.values === "function") return Array.from(members.values());
    return null;
}

function countMembersFromCollection(members) {
    const humanRes = members.filter(member => !member?.user?.bot);
    const botRes = members.filter(member => member?.user?.bot);
    const humanCount = Number(humanRes?.size ?? humanRes?.length ?? 0);
    const botCount = Number(botRes?.size ?? botRes?.length ?? 0);

    let verifiedCount = 0;
    try {
        const vRes = members.filter(member => member?.user?.bot && isVerifiedBotUser(member?.user));
        verifiedCount = Number(vRes?.size ?? vRes?.length ?? 0);
    } catch {
        verifiedCount = 0;
    }

    return {
        human: humanCount,
        bots: botCount,
        verifiedBots: verifiedCount,
        unverifiedBots: Math.max(0, botCount - verifiedCount)
    };
}

function countCachedMembers(members) {
    const list = toMemberList(members);

    if (list) {
        let human = 0;
        let bots = 0;
        let verifiedBots = 0;
        for (const member of list) {
            if (member?.user?.bot) {
                bots++;
                if (isVerifiedBotUser(member.user)) verifiedBots++;
            } else {
                human++;
            }
        }
        return {
            human,
            bots,
            verifiedBots,
            unverifiedBots: Math.max(0, bots - verifiedBots)
        };
    }

    if (typeof members?.filter === "function") {
        return countMembersFromCollection(members);
    }

    return { human: 0, bots: 0, verifiedBots: 0, unverifiedBots: 0 };
}

function unknownMemberCounts(guild, source) {
    const total = Number(guild.memberCount);
    return {
        human: null,
        bots: null,
        verifiedBots: null,
        unverifiedBots: null,
        total: Number.isFinite(total) && total >= 0 ? total : null,
        source,
        at: Date.now()
    };
}

async function getServerMemberCounts(guild, now = Date.now()) {
    const cached = serverInfoCounts.get(guild.id);
    if (cached && now - cached.at < SERVERINFO_CACHE_TTL_MS) return cached;
    if (serverInfoInFlight.has(guild.id)) return serverInfoInFlight.get(guild.id);
    if (!serverInfoCounts.has(guild.id) && serverInfoCounts.size >= 500) {
        serverInfoCounts.delete(serverInfoCounts.keys().next().value);
    }
    const task = (async () => {
        const cachedMembers = guild.members.cache;
        const rawMemberCount = Number(guild.memberCount);
        const memberCount = Number.isFinite(rawMemberCount) && rawMemberCount >= 0
            ? rawMemberCount
            : cachedMembers.size;
        if (memberCount > SERVERINFO_FULL_FETCH_MAX_MEMBERS) {
            const completeCache = memberCount > 0 && cachedMembers.size >= memberCount;
            const result = completeCache
                ? { ...countCachedMembers(cachedMembers), total: memberCount, source: "ข้อมูลที่บอทเก็บไว้ครบตามยอดสมาชิก", at: Date.now() }
                : unknownMemberCounts(guild, `มีสมาชิก ${memberCount} คน จึงไม่โหลดรายชื่อทั้งหมดเพื่อป้องกันคำสั่งทำงานหนักเกินไป`);
            serverInfoCounts.set(guild.id, result);
            return result;
        }
        try {
            const members = await guild.members.fetch({ time: SERVERINFO_FETCH_TIMEOUT_MS });
            const result = {
                ...countCachedMembers(members),
                total: memberCount || members.size,
                source: "ข้อมูลล่าสุดที่บอทโหลดจาก Discord (เก็บไว้ไม่เกิน 60 วินาที)",
                at: Date.now()
            };
            serverInfoCounts.set(guild.id, result);
            return result;
        } catch {
            const result = cachedMembers.size > 0
                ? { ...countCachedMembers(cachedMembers), total: memberCount || cachedMembers.size, source: "คำนวณจากข้อมูลที่บอทเก็บไว้ เพราะโหลดรายชื่อสมาชิกล่าสุดไม่สำเร็จ", at: Date.now() }
                : unknownMemberCounts(guild, "ประเมินจำนวนคนและบอทไม่ได้ เพราะ Discord ไม่ส่งรายชื่อกลับมาและบอทยังไม่มีข้อมูลเก็บไว้");
            serverInfoCounts.set(guild.id, result);
            return result;
        }
    })().finally(() => serverInfoInFlight.delete(guild.id));
    serverInfoInFlight.set(guild.id, task);
    return task;
}

async function handle(interaction, client, sessionManager) {
    const cmd = interaction.commandName;
    if (cmd === "serverinfo") return handleServerInfo(interaction);
    if (cmd === "userinfo")   return handleUserInfo(interaction);
    if (cmd === "ping")       return handlePing(interaction, client, sessionManager);
}

function discordTimestamp(timestamp, style = "F") {
    const epoch = Math.floor(Number(timestamp) / 1000);
    return Number.isFinite(epoch) && epoch > 0 ? `<t:${epoch}:${style}>` : "ไม่ทราบ";
}

function formatDuration(totalSeconds) {
    let remaining = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const days = Math.floor(remaining / 86400);
    remaining %= 86400;
    const hours = Math.floor(remaining / 3600);
    remaining %= 3600;
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const parts = [];
    if (days) parts.push(`${days} วัน`);
    if (hours || days) parts.push(`${hours} ชม.`);
    if (minutes || hours || days) parts.push(`${minutes} นาที`);
    parts.push(`${seconds} วินาที`);
    return parts.join(" ");
}

function formatCount(value, fallback = "ไม่ทราบ") {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number.toLocaleString("th-TH") : fallback;
}

function formatLatency(value) {
    const number = Number(value);
    return value !== null && value !== undefined && Number.isFinite(number) && number >= 0
        ? `${formatCount(number)} ms`
        : "ไม่ทราบ";
}

function buildServerLoadingEmbed(interaction) {
    const guildName = markdownText(interaction.guild?.name, "เซิร์ฟเวอร์นี้", 100);
    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.primary)
        .setTitle(`${config.emojis.signal || "🛰️"} กำลังสำรวจเซิร์ฟเวอร์`)
        .setDescription(`กำลังเปิดภาพรวมของ **${guildName}** และตรวจข้อมูลล่าสุดที่บอทมองเห็น`)
        .addField(
            "ขอบเขตที่กำลังตรวจสอบ",
            "`MEMBERS` คนและบอท\n`CHANNELS` ช่องและหมวดหมู่\n`SECURITY` การยืนยัน 2FA และตัวกรองสื่อ"
        )
        .setFooter({ text: "เซิร์ฟเวอร์ขนาดใหญ่อาจใช้เวลานานขึ้นเล็กน้อย" })
        .setTimestamp();
    const icon = interaction.guild?.iconURL?.({ forceStatic: false, size: 256 });
    if (icon) embed.setThumbnail(icon);
    return embed;
}

function buildUserLoadingEmbed(interaction) {
    const selectedUser = interaction.options?.getUser?.("member");
    const user = selectedUser || interaction.user;
    const targetLabel = user?.globalName || user?.username || "สมาชิก";
    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.info)
        .setTitle(`${config.emojis.search || "🔍"} กำลังเปิดแฟ้มข้อมูลสมาชิก`)
        .setDescription(`**${markdownText(targetLabel, "สมาชิก", 100)}**\nกำลังโหลดโปรไฟล์ล่าสุดจาก Discord และจับคู่กับข้อมูลในเซิร์ฟเวอร์นี้`)
        .addField(
            "กำลังจัดเรียงข้อมูล",
            `${config.emojis.loading || "⏳"} โปรไฟล์และอายุบัญชี • ยศและสิทธิ์ • Timeout และสถานะสมาชิก`
        )
        .setFooter({ text: "แสดงเฉพาะข้อมูลที่บอทเข้าถึงได้ • ผลลัพธ์จะมาแทนที่ข้อความนี้" })
        .setTimestamp();
    const avatar = user?.displayAvatarURL?.({ forceStatic: false, size: 256 });
    if (avatar) embed.setThumbnail(avatar);
    return embed;
}

function buildPingLoadingEmbed() {
    return new MessageEmbed()
        .setColor(config.system.themeColors.warning)
        .setTitle(`${config.emojis.ping || "🏓"} กำลังจับสัญญาณระบบ`)
        .setDescription(
            "```text\n" +
            "LATENCY   กำลังวัดการตอบกลับ\n" +
            "CPU/RAM   กำลังเก็บตัวอย่าง\n" +
            "VOICE     กำลังอ่านสถานะ\n" +
            "```"
        )
        .setFooter({ text: "ค่าทั้งหมดวัดใหม่จากการเรียกคำสั่งครั้งนี้" })
        .setTimestamp();
}

function buildLoadingEmbed(kind, interaction) {
    if (kind === "serverinfo") return buildServerLoadingEmbed(interaction);
    if (kind === "userinfo") return buildUserLoadingEmbed(interaction);
    return buildPingLoadingEmbed();
}

function sendLoadingState(interaction, kind) {
    return interaction.reply({
        embeds: [buildLoadingEmbed(kind, interaction)],
        fetchReply: true,
        allowedMentions: { parse: [] }
    });
}

function channelCounts(guild) {
    const channels = guild.channels?.cache;
    const count = type => channels?.filter?.(channel => getLegacyChannelType(channel.type) === type).size || 0;
    const known = ["GUILD_TEXT", "GUILD_VOICE", "GUILD_CATEGORY", "GUILD_NEWS", "GUILD_STAGE_VOICE", "GUILD_FORUM", "GUILD_MEDIA"];
    const knownTotal = known.reduce((total, type) => total + count(type), 0);
    return {
        text: count("GUILD_TEXT"),
        voice: count("GUILD_VOICE"),
        category: count("GUILD_CATEGORY"),
        announcement: count("GUILD_NEWS"),
        stage: count("GUILD_STAGE_VOICE"),
        forum: count("GUILD_FORUM"),
        media: count("GUILD_MEDIA"),
        other: Math.max(0, Number(channels?.size || 0) - knownTotal)
    };
}

function verificationLevelLabel(level) {
    return ({
        0: "ไม่มีเงื่อนไขเพิ่มเติม",
        1: "ต้องยืนยันอีเมล",
        2: "ยืนยันอีเมลและบัญชีเกิน 5 นาที",
        3: "ต้องอยู่ในเซิร์ฟเวอร์เกิน 10 นาที",
        4: "ต้องยืนยันหมายเลขโทรศัพท์"
    })[Number(level)] || "ไม่ทราบ";
}

function contentFilterLabel(level) {
    return ({
        0: "ปิดการสแกนสื่อ",
        1: "สแกนสมาชิกที่ไม่มียศ",
        2: "สแกนสื่อจากสมาชิกทุกคน"
    })[Number(level)] || "ไม่ทราบ";
}

function boostTierLabel(tier, count) {
    const tierNumber = Number(tier) || 0;
    const countLabel = formatCount(count, "0");
    return tierNumber === 0 ? `ยังไม่มีระดับ • ${countLabel} Boost` : `ระดับ ${tierNumber} • ${countLabel} Boost`;
}

function guildFeatureLabels(features = []) {
    const labels = {
        ANIMATED_ICON: "ไอคอนเคลื่อนไหว",
        BANNER: "แบนเนอร์",
        COMMUNITY: "Community",
        DISCOVERABLE: "Discoverable",
        FEATURABLE: "แนะนำโดย Discord",
        INVITE_SPLASH: "ภาพคำเชิญ",
        MONETIZATION_ENABLED: "สร้างรายได้",
        PARTNERED: "Discord Partner",
        VANITY_URL: "ลิงก์เชิญแบบกำหนดเอง",
        VERIFIED: "เซิร์ฟเวอร์ยืนยันแล้ว",
        WELCOME_SCREEN_ENABLED: "หน้าต้อนรับ"
    };
    const visible = features.map(feature => labels[feature]).filter(Boolean);
    return visible.length ? visible.join(" • ") : "ไม่มีคุณสมบัติพิเศษที่แสดงได้";
}

function channelMention(channelId) {
    return channelId ? `<#${channelId}>` : "ไม่ได้ตั้งค่า";
}

function buildOtherChannelsLine(channels) {
    const otherChannelParts = [];
    if (channels.announcement > 0) otherChannelParts.push(`ประกาศ **${formatCount(channels.announcement)}**`);
    if (channels.stage > 0) otherChannelParts.push(`Stage **${formatCount(channels.stage)}**`);
    if (channels.forum > 0) otherChannelParts.push(`ฟอรัม **${formatCount(channels.forum)}**`);
    if (channels.other > 0) otherChannelParts.push(`อื่น ๆ **${formatCount(channels.other)}**`);
    return otherChannelParts.length > 0
        ? `> **ช่องอื่น ๆ:** ${otherChannelParts.join(" • ")}\n`
        : "";
}

function buildSpecialChannelsLine(guild) {
    const specialChannels = [];
    if (guild.safetyAlertsChannelId) {
        specialChannels.push(`แจ้งเตือนความปลอดภัย ${channelMention(guild.safetyAlertsChannelId)}`);
    }
    if (guild.publicUpdatesChannelId) {
        specialChannels.push(`ข่าวสารทางการ ${channelMention(guild.publicUpdatesChannelId)}`);
    }
    return specialChannels.length > 0
        ? `> **ช่องพิเศษ:** ${specialChannels.join(" • ")}\n`
        : "";
}

function buildServerInfoEmbed(guild, owner, memberCounts, extra = {}) {
    const channels = channelCounts(guild);
    const ownerId = owner?.id || guild.ownerId;
    const humanCount = formatCount(memberCounts.human, "ประเมินไม่ได้");
    const botCount = formatCount(memberCounts.bots, "ประเมินไม่ได้");
    const totalMembers = formatCount(memberCounts.total ?? guild.memberCount);
    const roleCount = Math.max(0, Number(guild.roles?.cache?.size || 0) - 1);
    const emojiCount = Number(guild.emojis?.cache?.size || 0);
    const stickerCount = Number(guild.stickers?.cache?.size || 0);
    const totalChannels = (channels.text || 0) + (channels.voice || 0) + (channels.category || 0) +
        (channels.announcement || 0) + (channels.stage || 0) + (channels.forum || 0) +
        (channels.media || 0) + (channels.other || 0);

    const ownerValue = ownerId ? `<@${ownerId}>\n` + code(ownerId) : "ไม่ทราบ";
    const vanityValue = guild.vanityURLCode
        ? markdownText("discord.gg/" + guild.vanityURLCode, "-", 100)
        : "ไม่มี";
    const description = guild.description
        ? `> ${markdownText(guild.description, "", 300)}\n\n`
        : "";

    const maxUploadMb = [25, 25, 50, 100][Number(guild.premiumTier) || 0] || 25;
    const maxBitrateKbps = Math.round(Number(guild.maximumBitrate || 96000) / 1000);
    const autoModSummary = extra.autoModSummary || "ไม่ได้เปิดใช้";

    const otherChannelsLine = buildOtherChannelsLine(channels);
    const specialChannelsLine = buildSpecialChannelsLine(guild);

    const botBreakdown = (memberCounts.verifiedBots !== null && memberCounts.unverifiedBots !== null)
        ? ` (ยืนยันแล้ว: **${formatCount(memberCounts.verifiedBots)}** • ยังไม่ยืนยัน: **${formatCount(memberCounts.unverifiedBots)}**)`
        : "";

    const memberLines =
        `> **สมาชิกทั้งหมด:** **${totalMembers}** คน\n` +
        `> • 👥 คนจริง: **${humanCount}** คน\n` +
        `> • 🤖 บอท: **${botCount}** ตัว${botBreakdown}`;

    const embed = new MessageEmbed()
        .setColor(guild.available === false ? config.system.themeColors.warning : config.system.themeColors.primary)
        .setTitle(`📊 ข้อมูลเซิร์ฟเวอร์ • ${safeText(guild.name, "ไม่ทราบชื่อ", 180)}`)
        .setDescription(`${description}ข้อมูลด้านล่างมาจาก Discord และข้อมูลชั่วคราวที่บอทมองเห็นในขณะเรียกคำสั่ง`)
        .addFields(
            {
                name: "🏠 ข้อมูลทั่วไป & สมาชิก",
                value:
                    `> **เจ้าของ:** ${ownerValue}\n` +
                    `> **วันที่สร้าง:** ${discordTimestamp(guild.createdTimestamp, "F")} (${discordTimestamp(guild.createdTimestamp, "R")})\n` +
                    `> **ภาษาเริ่มต้น:** **${markdownText(guild.preferredLocale || "ไม่ทราบ", "ไม่ทราบ", 40)}**\n` +
                    memberLines,
                inline: false
            },
            {
                name: "🗂️ โครงสร้างช่อง & ทรัพยากร",
                value:
                    `> **ช่องแชท:** ทั้งหมด **${formatCount(totalChannels)}** (ข้อความ **${formatCount(channels.text)}** • เสียง **${formatCount(channels.voice)}** • หมวดหมู่ **${formatCount(channels.category)}**)\n` +
                    otherChannelsLine +
                    `> **ทรัพยากร:** ยศ **${formatCount(roleCount)}** • อีโมจิ **${formatCount(emojiCount)}** • สติกเกอร์ **${formatCount(stickerCount)}**`,
                inline: false
            },
            {
                name: "🛡️ ความปลอดภัย & Boost",
                value:
                    `> **ความปลอดภัย:** ระดับยืนยัน **${verificationLevelLabel(guild.verificationLevel)}**\n` +
                    `> **ตัวกรองสื่อ:** **${contentFilterLabel(guild.explicitContentFilter)}** • **2FA ผู้ดูแล:** **${Number(guild.mfaLevel) === 1 ? "บังคับใช้" : "ไม่ได้บังคับ"}**\n` +
                    `> **กฎ AutoMod:** ${autoModSummary}\n` +
                    `> **Boost:** ${boostTierLabel(guild.premiumTier, guild.premiumSubscriptionCount)} (Vanity: **${vanityValue}**)\n` +
                    `> **ขีดจำกัด:** อัปโหลดสูงสุด **${maxUploadMb} MB** • เสียงสูงสุด **${maxBitrateKbps} kbps**`,
                inline: false
            },
            {
                name: "🧭 ช่องระบบ & คุณสมบัติ",
                value:
                    `> **ช่องระบบ:** กฎ ${channelMention(guild.rulesChannelId)} • ข้อความระบบ ${channelMention(guild.systemChannelId)}\n` +
                    `> **ช่อง AFK:** ${channelMention(guild.afkChannelId)} • ย้ายเมื่อเงียบ **${formatDuration(guild.afkTimeout || 0)}**\n` +
                    specialChannelsLine +
                    `> **คุณสมบัติพิเศษ:** ${guildFeatureLabels(guild.features)}`,
                inline: false
            }
        )
        .setFooter({ text: `เรียกดูโดย ${safeText(guild.members?.me?.user?.tag || "Phomueangtai", "Phomueangtai", 120)} • ข้อมูลอาจเปลี่ยนหลังเรียกคำสั่ง` })
        .setTimestamp();

    const iconUrl = guild.iconURL?.({ forceStatic: false, size: 1024 });
    if (iconUrl) embed.setThumbnail(iconUrl);

    const bannerUrl = guild.bannerURL?.({ forceStatic: false, size: 1024 }) || guild.splashURL?.({ forceStatic: false, size: 1024 });
    if (bannerUrl) embed.setImage(bannerUrl);

    return embed;
}

function buildServerInfoActionRow(guild) {
    const buttons = [];
    const iconUrl = guild.iconURL?.({ forceStatic: false, size: 4096 });
    if (iconUrl) {
        buttons.push(
            new MessageButton()
                .setStyle("LINK")
                .setLabel("รูปไอคอน")
                .setEmoji("🖼️")
                .setURL(iconUrl)
        );
    }

    const bannerUrl = guild.bannerURL?.({ forceStatic: false, size: 4096 });
    if (bannerUrl) {
        buttons.push(
            new MessageButton()
                .setStyle("LINK")
                .setLabel("แบนเนอร์")
                .setEmoji("🎨")
                .setURL(bannerUrl)
        );
    } else {
        const splashUrl = guild.splashURL?.({ forceStatic: false, size: 4096 });
        if (splashUrl) {
            buttons.push(
                new MessageButton()
                    .setStyle("LINK")
                    .setLabel("ภาพคำเชิญ")
                    .setEmoji("🌅")
                    .setURL(splashUrl)
            );
        }
    }

    return buttons.length > 0 ? [new MessageActionRow().addComponents(buttons)] : [];
}

// ════════════════════════════════════════════════════════════════════════════
//  🏠  SERVERINFO (เฟส 4 — Bot/Human split + Boost)
// ════════════════════════════════════════════════════════════════════════════
async function handleServerInfo(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
            content: "> ⛔ คำสั่งนี้จำเป็นต้องใช้สิทธิ์ผู้ดูแลระบบ (Administrator) เท่านั้น",
            ephemeral: true
        });
    }
    markCommandAccepted(interaction);
    await sendLoadingState(interaction, "serverinfo");
    const guild = interaction.guild;
    if (!guild) return interaction.editReply({ content: "คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์", embeds: [] });

    let autoModSummary = "ไม่มีสิทธิ์ตรวจดู";
    const botMember = guild.members?.me;
    if (botMember?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        try {
            const rules = await guild.autoModerationRules?.fetch().catch(() => null);
            if (rules) {
                const enabledCount = rules.filter(r => r.enabled).size;
                autoModSummary = rules.size > 0
                    ? `**${rules.size}** กฎ (${enabledCount} เปิดใช้)`
                    : "ไม่ได้เปิดใช้";
            } else {
                autoModSummary = "ไม่ได้เปิดใช้";
            }
        } catch {
            autoModSummary = "ไม่มีสิทธิ์ตรวจดู";
        }
    }

    const memberCounts = await getServerMemberCounts(guild);
    const owner = await guild.fetchOwner().catch(() => null);
    const embed = buildServerInfoEmbed(guild, owner, memberCounts, { autoModSummary });
    const components = buildServerInfoActionRow(guild);
    return interaction.editReply({
        embeds: [embed],
        components: components.length > 0 ? components : [],
        allowedMentions: { parse: [] }
    });
}

const BADGE_LABELS = Object.freeze({
    DISCORD_EMPLOYEE: "Discord Staff",
    PARTNERED_SERVER_OWNER: "เจ้าของ Partnered Server",
    HYPESQUAD_EVENTS: "HypeSquad Events",
    BUGHUNTER_LEVEL_1: "Bug Hunter ระดับ 1",
    BUGHUNTER_LEVEL_2: "Bug Hunter ระดับ 2",
    HOUSE_BRAVERY: "HypeSquad Bravery",
    HOUSE_BRILLIANCE: "HypeSquad Brilliance",
    HOUSE_BALANCE: "HypeSquad Balance",
    EARLY_SUPPORTER: "Early Supporter",
    VERIFIED_BOT_DEVELOPER: "Early Verified Bot Developer",
    ACTIVE_DEVELOPER: "Active Developer",
    DISCORD_CERTIFIED_MODERATOR: "Discord Certified Moderator"
});

const IMPORTANT_PERMISSION_LABELS = Object.freeze({
    Administrator: "ผู้ดูแลระบบ",
    ManageGuild: "จัดการเซิร์ฟเวอร์",
    ManageRoles: "จัดการยศ",
    ManageChannels: "จัดการช่อง",
    KickMembers: "เตะสมาชิก",
    BanMembers: "แบนสมาชิก",
    ModerateMembers: "หมดเวลาสมาชิก",
    ManageWebhooks: "จัดการ Webhook",
    ManageMessages: "จัดการข้อความ"
});

function accountAgeSummary(user, now = Date.now()) {
    const ageDays = Math.max(0, Math.floor((now - Number(user.createdTimestamp || now)) / 86400000));
    const newLimit = Number(config.risk_thresholds.newAccountAgeDays) || 7;
    const recentLimit = Number(config.risk_thresholds.suspiciousAccountAgeDays) || 30;
    if (user.bot) return { ageDays, color: config.system.themeColors.info, label: "บัญชีบอท" };
    if (ageDays < newLimit) {
        return { ageDays, color: config.system.themeColors.warning, label: `บัญชีสร้างไม่ถึง ${newLimit} วัน — ควรตรวจสอบบริบทก่อนให้สิทธิ์สำคัญ` };
    }
    if (ageDays < recentLimit) {
        return { ageDays, color: config.system.themeColors.warning, label: `บัญชีสร้างมาไม่นาน (น้อยกว่า ${recentLimit} วัน)` };
    }
    return { ageDays, color: config.system.themeColors.success, label: "อายุบัญชีผ่านช่วงเฝ้าดูเบื้องต้น" };
}

function visibleRoleSummary(member) {
    const roleCollection = member?.roles?.cache;
    if (!roleCollection?.filter) return "ไม่พบข้อมูลยศในเซิร์ฟเวอร์";
    const roles = roleCollection
        .filter(role => role.id !== member?.guild?.id)
        .sort((left, right) => right.position - left.position)
        .map(role => role.toString());
    const visible = [];
    let length = 0;
    for (const role of roles) {
        if (length + role.length + 3 > 850) break;
        visible.push(role);
        length += role.length + 3;
    }
    const hidden = roles.length - visible.length;
    if (!visible.length) return "ไม่มียศเพิ่มเติม";
    const hiddenLabel = hidden > 0 ? "\nและอีก **" + hidden + "** ยศ" : "";
    return visible.join(" • ") + hiddenLabel;
}

function importantPermissions(member) {
    if (!member?.permissions?.has) return "ไม่พบข้อมูลสิทธิ์";
    if (member.guild?.ownerId === member.id) return "เจ้าของเซิร์ฟเวอร์ (มีสิทธิ์สูงสุด)";
    const labels = Object.entries(IMPORTANT_PERMISSION_LABELS)
        .filter(([permission]) => member.permissions.has(PermissionFlagsBits[permission]))
        .map(([, label]) => label);
    return labels.length ? labels.join(" • ") : "ไม่มีสิทธิ์จัดการระดับสูง";
}

function publicBadges(user) {
    const flags = user.flags?.toArray?.() || [];
    return flags.length ? flags.map(flag => BADGE_LABELS[flag] || flag).join(" • ") : "ไม่มี Public Badge ที่ Discord ส่งมา";
}

function userTypeDetailLabel(user) {
    if (user?.bot) {
        return isVerifiedBotUser(user) ? "บอทที่ได้รับการยืนยัน (Verified Bot ✔️)" : "บอททั่วไป (Bot)";
    }
    if (user?.system) return "บัญชีระบบ Discord (System)";
    return "ผู้ใช้งานทั่วไป (User)";
}

function userTypeLabel(user) {
    return userTypeDetailLabel(user);
}

function getJoinPosition(member) {
    if (!member?.joinedTimestamp || !member?.guild?.members?.cache) return null;
    const sorted = [...member.guild.members.cache.values()]
        .filter(m => m?.joinedTimestamp)
        .sort((a, b) => a.joinedTimestamp - b.joinedTimestamp);
    const index = sorted.findIndex(m => m.id === member.id);
    return index >= 0 ? index + 1 : null;
}

function memberStaffLabel(member) {
    if (!member) return "ไม่พบข้อมูลสมาชิก";
    if (member.guild?.ownerId === member.id) return "👑 เจ้าของเซิร์ฟเวอร์ (Server Owner)";
    const hasModPerms = Boolean(
        member.permissions?.has?.(PermissionFlagsBits.Administrator) ||
        member.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
        member.permissions?.has?.(PermissionFlagsBits.BanMembers) ||
        member.permissions?.has?.(PermissionFlagsBits.KickMembers) ||
        member.permissions?.has?.(PermissionFlagsBits.ModerateMembers) ||
        member.permissions?.has?.(PermissionFlagsBits.ManageMessages)
    );
    return hasModPerms ? "🛡️ ทีมงานดูแลเซิร์ฟเวอร์ (Staff / Mod)" : "👤 สมาชิกทั่วไป (Member)";
}

function highestRoleLabel(member) {
    if (!member?.roles?.cache) return "ไม่พบข้อมูลยศ";
    const nonEveryone = member.roles.cache.filter(role => role.id !== member.guild?.id);
    if (!nonEveryone.size) return "ไม่มี (มีเฉพาะ @everyone)";
    const highest = nonEveryone.sort((a, b) => b.position - a.position).first();
    return highest ? `${highest.toString()} (ลำดับที่ ${highest.position})` : "ไม่มี";
}

function memberBoostDetail(member) {
    if (!member?.premiumSinceTimestamp) return "ไม่ได้ Boost เซิร์ฟเวอร์นี้";
    const days = Math.max(0, Math.floor((Date.now() - member.premiumSinceTimestamp) / 86400000));
    return `กำลัง Boost เซิร์ฟเวอร์นี้ 🚀 (นาน **${formatCount(days)} วัน** • ตั้งแต่ ${discordTimestamp(member.premiumSinceTimestamp, "R")})`;
}

function memberState(member) {
    if (!member) return "ไม่พบข้อมูลสมาชิกในเซิร์ฟเวอร์";
    const timeoutUntil = Number(member.communicationDisabledUntilTimestamp || 0);
    const timeout = timeoutUntil > Date.now() ? `ถูกหมดเวลาถึง ${discordTimestamp(timeoutUntil, "F")}` : "ไม่ได้ถูกหมดเวลา";
    const pending = member.pending ? "ยังไม่ผ่าน Membership Screening" : "ผ่าน Membership Screening แล้ว/ไม่ได้เปิดใช้";
    const boosting = memberBoostDetail(member);
    return `${timeout}\n${pending}\n${boosting}`;
}

function buildUserInfoActionRow(user, member) {
    const buttons = [];
    const globalAvatar = user?.displayAvatarURL?.({ forceStatic: false, size: 4096 });
    if (globalAvatar) {
        buttons.push(
            new MessageButton()
                .setStyle("LINK")
                .setLabel("รูปโปรไฟล์")
                .setEmoji("🖼️")
                .setURL(globalAvatar)
        );
    }
    const serverAvatar = member?.avatarURL?.({ forceStatic: false, size: 4096 });
    if (serverAvatar) {
        buttons.push(
            new MessageButton()
                .setStyle("LINK")
                .setLabel("รูปในเซิร์ฟเวอร์")
                .setEmoji("🏠")
                .setURL(serverAvatar)
        );
    }
    const banner = user?.bannerURL?.({ forceStatic: false, size: 4096 });
    if (banner) {
        buttons.push(
            new MessageButton()
                .setStyle("LINK")
                .setLabel("แบนเนอร์")
                .setEmoji("🎨")
                .setURL(banner)
        );
    }
    if (user?.id) {
        buttons.push(
            new MessageButton()
                .setStyle("LINK")
                .setLabel("โปรไฟล์ Discord")
                .setEmoji("👤")
                .setURL(`https://discord.com/users/${user.id}`)
        );
    }
    return buttons.length > 0 ? [new MessageActionRow().addComponents(buttons)] : [];
}

function buildUserInfoEmbed(interaction, user, member) {
    const age = accountAgeSummary(user);
    const displayName = user.globalName || member?.displayName || user.username;
    const tag = user.discriminator && user.discriminator !== "0" ? user.tag : `@${user.username}`;
    const joined = member?.joinedTimestamp
        ? `${discordTimestamp(member.joinedTimestamp, "F")} (${discordTimestamp(member.joinedTimestamp, "R")})`
        : "ไม่พบข้อมูลวันที่เข้าเซิร์ฟเวอร์";
    const displayColor = member?.displayHexColor && member.displayHexColor !== "#000000"
        ? member.displayHexColor
        : (user.hexAccentColor || "ไม่มีสีประจำยศ");
    const profileIcon = user.bot ? "🤖" : "🧑";
    const userMention = user.id ? `<@${user.id}>` : "";
    const joinPos = getJoinPosition(member);
    const guildMemberCount = member?.guild?.memberCount || member?.guild?.members?.cache?.size || 0;
    const joinOrderStr = joinPos
        ? `คนที่ **#${joinPos}** (จากสมาชิก ${formatCount(guildMemberCount)} คน)`
        : "ไม่ทราบลำดับ";
    const rolesCount = Math.max(0, Number(member?.roles?.cache?.size || 1) - 1);

    const timeoutUntil = Number(member?.communicationDisabledUntilTimestamp || 0);
    const timeoutStr = timeoutUntil > Date.now() ? `ถูกหมดเวลาถึง ${discordTimestamp(timeoutUntil, "F")}` : "ไม่ได้ถูกหมดเวลา";
    const pendingStr = member?.pending ? "ยังไม่ผ่าน Membership Screening" : "ผ่านการคัดกรองแล้ว / ไม่ได้เปิดใช้";

    const embed = new MessageEmbed()
        .setColor(age.color)
        .setTitle(`👤 ข้อมูลสมาชิก • ${safeText(displayName, "ไม่ทราบชื่อ", 180)}`)
        .setDescription(`${profileIcon} **${markdownText(displayName, "ไม่ทราบชื่อ", 100)}** • ${markdownText(tag, "ไม่ทราบ", 100)}\n${userMention}`)
        .addFields(
            {
                name: "🪪 1. ข้อมูลบัญชี & อายุ (Account Details)",
                value:
                    `• User ID: ${code(user.id)}\n` +
                    `• ประเภท: **${userTypeDetailLabel(user)}**\n` +
                    `• วันสร้างบัญชี: ${discordTimestamp(user.createdTimestamp, "F")} (${discordTimestamp(user.createdTimestamp, "R")})\n` +
                    `• อายุบัญชี: **${formatCount(age.ageDays)} วัน** • สถานะ: **${age.label}**\n` +
                    `• Public Badges: ${publicBadges(user)}`,
                inline: false
            },
            {
                name: "🏠 2. ข้อมูลในเซิร์ฟเวอร์นี้ (Server Profile)",
                value:
                    `• ชื่อเล่น: **${markdownText(member?.nickname || "ไม่ได้ตั้งชื่อเล่น", "ไม่ได้ตั้ง", 100)}**\n` +
                    `• เข้าร่วมเมื่อ: ${joined}\n` +
                    `• ลำดับการเข้าร่วม: ${joinOrderStr}\n` +
                    `• โทนสีประจำตัว/ยศ: **${displayColor}**`,
                inline: false
            },
            {
                name: "🛡️ 3. ยศและสิทธิ์ในเซิร์ฟเวอร์ (Roles & Permissions)",
                value:
                    `• บทบาทหน้าที่: **${memberStaffLabel(member)}**\n` +
                    `• ยศสูงสุด: ${highestRoleLabel(member)}\n` +
                    `• ยศทั้งหมด (${formatCount(rolesCount)}): ${visibleRoleSummary(member)}\n` +
                    `• สิทธิ์สำคัญ: ${importantPermissions(member)}`,
                inline: false
            },
            {
                name: "🧭 4. สถานะสมาชิก & กิจกรรม (Member Status)",
                value:
                    `• สถานะการ Boost: ${memberBoostDetail(member)}\n` +
                    `• การหมดเวลา (Timeout): ${timeoutStr}\n` +
                    `• Membership Screening: ${pendingStr}`,
                inline: false
            }
        )
        .setFooter({ text: `เรียกดูโดย ${safeText(interaction.user?.tag || interaction.user?.username, "สมาชิก", 120)} • ข้อมูลเรียลไทม์` })
        .setTimestamp();

    const avatar = member?.displayAvatarURL?.({ forceStatic: false, size: 1024 }) ||
        user.displayAvatarURL?.({ forceStatic: false, size: 1024 });
    if (avatar) embed.setThumbnail(avatar);
    const banner = user.bannerURL?.({ forceStatic: false, size: 1024 });
    if (banner) embed.setImage(banner);
    return embed;
}

async function resolveUserInfoTarget(interaction) {
    const selectedUser = interaction.options?.getUser?.("member") || null;
    const selectedMember = interaction.options?.getMember?.("member") || null;
    const targetId = selectedUser?.id || selectedMember?.id || interaction.user?.id;
    let member = selectedMember;
    if (!member && targetId === interaction.user?.id) member = interaction.member || null;
    if (!member && interaction.guild?.members?.fetch) member = await interaction.guild.members.fetch(targetId).catch(() => null);
    const fallbackUser = selectedUser || member?.user || interaction.user;
    const user = (interaction.client?.users?.fetch
        ? await interaction.client.users.fetch(targetId, { force: true }).catch(() => fallbackUser)
        : fallbackUser) || fallbackUser;
    return { user, member };
}

// ════════════════════════════════════════════════════════════════════════════
//  👤  USERINFO (Account context + badges + current guild state)
// ════════════════════════════════════════════════════════════════════════════
async function handleUserInfo(interaction) {
    markCommandAccepted(interaction);
    await sendLoadingState(interaction, "userinfo");
    const { user, member } = await resolveUserInfoTarget(interaction);
    const components = buildUserInfoActionRow(user, member);
    return interaction.editReply({
        embeds: [buildUserInfoEmbed(interaction, user, member)],
        components: components.length > 0 ? components : [],
        allowedMentions: { parse: [] }
    });
}

function makeProgressBar(percent, length = 8) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const filled = Math.round((clamped / 100) * length);
    const empty = Math.max(0, length - filled);
    return `\`[${"▰".repeat(filled)}${"▱".repeat(empty)}]\``;
}

function collectSessionStats(sessionManager) {
    if (!sessionManager || typeof sessionManager.getAllSessions !== "function") {
        return { total: 0, active: 0, recovering: 0, failed: 0 };
    }
    const sessions = [...sessionManager.getAllSessions().values()];
    return {
        total: sessions.length,
        active: sessions.filter(session => sessionManager.isSessionRunnable?.(session) !== false && !session?.reconnecting).length,
        recovering: sessions.filter(session => session?.reconnecting === true).length,
        failed: sessions.filter(session => session?.state === "failed" || session?.tokenInvalid === true).length
    };
}

function cpuPercent(cpuStart, cpuEnd, elapsedMicroseconds) {
    const used = Math.max(0, Number(cpuEnd.user - cpuStart.user) + Number(cpuEnd.system - cpuStart.system));
    const elapsed = Math.max(1, Number(elapsedMicroseconds) || 1);
    return used / elapsed * 100;
}

function latencyState(latency) {
    if (!Number.isFinite(latency) || latency < 0) return { label: "ไม่ทราบ", color: config.system.themeColors.warning };
    if (latency < 100) return { label: "ตอบสนองดีเยี่ยม", color: config.system.themeColors.success };
    if (latency < 300) return { label: "ตอบสนองปกติ", color: config.system.themeColors.warning };
    return { label: "ตอบสนองช้า", color: config.system.themeColors.error };
}

function buildPingEmbed(stats) {
    const state = latencyState(Math.max(stats.interactionLatency, stats.websocketLatency ?? 0));
    const hostTotalGB = Number.isFinite(stats.hostTotalGB) ? stats.hostTotalGB : (os.totalmem() / 1024 / 1024 / 1024);
    const hostUsedGB = Number.isFinite(stats.hostUsedGB) ? stats.hostUsedGB : ((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024);
    let calculatedHostPercent = 0;
    if (hostTotalGB > 0) {
        calculatedHostPercent = (hostUsedGB / hostTotalGB) * 100;
    }
    const hostUsedPercent = Number.isFinite(stats.hostUsedPercent) ? stats.hostUsedPercent : calculatedHostPercent;
    const cpuCores = stats.cpuCores || os.cpus()?.length || 1;

    const dbFallbackStatus = stats.databaseReady ? "พร้อมใช้งาน (Connected)" : "ไม่ได้เชื่อมต่อ";
    const mongoStatus = stats.mongoPingMs != null
        ? `${stats.mongoPingMs} ms`
        : dbFallbackStatus;

    const embed = new MessageEmbed()
        .setColor(state.color)
        .setTitle("🏓 รายงานสถานะบอทและประสิทธิภาพระบบ (System Diagnostics)")
        .setDescription(`สถานะปัจจุบัน: **${state.label}** • อัปเดตล่าสุด <t:${Math.floor(Date.now() / 1000)}:T>\n> ข้อมูลสถิติเครือข่าย ฮาร์ดแวร์โฮสต์ และ Voice Subsystem แบบเรียลไทม์`)
        .addFields(
            {
                name: "🌐 1. การเชื่อมต่อ & ความหน่วง (Network & Latency)",
                value:
                    `• คำสั่งตอบกลับ: **${formatLatency(stats.interactionLatency)}**\n` +
                    `• WebSocket **${formatLatency(stats.websocketLatency)}**\n` +
                    `• MongoDB Database: **${mongoStatus}**\n` +
                    `• คลัสเตอร์ Shard: **${formatCount(stats.shardId)}** จาก **${formatCount(stats.shardCount)}**`,
                inline: false
            },
            {
                name: "🧠 2. ทรัพยากรระบบ & Host (Resources & Hardware)",
                value:
                    `• CPU ระหว่างการวัด **${stats.cpuPercent.toFixed(1)}%** ${makeProgressBar(stats.cpuPercent)}\n` +
                    `• RAM (RSS) **${stats.rssMB.toFixed(1)} MB** • V8 Heap **${stats.heapUsedMB.toFixed(1)} / ${stats.heapTotalMB.toFixed(1)} MB**\n` +
                    `• Host RAM **${hostUsedGB.toFixed(1)} / ${hostTotalGB.toFixed(1)} GB** (${hostUsedPercent.toFixed(0)}%) ${makeProgressBar(hostUsedPercent)}\n` +
                    `• ระบบปฏิบัติการ: **${process.platform} (${process.arch})** • **${cpuCores} Cores**`,
                inline: false
            },
            {
                name: "📡 3. สถิติระบบ & เวลาทำงาน (System & Uptime)",
                value:
                    `• เวลาทำงาน: **${formatDuration(stats.uptimeSeconds)}**\n` +
                    `• เริ่มทำงาน: ${discordTimestamp(stats.startedAt, "R")}\n` +
                    `• เซิร์ฟเวอร์ที่ดูแล: **${formatCount(stats.guildCount)}** เซิร์ฟเวอร์\n` +
                    `• สมาชิกรวม: **${formatCount(stats.reportedMemberCount)}** คน • Node.js **${process.version}**`,
                inline: false
            },
            {
                name: "🎙️ 4. Voice Subsystem & สุขภาพระบบ (Voice & Health)",
                value:
                    `• Voice Sessions: ใช้งาน **${formatCount(stats.sessions.active)}** • กำลังกู้คืน **${formatCount(stats.sessions.recovering)}**\n` +
                    `  (ล้มเหลว **${formatCount(stats.sessions.failed)}** • จัดเก็บทั้งหมด **${formatCount(stats.sessions.total)}**)\n` +
                    `• ฐานข้อมูล: **${stats.databaseReady ? "พร้อมใช้งาน" : "ยังไม่พร้อม"}**\n` +
                    `• Telemetry: คำขอ **${formatCount(stats.requests)}** • Error events **${formatCount(stats.errors)}** • Reconnect **${formatCount(stats.reconnects)}**`,
                inline: false
            }
        )
        .setFooter({ text: "RAM คือ Process RSS จริง • CPU เป็นค่าที่วัดระหว่างตอบคำสั่งครั้งนี้" })
        .setTimestamp();

    if (stats.botAvatarUrl) {
        embed.setThumbnail(stats.botAvatarUrl);
    }

    return embed;
}

// ════════════════════════════════════════════════════════════════════════════
//  🏓  PING (เฟส 4 — Shard & System Dashboard, Owner Only)
// ════════════════════════════════════════════════════════════════════════════
async function handlePing(interaction, client, sessionManager) {
    markCommandAccepted(interaction);
    if (!isConfiguredOwner(config, interaction.user?.id)) {
        return interaction.reply({
            content: "> 🔒 คำสั่งนี้สงวนสิทธิ์เฉพาะ **เจ้าของบอท (Bot Owner)** เท่านั้น",
            ephemeral: true
        });
    }

    const cpuStart = process.cpuUsage();
    const wallStart = process.hrtime.bigint();
    const sent = await sendLoadingState(interaction, "ping");
    const cpuEnd = process.cpuUsage();
    const elapsedMicroseconds = Number(process.hrtime.bigint() - wallStart) / 1000;
    const interactionLatency = Math.max(0, Number(sent?.createdTimestamp ?? Date.now()) - Number(interaction.createdTimestamp ?? Date.now()));
    const websocketLatency = Number(client?.ws?.ping);

    let mongoPingMs = null;
    try {
        if (mongoose.connection?.readyState === 1 && mongoose.connection?.db) {
            const mongoStart = Date.now();
            await mongoose.connection.db.admin().ping();
            mongoPingMs = Date.now() - mongoStart;
        }
    } catch {
        mongoPingMs = null;
    }

    const startedAt = Number(sessionManager?.systemMetrics?.uptime || Date.now());
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = Math.max(0, totalMem - freeMem);
    const hostUsedPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
    const cpuCores = os.cpus()?.length || 1;

    const guildCount = client?.guilds?.cache?.size || 0;
    const reportedMemberCount = client?.guilds?.cache?.reduce?.((total, guild) => total + (Number(guild?.memberCount) || 0), 0) || 0;
    const metrics = sessionManager?.getSystemMetrics?.() || sessionManager?.systemMetrics || {};
    const botAvatarUrl = client?.user?.displayAvatarURL?.({ size: 1024, forceStatic: false }) || null;

    const stats = {
        interactionLatency,
        websocketLatency: Number.isFinite(websocketLatency) && websocketLatency >= 0 ? websocketLatency : null,
        mongoPingMs,
        shardId: Number(interaction.guild?.shardId || 0),
        shardCount: Number(client?.ws?.shards?.size || 1),
        startedAt,
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
        rssMB: mem.rss / 1024 / 1024,
        heapUsedMB: mem.heapUsed / 1024 / 1024,
        heapTotalMB: mem.heapTotal / 1024 / 1024,
        externalMB: mem.external / 1024 / 1024,
        hostTotalGB: totalMem / 1024 / 1024 / 1024,
        hostUsedGB: usedMem / 1024 / 1024 / 1024,
        hostFreeGB: freeMem / 1024 / 1024 / 1024,
        hostUsedPercent,
        cpuCores,
        cpuPercent: cpuPercent(cpuStart, cpuEnd, elapsedMicroseconds),
        guildCount,
        reportedMemberCount,
        sessions: collectSessionStats(sessionManager),
        databaseReady: Boolean(metrics.dbConnected || mongoose.connection?.readyState === 1),
        requests: Number(metrics.requests || 0),
        errors: Number(metrics.errors || 0),
        reconnects: Number(metrics.reconnects || 0),
        botAvatarUrl
    };
    return interaction.editReply({ content: null, embeds: [buildPingEmbed(stats)], allowedMentions: { parse: [] } });
}

module.exports = {
    handle,
    _test: {
        getServerMemberCounts,
        countCachedMembers,
        unknownMemberCounts,
        serverInfoCounts,
        serverInfoInFlight,
        SERVERINFO_FETCH_TIMEOUT_MS,
        SERVERINFO_FULL_FETCH_MAX_MEMBERS,
        discordTimestamp,
        formatDuration,
        formatLatency,
        buildServerLoadingEmbed,
        buildUserLoadingEmbed,
        buildPingLoadingEmbed,
        buildLoadingEmbed,
        sendLoadingState,
        channelCounts,
        verificationLevelLabel,
        contentFilterLabel,
        channelMention,
        buildServerInfoEmbed,
        buildServerInfoActionRow,
        accountAgeSummary,
        visibleRoleSummary,
        importantPermissions,
        memberState,
        buildUserInfoEmbed,
        buildUserInfoActionRow,
        getJoinPosition,
        userTypeDetailLabel,
        memberStaffLabel,
        highestRoleLabel,
        memberBoostDetail,
        resolveUserInfoTarget,
        makeProgressBar,
        collectSessionStats,
        cpuPercent,
        latencyState,
        buildPingEmbed
    }
};
