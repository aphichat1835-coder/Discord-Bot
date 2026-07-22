/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: /ping dashboard — shows Latency, RAM, CPU, Sessions.
DO NOT REMOVE: /userinfo account-age context — new account detection without claiming certainty.
DO NOT SIMPLIFY: /serverinfo member fetch — bot/human split required.
================================================================================
*/

const { MessageEmbed, getLegacyChannelType } = require("../core/discordCompat");
const config = require("../config.json");
const { markCommandAccepted } = require("../guards/commandGuards");
const { code, markdownText, safeText } = require("../dm/design");
const SERVERINFO_CACHE_TTL_MS = 60 * 1000;
const SERVERINFO_FETCH_TIMEOUT_MS = 5 * 1000;
const SERVERINFO_FULL_FETCH_MAX_MEMBERS = 2500;
const serverInfoCounts = new Map();
const serverInfoInFlight = new Map();

function countCachedMembers(members) {
    return {
        human: members.filter(member => !member.user.bot).size,
        bots: members.filter(member => member.user.bot).size
    };
}

function unknownMemberCounts(guild, source) {
    const total = Number(guild.memberCount);
    return {
        human: null,
        bots: null,
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
    const known = ["GUILD_TEXT", "GUILD_VOICE", "GUILD_CATEGORY", "GUILD_NEWS", "GUILD_STAGE_VOICE"];
    const knownTotal = known.reduce((total, type) => total + count(type), 0);
    return {
        text: count("GUILD_TEXT"),
        voice: count("GUILD_VOICE"),
        category: count("GUILD_CATEGORY"),
        announcement: count("GUILD_NEWS"),
        stage: count("GUILD_STAGE_VOICE"),
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

function buildServerInfoEmbed(guild, owner, memberCounts) {
    const channels = channelCounts(guild);
    const ownerId = owner?.id || guild.ownerId;
    const humanCount = formatCount(memberCounts.human, "ประเมินไม่ได้");
    const botCount = formatCount(memberCounts.bots, "ประเมินไม่ได้");
    const totalMembers = formatCount(memberCounts.total ?? guild.memberCount);
    const roleCount = Math.max(0, Number(guild.roles?.cache?.size || 0) - 1);
    const emojiCount = Number(guild.emojis?.cache?.size || 0);
    const stickerCount = Number(guild.stickers?.cache?.size || 0);
    const ownerValue = ownerId ? `<@${ownerId}>\n` + code(ownerId) : "ไม่ทราบ";
    const vanityValue = guild.vanityURLCode
        ? markdownText("discord.gg/" + guild.vanityURLCode, "-", 100)
        : "ไม่มี";
    const description = guild.description
        ? `> ${markdownText(guild.description, "", 300)}\n\n`
        : "";
    const embed = new MessageEmbed()
        .setColor(guild.available === false ? config.system.themeColors.warning : config.system.themeColors.primary)
        .setTitle(`📊 ข้อมูลเซิร์ฟเวอร์ • ${safeText(guild.name, "ไม่ทราบชื่อ", 180)}`)
        .setDescription(`${description}ข้อมูลด้านล่างมาจาก Discord และข้อมูลชั่วคราวที่บอทมองเห็นในขณะเรียกคำสั่ง`)
        .addFields(
            {
                name: "🏠 ตัวตนของเซิร์ฟเวอร์",
                value: `ชื่อ: **${markdownText(guild.name, "ไม่ทราบชื่อ", 100)}**\nID: ${code(guild.id)}\nเจ้าของ: ${ownerValue}`,
                inline: true
            },
            {
                name: "🗓️ วันที่สร้าง",
                value: `${discordTimestamp(guild.createdTimestamp, "F")}\n${discordTimestamp(guild.createdTimestamp, "R")}\nภาษาเริ่มต้น: **${markdownText(guild.preferredLocale || "ไม่ทราบ", "ไม่ทราบ", 40)}**`,
                inline: true
            },
            {
                name: "👥 สมาชิก",
                value: `ทั้งหมด **${totalMembers}**\nคน **${humanCount}** • บอท **${botCount}**\nแหล่งข้อมูล: ${markdownText(memberCounts.source, "ไม่ทราบ", 220)}`,
                inline: false
            },
            {
                name: "🗂️ ช่องที่บอทมองเห็น",
                value: `ข้อความ **${formatCount(channels.text)}** • เสียง **${formatCount(channels.voice)}** • หมวดหมู่ **${formatCount(channels.category)}**\nประกาศ **${formatCount(channels.announcement)}** • Stage **${formatCount(channels.stage)}** • อื่น ๆ **${formatCount(channels.other)}**`,
                inline: false
            },
            {
                name: "🛡️ การป้องกันสมาชิก",
                value: `ระดับยืนยัน: **${verificationLevelLabel(guild.verificationLevel)}**\nตัวกรองสื่อ: **${contentFilterLabel(guild.explicitContentFilter)}**\n2FA สำหรับผู้ดูแล: **${Number(guild.mfaLevel) === 1 ? "บังคับใช้" : "ไม่ได้บังคับ"}**`,
                inline: true
            },
            {
                name: "🚀 Boost",
                value: `${boostTierLabel(guild.premiumTier, guild.premiumSubscriptionCount)}\nVanity URL: **${vanityValue}**`,
                inline: true
            },
            {
                name: "📦 ทรัพยากร",
                value: `ยศ **${formatCount(roleCount)}** • อีโมจิ **${formatCount(emojiCount)}** • สติกเกอร์ **${formatCount(stickerCount)}**`,
                inline: false
            },
            {
                name: "🧭 ช่องระบบ",
                value: `กฎ ${channelMention(guild.rulesChannelId)} • ข้อความระบบ ${channelMention(guild.systemChannelId)}\nAFK ${channelMention(guild.afkChannelId)} • ย้ายเมื่อเงียบ **${formatDuration(guild.afkTimeout || 0)}**`,
                inline: false
            },
            {
                name: "✨ คุณสมบัติที่เปิดใช้",
                value: guildFeatureLabels(guild.features),
                inline: false
            }
        )
        .setFooter({ text: `เรียกดูโดย ${safeText(guild.members?.me?.user?.tag || "Phomueangtai", "Phomueangtai", 120)} • ข้อมูลอาจเปลี่ยนหลังเรียกคำสั่ง` })
        .setTimestamp();
    const iconUrl = guild.iconURL?.({ forceStatic: false, size: 1024 });
    if (iconUrl) embed.setThumbnail(iconUrl);
    return embed;
}

// ════════════════════════════════════════════════════════════════════════════
//  🏠  SERVERINFO (เฟส 4 — Bot/Human split + Boost)
// ════════════════════════════════════════════════════════════════════════════
async function handleServerInfo(interaction) {
    markCommandAccepted(interaction);
    await sendLoadingState(interaction, "serverinfo");
    const guild = interaction.guild;
    if (!guild) return interaction.editReply({ content: "คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์", embeds: [] });
    const memberCounts = await getServerMemberCounts(guild);
    const owner = await guild.fetchOwner().catch(() => null);
    return interaction.editReply({ embeds: [buildServerInfoEmbed(guild, owner, memberCounts)], allowedMentions: { parse: [] } });
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
    ADMINISTRATOR: "ผู้ดูแลระบบ",
    MANAGE_GUILD: "จัดการเซิร์ฟเวอร์",
    MANAGE_ROLES: "จัดการยศ",
    MANAGE_CHANNELS: "จัดการช่อง",
    KICK_MEMBERS: "เตะสมาชิก",
    BAN_MEMBERS: "แบนสมาชิก",
    MODERATE_MEMBERS: "หมดเวลาสมาชิก",
    MANAGE_WEBHOOKS: "จัดการ Webhook",
    MANAGE_MESSAGES: "จัดการข้อความ"
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
        .filter(role => role.id !== member.guild.id)
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
        .filter(([permission]) => member.permissions.has(permission))
        .map(([, label]) => label);
    return labels.length ? labels.join(" • ") : "ไม่มีสิทธิ์จัดการระดับสูง";
}

function publicBadges(user) {
    const flags = user.flags?.toArray?.() || [];
    return flags.length ? flags.map(flag => BADGE_LABELS[flag] || flag).join(" • ") : "ไม่มี Public Badge ที่ Discord ส่งมา";
}

function userTypeLabel(user) {
    if (user.bot) return "Bot";
    if (user.system) return "บัญชีระบบ Discord";
    return "ผู้ใช้";
}

function memberState(member) {
    if (!member) return "ไม่พบข้อมูลสมาชิกในเซิร์ฟเวอร์";
    const timeoutUntil = Number(member.communicationDisabledUntilTimestamp || 0);
    const timeout = timeoutUntil > Date.now() ? `ถูกหมดเวลาถึง ${discordTimestamp(timeoutUntil, "F")}` : "ไม่ได้ถูกหมดเวลา";
    const pending = member.pending ? "ยังไม่ผ่าน Membership Screening" : "ผ่าน Membership Screening แล้ว/ไม่ได้เปิดใช้";
    const boosting = member.premiumSinceTimestamp
        ? `Boost ตั้งแต่ ${discordTimestamp(member.premiumSinceTimestamp, "R")}`
        : "ไม่ได้ Boost เซิร์ฟเวอร์นี้";
    return `${timeout}\n${pending}\n${boosting}`;
}

function buildUserInfoEmbed(interaction, user, member) {
    const age = accountAgeSummary(user);
    const displayName = user.globalName || member?.displayName || user.username;
    const tag = user.discriminator && user.discriminator !== "0" ? user.tag : `@${user.username}`;
    const joined = member?.joinedTimestamp
        ? `${discordTimestamp(member.joinedTimestamp, "F")}\n${discordTimestamp(member.joinedTimestamp, "R")}`
        : "ไม่พบข้อมูลวันที่เข้าเซิร์ฟเวอร์";
    const displayColor = member?.displayHexColor && member.displayHexColor !== "#000000"
        ? member.displayHexColor
        : "ไม่มีสีประจำยศ";
    const profileIcon = user.bot ? "🤖" : "🧑";
    const userMention = user.id ? `<@${user.id}>` : "";
    const embed = new MessageEmbed()
        .setColor(age.color)
        .setTitle(`👤 ข้อมูลสมาชิก • ${safeText(displayName, "ไม่ทราบชื่อ", 180)}`)
        .setDescription(`${profileIcon} **${markdownText(displayName, "ไม่ทราบชื่อ", 100)}** • ${markdownText(tag, "ไม่ทราบ", 100)}\n${userMention}`)
        .addFields(
            {
                name: "🪪 บัญชี Discord",
                value: `User ID: ${code(user.id)}\nประเภท: **${userTypeLabel(user)}**\nPublic Badge: ${publicBadges(user)}`,
                inline: false
            },
            {
                name: "🎂 อายุบัญชี",
                value: `สร้างเมื่อ ${discordTimestamp(user.createdTimestamp, "F")}\n${discordTimestamp(user.createdTimestamp, "R")} • **${formatCount(age.ageDays)} วัน**\nสถานะ: **${age.label}**`,
                inline: false
            },
            {
                name: "🏠 ข้อมูลในเซิร์ฟเวอร์นี้",
                value: `ชื่อเล่น: **${markdownText(member?.nickname || "ไม่ได้ตั้งชื่อเล่น", "ไม่ได้ตั้ง", 100)}**\nเข้าร่วม: ${joined}\nสีประจำยศ: **${displayColor}**`,
                inline: false
            },
            {
                name: `🎭 ยศ (${formatCount(Math.max(0, Number(member?.roles?.cache?.size || 1) - 1))})`,
                value: visibleRoleSummary(member),
                inline: false
            },
            {
                name: "🔐 สิทธิ์สำคัญในเซิร์ฟเวอร์",
                value: importantPermissions(member),
                inline: false
            },
            {
                name: "🧭 สถานะสมาชิก",
                value: memberState(member),
                inline: false
            }
        )
        .setFooter({ text: `เรียกดูโดย ${safeText(interaction.user?.tag || interaction.user?.username, "สมาชิก", 120)} • แสดงเฉพาะข้อมูลที่บอทเข้าถึงได้` })
        .setTimestamp();
    const avatar = member?.displayAvatarURL?.({ forceStatic: false, size: 1024 }) ||
        user.displayAvatarURL?.({ forceStatic: false, size: 1024 });
    if (avatar) embed.setThumbnail(avatar);
    const banner = user.bannerURL?.({ forceStatic: false, size: 1024 });
    if (banner) embed.setImage(banner);
    return embed;
}

async function resolveUserInfoTarget(interaction) {
    const selectedUser = interaction.options.getUser?.("member") || null;
    const selectedMember = interaction.options.getMember?.("member") || null;
    const targetId = selectedUser?.id || selectedMember?.id || interaction.user.id;
    let member = selectedMember;
    if (!member && targetId === interaction.user.id) member = interaction.member || null;
    if (!member) member = await interaction.guild.members.fetch(targetId).catch(() => null);
    const fallbackUser = selectedUser || member?.user || interaction.user;
    const user = await interaction.client.users.fetch(targetId, { force: true }).catch(() => fallbackUser);
    return { user, member };
}

// ════════════════════════════════════════════════════════════════════════════
//  👤  USERINFO (Account context + badges + current guild state)
// ════════════════════════════════════════════════════════════════════════════
async function handleUserInfo(interaction) {
    markCommandAccepted(interaction);
    await sendLoadingState(interaction, "userinfo");
    const { user, member } = await resolveUserInfoTarget(interaction);
    return interaction.editReply({ embeds: [buildUserInfoEmbed(interaction, user, member)], allowedMentions: { parse: [] } });
}

function collectSessionStats(sessionManager) {
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
    if (latency < 100) return { label: "ตอบสนองดี", color: config.system.themeColors.success };
    if (latency < 300) return { label: "ตอบสนองช้าลงเล็กน้อย", color: config.system.themeColors.warning };
    return { label: "ตอบสนองช้า", color: config.system.themeColors.error };
}

function buildPingEmbed(stats) {
    const state = latencyState(Math.max(stats.interactionLatency, stats.websocketLatency));
    return new MessageEmbed()
        .setColor(state.color)
        .setTitle("🏓 สถานะบอทแบบเรียลไทม์")
        .setDescription(`สถานะปัจจุบัน: **${state.label}** • วัดเมื่อ <t:${Math.floor(Date.now() / 1000)}:T>`)
        .addFields(
            {
                name: "🌐 การเชื่อมต่อ Discord",
                value: `คำสั่งตอบกลับ **${formatLatency(stats.interactionLatency)}**\nWebSocket **${formatLatency(stats.websocketLatency)}**\nShard **${formatCount(stats.shardId)}** จาก **${formatCount(stats.shardCount)}**`,
                inline: true
            },
            {
                name: "⏱️ เวลาทำงาน",
                value: `${formatDuration(stats.uptimeSeconds)}\nเริ่มทำงาน ${discordTimestamp(stats.startedAt, "R")}`,
                inline: true
            },
            {
                name: "🧠 หน่วยความจำของ Process",
                value: `RAM (RSS) **${stats.rssMB.toFixed(1)} MB**\nV8 Heap **${stats.heapUsedMB.toFixed(1)} / ${stats.heapTotalMB.toFixed(1)} MB**\nExternal **${stats.externalMB.toFixed(1)} MB**`,
                inline: false
            },
            {
                name: "⚙️ การประมวลผล",
                value: `CPU ระหว่างการวัด **${stats.cpuPercent.toFixed(1)}%**\nNode.js **${process.version}** • ${process.platform}/${process.arch}`,
                inline: false
            },
            {
                name: "📡 ขนาดระบบ",
                value: `เซิร์ฟเวอร์ **${formatCount(stats.guildCount)}**\nยอดสมาชิกรวมที่แต่ละเซิร์ฟเวอร์รายงาน **${formatCount(stats.reportedMemberCount)}**`,
                inline: true
            },
            {
                name: "🎙️ Voice Sessions",
                value: `ใช้งาน **${formatCount(stats.sessions.active)}** • กำลังกู้คืน **${formatCount(stats.sessions.recovering)}**\nล้มเหลว **${formatCount(stats.sessions.failed)}** • จัดเก็บทั้งหมด **${formatCount(stats.sessions.total)}**`,
                inline: true
            },
            {
                name: "🩺 สุขภาพระบบ",
                value: `ฐานข้อมูล **${stats.databaseReady ? "พร้อมใช้งาน" : "ยังไม่พร้อม"}**\nคำขอ **${formatCount(stats.requests)}** • Error events **${formatCount(stats.errors)}** • Reconnect **${formatCount(stats.reconnects)}**`,
                inline: false
            }
        )
        .setFooter({ text: "RAM คือ Process RSS จริง • CPU เป็นค่าที่วัดระหว่างตอบคำสั่งครั้งนี้" })
        .setTimestamp();
}

// ════════════════════════════════════════════════════════════════════════════
//  🏓  PING (เฟส 4 — Shard & System Dashboard)
// ════════════════════════════════════════════════════════════════════════════
async function handlePing(interaction, client, sessionManager) {
    markCommandAccepted(interaction);
    const cpuStart = process.cpuUsage();
    const wallStart = process.hrtime.bigint();
    const sent = await sendLoadingState(interaction, "ping");
    const cpuEnd = process.cpuUsage();
    const elapsedMicroseconds = Number(process.hrtime.bigint() - wallStart) / 1000;
    const interactionLatency = Math.max(0, Number(sent.createdTimestamp) - Number(interaction.createdTimestamp));
    const websocketLatency = Number(client.ws.ping);
    const startedAt = Number(sessionManager.systemMetrics.uptime);
    const mem = process.memoryUsage();
    const guildCount = client.guilds.cache.size;
    const reportedMemberCount = client.guilds.cache.reduce((total, guild) => total + (Number(guild.memberCount) || 0), 0);
    const metrics = sessionManager.getSystemMetrics?.() || sessionManager.systemMetrics;
    const stats = {
        interactionLatency,
        websocketLatency: Number.isFinite(websocketLatency) && websocketLatency >= 0 ? websocketLatency : null,
        shardId: Number(interaction.guild?.shardId || 0),
        shardCount: Number(client.ws.shards?.size || 1),
        startedAt,
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
        rssMB: mem.rss / 1024 / 1024,
        heapUsedMB: mem.heapUsed / 1024 / 1024,
        heapTotalMB: mem.heapTotal / 1024 / 1024,
        externalMB: mem.external / 1024 / 1024,
        cpuPercent: cpuPercent(cpuStart, cpuEnd, elapsedMicroseconds),
        guildCount,
        reportedMemberCount,
        sessions: collectSessionStats(sessionManager),
        databaseReady: Boolean(metrics.dbConnected),
        requests: Number(metrics.requests || 0),
        errors: Number(metrics.errors || 0),
        reconnects: Number(metrics.reconnects || 0)
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
        accountAgeSummary,
        visibleRoleSummary,
        importantPermissions,
        memberState,
        buildUserInfoEmbed,
        resolveUserInfoTarget,
        collectSessionStats,
        cpuPercent,
        latencyState,
        buildPingEmbed
    }
};
