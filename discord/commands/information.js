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
const CB = "```";

async function handle(interaction, client, sessionManager) {
    const cmd = interaction.commandName;
    if (cmd === "serverinfo") return handleServerInfo(interaction);
    if (cmd === "userinfo")   return handleUserInfo(interaction);
    if (cmd === "help")       return handleHelp(interaction);
    if (cmd === "ping")       return handlePing(interaction, client, sessionManager);
}

// ════════════════════════════════════════════════════════════════════════════
//  🏠  SERVERINFO (เฟส 4 — Bot/Human split + Boost)
// ════════════════════════════════════════════════════════════════════════════
async function handleServerInfo(interaction) {
    await interaction.deferReply();
    const guild = interaction.guild;

    const botCount   = guild.members.cache.filter(m => m.user.bot).size;
    const humanCount = Math.max(0, guild.memberCount - botCount);

    const textChannels  = guild.channels.cache.filter(c => c.type === 'GUILD_TEXT').size;
    const voiceChannels = guild.channels.cache.filter(c => c.type === 'GUILD_VOICE').size;
    const catChannels   = guild.channels.cache.filter(c => c.type === 'GUILD_CATEGORY').size;

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
            `— ${config.emojis.robot} Bot: ${CB}${botCount}${CB}\n\n` +
            `**${config.emojis.folder} Channels:**\n` +
            `— ${config.emojis.text_ch} Text: ${CB}${textChannels}${CB}\n` +
            `— ${config.emojis.voice_ch} Voice: ${CB}${voiceChannels}${CB}\n` +
            `— ${config.emojis.category} Category: ${CB}${catChannels}${CB}\n\n` +
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

    const roles = member.roles.cache
        .filter(r => r.id !== interaction.guild.id)
        .map(r => r.toString())
        .join(" | ") || "ไม่มียศ";

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
    const sessionCount = sessionManager.getAllSessions().size;

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
            `— **Active Sessions:** ${CB}${sessionCount}${CB}`
        )
        .setTimestamp();

    return interaction.editReply({ content: null, embeds: [embed] });
}

// ════════════════════════════════════════════════════════════════════════════
//  📖  HELP (เฟส 4 — OpSec Hide ซ่อนหมวดระบบ)
// ════════════════════════════════════════════════════════════════════════════
async function handleHelp(interaction) {
    const isAdmin = interaction.member.permissions.has("ADMINISTRATOR");

    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.primary)
        .setTitle(`${config.emojis.shield} คู่มือการใช้งาน Enterprise V5.1`)
        .setDescription(
            `**ระบบนี้ถูกออกแบบมาเพื่อความปลอดภัยและประสิทธิภาพสูงสุด**\n\n` +
            `**${config.emojis.settings_icon} คำสั่งข้อมูล:**\n` +
            `— ${CB}/ping${CB} — ตรวจสอบ Latency และสถานะระบบ\n` +
            `— ${CB}/serverinfo${CB} — ตรวจสอบข้อมูลเชิงลึกของเซิร์ฟเวอร์\n` +
            `— ${CB}/userinfo${CB} — ตรวจสอบข้อมูลและความเสี่ยงของบัญชี\n\n` +
            `**${config.emojis.mod_icon} คำสั่งผู้ดูแล:**\n` +
            `— ${CB}/ban${CB} ${CB}/kick${CB} ${CB}/timeout${CB} — ลงโทษพร้อม DM แจ้งเตือน\n` +
            `— ${CB}/voicekickall${CB} — เตะทุกคนออกจากห้องเสียง\n` +
            `— ${CB}/clear${CB} — ลบข้อความรวมข้อความเกิน 14 วัน (สูงสุด 100)\n` +
            `— ${CB}/steal${CB} — ดึงอิโมจิเข้าเซิร์ฟเวอร์\n` +
            `— ${CB}/say${CB} ${CB}/announce${CB} — ส่งข้อความและประกาศ\n\n` +
            `**${config.emojis.backup_icon} คำสั่งระบบ:**\n` +
            `— ${CB}/setup-log${CB} — ติดตั้งโครงสร้าง Audit Log\n` +
            `— ${CB}/backup${CB} — บันทึกโครงสร้างเซิร์ฟเวอร์\n` +
            `— ${CB}/restore${CB} — กู้คืนโครงสร้างเซิร์ฟเวอร์\n` +
            (isAdmin
                ? `\n**${config.emojis.admin_icon} คำสั่ง Admin (ซ่อนจากผู้ใช้ทั่วไป):**\n` +
                  `— ${CB}/panel${CB} — เรียกแผงควบคุมระบบออนช่องเสียง\n`
                : '') +
            `\n*หากพบปัญหา ติดต่อ: <@${config.system.ownerId}>*`
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: !isAdmin });
}

module.exports = { handle };
