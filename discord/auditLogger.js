/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT MODIFY: Event listener structure — each listener maps to a specific
audit log channel from LogChannelMapModel.
DO NOT REMOVE: Any event listener — each one serves เฟส 25 requirements.
================================================================================
*/

const { MessageEmbed } = require("discord.js");

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 1: HELPER — ดึงห้อง log จาก DB (with in-memory cache 5 min)
// ════════════════════════════════════════════════════════════════════════════
const auditChannelCache = new Map(); // guildId → { map, expiry }

async function getAuditChannel(guild, sessionManager, type) {
    try {
        const now = Date.now();
        let cached = auditChannelCache.get(guild.id);
        if (!cached || now > cached.expiry) {
            const map = await sessionManager.getLogChannelMap(guild.id);
            cached = { map, expiry: now + 300000 };
            auditChannelCache.set(guild.id, cached);
        }
        if (!cached.map) return null;
        const channelId = cached.map[`${type}ChannelId`];
        if (!channelId) return null;
        return guild.channels.cache.get(channelId) || null;
    } catch (e) {
        return null;
    }
}

async function sendAuditLog(guild, sessionManager, type, embed) {
    const ch = await getAuditChannel(guild, sessionManager, type);
    if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════
//  📝  REGION 2: MESSAGE EVENTS
// ════════════════════════════════════════════════════════════════════════════
function registerMessageEvents(client, sessionManager) {
    const config = require("./config.json");

    // Map ติดตาม bulk-delete ล่าสุด → ป้องกัน messageDelete ซ้ำ (Bug A-1)
    const recentBulkChannels = new Map();

    // ข้อความถูกลบ
    client.on("messageDelete", async (message) => {
        if (!message.guild) return;
        if (!message.author) return;
        if (message.author.bot) return;
        const bulkTs = recentBulkChannels.get(message.channel.id);
        if (bulkTs && Date.now() - bulkTs < 3000) return;
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.error)
            .setTitle(`${config.emojis.trash} ข้อความถูกลบ`)
            .setDescription(
                `**ผู้ส่ง:** <@${message.author.id}> (\`${message.author.tag}\`)\n` +
                `**ช่อง:** <#${message.channel.id}>\n` +
                `**เนื้อหา:** ${message.content || "*ไม่มีข้อความ (สื่อ/ไฟล์)*"}`
            )
            .setTimestamp();
        await sendAuditLog(message.guild, sessionManager, 'message', embed);
    });

    // ข้อความถูกแก้ไข
    client.on("messageUpdate", async (oldMsg, newMsg) => {
        if (!newMsg.guild) return;
        if (!newMsg.author) return;
        if (newMsg.author.bot) return;
        if (!newMsg.content) return;
        if (oldMsg.content === newMsg.content) return;
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.warning)
            .setTitle(`${config.emojis.pencil} ข้อความถูกแก้ไข`)
            .setDescription(
                `**ผู้ส่ง:** <@${newMsg.author?.id}>\n` +
                `**ช่อง:** <#${newMsg.channel.id}>\n` +
                `**ก่อน:** ${oldMsg.content || "*ไม่มีข้อมูลเดิม*"}\n` +
                `**หลัง:** ${newMsg.content}`
            )
            .setURL(newMsg.url)
            .setTimestamp();
        await sendAuditLog(newMsg.guild, sessionManager, 'message', embed);
    });

    // Bulk Delete (Clear)
    client.on("messageDeleteBulk", async (messages) => {
        const first = messages.first();
        if (!first?.guild) return;
        recentBulkChannels.set(first.channel.id, Date.now());
        setTimeout(() => recentBulkChannels.delete(first.channel.id), 3000);
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.error)
            .setTitle(`${config.emojis.broom} ลบข้อความหมู่ (Bulk Delete)`)
            .setDescription(
                `**ช่อง:** <#${first.channel.id}>\n` +
                `**จำนวน:** ${messages.size} ข้อความ`
            )
            .setTimestamp();
        await sendAuditLog(first.guild, sessionManager, 'message', embed);
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  👥  REGION 3: MEMBER EVENTS
// ════════════════════════════════════════════════════════════════════════════
function registerMemberEvents(client, sessionManager) {
    const config = require("./config.json");

    // สมาชิกเข้า
    client.on("guildMemberAdd", async (member) => {
        const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
        const isNew = accountAgeDays < config.risk_thresholds.newAccountAgeDays;
        const embed = new MessageEmbed()
            .setColor(isNew ? config.system.themeColors.error : config.system.themeColors.success)
            .setTitle(`${config.emojis.success} สมาชิกใหม่เข้าร่วม`)
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
            .setDescription(
                `**ผู้ใช้:** <@${member.id}> (\`${member.user.tag}\`)\n` +
                `**บัญชีสร้างเมื่อ:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>\n` +
                (isNew ? `${config.emojis.warning} **บัญชีใหม่มาก! (${accountAgeDays} วัน)**` : ``)
            )
            .setTimestamp();
        await sendAuditLog(member.guild, sessionManager, 'member', embed);
    });

    // สมาชิกออก
    client.on("guildMemberRemove", async (member) => {
        const userTag  = member.user?.tag  || 'Unknown#0000';
        const joinedTs = member.joinedTimestamp
            ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`
            : 'ไม่ทราบ';
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.warning)
            .setTitle(`${config.emojis.wave} สมาชิกออกจากเซิร์ฟเวอร์`)
            .setDescription(
                `**ผู้ใช้:** <@${member.id}> (\`${userTag}\`)\n` +
                `**เข้าร่วมเมื่อ:** ${joinedTs}`
            )
            .setTimestamp();
        await sendAuditLog(member.guild, sessionManager, 'member', embed);
    });

    // ยศเปลี่ยน
    client.on("guildMemberUpdate", async (oldMember, newMember) => {
        const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
        const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
        if (addedRoles.size === 0 && removedRoles.size === 0) return;
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.info)
            .setTitle(`${config.emojis.role_icon} ยศสมาชิกเปลี่ยน`)
            .setDescription(
                `**ผู้ใช้:** <@${newMember.id}>\n` +
                (addedRoles.size > 0 ? `**เพิ่มยศ:** ${addedRoles.map(r => r.toString()).join(', ')}\n` : '') +
                (removedRoles.size > 0 ? `**ลบยศ:** ${removedRoles.map(r => r.toString()).join(', ')}` : '')
            )
            .setTimestamp();
        await sendAuditLog(newMember.guild, sessionManager, 'member', embed);
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  🔊  REGION 4: VOICE EVENTS
// ════════════════════════════════════════════════════════════════════════════
function registerVoiceEvents(client, sessionManager) {
    const config = require("./config.json");

    client.on("voiceStateUpdate", async (oldState, newState) => {
        const member = newState.member;
        if (!member || member.user.bot) return;

        let title = '';
        let color = config.system.themeColors.info;
        let desc = `**ผู้ใช้:** <@${member.id}>`;

        if (!oldState.channelId && newState.channelId) {
            title = `${config.emojis.voice_ch} เข้าห้องเสียง`;
            color = config.system.themeColors.success;
            desc += `\n**ห้อง:** <#${newState.channelId}>`;
        } else if (oldState.channelId && !newState.channelId) {
            title = `${config.emojis.voice_leave} ออกจากห้องเสียง`;
            color = config.system.themeColors.error;
            desc += `\n**ห้อง:** <#${oldState.channelId}>`;
        } else if (oldState.channelId !== newState.channelId) {
            title = `${config.emojis.voice_move} ย้ายห้องเสียง`;
            desc += `\n**จาก:** <#${oldState.channelId}>\n**ไป:** <#${newState.channelId}>`;
        } else if (!oldState.serverMute && newState.serverMute) {
            title = `${config.emojis.voice_leave} ถูก Server Mute`;
            color = config.system.themeColors.warning;
            desc += `\n**ห้อง:** <#${newState.channelId}>`;
        } else if (oldState.serverMute && !newState.serverMute) {
            title = `${config.emojis.voice_ch} ถูกยกเลิก Server Mute`;
            color = config.system.themeColors.success;
            desc += `\n**ห้อง:** <#${newState.channelId}>`;
        } else if (!oldState.serverDeaf && newState.serverDeaf) {
            title = `${config.emojis.server_deafen} ถูก Server Deafen`;
            color = config.system.themeColors.warning;
            desc += `\n**ห้อง:** <#${newState.channelId}>`;
        } else if (oldState.serverDeaf && !newState.serverDeaf) {
            title = `${config.emojis.voice_ch} ถูกยกเลิก Server Deafen`;
            color = config.system.themeColors.success;
            desc += `\n**ห้อง:** <#${newState.channelId}>`;
        } else return;

        const embed = new MessageEmbed()
            .setColor(color).setTitle(title)
            .setDescription(desc).setTimestamp();
        await sendAuditLog(newState.guild, sessionManager, 'voice', embed);
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  REGION 5: SERVER EVENTS
// ════════════════════════════════════════════════════════════════════════════
function registerServerEvents(client, sessionManager) {
    const config = require("./config.json");

    // ห้องถูกสร้าง
    client.on("channelCreate", async (channel) => {
        if (!channel.guild) return;
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setTitle(`${config.emojis.plus} ห้องใหม่ถูกสร้าง`)
            .setDescription(`**ชื่อ:** ${channel.name}\n**ประเภท:** ${channel.type}`)
            .setTimestamp();
        await sendAuditLog(channel.guild, sessionManager, 'server', embed);
    });

    // ห้องถูกลบ
    client.on("channelDelete", async (channel) => {
        if (!channel.guild) return;
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.error)
            .setTitle(`${config.emojis.trash} ห้องถูกลบ`)
            .setDescription(`**ชื่อ:** ${channel.name}\n**ประเภท:** ${channel.type}`)
            .setTimestamp();
        await sendAuditLog(channel.guild, sessionManager, 'server', embed);
    });

    // ยศถูกสร้าง
    client.on("roleCreate", async (role) => {
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setTitle(`${config.emojis.role_icon} ยศใหม่ถูกสร้าง`)
            .setDescription(`**ชื่อ:** ${role.name}\n**ID:** \`${role.id}\``)
            .setTimestamp();
        await sendAuditLog(role.guild, sessionManager, 'server', embed);
    });

    // ยศถูกลบ
    client.on("roleDelete", async (role) => {
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.error)
            .setTitle(`${config.emojis.trash} ยศถูกลบ`)
            .setDescription(`**ชื่อ:** ${role.name}\n**ID:** \`${role.id}\``)
            .setTimestamp();
        await sendAuditLog(role.guild, sessionManager, 'server', embed);
    });

    // อิโมจิถูกเพิ่ม
    client.on("emojiCreate", async (emoji) => {
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.info)
            .setTitle(`${config.emojis.emoji_icon} อิโมจิใหม่ถูกเพิ่ม`)
            .setDescription(`**ชื่อ:** ${emoji.name}\n**ID:** \`${emoji.id}\``)
            .setThumbnail(emoji.url)
            .setTimestamp();
        await sendAuditLog(emoji.guild, sessionManager, 'server', embed);
    });

    // Webhook ถูกสร้าง (security risk)
    client.on("webhookUpdate", async (channel) => {
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.error)
            .setTitle(`${config.emojis.alert} Webhook ในห้องเปลี่ยนแปลง`)
            .setDescription(`**ช่อง:** <#${channel.id}>\n${config.emojis.warning} มีการสร้าง/แก้ไข/ลบ Webhook — ตรวจสอบทันที!`)
            .setTimestamp();
        await sendAuditLog(channel.guild, sessionManager, 'security', embed);
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  🚨  REGION 6: SECURITY EVENTS
// ════════════════════════════════════════════════════════════════════════════
function registerSecurityEvents(client, sessionManager) {
    const config = require("./config.json");

    // บอทไม่ได้รับการยืนยันตัวตนถูกเชิญ
    client.on("guildMemberAdd", async (member) => {
        if (!member.user.bot) return;
        if (member.user.id === client.user?.id) return;
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.error)
            .setTitle(`${config.emojis.robot} บอทใหม่ถูกเชิญเข้าเซิร์ฟเวอร์`)
            .setDescription(
                `**บอท:** <@${member.id}> (\`${member.user.tag}\`)\n` +
                `**Verified:** ${member.user.flags?.has('VERIFIED_BOT') ? `${config.emojis.success} ใช่` : `${config.emojis.error} ไม่ได้ยืนยัน — ระวัง!`}`
            )
            .setTimestamp();
        await sendAuditLog(member.guild, sessionManager, 'security', embed);
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  REGION 7: REGISTER ALL + EXPORT
// ════════════════════════════════════════════════════════════════════════════
function register(client, sessionManager) {
    registerMessageEvents(client, sessionManager);
    registerMemberEvents(client, sessionManager);
    registerVoiceEvents(client, sessionManager);
    registerServerEvents(client, sessionManager);
    registerSecurityEvents(client, sessionManager);
    console.log("[AUDIT] ✅ Audit Logger registered — 5 channel categories active.");
}

module.exports = { register, sendAuditLog, invalidateAuditCache: (guildId) => auditChannelCache.delete(guildId) };
