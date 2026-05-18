const { MessageEmbed, MessageActionRow, MessageButton, Modal, TextInputComponent, WebhookClient } = require("discord.js");
const config = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker = require("./voiceWorker");

// ════════════════════════════════════════════════════════════════
//  🛡️ SYSTEM STATE & GARBAGE COLLECTED MEMORY
// ════════════════════════════════════════════════════════════════
const snipes = new Map();
const panelMessages = new Map(); // ป้องกันแผงควบคุมรวนข้ามเซิร์ฟเวอร์
const activeRestores = new Set(); // ล็อกป้องกัน Race Condition เวลากดกู้คืนรัวๆ
const activeBackups = new Set(); // ล็อกป้องกัน Race Condition เวลาสแปมกดบันทึกโครงสร้าง
const activeVoiceKicks = new Set(); // ล็อกป้องกันมาโครสแปมคำสั่งเตะรวดเดียว

// ตัวแปร Code Block สำหรับตกแต่งข้อความสไตล์พรีเมียม
const CB = "\x60\x60\x60"; 

// ════════════════════════════════════════════════════════════════
//  📋 COMMANDS REGISTRY (100% COMPLETE)
// ════════════════════════════════════════════════════════════════
const slashCommandsData = [
    { name: "panel",      description: "เรียกแผงควบคุมระบบออนช่องเสียง" },
    { name: "help",       description: "แสดงคู่มือการใช้งานระบบ Enterprise" },
    { name: "stats",      description: "ดูสถิติการทำงานของระบบ" },
    { name: "serverinfo", description: "แสดงข้อมูลรายละเอียดของเซิร์ฟเวอร์แบบเจาะลึก" },
    { name: "setup-log",  description: "ติดตั้งระบบ Auto-Setup (ยศ/หมวดหมู่/ห้อง Log)" },
    { name: "snipe",      description: "ดูข้อความล่าสุดที่ถูกลบล่าสุดในช่องแชทปัจจุบัน" },
    {
        name: "userinfo", description: "แสดงข้อมูลโปรไฟล์ของสมาชิก",
        options: [{ type: 6, name: "member", description: "สมาชิกที่ต้องการดูข้อมูล", required: false }]
    },
    {
        name: "clear", description: "ลบข้อความในช่องปัจจุบัน (สูงสุด 100 ข้อความ)",
        options: [{ type: 4, name: "amount", description: "จำนวนข้อความที่ต้องการลบ (1-100)", required: true }]
    },
    {
        name: "say", description: "ส่งข้อความในนามระบบ",
        options: [{ type: 3, name: "message", description: "ข้อความที่ต้องการส่ง", required: true }]
    },
    {
        name: "announce", description: "ส่งข้อความประกาศแบบ Embed",
        options: [
            { type: 3, name: "title", description: "หัวข้อประกาศ", required: true },
            { type: 3, name: "message", description: "เนื้อหาประกาศ", required: true }
        ]
    },
    {
        name: "steal", description: "ดึงอิโมจิเข้าเซิร์ฟเวอร์แบบรวดเดียว (Bulk Steal สูงสุด 50 ตัว)",
        options: [{ type: 3, name: "emojis", description: "วางอิโมจิที่ก๊อปปี้มาติดๆ กันได้เลย", required: true }]
    },
    {
        name: "backup", description: "บันทึกข้อมูลโครงสร้างเซิร์ฟเวอร์ (เฉพาะเจ้าของเซิร์ฟเวอร์)"
    },
    {
        name: "restore", description: "กู้คืนโครงสร้างเซิร์ฟเวอร์ (ต้องมีกรรมสิทธิ์การบันทึก)",
        options: [{ type: 3, name: "server_id", description: "ไอดีเซิร์ฟเวอร์ต้นทางที่ต้องการดึงข้อมูล", required: true }]
    },
    {
        name: "voicekickall", description: "เตะทุกคนในห้องเสียงที่คุณอยู่ (ยกเว้นผู้ดูแลระบบ)"
    },
    {
        name: "ban", description: "แบนสมาชิกออกจากเซิร์ฟเวอร์ พร้อมแจ้งเตือน DM",
        options: [
            { type: 6, name: "target", description: "สมาชิกที่ต้องการแบน", required: true },
            { type: 3, name: "reason", description: "เหตุผล", required: false }
        ]
    },
    {
        name: "kick", description: "เตะสมาชิกออกจากเซิร์ฟเวอร์ พร้อมแจ้งเตือน DM",
        options: [
            { type: 6, name: "target", description: "สมาชิกที่ต้องการเตะ", required: true },
            { type: 3, name: "reason", description: "เหตุผล", required: false }
        ]
    },
    {
        name: "timeout", description: "ระงับการใช้งานสมาชิกชั่วคราว พร้อมแจ้งเตือน DM",
        options: [
            { type: 6, name: "target", description: "สมาชิก", required: true },
            { type: 4, name: "minutes", description: "จำนวนนาที (1-40000)", required: true },
            { type: 3, name: "reason", description: "เหตุผล", required: false }
        ]
    }
];

function getPanelMessages() {
    return panelMessages;
}

function sendDM(user, embed) {
    if (!user || user.bot) return;
    user.send({ embeds: [embed] }).catch(() => {});
}

async function getLogChannel(guild) {
    const channelName = config.channels.logName;
    return guild.channels.cache.find(c => c.name === channelName && c.isText());
}

async function updatePanel(guildId) {
    if (!guildId) return;
    const panelMsg = panelMessages.get(guildId);
    if (!panelMsg) return;

    try {
        const guild = panelMsg.guild;
        const total = Array.from(sessionManager.getAllSessions().values()).filter(s => s.serverId === guild.id).length;
        
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.primary)
            .setAuthor({ name: "ระบบจัดการผู้ใช้งานช่องเสียง", iconURL: guild.iconURL() || config.system.bannerUrl })
            .setDescription(`— ใช้งานเพื่อเปิดบอทเข้าไปออนในห้องเสียง\n— ข้อมูลทั้งหมดถูกจัดการและรักษาความปลอดภัยสูงสุด\n\n**สถานะปัจจุบัน:** ${total > 0 ? config.emojis.success + " **ทำงานอยู่**" : config.emojis.error + " **หยุดทำงาน**"}\n— จำนวนผู้ใช้งานในเซิร์ฟเวอร์นี้: **${total}** บัญชี\n\n*Developed by <@661415152146710558>*`)
            .setImage(config.system.bannerUrl);

        const row = new MessageActionRow().addComponents(
            new MessageButton().setCustomId("btn_start").setLabel("เริ่มการทำงาน").setEmoji("1505303237585141770").setStyle("SUCCESS"),
            new MessageButton().setCustomId("btn_status").setLabel("สถานะ & จัดการ").setEmoji("1505295037213184161").setStyle("PRIMARY"),
            new MessageButton().setCustomId("btn_stop_all").setLabel("หยุดการทำงานทั้งหมด").setEmoji("1505544059056427079").setStyle("DANGER")
        );

        await panelMsg.edit({ embeds: [embed], components: [row] });
    } catch (err) {
        console.error("[PANEL] Update Panel Error:", err.message);
    }
}

// ════════════════════════════════════════════════════════════════
//  MESSAGE EVENT HANDLER (Snipe Capture)
// ════════════════════════════════════════════════════════════════
async function handleMessage(message) {
    if (message.author.bot) return;

    if (!message.content.startsWith("/") && !message.content.startsWith("!")) {
        snipes.set(message.channel.id, {
            content: message.content,
            author: message.author,
            timestamp: message.createdAt,
            image: message.attachments.first() ? message.attachments.first().proxyURL : null
        });
        
        // ระบบ Memory Leak Prevention ทยอยลบทิ้งทุก 1 ชั่วโมง
        setTimeout(() => {
            snipes.delete(message.channel.id);
        }, 3600000);
    }
}

// ════════════════════════════════════════════════════════════════
//  INTERACTION EVENT HANDLER
// ════════════════════════════════════════════════════════════════
async function handleInteraction(interaction, client) {
    try {
        if (interaction.isCommand()) {
            
            // --- SERVERINFO ---
            if (interaction.commandName === "serverinfo") {
                const guild = interaction.guild;
                const owner = await guild.fetchOwner();
                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.primary)
                    .setTitle(`Server Information`)
                    .setThumbnail(guild.iconURL({ dynamic: true, size: 1024 }))
                    .setDescription(`**[ ${guild.name} ]**\n\n` +
                        `${config.emojis.robot} **Name:** ${CB}${guild.name}${CB}\n` +
                        `» **ID:** ${CB}${guild.id}${CB}\n` +
                        `👑 **Owner:** <@${owner.id}>\n` +
                        `🎂 **Creation:** <t:${Math.floor(guild.createdTimestamp / 1000)}:R>\n` +
                        `▶ **Channels:** ${CB}${guild.channels.cache.size}${CB}\n` +
                        `  #️⃣ Text: ${guild.channels.cache.filter(c => c.type === 'GUILD_TEXT').size}\n` +
                        `  🔊 VC: ${guild.channels.cache.filter(c => c.type === 'GUILD_VOICE').size}\n` +
                        `👥 **Members:** ${CB}${guild.memberCount}${CB}\n` +
                        `📑 **Roles:** ${CB}${guild.roles.cache.size}${CB}`)
                    .setFooter({ text: "Enterprise Architecture", iconURL: config.system.bannerUrl });
                return interaction.reply({ embeds: [embed] });
            }

            // --- USERINFO ---
            if (interaction.commandName === "userinfo") {
                const member = interaction.options.getMember("member") || interaction.member;
                const user = member.user;
                const roles = member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.toString()).join(" | ") || "None";
                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.info)
                    .setTitle(`Who is ${user.username}?`)
                    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 1024 }))
                    .setDescription(`**General Informations:**\n` +
                        `👤 **Name:** ${CB}${user.tag}${CB}\n` +
                        `» **ID:** ${CB}${user.id}${CB}\n` +
                        `🎂 **Creation:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>\n` +
                        `📆 **Join:** <t:${Math.floor(member.joinedTimestamp / 1000)}:R>\n\n` +
                        `**Account Accessories:**\n` +
                        `📑 **Roles:** ${roles}`)
                    .setFooter({ text: "Enterprise Architecture", iconURL: config.system.bannerUrl });
                return interaction.reply({ embeds: [embed] });
            }

            // --- STATS ---
            if (interaction.commandName === "stats") {
                const uptime = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 60000);
                const mem = process.memoryUsage();
                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.primary)
                    .setTitle(`${config.emojis.signal} System Stats`)
                    .setDescription(`— **Uptime:** ${CB}${uptime} Minutes${CB}\n` +
                        `— **RAM Usage:** ${CB}${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB${CB}\n` +
                        `— **Total Sessions:** ${CB}${sessionManager.getAllSessions().size} Active${CB}\n` +
                        `— **Security Level:** ${CB}AES-256 Enabled${CB}`)
                    .setFooter({ text: "Protected by Enterprise Security" });
                return interaction.reply({ embeds: [embed] });
            }

            // --- HELP ---
            if (interaction.commandName === "help") {
                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.primary)
                    .setTitle(`${config.emojis.shield} คู่มือการใช้งานระบบ Enterprise V5.0`)
                    .setDescription(
                        `**ระบบนี้ถูกออกแบบมาเพื่อความปลอดภัยและประสิทธิภาพสูงสุด**\n\n` +
                        `**⚙️ คำสั่งระบบพื้นฐาน:**\n` +
                        `- ${CB}/panel${CB} — เรียกแผงควบคุมออนช่องเสียง (เฉพาะแอดมิน)\n` +
                        `- ${CB}/stats${CB} — ดูสถานะการทำงานและทรัพยากรระบบ\n` +
                        `- ${CB}/serverinfo${CB} — ตรวจสอบข้อมูลเชิงลึกของเซิร์ฟเวอร์\n` +
                        `- ${CB}/userinfo${CB} — ตรวจสอบข้อมูลบัญชีผู้ใช้งาน\n` +
                        `- ${CB}/snipe${CB} — ดึงประวัติข้อความที่ถูกลบล่าสุด\n\n` +
                        `**🛡️ คำสั่งผู้ดูแล (Moderation):**\n` +
                        `- ${CB}/ban${CB}, ${CB}/kick${CB}, ${CB}/timeout${CB} — ลงโทษผู้ใช้พร้อมส่งแจ้งเตือนโปร่งใสทาง DM\n` +
                        `- ${CB}/voicekickall${CB} — ทำความสะอาดช่องเสียง (เตะทุกคนยกเว้นผู้ดูแล)\n` +
                        `- ${CB}/clear${CB} — ทำความสะอาดช่องแชท (สูงสุด 100 ข้อความ)\n` +
                        `- ${CB}/steal${CB} — ดึงอิโมจิเข้าเซิร์ฟเวอร์แบบรวดเดียว วางกี่อันก็ได้\n` +
                        `- ${CB}/say${CB}, ${CB}/announce${CB} — บริหารจัดแจงส่งข้อความประกาศ\n\n` +
                        `**💾 คำสั่งสำรองข้อมูล (Backup & Restore):**\n` +
                        `- ${CB}/setup-log${CB} — ติดตั้งโครงสร้างยศและหมวดหมู่ Log เริ่มต้น\n` +
                        `- ${CB}/backup${CB} — บันทึกโครงสร้าง (จำกัด 1 ครั้ง/24ชม. และเฉพาะ Owner เท่านั้น)\n` +
                        `- ${CB}/restore${CB} — กู้คืนโครงสร้าง (ป้องกันการขโมยด้วยระบบ Two-Key Verification)\n` +
                        `\n*หากพบปัญหา ติดต่อ Developer: <@661415152146710558>*`
                    );
                return interaction.reply({ embeds: [embed] });
            }

            // --- SNIPE ---
            if (interaction.commandName === "snipe") {
                const sniped = snipes.get(interaction.channel.id);
                if (!sniped) return interaction.reply({ content: `> ${config.emojis.warning} ไม่พบประวัติข้อความถูกลบในห้องนี้`, ephemeral: true });
                
                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.info)
                    .setAuthor({ name: sniped.author.tag, iconURL: sniped.author.displayAvatarURL({ dynamic: true }) })
                    .setDescription(sniped.content || "*ไม่มีข้อความ (อาจเป็นสื่อ/ภาพ)*")
                    .setFooter({ text: "Sniped Message" })
                    .setTimestamp(sniped.timestamp);
                
                if (sniped.image) embed.setImage(sniped.image);
                return interaction.reply({ embeds: [embed] });
            }

            // --- SAY & ANNOUNCE ---
            if (interaction.commandName === "say") {
                if (!interaction.member.permissions.has("MANAGE_MESSAGES")) return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์ใช้งาน`, ephemeral: true });
                const msg = interaction.options.getString("message");
                await interaction.channel.send(msg);
                return interaction.reply({ content: `> ${config.emojis.success} ส่งเรียบร้อยแล้ว`, ephemeral: true });
            }

            if (interaction.commandName === "announce") {
                if (!interaction.member.permissions.has("MANAGE_MESSAGES")) return interaction.reply({ content: `> ${config.emojis.no_entry} คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้`, ephemeral: true });
                const title = interaction.options.getString("title");
                const msgStr = interaction.options.getString("message");
                
                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.primary)
                    .setTitle(title)
                    .setDescription(msgStr)
                    .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL() })
                    .setTimestamp();
                
                await interaction.channel.send({ embeds: [embed] });
                return interaction.reply({ content: `> ${config.emojis.success} ประกาศสำเร็จแล้ว`, ephemeral: true });
            }

            // --- PANEL ---
            if (interaction.commandName === "panel") {
                if (!interaction.member.permissions.has("ADMINISTRATOR")) return interaction.reply({ content: `> ${config.emojis.no_entry} คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้`, ephemeral: true });
                
                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.primary)
                    .setAuthor({ name: "ระบบจัดการผู้ใช้งานช่องเสียง", iconURL: interaction.guild.iconURL() || config.system.bannerUrl })
                    .setDescription(`— ใช้งานเพื่อเปิดบอทเข้าไปออนในห้องเสียง\n— ข้อมูลทั้งหมดถูกจัดการและรักษาความปลอดภัยสูงสุด\n\n**สถานะปัจจุบัน:** ${config.emojis.success + " **ทำงานอยู่**"}\n\n*Developed by <@661415152146710558>*`)
                    .setImage(config.system.bannerUrl);

                const row = new MessageActionRow().addComponents(
                    new MessageButton().setCustomId("btn_start").setLabel("เริ่มการทำงาน").setEmoji("1505303237585141770").setStyle("SUCCESS"),
                    new MessageButton().setCustomId("btn_status").setLabel("สถานะ & จัดการ").setEmoji("1505295037213184161").setStyle("PRIMARY"),
                    new MessageButton().setCustomId("btn_stop_all").setLabel("หยุดการทำงานทั้งหมด").setEmoji("1505544059056427079").setStyle("DANGER")
                );

                const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
                panelMessages.set(interaction.guild.id, msg);
                await updatePanel(interaction.guild.id);
                return;
            }

            // --- BULK STEAL ---
            if (interaction.commandName === "steal") {
                if (!interaction.member.permissions.has("MANAGE_EMOJIS_AND_STICKERS")) return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์จัดการอิโมจิ`, ephemeral: true });
                if (!interaction.guild.me.permissions.has("MANAGE_EMOJIS_AND_STICKERS")) return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์จัดการอิโมจิในเซิร์ฟเวอร์นี้!`, ephemeral: true });

                const text = interaction.options.getString("emojis");
                const regex = /<(a?):([a-zA-Z0-9_]+):(\d+)>/g;
                let matches = [...text.matchAll(regex)];

                if (matches.length > 50) {
                    return interaction.reply({ content: `> ${config.emojis.error} **ระบบปฏิเสธคำสั่ง:** ไม่สามารถดึงอิโมจิเกิน 50 ตัวในครั้งเดียวได้ เพื่อป้องกันระบบหมดเวลาทำงาน (Interaction Timeout Limit)`, ephemeral: true });
                }

                await interaction.deferReply();
                let added = 0;
                let failed = 0;

                for (const match of matches) {
                    const isAnimated = match[1] === "a";
                    const name = match[2];
                    const id = match[3];
                    const url = `https://cdn.discordapp.com/emojis/${id}.${isAnimated ? 'gif' : 'png'}`;
                    try {
                        await interaction.guild.emojis.create(url, name);
                        added++;
                        await new Promise(r => setTimeout(r, 1000)); 
                    } catch {
                        failed++;
                    }
                }
                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.success)
                    .setDescription(`> ${config.emojis.success} **นำเข้าอิโมจิสำเร็จ:** ${added} รายการ` + (failed > 0 ? `\n> ${config.emojis.error} **ล้มเหลว:** ${failed} รายการ` : ""));
                return interaction.editReply({ embeds: [embed] });
            }

            // --- VOICE KICK ALL ---
            if (interaction.commandName === "voicekickall") {
                const vc = interaction.member.voice.channel;
                if (!vc) return interaction.reply({ content: `> ${config.emojis.no_entry} คุณต้องอยู่ในห้องเสียงก่อน!`, ephemeral: true });
                if (!interaction.member.permissions.has("ADMINISTRATOR")) return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์ผู้ดูแลระบบ`, ephemeral: true });
                if (!interaction.guild.me.permissions.has("MOVE_MEMBERS")) return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์เตะสมาชิก (ย้ายสมาชิก) ออกจากห้องเสียง!`, ephemeral: true });
                
                if (activeVoiceKicks.has(interaction.guild.id)) {
                    return interaction.reply({ content: `> ${config.emojis.warning} ระบบกำลังดำเนินการเตะสมาชิกห้องเสียงอยู่ กรุณารอสักครู่!`, ephemeral: true });
                }
                activeVoiceKicks.add(interaction.guild.id);

                await interaction.deferReply();
                
                try {
                    const startTime = Date.now();
                    const MAX_DURATION = 14 * 60 * 1000; 
                    let kicked = [];
                    let isTimeoutHit = false;

                    for (const [memberId, member] of vc.members) {
                        if (Date.now() - startTime > MAX_DURATION) {
                            isTimeoutHit = true;
                            break;
                        }
                        if (!member.permissions.has("ADMINISTRATOR")) {
                            try {
                                await member.voice.disconnect();
                                kicked.push(`<@${memberId}>`);
                                await new Promise(r => setTimeout(r, 500)); 
                            } catch {}
                        }
                    }

                    const limitMsg = isTimeoutHit ? `\n> ⚠️ **หยุดอัตโนมัติ:** ป้องกัน API หมดอายุ (เกิน 14 นาที)` : "";
                    const embed = new MessageEmbed()
                        .setColor(config.system.themeColors.success)
                        .setDescription(`> ${config.emojis.success} **จัดการห้องเสียงเรียบร้อย 🧹**\n\n— **เตะสำเร็จ ${kicked.length} คน ได้แก่:**\n${kicked.length > 0 ? kicked.join(", ") : "- ไม่มีใครถูกเตะ -"}${limitMsg}`);
                    
                    const logCh = await getLogChannel(interaction.guild);
                    if (logCh) logCh.send({ embeds: [embed] }).catch(()=>{});
                    return interaction.editReply({ embeds: [embed] });
                } finally {
                    activeVoiceKicks.delete(interaction.guild.id);
                }
            }

            // --- MODERATION ---
            if (["ban", "kick", "timeout"].includes(interaction.commandName)) {
                if (!interaction.member.permissions.has("MODERATE_MEMBERS") && !interaction.member.permissions.has("ADMINISTRATOR")) 
                    return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์ใช้งาน!`, ephemeral: true });
                
                const target = interaction.options.getMember("target");
                const reason = interaction.options.getString("reason") || "ไม่มีเหตุผลระบุ";
                if (!target) return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่พบเป้าหมาย!`, ephemeral: true });

                if (target.id === interaction.user.id) return interaction.reply({ content: `> ${config.emojis.warning} คุณไม่สามารถทำโทษตัวเองได้!`, ephemeral: true });
                if (target.id === client.user.id) return interaction.reply({ content: `> ${config.emojis.warning} คุณไม่สามารถทำโทษบอทระบบได้!`, ephemeral: true });
                
                if (target.roles.highest.position >= interaction.member.roles.highest.position && interaction.user.id !== interaction.guild.ownerId) {
                    return interaction.reply({ content: `> ${config.emojis.no_entry} คุณไม่สามารถทำโทษผู้ที่มียศสูงกว่าหรือเท่ากับคุณได้!`, ephemeral: true });
                }
                
                if (target.roles.highest.position >= interaction.guild.me.roles.highest.position) {
                    return interaction.reply({ content: `> ${config.emojis.error} ยศของบอทต่ำกว่าหรือเท่ากับเป้าหมาย ไม่สามารถทำโทษได้!`, ephemeral: true });
                }
                if (!target.manageable && interaction.commandName !== "ban") {
                    return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์จัดการสมาชิกท่านนี้`, ephemeral: true });
                }

                if (interaction.commandName === "timeout") {
                    const mins = interaction.options.getInteger("minutes");
                    if (mins <= 0) return interaction.reply({ content: `> ${config.emojis.error} เวลาต้องมากกว่า 0 นาที!`, ephemeral: true });
                    if (mins > 40000) return interaction.reply({ content: `> ${config.emojis.error} เวลาเกินขีดจำกัดของระบบ Discord (สูงสุด 28 วัน / ประมาณ 40,000 นาที)`, ephemeral: true });
                }

                await interaction.deferReply();
                
                // [V5.0 AESTHETIC POLISH]: ดึงรูปภาพ Avatar ของผู้ถูกลงโทษมาประดับใน Embed แจ้งเตือนและ Embed ตอบกลับ
                const targetAvatar = target.user.displayAvatarURL({ dynamic: true, size: 1024 });

                const dmEmbed = new MessageEmbed()
                    .setColor(config.system.themeColors.error)
                    .setTitle(`🚨 คุณถูกระงับสิทธิ์ในเซิร์ฟเวอร์ ${interaction.guild.name}`)
                    .setThumbnail(targetAvatar); // V5.0 Aesthetic Update
                
                try {
                    if (interaction.commandName === "ban") {
                        if (!interaction.guild.me.permissions.has("BAN_MEMBERS")) throw new Error("MISSING_PERMS");
                        dmEmbed.setDescription(`— **การดำเนินการ:** แบนถาวร\n— **ผู้ดำเนินการ:** ${interaction.user.tag}\n— **เหตุผล:** ${reason}`);
                        sendDM(target.user, dmEmbed);
                        await target.ban({ reason });
                    } else if (interaction.commandName === "kick") {
                        if (!interaction.guild.me.permissions.has("KICK_MEMBERS")) throw new Error("MISSING_PERMS");
                        dmEmbed.setDescription(`— **การดำเนินการ:** เตะออกจากเซิร์ฟเวอร์\n— **ผู้ดำเนินการ:** ${interaction.user.tag}\n— **เหตุผล:** ${reason}`);
                        sendDM(target.user, dmEmbed);
                        await target.kick(reason);
                    } else if (interaction.commandName === "timeout") {
                        if (!interaction.guild.me.permissions.has("MODERATE_MEMBERS")) throw new Error("MISSING_PERMS");
                        const mins = interaction.options.getInteger("minutes");
                        dmEmbed.setDescription(`— **การดำเนินการ:** ระงับการใช้งาน (Timeout) ${mins} นาที ⏳\n— **ผู้ดำเนินการ:** ${interaction.user.tag}\n— **เหตุผล:** ${reason}`);
                        sendDM(target.user, dmEmbed);
                        await target.timeout(mins * 60000, reason);
                    }
                    
                    const replyEmbed = new MessageEmbed()
                        .setColor(config.system.themeColors.success)
                        .setAuthor({ name: `ลงดาบผู้กระทำผิดเรียบร้อย`, iconURL: interaction.guild.iconURL() })
                        .setDescription(`> ${config.emojis.success} **ดำเนินการสำเร็จ!**\n> 👤 **เป้าหมาย:** <@${target.id}>\n> 🔨 **การดำเนินการ:** **${interaction.commandName.toUpperCase()}**\n> 📝 **เหตุผล:** ${reason}`)
                        .setThumbnail(targetAvatar); // V5.0 Aesthetic Update

                    const logCh = await getLogChannel(interaction.guild);
                    if (logCh) logCh.send({ embeds: [replyEmbed] }).catch(()=>{});
                    return interaction.editReply({ embeds: [replyEmbed] });
                } catch (err) {
                    if (err.message === "MISSING_PERMS") return interaction.editReply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์ที่จำเป็นในการลงโทษ! (Missing Permissions)` });
                    const details = err.message === "NOT_FOUND" ? "ไม่พบประวัติผู้ใช้" : err.message;
                    return interaction.editReply({ content: `> ${config.emojis.error} ไม่สามารถดำเนินการได้: ${details}` });
                }
            }

            // --- SETUP LOG ---
            if (interaction.commandName === "setup-log") {
                if (!interaction.member.permissions.has("ADMINISTRATOR")) return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์ผู้ดูแลระบบ`, ephemeral: true });
                if (!interaction.guild.me.permissions.has("MANAGE_CHANNELS") || !interaction.guild.me.permissions.has("MANAGE_ROLES")) {
                    return interaction.reply({ content: `> ${config.emojis.error} บอทต้องการสิทธิ์ 'จัดการช่อง' และ 'จัดการบทบาท' เพื่อดำเนินการติดตั้ง`, ephemeral: true });
                }
                
                await interaction.deferReply();
                try {
                    const guild = interaction.guild;
                    const adminRole = await guild.roles.create({ name: config.roles.adminName, color: "DARK_BUT_NOT_BLACK", permissions: ["ADMINISTRATOR"] });
                    const userRole = await guild.roles.create({ name: config.roles.userName, color: "DEFAULT" });
                    
                    const cat = await guild.channels.create("🛡️ Enterprise System", { 
                        type: "GUILD_CATEGORY",
                        permissionOverwrites: [
                            { id: guild.id, deny: ["VIEW_CHANNEL"] },
                            { id: adminRole.id, allow: ["VIEW_CHANNEL"] }
                        ]
                    });

                    await guild.channels.create(config.channels.logName, { type: "GUILD_TEXT", parent: cat.id });

                    const embed = new MessageEmbed().setColor(config.system.themeColors.success)
                        .setDescription(`> ✅ **ติดตั้งระบบ Enterprise สำเร็จแล้ว!**\n\n— 👑 **ยศผู้ดูแล:** <@&${adminRole.id}>\n— 🛡️ **ยศผู้ใช้งาน:** <@&${userRole.id}>\n— 📁 **หมวดหมู่ซ่อน:** สร้างและล็อกสิทธิ์เรียบร้อย`);
                    return interaction.editReply({ embeds: [embed] });
                } catch (e) {
                    return interaction.editReply({ content: `> ${config.emojis.error} เกิดข้อผิดพลาด: ${e.message}` });
                }
            }

            // --- BACKUP ---
            if (interaction.commandName === "backup") {
                if (interaction.user.id !== interaction.guild.ownerId && interaction.user.id !== config.system.ownerId) {
                    return interaction.reply({ content: `> ${config.emojis.no_entry} คำสั่งนี้สงวนไว้สำหรับ **เจ้าของเซิร์ฟเวอร์** เท่านั้น!`, ephemeral: true });
                }
                
                if (activeBackups.has(interaction.guild.id)) {
                    return interaction.reply({ content: `> ${config.emojis.warning} ระบบกำลังทำการสำรองข้อมูลเซิร์ฟเวอร์นี้อยู่ โปรดรอสักครู่!`, ephemeral: true });
                }
                activeBackups.add(interaction.guild.id);
                
                await interaction.deferReply();

                try {
                    const existing = await sessionManager.SnapshotModel.findOne({ guildId: interaction.guild.id });
                    if (existing && interaction.user.id !== config.system.ownerId) {
                        const hoursPassed = (Date.now() - existing.createdAt) / 3600000;
                        if (hoursPassed < 24) return interaction.editReply({ content: `> ${config.emojis.warning} บันทึกไปแล้วเมื่อ <t:${Math.floor(existing.createdAt/1000)}:R> โปรดรอให้ครบ 24 ชั่วโมง` });
                        await sessionManager.SnapshotModel.deleteOne({ guildId: interaction.guild.id });
                    }

                    const data = {
                        roles: interaction.guild.roles.cache.map(r => ({ 
                            id: r.id, name: r.name, color: r.color, permissions: r.permissions.bitfield.toString() 
                        })),
                        channels: interaction.guild.channels.cache.map(c => ({ 
                            name: c.name, type: c.type, parentId: c.parentId,
                            permissionOverwrites: c.permissionOverwrites.cache.map(o => ({
                                id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString()
                            }))
                        }))
                    };

                    await sessionManager.SnapshotModel.create({
                        snapshotId: crypto.randomUUID(),
                        guildId: interaction.guild.id,
                        Backup_Owner_ID: interaction.user.id, 
                        data: data,
                        createdAt: Date.now()
                    });

                    const embed = new MessageEmbed().setColor(config.system.themeColors.success)
                        .setDescription(`> 💾 **ประทับตราและบันทึกโครงสร้างสำเร็จ!**\n— **ผู้บันทึก:** <@${interaction.user.id}>\n— **จำนวน:** ${data.roles.length} ยศ / ${data.channels.length} ห้อง`);
                    
                    if (process.env.WEBHOOK_SECRET) {
                        try {
                            const wh = new WebhookClient({ url: process.env.WEBHOOK_SECRET });
                            wh.send({ content: `🚨 **[SECRET LOG] Backup Created!**\nGuild: ${interaction.guild.name}\nBy: ${interaction.user.tag}\nRoles: ${data.roles.length}` }).catch(()=>{});
                        } catch(e) {}
                    }

                    return interaction.editReply({ embeds: [embed] });
                } finally {
                    activeBackups.delete(interaction.guild.id);
                }
            }

            // --- RESTORE ---
            if (interaction.commandName === "restore") {
                const targetId = interaction.options.getString("server_id");
                if (interaction.user.id !== interaction.guild.ownerId && interaction.user.id !== config.system.ownerId) {
                    return interaction.reply({ content: `> ${config.emojis.no_entry} คุณต้องเป็น **เจ้าของเซิร์ฟเวอร์ปัจจุบัน** เท่านั้น!`, ephemeral: true });
                }
                
                if (!interaction.guild.me.permissions.has("ADMINISTRATOR")) {
                    return interaction.reply({ content: `> ${config.emojis.error} บอทต้องมีสิทธิ์ **Administrator** เท่านั้น เพื่อดำเนินการกู้คืนระบบเชิงลึก!`, ephemeral: true });
                }

                await interaction.deferReply();

                const backup = await sessionManager.SnapshotModel.findOne({ guildId: targetId });
                if (!backup) return interaction.editReply({ content: `> ${config.emojis.error} ไม่พบข้อมูล Backup ของไอดีเซิร์ฟเวอร์นี้` });

                if (backup.Backup_Owner_ID !== interaction.user.id && interaction.user.id !== config.system.ownerId) {
                    return interaction.editReply({ content: `> ${config.emojis.lock} **ปฏิเสธการเข้าถึง!** กุญแจผู้บันทึกไม่ตรงกัน คุณไม่สิทธิ์ดึงข้อมูลนี้` });
                }

                const embed = new MessageEmbed().setColor(config.system.themeColors.error)
                    .setTitle(`⚠️ ยืนยันการกู้คืนเซิร์ฟเวอร์!`)
                    .setDescription(`📁 **ข้อมูลการบันทึกล่าสุด:**\n— บันทึกโดย: <@${backup.Backup_Owner_ID}>\n— เวลา: <t:${Math.floor(backup.createdAt/1000)}:F>\n— ข้อมูล: ${backup.data.roles.length} ยศ, ${backup.data.channels.length} ห้อง\n\n*กระบวนการนี้จะสร้างสิ่งที่หายไปกลับมา (อาจใช้เวลาหลายนาที)*`);
                
                const row = new MessageActionRow().addComponents(
                    new MessageButton().setCustomId(`btn_restore_confirm_${backup.snapshotId}`).setLabel("ยืนยันกู้คืน").setStyle("SUCCESS"),
                    new MessageButton().setCustomId("btn_restore_cancel").setLabel("ยกเลิก").setStyle("DANGER")
                );

                return interaction.editReply({ embeds: [embed], components: [row] });
            }

            // --- CLEAR ---
            if (interaction.commandName === "clear") {
                if (!interaction.member.permissions.has("MANAGE_MESSAGES")) return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์ลบข้อความ`, ephemeral: true });
                if (!interaction.guild.me.permissions.has("MANAGE_MESSAGES")) return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์ลบข้อความในช่องนี้!`, ephemeral: true });
                
                const amt = interaction.options.getInteger("amount");
                if (amt < 1 || amt > 100) return interaction.reply({ content: `> ${config.emojis.warning} กรุณาระบุจำนวน 1-100 เท่านั้น`, ephemeral: true });
                
                try {
                    const deletedMsgs = await interaction.channel.bulkDelete(amt, true);
                    if (deletedMsgs.size === 0) {
                        return interaction.reply({ content: `> ${config.emojis.warning} ลบไม่สำเร็จ: ไม่พบข้อความใหม่ (ข้อความที่เก่ากว่า 14 วันไม่สามารถลบแบบรวดเดียวได้ตามกฎ Discord)`, ephemeral: true });
                    }
                    return interaction.reply({ content: `> ${config.emojis.success} ลบข้อความสำเร็จ **${deletedMsgs.size}** ข้อความ`, ephemeral: true });
                } catch(e) {
                    return interaction.reply({ content: `> ${config.emojis.error} ล้มเหลว: เกิดข้อผิดพลาดในการลบข้อความ`, ephemeral: true });
                }
            }

            return;
        }

        // ════════════════════════════════════════════════════════════════
        //  BUTTON INTERACTIONS
        // ════════════════════════════════════════════════════════════════
        if (interaction.isButton()) {
            if (interaction.customId.startsWith("btn_restore_confirm_")) {
                if (activeRestores.has(interaction.guild.id)) {
                    return interaction.reply({ content: `> ${config.emojis.warning} เซิร์ฟเวอร์นี้กำลังอยู่ในระหว่างการกู้คืน โปรดรอจนกว่าจะเสร็จสิ้น!`, ephemeral: true });
                }
                activeRestores.add(interaction.guild.id);
                
                await interaction.update({ components: [], embeds: [new MessageEmbed().setColor(config.system.themeColors.warning).setDescription(`> ${config.emojis.signal} **กำลังกู้คืนระบบ กรุณารอสักครู่... (กระบวนการนี้อาจใช้เวลาหลายนาที)**`)] });
                
                const snapshotId = interaction.customId.replace("btn_restore_confirm_", "");
                
                (async () => {
                    try {
                        const backup = await sessionManager.SnapshotModel.findOne({ snapshotId });
                        if (!backup || !backup.data) return interaction.followUp({ content: `> ${config.emojis.error} ไม่พบข้อมูล Backup`, ephemeral: true }).catch(()=>{});
                        
                        const guild = interaction.guild;
                        const { roles, channels } = backup.data;
                        let restoredRoles = 0;
                        let restoredChannels = 0;
                        
                        const startTime = Date.now();
                        const MAX_DUR = 14 * 60 * 1000; 
                        let timeoutHit = false;

                        const roleIdMap = new Map();
                        const oldGuildId = backup.guildId; 

                        if (roles && Array.isArray(roles)) {
                            for (const rData of roles) {
                                if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }
                                if (rData.name === config.roles.adminName || rData.name === config.roles.userName) continue; 
                                
                                let existingRole = guild.roles.cache.find(r => r.name === rData.name);
                                if (rData.name === "@everyone") existingRole = guild.roles.everyone;

                                if (!existingRole) {
                                    try {
                                        existingRole = await guild.roles.create({
                                            name: rData.name,
                                            color: rData.color,
                                            permissions: BigInt(rData.permissions),
                                            reason: "Enterprise Restore"
                                        });
                                        restoredRoles++;
                                        await new Promise(res => setTimeout(res, 500)); 
                                    } catch(e) { console.error("Restore Role Error", e.message); }
                                }
                                
                                if (existingRole && rData.id) roleIdMap.set(rData.id, existingRole.id);
                            }
                        }

                        if (channels && Array.isArray(channels)) {
                            for (const cData of channels) {
                                if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }
                                const exists = guild.channels.cache.find(c => c.name === cData.name && c.type === cData.type);
                                if (!exists) {
                                    try {
                                        const validTypes = ["GUILD_TEXT", "GUILD_VOICE", "GUILD_CATEGORY", "GUILD_NEWS", "GUILD_STAGE_VOICE"];
                                        if (validTypes.includes(cData.type)) {
                                            let mappedOverwrites = [];
                                            if (cData.permissionOverwrites && Array.isArray(cData.permissionOverwrites)) {
                                                for (const ow of cData.permissionOverwrites) {
                                                    let targetId = roleIdMap.get(ow.id);
                                                    if (ow.id === oldGuildId) targetId = guild.id;
                                                    if (targetId) {
                                                        mappedOverwrites.push({ id: targetId, allow: BigInt(ow.allow), deny: BigInt(ow.deny) });
                                                    }
                                                }
                                            }

                                            await guild.channels.create(cData.name, {
                                                type: cData.type,
                                                permissionOverwrites: mappedOverwrites,
                                                reason: "Enterprise Restore - Full Structure"
                                            });
                                            restoredChannels++;
                                            await new Promise(res => setTimeout(res, 500)); 
                                        }
                                    } catch(e) { console.error("Restore Channel Error", e.message); }
                                }
                            }
                        }
                        
                        const timeMsg = timeoutHit ? "\n> ⚠️ **หยุดการกู้คืนอัตโนมัติ:** ป้องกัน API หมดอายุ (เกิน 14 นาที)" : "";
                        await interaction.followUp({ content: `> ${config.emojis.success} **กู้คืนโครงสร้างสำเร็จ!**\n— สร้างยศเพิ่ม: ${restoredRoles} ยศ\n— สร้างห้องเพิ่ม: ${restoredChannels} ห้อง${timeMsg}`, ephemeral: true }).catch(()=>{});

                    } catch (err) {
                        console.error("[RESTORE] Catch Error:", err.message);
                        await interaction.followUp({ content: `> ${config.emojis.error} เกิดข้อผิดพลาดขณะกู้คืน: ${err.message}`, ephemeral: true }).catch(()=>{});
                    } finally {
                        activeRestores.delete(interaction.guild.id);
                    }
                })();
                return;
            }

            if (interaction.customId === "btn_restore_cancel") {
                return interaction.update({ components: [], embeds: [new MessageEmbed().setColor(config.system.themeColors.error).setDescription(`> ${config.emojis.stop} ยกเลิกการกู้คืน`)] });
            }

            if (interaction.customId === "btn_start") {
                const modal = new Modal().setCustomId("modal_start").setTitle("เริ่มการทำงาน");
                modal.addComponents(
                    new MessageActionRow().addComponents(new TextInputComponent().setCustomId("token").setLabel("Token บัญชี (ปลอดภัย 100%)").setStyle("SHORT").setRequired(true)),
                    new MessageActionRow().addComponents(new TextInputComponent().setCustomId("voice_id").setLabel("ไอดีช่องเสียง").setStyle("SHORT").setRequired(true))
                );
                return interaction.showModal(modal);
            }

            if (interaction.customId === "btn_stop_all") {
                await interaction.deferReply({ ephemeral: true });
                const allSessions = Array.from(sessionManager.getAllSessions().values());
                const userSessions = allSessions.filter(s => s.serverId === interaction.guild.id && s.ownerId === interaction.user.id);
                
                if (userSessions.length === 0) return interaction.editReply({ content: `> ${config.emojis.warning} คุณไม่มีผู้ใช้งานที่กำลังทำงานอยู่` });
                
                for (const s of userSessions) {
                    await voiceWorker.stopSession(s.sessionId);
                }
                await updatePanel(interaction.guild.id);
                return interaction.editReply({ content: `> ${config.emojis.stop} ปิดผู้ใช้งานของคุณทั้งหมด ${userSessions.length} รายการ เรียบร้อยแล้ว` });
            }

            if (interaction.customId === "btn_status" || interaction.customId.startsWith("status_page_")) {
                const allSessions = Array.from(sessionManager.getAllSessions().values());
                const userSessions = allSessions.filter(s => s.serverId === interaction.guild.id && s.ownerId === interaction.user.id);
                
                if (userSessions.length === 0) {
                    if (interaction.deferred) return interaction.editReply({ content: `> ${config.emojis.warning} คุณไม่มีผู้ใช้งานที่ออนอยู่ในเซิร์ฟเวอร์นี้` });
                    return interaction.reply({ content: `> ${config.emojis.warning} คุณไม่มีผู้ใช้งานที่ออนอยู่ในเซิร์ฟเวอร์นี้`, ephemeral: true });
                }

                let page = 0;
                if (interaction.customId.startsWith("status_page_")) {
                    page = parseInt(interaction.customId.split("_")[2]);
                }
                
                if (page < 0) page = userSessions.length - 1;
                if (page >= userSessions.length) page = 0;

                const current = userSessions[page];
                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.primary)
                    .setAuthor({ name: current.ownerTag || "Unknown User", iconURL: current.ownerAvatar || "https://cdn.discordapp.com/embed/avatars/0.png" })
                    .setDescription(`— **เซิร์ฟเวอร์:** ${CB}${current.serverName}${CB}\n— **ห้องเสียง:** <#${current.voiceId}>\n— **Token (ท้าย):** ${CB}${current.tokenTail}${CB}\n— **สถานะ:** ${config.emojis.status_online} กำลังเชื่อมต่อ\n— **ออนเมื่อ:** <t:${Math.floor(current.startedAt / 1000)}:R>`)
                    .setFooter({ text: `รายการของคุณ ${page + 1} / ${userSessions.length}` });

                const row = new MessageActionRow().addComponents(
                    new MessageButton().setCustomId(`status_page_${page - 1}`).setEmoji(config.emojis.page_prev).setStyle("SECONDARY"),
                    new MessageButton().setCustomId(`status_stop_${current.sessionId}`).setLabel("หยุดออนตัวนี้").setEmoji(config.emojis.status_offline).setStyle("DANGER"),
                    new MessageButton().setCustomId(`status_page_${page + 1}`).setEmoji(config.emojis.page_next).setStyle("SECONDARY")
                );

                if (interaction.replied || interaction.deferred) {
                    return interaction.update({ embeds: [embed], components: [row], ephemeral: true });
                } else {
                    return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
                }
            }

            if (interaction.customId.startsWith("status_stop_")) {
                await interaction.deferUpdate();
                const sId = interaction.customId.replace("status_stop_", "");
                await voiceWorker.stopSession(sId);
                await updatePanel(interaction.guild.id);
                
                const allSessions = Array.from(sessionManager.getAllSessions().values());
                const userSessions = allSessions.filter(s => s.serverId === interaction.guild.id && s.ownerId === interaction.user.id);
                if (userSessions.length === 0) {
                    return interaction.editReply({ embeds: [new MessageEmbed().setColor(config.system.themeColors.success).setDescription(`> ${config.emojis.success} ลบผู้ใช้งานสำเร็จ (ไม่มีรายการเหลือแล้ว)`)], components: [] });
                }
                const current = userSessions[0];
                const embed = new MessageEmbed().setColor(config.system.themeColors.primary).setAuthor({ name: current.ownerTag || "Unknown", iconURL: current.ownerAvatar }).setDescription(`— **เซิร์ฟเวอร์:** ${CB}${current.serverName}${CB}\n— **ห้องเสียง:** <#${current.voiceId}>`).setFooter({ text: `รายการของคุณ 1 / ${userSessions.length}` });
                const row = new MessageActionRow().addComponents(
                    new MessageButton().setCustomId(`status_page_-1`).setEmoji(config.emojis.page_prev).setStyle("SECONDARY"),
                    new MessageButton().setCustomId(`status_stop_${current.sessionId}`).setLabel("หยุดออนตัวนี้").setEmoji(config.emojis.status_offline).setStyle("DANGER"),
                    new MessageButton().setCustomId(`status_page_1`).setEmoji(config.emojis.page_next).setStyle("SECONDARY")
                );
                return interaction.editReply({ embeds: [embed], components: [row] });
            }
        }

        // ════════════════════════════════════════════════════════════════
        //  MODAL SUBMIT HANDLER
        // ════════════════════════════════════════════════════════════════
        if (interaction.isModalSubmit()) {
            if (interaction.customId === "modal_start") {
                await interaction.deferReply({ ephemeral: true });
                const token = interaction.fields.getTextInputValue("token").trim();
                const voiceId = interaction.fields.getTextInputValue("voice_id").trim();

                try {
                    const sessionId = await sessionManager.createSession(
                        token, 
                        interaction.guild.id, 
                        voiceId, 
                        interaction.guild.name,
                        interaction.user.id,
                        interaction.user.displayAvatarURL({ dynamic: true }),
                        interaction.user.tag
                    );
                    await voiceWorker.startSession(sessionId, token);
                    await updatePanel(interaction.guild.id);
                    
                    const logCh = await getLogChannel(interaction.guild);
                    if (logCh) {
                        logCh.send({ embeds: [new MessageEmbed().setColor(config.system.themeColors.success).setDescription(`> ${config.emojis.success} **เริ่มการทำงานผู้ใช้งานใหม่!**\n— **โดย:** <@${interaction.user.id}>\n— **ห้อง:** <#${voiceId}>`)] }).catch(()=>{});
                    }

                    return interaction.editReply({ content: `> ${config.emojis.success} เริ่มระบบสำเร็จ! ผู้ใช้งานเข้าห้องเสียงเรียบร้อย` });
                } catch (err) {
                    const errMsg = {
                        "INVALID_TOKEN_FORMAT": `> ${config.emojis.error} รูปแบบ Token ไม่ถูกต้อง`,
                        "ALREADY_ACTIVE": `> ${config.emojis.warning} Token นี้กำลังทำงานอยู่ในเซิร์ฟเวอร์นี้แล้ว`,
                        "SYSTEM_LIMIT": `> ${config.emojis.error} ระบบเต็ม! (เกินขีดจำกัด ${config.limits.maxSessions} เซสชัน)`,
                        "LOGIN_TIMEOUT": `> ${config.emojis.warning} เชื่อมต่อบัญชีล่าช้า โปรดลองใหม่`,
                        "TOKEN_INVALID": `> ${config.emojis.error} Token ไม่ถูกต้อง หรือหมดอายุ`,
                        "GUILD_NOT_FOUND": `> ${config.emojis.error} บอทเข้าถึงเซิร์ฟเวอร์ไม่ได้`,
                        "CHANNEL_NOT_FOUND": `> ${config.emojis.error} ไม่พบห้องเสียง หรือไม่มีสิทธิ์เข้าห้อง`,
                    }[err.message] ?? `> ${config.emojis.warning} เกิดข้อผิดพลาด: ${err.message}`;
                    return interaction.editReply({ content: errMsg });
                }
            }
        }
    } catch (err) {
        console.error(`[SLASH] Error in /${interaction.commandName || 'interaction'}:`, err.message);
        const reply = { content: `> ${config.emojis.warning} เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง`, ephemeral: true };
        if (interaction.deferred) return interaction.editReply(reply).catch(() => {});
        if (!interaction.replied) return interaction.reply(reply).catch(() => {});
    }
}

module.exports = { handleMessage, handleInteraction, updatePanel, slashCommandsData, getPanelMessages, snipes };
