/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: /ping dashboard — shows Latency, RAM, CPU, Sessions.
DO NOT REMOVE: /userinfo risk assessment — new account detection (เฟส 4).
DO NOT SIMPLIFY: /serverinfo member fetch — bot/human split required.
================================================================================
*/

const { MessageEmbed } = require("discord.js");
const config = require("../config.json");
const { markCommandAccepted } = require("../guards/commandGuards");
const CB = "```";
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
                ? { ...countCachedMembers(cachedMembers), total: memberCount, source: "ข้อมูลจาก cache ที่ครบทั้งเซิร์ฟเวอร์", at: Date.now() }
                : unknownMemberCounts(guild, `สมาชิก ${memberCount} คน เกินเพดาน full fetch จึงไม่โหลดทั้งหมด`);
            serverInfoCounts.set(guild.id, result);
            return result;
        }
        try {
            const members = await guild.members.fetch({ time: SERVERINFO_FETCH_TIMEOUT_MS });
            const result = {
                ...countCachedMembers(members),
                total: memberCount || members.size,
                source: "ข้อมูลล่าสุดจาก Discord",
                at: Date.now()
            };
            serverInfoCounts.set(guild.id, result);
            return result;
        } catch {
            const result = cachedMembers.size > 0
                ? { ...countCachedMembers(cachedMembers), total: memberCount || cachedMembers.size, source: "คำนวณจาก cache เพราะโหลดรายชื่อสมาชิกล่าสุดไม่สำเร็จ", at: Date.now() }
                : unknownMemberCounts(guild, "ไม่สามารถประเมิน Bot/Human ได้ เพราะ Discord fetch ไม่สำเร็จและ cache ว่าง");
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

// ════════════════════════════════════════════════════════════════════════════
//  🏠  SERVERINFO (เฟส 4 — Bot/Human split + Boost)
// ════════════════════════════════════════════════════════════════════════════
async function handleServerInfo(interaction) {
    markCommandAccepted(interaction);
    await interaction.deferReply();
    const guild = interaction.guild;

    const memberCounts = await getServerMemberCounts(guild);
    const botCount = Number.isFinite(memberCounts.bots) ? memberCounts.bots : "ประเมินไม่ได้";
    const humanCount = Number.isFinite(memberCounts.human) ? memberCounts.human : "ประเมินไม่ได้";
    const memberSource = memberCounts.source;

    const textChannels  = guild.channels.cache.filter(c => c.type === 'GUILD_TEXT').size;
    const voiceChannels = guild.channels.cache.filter(c => c.type === 'GUILD_VOICE').size;
    const catChannels   = guild.channels.cache.filter(c => c.type === 'GUILD_CATEGORY').size;
    const newsChannels  = guild.channels.cache.filter(c => c.type === 'GUILD_NEWS').size;
    const stageChannels = guild.channels.cache.filter(c => c.type === 'GUILD_STAGE_VOICE').size;
    const otherChannels = Math.max(0, guild.channels.cache.size - textChannels - voiceChannels - catChannels - newsChannels - stageChannels);

    const boostTier  = guild.premiumTier || 0;
    const boostCount = guild.premiumSubscriptionCount || 0;
    const boostLabel = boostTier === 0 ? 'ไม่มี Boost' : `Tier ${boostTier} (${boostCount} boosts)`;

    const owner = await guild.fetchOwner().catch(() => null);

    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.primary)
        .setTitle(`${config.emojis.serverinfo_icon} Server Information`)
        .setThumbnail(guild.iconURL({ dynamic: true, size: 1024 }))
        .setDescription(
            `**[ ${guild.name} ]**\n\n` +
            `${config.emojis.robot} **Name:** ${CB}${guild.name}${CB}\n` +
            `» **ID:** ${CB}${guild.id}${CB}\n` +
            `${config.emojis.owner} **Owner:** ${owner ? `<@${owner.id}>` : 'Unknown'}\n` +
            `${config.emojis.created} **Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:R>\n\n` +
            `**${config.emojis.members} Members:**\n` +
            `— Total: ${CB}${guild.memberCount}${CB}\n` +
            `— ${config.emojis.human} Human: ${CB}${humanCount}${CB}\n` +
            `— ${config.emojis.robot} Bot: ${CB}${botCount}${CB}\n` +
            `— แหล่งข้อมูล: ${memberSource}\n\n` +
            `**${config.emojis.folder} Channels:**\n` +
            `— ${config.emojis.text_ch} Text: ${CB}${textChannels}${CB}\n` +
            `— ${config.emojis.voice_ch} Voice: ${CB}${voiceChannels}${CB}\n` +
            `— ${config.emojis.category} Category: ${CB}${catChannels}${CB}\n` +
            `— Announcement: ${CB}${newsChannels}${CB} | Stage: ${CB}${stageChannels}${CB} | Other: ${CB}${otherChannels}${CB}\n\n` +
            `**${config.emojis.roles_icon} Roles:** ${CB}${guild.roles.cache.size}${CB}\n` +
            `**${config.emojis.boost} Boost:** ${CB}${boostLabel}${CB}`
        )
        .setFooter({ text: "Enterprise Architecture", iconURL: config.system.bannerUrl || undefined })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

// ════════════════════════════════════════════════════════════════════════════
//  👤  USERINFO (เฟส 4 — Risk Assessment + Badges)
// ════════════════════════════════════════════════════════════════════════════
async function handleUserInfo(interaction) {
    markCommandAccepted(interaction);
    await interaction.deferReply();
    const member = interaction.options.getMember("member") || interaction.member;

    let user;
    try {
        user = await interaction.client.users.fetch(member.user.id, { force: true });
    } catch (e) {
        user = member.user;
    }

    const accountAgeDays = Math.floor((Date.now() - user.createdTimestamp) / 86400000);
    const isNewAccount = accountAgeDays < config.risk_thresholds.newAccountAgeDays;
    const isSuspicious = accountAgeDays < config.risk_thresholds.suspiciousAccountAgeDays;

    let riskLabel = `${config.emojis.success} บัญชีปกติ`;
    let riskColor = config.system.themeColors.success;
    if (isNewAccount) {
        riskLabel = `${config.emojis.punishment} **บัญชีใหม่มาก! (HIGH RISK)**`;
        riskColor = config.system.themeColors.error;
    } else if (isSuspicious) {
        riskLabel = `${config.emojis.warning} บัญชีค่อนข้างใหม่ (MEDIUM RISK)`;
        riskColor = config.system.themeColors.warning;
    }

    const flags = user.flags?.toArray() || [];
    const badgeMap = {
        'DISCORD_EMPLOYEE':             '👨‍💼 Discord Staff',
        'PARTNERED_SERVER_OWNER':       '🤝 Partnered',
        'HYPESQUAD_EVENTS':             '🎉 HypeSquad Events',
        'BUGHUNTER_LEVEL_1':            '🐛 Bug Hunter Lv.1',
        'BUGHUNTER_LEVEL_2':            '🐛 Bug Hunter Lv.2',
        'HOUSE_BRAVERY':                '🏠 Bravery',
        'HOUSE_BRILLIANCE':             '🏠 Brilliance',
        'HOUSE_BALANCE':                '🏠 Balance',
        'EARLY_SUPPORTER':              '⭐ Early Supporter',
        'VERIFIED_BOT_DEVELOPER':       '🔧 Verified Dev',
        'ACTIVE_DEVELOPER':             '💻 Active Dev',
        'DISCORD_CERTIFIED_MODERATOR':  '🛡️ Certified Mod',
    };
    const badgeStr = flags.length > 0
        ? flags.map(f => badgeMap[f] || f).join(', ')
        : 'ไม่มี Badge';

    const hexColor = member.displayHexColor !== '#000000' ? member.displayHexColor : 'ไม่มี';

    const roleMentions = member.roles.cache
        .filter(r => r.id !== interaction.guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => r.toString());
    const visibleRoles = [];
    let rolesLength = 0;
    for (const mention of roleMentions) {
        if (rolesLength + mention.length + 3 > 700) break;
        visibleRoles.push(mention);
        rolesLength += mention.length + 3;
    }
    const hiddenRoleCount = roleMentions.length - visibleRoles.length;
    const roles = visibleRoles.join(" | ") + (hiddenRoleCount > 0 ? ` | และอีก ${hiddenRoleCount} ยศ` : "") || "ไม่มียศ";

    const hasWebhook = member.permissions.has("MANAGE_WEBHOOKS");

    const embed = new MessageEmbed()
        .setColor(riskColor)
        .setTitle(`${config.emojis.search} Who is ${user.username}?`)
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 1024 }))
        .setDescription(
            `**[Wick Informations]**\n` +
            `— **Risk Level:** ${riskLabel}\n` +
            `— **Account Age:** ${CB}${accountAgeDays} วัน${CB}\n\n` +
            `**General Informations:**\n` +
            `${config.emojis.user} **Name:** ${CB}${user.tag}${CB}\n` +
            `» **ID:** ${CB}${user.id}${CB}\n` +
            `${config.emojis.created} **Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>\n` +
            `${config.emojis.calendar} **Joined:** ${member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'ไม่ทราบ'}\n` +
            `${config.emojis.color_icon} **Color:** ${CB}${hexColor}${CB}\n\n` +
            `**Account Accessories:**\n` +
            `${config.emojis.badge} **Badges:** ${badgeStr}\n` +
            `${config.emojis.webhook_icon} **Webhook Perm:** ${hasWebhook ? `${config.emojis.warning} มีสิทธิ์จัดการ Webhook` : `${config.emojis.success} ไม่มีสิทธิ์`}\n` +
            `${config.emojis.roles_icon} **Roles:** ${roles}`
        )
        .setFooter({ text: "Enterprise Architecture", iconURL: config.system.bannerUrl || undefined })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

// ════════════════════════════════════════════════════════════════════════════
//  🏓  PING (เฟส 4 — Shard & System Dashboard)
// ════════════════════════════════════════════════════════════════════════════
async function handlePing(interaction, client, sessionManager) {
    markCommandAccepted(interaction);
    const sent = await interaction.reply({ content: `${config.emojis.ping} กำลังวัด...`, fetchReply: true });
    const latency = Math.max(0, sent.createdTimestamp - interaction.createdTimestamp);
    const wsLatency = client.ws.ping;
    const uptime = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000);
    const m = Math.floor(uptime / 60);
    const s = uptime % 60;
    const mem = process.memoryUsage();
    const ramMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const guildCount = client.guilds.cache.size;
    const memberCount = client.guilds.cache.reduce((a, g) => a + g.memberCount, 0);
    const sessionValues = [...sessionManager.getAllSessions().values()];
    const sessionCount = sessionValues.filter(session =>
        sessionManager.isSessionRunnable?.(session) !== false && session?.reconnecting !== true
    ).length;
    const failedSessions = sessionValues.filter(session => session?.state === "failed").length;
    const recoveringSessions = sessionValues.filter(session => session?.reconnecting === true).length;

    const latencyColor = latency < 100
        ? config.system.themeColors.success
        : latency < 300
            ? config.system.themeColors.warning
            : config.system.themeColors.error;

    const embed = new MessageEmbed()
        .setColor(latencyColor)
        .setTitle(`${config.emojis.ping} System Dashboard`)
        .setDescription(
            `**${config.emojis.network} Network:**\n` +
            `— **Latency:** ${CB}${latency}ms${CB}\n` +
            `— **WebSocket:** ${CB}${wsLatency}ms${CB}\n\n` +
            `**${config.emojis.system_icon} System:**\n` +
            `— **Uptime:** ${CB}${m}m ${s}s${CB}\n` +
            `— **RAM:** ${CB}${ramMB} MB${CB}\n\n` +
            `**${config.emojis.scale} Scale:**\n` +
            `— **Servers:** ${CB}${guildCount}${CB}\n` +
            `— **Members:** ${CB}${memberCount}${CB}\n` +
            `— **Active Sessions:** ${CB}${sessionCount}${CB}\n` +
            `— **Recovering / Failed:** ${CB}${recoveringSessions} / ${failedSessions}${CB}`
        )
        .setTimestamp();

    return interaction.editReply({ content: null, embeds: [embed] });
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
        SERVERINFO_FULL_FETCH_MAX_MEMBERS
    }
};
