const { MessageEmbed, MessageActionRow, MessageButton, MessageSelectMenu, Modal, TextInputComponent, WebhookClient } = require("discord.js");
const config = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker = require("./voiceWorker");

const snipes = new Map();
const CB = "\x60\x60\x60"; 

const slashCommandsData = [
    { name: "panel",      description: "เรียกแผงควบคุมระบบออนช่องเสียง" },
    { name: "help",       description: "แสดงคู่มือการใช้งาน" },
    { name: "stats",      description: "ดูสถิติการทำงานของระบบ" },
    { name: "serverinfo", description: "แสดงข้อมูลรายละเอียดของเซิร์ฟเวอร์" },
    { name: "setup-log",  description: "สร้างห้อง Log สำหรับบันทึกกิจกรรม" },
    {
        name: "userinfo", description: "แสดงข้อมูลโปรไฟล์ของสมาชิก",
        options: [{ type: 6, name: "member", description: "สมาชิกที่ต้องการดูข้อมูล", required: false }]
    },
    {
        name: "clear", description: "ลบข้อความในช่องปัจจุบัน",
        options: [{ type: 4, name: "amount", description: "จำนวนข้อความที่ต้องการลบ (1-100)", required: true }]
    },
    {
        name: "say", description: "ส่งข้อความในนามระบบ",
        options: [{ type: 3, name: "message", description: "ข้อความที่ต้องการส่ง", required: true }]
    },
    {
        name: "announce", description: "เผยแพร่ประกาศสำคัญ",
        options: [{ type: 3, name: "message", description: "เนื้อหาประกาศ", required: true }]
    },
    { name: "lock",   description: "ล็อกช่องข้อความปัจจุบัน" },
    { name: "unlock", description: "ปลดล็อกช่องข้อความปัจจุบัน" },
    {
        name: "kick", description: "เตะสมาชิกออกจากเซิร์ฟเวอร์",
        options: [
            { type: 6, name: "member",  description: "สมาชิกที่ต้องการเตะ", required: true },
            { type: 3, name: "reason",  description: "เหตุผล", required: false }
        ]
    },
    {
        name: "ban", description: "แบนสมาชิกถาวร",
        options: [
            { type: 6, name: "member",  description: "สมาชิกที่ต้องการแบน", required: true },
            { type: 3, name: "reason",  description: "เหตุผล", required: false }
        ]
    },
    {
        name: "unban", description: "ยกเลิกการแบน",
        options: [{ type: 3, name: "userid", description: "User ID ที่ต้องการปลดแบน", required: true }]
    },
    {
        name: "timeout", description: "ระงับสิทธิ์การพิมพ์ชั่วคราว",
        options: [
            { type: 6, name: "member",  description: "สมาชิกที่ต้องการระงับ", required: true },
            { type: 4, name: "minutes", description: "จำนวนนาที", required: true },
            { type: 3, name: "reason",  description: "เหตุผล", required: false }
        ]
    },
    { name: "snipe", description: "ดูข้อความล่าสุดที่ถูกลบ" },
    { 
        name: "enlarge", description: "ขยายภาพอิโมจิ",
        options: [{ type: 3, name: "emoji", description: "อิโมจิ", required: true }]
    },
    { 
        name: "steal", description: "ดึงอิโมจิเข้าเซิร์ฟเวอร์",
        options: [{ type: 3, name: "emoji", description: "อิโมจิ", required: true }, { type: 3, name: "name", description: "ชื่อ", required: true }]
    },
    { 
        name: "voice", description: "ควบคุมห้องเสียงแบบฉับพลัน",
        options: [
            { type: 1, name: "lock", description: "ล็อก" },
            { type: 1, name: "hide", description: "ซ่อน" },
            { type: 1, name: "kickall", description: "เตะทุกคน" }
        ]
    },
    { name: "backup", description: "ถ่ายข้อมูลเซิร์ฟเวอร์สำรอง" },
    
    { name: "🔨 จัดการสมาชิก", type: 2 },
    { name: "🗑️ ลบข้อความนี้", type: 3 },
    { name: "📝 บันทึกข้อมูล", type: 3 }
];

const panelMessages = new Map();
let isUpdatingPanel = false;

function getPanelMessages() {
    return panelMessages;
}

let logWebhook = null;
let webhookFailCount = 0;
const MAX_WEBHOOK_FAILS = 5;

if (process.env.WEBHOOK_LOG_URL) {
    try {
        logWebhook = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
        console.log("✅ [WEBHOOK] Initialized successfully");
    } catch (err) {
        console.error("❌ [WEBHOOK] Invalid URL:", err.message);
        logWebhook = null;
    }
}

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s % 60}s`;
}

function safeSlice(str, max) {
    if (!str || str.length <= max) return str;
    return str.slice(0, max) + "…";
}

function getPanelEmbed() {
    const embed = new MessageEmbed()
        .setColor(config.system.themeColor)
        .setDescription(
            `# ${config.emojis.universe} : Phomueangtai ระบบออนช่องเสียง\n\n` +
            `> ระบบออนช่องเสียงอัตโนมัติ ${config.emojis.dreamworld}\n` +
            `> ออนไลน์ฟรีครบ 24. ${config.emojis.dreamworld}\n` +
            `> ตั้งค่าควบคุมผ่านปุ่มเเผงควบคุมด้านล่าง ${config.emojis.dreamworld}`
        )
        .setImage(config.system.bannerUrl);

    return embed;
}

function getPanelRow() {
    return new MessageActionRow().addComponents(
        new MessageButton().setCustomId("btn_start").setLabel("ออนช่องเสียง").setEmoji(config.emojis.signal).setStyle("SUCCESS"),
        new MessageButton().setCustomId("btn_stop").setLabel("ปิดช่องเสียง").setEmoji(config.emojis.stop).setStyle("DANGER"),
        new MessageButton().setCustomId("btn_help").setLabel("คู่มือ").setEmoji(config.emojis.books).setStyle("SECONDARY")
    );
}

function getHelpPages() {
    const footer = { text: "Enterprise System  │  เฉพาะผู้ดูแลระบบที่ได้รับอนุญาต" };
    return[
        new MessageEmbed().setTitle(`${config.emojis.books}  คู่มือระบบ  ·  หน้า 1 / 3`).setColor(config.system.themeColor)
            .setDescription(`> **ข้อมูลและการสืบค้น**\n\n${CB}ansi\n\u001b[1;36mINFORMATION COMMANDS\u001b[0m\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${CB}`)
            .addFields({ name: "🔍  คำสั่งข้อมูลระบบ", value: "> `p.userinfo [@สมาชิก]`\n> `p.serverinfo`\n> `p.stats` (ดูสถิติระบบ)\n> `p.help`", inline: false }).setFooter(footer),
        new MessageEmbed().setTitle(`${config.emojis.books}  คู่มือระบบ  ·  หน้า 2 / 3`).setColor(config.system.themeColor)
            .setDescription(`> **การควบคุมและบังคับใช้กฎ**\n\n${CB}ansi\n\u001b[1;31mMODERATION COMMANDS\u001b[0m\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${CB}`)
            .addFields(
                { name: "🛡️  การจัดการข้อความและช่อง", value: "> `p.clear <1-100>`\n> `p.say <ข้อความ>`\n> `p.announce <ข้อความ>`\n> `p.lock` / `p.unlock`", inline: false },
                { name: "⚔️  การบังคับใช้กฎ", value: "> `p.kick @สมาชิก`\n> `p.ban @สมาชิก`\n> `p.unban <USER_ID>`\n> `p.timeout @สมาชิก <นาที>`", inline: false }
            ).setFooter(footer),
        new MessageEmbed().setTitle(`${config.emojis.books}  คู่มือระบบ  ·  หน้า 3 / 3`).setColor(config.system.themeColor)
            .setDescription(`> **ระบบออนช่องเสียงผู้ใช้**\n\n${CB}ansi\n\u001b[1;32mVOICE MANAGEMENT SYSTEM\u001b[0m\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${CB}`)
            .addFields(
                { name: "🎧  คำสั่งระบบเสียง", value: "> `p.panel`\n> `p.setup-log`", inline: false },
                { name: "⚡  วิธีใช้งานแผงควบคุม", value: "> **⚡ เริ่มเซสชัน** กรอก Token เพื่อเริ่ม\n> **📡 สถานะ** ตรวจสอบเซสชัน\n> **⏹ หยุดรายการ** หยุดเฉพาะรายการ\n> **🛑 หยุดทั้งหมด** ปิดทุกเซสชัน", inline: false }
            ).setFooter(footer),
    ];
}

function getHelpRow(page) {
    return new MessageActionRow().addComponents(
        new MessageButton().setCustomId(`help_prev_${page}`).setLabel("◀  ก่อนหน้า").setStyle("SECONDARY").setDisabled(page === 0),
        new MessageButton().setCustomId(`help_page_${page}`).setLabel(`หน้า ${page + 1} / 3`).setStyle("PRIMARY").setDisabled(true),
        new MessageButton().setCustomId(`help_next_${page}`).setLabel("ถัดไป  ▶").setStyle("SECONDARY").setDisabled(page === 2),
    );
}

async function sendLog(guild, embed) {
    setImmediate(async () => {
        try {
            if (logWebhook && webhookFailCount < MAX_WEBHOOK_FAILS) {
                try {
                    await logWebhook.send({ embeds: [embed] });
                    webhookFailCount = 0;
                } catch (err) {
                    webhookFailCount++;
                    console.error(`❌ [WEBHOOK] Send failed (${webhookFailCount}/${MAX_WEBHOOK_FAILS}):`, err.message);
                    if (webhookFailCount >= MAX_WEBHOOK_FAILS) {
                        console.warn("⚠️  [WEBHOOK] Too many failures, falling back to channel logging");
                        logWebhook = null;
                    }
                    if (guild) {
                        const ch = guild.channels.cache.find(c => c.name === config.channels.logName && c.type === "GUILD_TEXT");
                        if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
                    }
                }
            } else if (guild) {
                const ch = guild.channels.cache.find(c => c.name === config.channels.logName && c.type === "GUILD_TEXT");
                if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
            }
        } catch (err) { console.error("❌ [LOG] Critical failure:", err.message); }
    });
}

function buildModerationEmbed(action, moderator, target, reason, durationMins = null) {
    const colorMap = {
        "⚔️  เตะสมาชิก":          "#F59E0B",
        "🔨  แบนสมาชิก":          "#EF4444",
        "⏳  ระงับสิทธิ์ชั่วคราว": "#8B5CF6",
        "✅  ยกเลิกการแบน":        "#10B981",
    };
    const embed = new MessageEmbed()
        .setColor(colorMap[action] || config.system.themeColor)
        .setTitle(`${action}`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 128 }))
        .addFields(
            { name: "🛡️  ผู้ดำเนินการ", value: `${CB}yaml\nUser: ${moderator.tag}\nID  : ${moderator.id}\n${CB}`, inline: false },
            { name: "🎯  เป้าหมาย",     value: `${CB}yaml\nUser: ${target.tag}\nID  : ${target.id}\n${CB}`, inline: false },
            { name: "📋  เหตุผล",        value: `${CB}yaml\n${reason}\n${CB}`,                                  inline: false },
        )
        .setTimestamp();
    if (durationMins !== null) embed.addFields({ name: "⏱️  ระยะเวลา", value: `${CB}yaml\n${durationMins} นาที\n${CB}`, inline: false });
    return embed;
}

async function updatePanel() {
    if (isUpdatingPanel || panelMessages.size === 0) return;
    isUpdatingPanel = true;
    try {
        const embed = getPanelEmbed();
        const row = getPanelRow();
        for (const [channelId, msg] of panelMessages) {
            try {
                await msg.edit({ embeds: [embed], components: [row] });
                await new Promise(r => setTimeout(r, 600));
            } catch (err) {
                if (err.code === 10008 || err.code === 10003 || err.code === 50013) panelMessages.delete(channelId);
            }
        }
    } finally { isUpdatingPanel = false; }
}

async function handleMessage(msg) {
    try {
        if (!msg.guild || msg.author.bot || !msg.content.startsWith("p.")) return;
        if (!msg.member?.roles.cache.has(config.roles.admin)) return;

        const args = msg.content.slice(2).trim().split(/ +/);
        const cmd = args.shift()?.toLowerCase();
        const target = msg.mentions.members.first();

        switch (cmd) {
            case "clear": {
                const amount = parseInt(args[0]);
                if (!amount || amount < 1 || amount > 100) return msg.reply(`> ${config.emojis.no_entry}  กรุณาระบุจำนวนข้อความ 1–100`);
                await msg.delete().catch(() => {});
                const deleted = await msg.channel.bulkDelete(amount, true).catch(() => null);
                const m = await msg.channel.send(`> ${config.emojis.trash}  ลบข้อความสำเร็จ ${deleted?.size || amount} รายการ`);
                setTimeout(() => m.delete().catch(() => {}), 3000);
                break;
            }
            case "say":
                if (!args.length) return msg.reply(`> ${config.emojis.no_entry}  กรุณาระบุข้อความ`);
                await msg.delete().catch(() => {});
                await msg.channel.send({
                    content: args.join(" "),
                    allowedMentions: { parse: [], users: [] }
                });
                break;
            case "announce":
                if (!args.length) return msg.reply(`> ${config.emojis.no_entry}  กรุณาระบุเนื้อหาประกาศ`);
                await msg.delete().catch(() => {});
                await msg.channel.send({ embeds:[new MessageEmbed().setColor(config.system.themeColor).setTitle(`${config.emojis.announce}  ประกาศจากผู้ดูแลระบบ`).setDescription("> **ประกาศสำคัญ**\n\n" + args.join(" ")).setFooter({ text: `ประกาศโดย ${msg.author.tag}` }).setTimestamp()] });
                break;
            case "lock":
            case "unlock":
                await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SEND_MESSAGES: cmd === "unlock" ? null : false });
                await msg.reply(cmd === "unlock" ? `> ${config.emojis.shield}  ปลดล็อกช่องแล้ว` : `> ${config.emojis.lock}  ล็อกช่องแล้ว`);
                break;
            case "kick": {
                if (!target) return msg.reply(`> ${config.emojis.no_entry}  กรุณาระบุสมาชิกด้วย @mention`);
                const reason = args.slice(1).join(" ") || "ไม่ระบุเหตุผล";
                if (!target.kickable) return msg.reply(`> ${config.emojis.warning} บอทไม่มีสิทธิ์เตะคนนี้`);
                await target.kick(reason);
                await msg.reply(`> ${config.emojis.sword}  เตะสมาชิก \`${target.user.tag}\` แล้ว`);
                sendLog(msg.guild, buildModerationEmbed("⚔️  เตะสมาชิก", msg.author, target.user, reason));
                break;
            }
            case "ban": {
                if (!target) return msg.reply(`> ${config.emojis.no_entry}  กรุณาระบุสมาชิกด้วย @mention`);
                const reason = args.slice(1).join(" ") || "ไม่ระบุเหตุผล";
                if (!target.bannable) return msg.reply(`> ${config.emojis.warning} บอทไม่มีสิทธิ์แบนคนนี้`);
                await target.ban({ reason });
                await msg.reply(`> ${config.emojis.hammer}  แบนสมาชิก \`${target.user.tag}\` แล้ว`);
                sendLog(msg.guild, buildModerationEmbed("🔨  แบนสมาชิก", msg.author, target.user, reason));
                break;
            }
            case "timeout": {
                const mins = parseInt(args[1]);
                if (!target || !mins || mins < 1) return msg.reply(`> ${config.emojis.no_entry}  กรุณาระบุสมาชิกและจำนวนนาที`);
                const reason = args.slice(2).join(" ") || "ไม่ระบุเหตุผล";
                if (!target.manageable) return msg.reply(`> ${config.emojis.warning} บอทไม่มีสิทธิ์ทำโทษคนนี้`);
                await target.timeout(mins * 60000);
                await msg.reply(`> ${config.emojis.timer}  ระงับสิทธิ์ \`${target.user.tag}\` ${mins} นาทีแล้ว`);
                sendLog(msg.guild, buildModerationEmbed("⏳  ระงับสิทธิ์ชั่วคราว", msg.author, target.user, reason, mins));
                break;
            }
            case "unban": {
                if (!args[0]) return msg.reply(`> ${config.emojis.no_entry}  กรุณาระบุ User ID`);
                await msg.guild.members.unban(args[0]);
                await msg.reply(`> ${config.emojis.success}  ยกเลิกการแบนสำเร็จ`);
                sendLog(msg.guild, new MessageEmbed()
                    .setColor("#10B981")
                    .setTitle(`${config.emojis.success}  ยกเลิกการแบน`)
                    .addFields(
                        { name: "👤  ผู้ดำเนินการ", value: `${CB}yaml\nUser: ${msg.author.tag}\nID: ${msg.author.id}\n${CB}`, inline: false },
                        { name: "🆔  User ที่ถูกปลดแบน", value: `${CB}yaml\nUser ID: ${args[0]}\n${CB}`, inline: false }
                    ).setTimestamp());
                break;
            }
            case "panel": {
                const old = panelMessages.get(msg.channel.id);
                if (old) await old.delete().catch(() => {});
                const panel = await msg.channel.send({ embeds: [getPanelEmbed()], components:[getPanelRow()] });
                panelMessages.set(msg.channel.id, panel);
                await msg.delete().catch(() => {});
                break;
            }
            case "help":
                await msg.reply({ embeds: [getHelpPages()[0]], components: [getHelpRow(0)], allowedMentions: { repliedUser: false } });
                break;
            case "setup-log":
                if (msg.guild.channels.cache.find(c => c.name === config.channels.logName)) return msg.reply(`> ${config.emojis.fail}  มีห้อง Log อยู่แล้ว`);
                await msg.guild.channels.create(config.channels.logName, { type: "GUILD_TEXT" });
                await msg.reply(`> ${config.emojis.success}  สร้างห้อง Log สำเร็จ`);
                break;
            case "userinfo": {
                const u = target?.user || msg.author;
                await msg.reply({ embeds:[new MessageEmbed().setTitle(`${config.emojis.user}  ข้อมูลสมาชิก`).setColor(config.system.themeColor).setDescription(`${CB}yaml\nUsername : ${u.tag}\nUser ID  : ${u.id}\nCreated  : ${u.createdAt.toLocaleDateString("th-TH")}\n${CB}`).setThumbnail(u.displayAvatarURL({ dynamic: true, size: 256 })).setTimestamp()] });
                break;
            }
            case "serverinfo":
                await msg.reply({ embeds:[new MessageEmbed().setTitle(`${config.emojis.globe}  ข้อมูลเซิร์ฟเวอร์`).setColor(config.system.themeColor).setDescription(`${CB}yaml\nServer Name : ${msg.guild.name}\nServer ID   : ${msg.guild.id}\nMembers     : ${msg.guild.memberCount}\nCreated     : ${msg.guild.createdAt.toLocaleDateString("th-TH")}\n${CB}`).setTimestamp()] });
                break;
            case "stats": {
                const report = sessionManager.systemMetrics.getReport();
                await msg.reply({ embeds:[new MessageEmbed().setTitle(`${config.emojis.chart}  System Analytics`).setColor(config.system.themeColor).setDescription(`${CB}yaml\nSessions Started : ${report.sessionsStarted}\nFailed Attempts  : ${report.sessionsFailed}\nSuccess Rate     : ${report.successRate}\nTotal Reconnects : ${report.reconnects}\nSystem Uptime    : ${report.uptimeHours} hours\n${CB}`).setTimestamp()] });
                break;
            }
        }
    } catch (err) { console.error("❌ [COMMAND] Error:", err.message); }
}

async function handleInteraction(interaction) {
    try {
        if (!interaction.guild) return;

        const isAdmin = interaction.member.roles.cache.has(config.roles.admin) || interaction.member.permissions.has("ADMINISTRATOR");
        const hasAccess = isAdmin || interaction.member.roles.cache.has(config.roles.user);

        if (interaction.isCommand()) {
            const adminCmds = ["clear", "voice", "backup", "steal", "panel", "kick", "ban", "timeout", "say", "announce", "lock", "unlock", "setup-log", "unban"];
            if (adminCmds.includes(interaction.commandName) && !isAdmin) {
                return interaction.reply({ content: `> ${config.emojis.no_entry} คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้`, ephemeral: true });
            }

            const cmd = interaction.commandName;

            switch (cmd) {
                case "panel": {
                    const old = panelMessages.get(interaction.channelId);
                    if (old) await old.delete().catch(() => {});
                    const panel = await interaction.channel.send({ embeds: [getPanelEmbed()], components: [getPanelRow()] });
                    panelMessages.set(interaction.channelId, panel);
                    return interaction.reply({ content: `> ${config.emojis.success} เรียกแผงควบคุมสำเร็จ`, ephemeral: true });
                }
                case "help":
                    return interaction.reply({ embeds: [getHelpPages()[0]], components: [getHelpRow(0)], ephemeral: true });

                case "stats": {
                    const report = sessionManager.systemMetrics.getReport();
                    return interaction.reply({ embeds: [new MessageEmbed().setTitle(`${config.emojis.chart}  System Analytics`).setColor(config.system.themeColor).setDescription(`${CB}yaml\nSessions Started : ${report.sessionsStarted}\nFailed Attempts  : ${report.sessionsFailed}\nSuccess Rate     : ${report.successRate}\nTotal Reconnects : ${report.reconnects}\nSystem Uptime    : ${report.uptimeHours} hours\n${CB}`).setTimestamp()], ephemeral: true });
                }
                case "serverinfo":
                    return interaction.reply({ embeds: [new MessageEmbed().setTitle(`${config.emojis.globe}  ข้อมูลเซิร์ฟเวอร์`).setColor(config.system.themeColor).setDescription(`${CB}yaml\nServer Name : ${interaction.guild.name}\nServer ID   : ${interaction.guild.id}\nMembers     : ${interaction.guild.memberCount}\nCreated     : ${interaction.guild.createdAt.toLocaleDateString("th-TH")}\n${CB}`).setTimestamp()], ephemeral: true });

                case "userinfo": {
                    const member = interaction.options.getMember("member");
                    const u = member?.user || interaction.user;
                    return interaction.reply({ embeds: [new MessageEmbed().setTitle(`${config.emojis.user}  ข้อมูลสมาชิก`).setColor(config.system.themeColor).setDescription(`${CB}yaml\nUsername : ${u.tag}\nUser ID  : ${u.id}\nCreated  : ${u.createdAt.toLocaleDateString("th-TH")}\n${CB}`).setThumbnail(u.displayAvatarURL({ dynamic: true, size: 256 })).setTimestamp()], ephemeral: true });
                }
                case "clear": {
                    const amount = interaction.options.getInteger("amount");
                    if (amount < 1 || amount > 100) return interaction.reply({ content: `> ${config.emojis.no_entry} จำนวนต้องอยู่ระหว่าง 1-100`, ephemeral: true });
                    if (!interaction.guild.me.permissions.has("MANAGE_MESSAGES")) return interaction.reply({ content: `> ${config.emojis.no_entry} บอทไม่มีสิทธิ์ Manage Messages`, ephemeral: true });
                    await interaction.deferReply({ ephemeral: true });
                    const deleted = await interaction.channel.bulkDelete(amount, true).catch(() => null);
                    return interaction.editReply({ content: `> ${config.emojis.trash}  ลบข้อความสำเร็จ ${deleted?.size || amount} รายการ` });
                }
                case "say": {
                    const text = interaction.options.getString("message");
                    await interaction.channel.send({
                        content: text,
                        allowedMentions: { parse: [], users: [] }
                    });
                    return interaction.reply({ content: `> ${config.emojis.success}  ส่งข้อความสำเร็จ`, ephemeral: true });
                }
                case "announce": {
                    const text = interaction.options.getString("message");
                    await interaction.channel.send({ embeds: [new MessageEmbed().setColor(config.system.themeColor).setTitle(`${config.emojis.announce}  ประกาศจากผู้ดูแลระบบ`).setDescription("> **ประกาศสำคัญ**\n\n" + text).setFooter({ text: `ประกาศโดย ${interaction.user.tag}` }).setTimestamp()] });
                    return interaction.reply({ content: `> ${config.emojis.success}  เผยแพร่ประกาศสำเร็จ`, ephemeral: true });
                }
                case "lock":
                case "unlock": {
                    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SEND_MESSAGES: cmd === "unlock" ? null : false });
                    return interaction.reply({ content: cmd === "unlock" ? `> ${config.emojis.shield}  ปลดล็อกช่องแล้ว` : `> ${config.emojis.lock}  ล็อกช่องแล้ว`, ephemeral: true });
                }
                case "kick": {
                    const member = interaction.options.getMember("member");
                    const reason = interaction.options.getString("reason") || "ไม่ระบุเหตุผล";
                    if (!member) return interaction.reply({ content: `> ${config.emojis.no_entry}  ไม่พบสมาชิก`, ephemeral: true });
                    if (!member.kickable) return interaction.reply({ content: `> ${config.emojis.warning} บอทไม่มีสิทธิ์เตะคนนี้`, ephemeral: true });
                    await member.kick(reason);
                    await interaction.reply({ content: `> ${config.emojis.sword}  เตะสมาชิก \`${member.user.tag}\` แล้ว`, ephemeral: true });
                    sendLog(interaction.guild, buildModerationEmbed("⚔️  เตะสมาชิก", interaction.user, member.user, reason));
                    return;
                }
                case "ban": {
                    const member = interaction.options.getMember("member");
                    const reason = interaction.options.getString("reason") || "ไม่ระบุเหตุผล";
                    if (!member) return interaction.reply({ content: `> ${config.emojis.no_entry}  ไม่พบสมาชิก`, ephemeral: true });
                    if (!member.bannable) return interaction.reply({ content: `> ${config.emojis.warning} บอทไม่มีสิทธิ์แบนคนนี้`, ephemeral: true });
                    await member.ban({ reason });
                    await interaction.reply({ content: `> ${config.emojis.hammer}  แบนสมาชิก \`${member.user.tag}\` แล้ว`, ephemeral: true });
                    sendLog(interaction.guild, buildModerationEmbed("🔨  แบนสมาชิก", interaction.user, member.user, reason));
                    return;
                }
                case "unban": {
                    const userId = interaction.options.getString("userid");
                    await interaction.guild.members.unban(userId).catch(() => { throw new Error("NOT_FOUND"); });
                    await interaction.reply({ content: `> ${config.emojis.success}  ยกเลิกการแบนสำเร็จ`, ephemeral: true });
                    sendLog(interaction.guild, new MessageEmbed()
                        .setColor("#10B981")
                        .setTitle(`${config.emojis.success}  ยกเลิกการแบน`)
                        .addFields(
                            { name: "🛡️  ผู้ดำเนินการ", value: `${CB}yaml\nUser: ${interaction.user.tag}\nID  : ${interaction.user.id}\n${CB}`, inline: false },
                            { name: "🆔  User ที่ถูกปลดแบน", value: `${CB}yaml\nUser ID: ${userId}\n${CB}`, inline: false }
                        ).setTimestamp());
                    return;
                }
                case "timeout": {
                    const member = interaction.options.getMember("member");
                    const mins = interaction.options.getInteger("minutes");
                    const reason = interaction.options.getString("reason") || "ไม่ระบุเหตุผล";
                    if (!member) return interaction.reply({ content: `> ${config.emojis.no_entry}  ไม่พบสมาชิก`, ephemeral: true });
                    if (!member.manageable) return interaction.reply({ content: `> ${config.emojis.warning} บอทไม่มีสิทธิ์ลงโทษคนนี้`, ephemeral: true });
                    await member.timeout(mins * 60000);
                    await interaction.reply({ content: `> ${config.emojis.timer}  ระงับสิทธิ์ \`${member.user.tag}\` ${mins} นาทีแล้ว`, ephemeral: true });
                    sendLog(interaction.guild, buildModerationEmbed("⏳  ระงับสิทธิ์ชั่วคราว", interaction.user, member.user, reason, mins));
                    return;
                }
                case "setup-log": {
                    if (interaction.guild.channels.cache.find(c => c.name === config.channels.logName))
                        return interaction.reply({ content: `> ${config.emojis.fail}  มีห้อง Log อยู่แล้ว`, ephemeral: true });
                    await interaction.guild.channels.create(config.channels.logName, { type: "GUILD_TEXT" });
                    return interaction.reply({ content: `> ${config.emojis.success}  สร้างห้อง Log สำเร็จ`, ephemeral: true });
                }
                case "enlarge": {
                    const emoji = interaction.options.getString("emoji");
                    const parsed = emoji.match(/<a?:.+:(\d+)>/);
                    if (!parsed) return interaction.reply({ content: `> ${config.emojis.warning} ไม่พบรหัสอิโมจิ`, ephemeral: true });
                    const ext = emoji.startsWith("<a:") ? "gif" : "png";
                    return interaction.reply({ content: `https://cdn.discordapp.com/emojis/${parsed[1]}.${ext}?v=1` });
                }
                case "snipe": {
                    const msg = snipes.get(interaction.channel.id);
                    if (!msg) return interaction.reply({ content: `> ${config.emojis.warning} ไม่มีข้อความที่เพิ่งลบในช่องนี้`, ephemeral: true });
                    const embed = new MessageEmbed()
                        .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
                        .setDescription(msg.content || "*ไม่มีข้อความ (อาจเป็นรูปภาพ)*").setColor(config.system.themeColor);
                    return interaction.reply({ embeds: [embed] });
                }
                case "voice": {
                    const vc = interaction.member.voice.channel;
                    if (!vc) return interaction.reply({ content: `> ${config.emojis.warning} เข้าห้องเสียงก่อนใช้งานคำสั่งนี้`, ephemeral: true });
                    const sub = interaction.options.getSubcommand();
                    
                    if (sub === "lock") await vc.permissionOverwrites.edit(interaction.guild.roles.everyone, { CONNECT: false });
                    if (sub === "hide") await vc.permissionOverwrites.edit(interaction.guild.roles.everyone, { VIEW_CHANNEL: false });
                    if (sub === "kickall") for (const [, m] of vc.members) await m.voice.disconnect().catch(()=>{});
                    return interaction.reply({ content: `> ${config.emojis.shield} จัดการห้องเสียง ${vc.name} เรียบร้อย` });
                }
                case "backup": {
                    await interaction.deferReply({ ephemeral: true });
                    const snapshot = {
                        channels: interaction.guild.channels.cache.map(c => ({ name: c.name, type: c.type })),
                        roles: interaction.guild.roles.cache.map(r => ({ name: r.name, perms: r.permissions.bitfield.toString() }))
                    };
                    const id = await sessionManager.saveSnapshot(interaction.guild.id, snapshot);
                    return interaction.editReply({ content: `> ${config.emojis.save} บันทึก Snapshot สำเร็จ! (ID: \`${id}\`)` });
                }
                default:
                    return interaction.reply({ content: `> ${config.emojis.no_entry}  ไม่รู้จักคำสั่งนี้`, ephemeral: true });
            }
        }

        if (interaction.isMessageContextMenu()) {
            if (!isAdmin) return interaction.reply({ content: `> ${config.emojis.no_entry} เฉพาะผู้ดูแลระบบ`, ephemeral: true });
            const msg = interaction.targetMessage;

            if (interaction.commandName === "🗑️ ลบข้อความนี้") {
                await msg.delete().catch(()=>{});
                return interaction.reply({ content: `> ${config.emojis.trash} ลบข้อความด่วนสำเร็จ`, ephemeral: true });
            }
            else if (interaction.commandName === "📝 บันทึกข้อมูล") {
                const embed = new MessageEmbed().setColor(config.system.themeColor)
                    .setTitle(`${config.emojis.clipboard} Saved Log`)
                    .setDescription(`**User:** ${msg.author.tag}\n**Content:**\n${CB}text\n${msg.content}\n${CB}`);
                sendLog(interaction.client, embed);
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
        }
        
        if (interaction.isUserContextMenu()) {
            if (!isAdmin) return interaction.reply({ content: `> ${config.emojis.no_entry} เฉพาะผู้ดูแลระบบ`, ephemeral: true });
            const target = interaction.targetUser;
            const modal = new Modal().setCustomId(`mod_${target.id}`).setTitle(`ลงโทษ: ${target.username.slice(0, 30)}`);
            modal.addComponents(new MessageActionRow().addComponents(new TextInputComponent().setCustomId("reason").setLabel("พิมพ์ kick / ban / timeout").setStyle("SHORT")));
            return interaction.showModal(modal);
        }

        if (interaction.isButton() || interaction.isSelectMenu() || interaction.isModalSubmit()) {
            if (!interaction.customId.startsWith("help_") && !hasAccess) {
                return interaction.reply({ content: `> ${config.emojis.no_entry}  คุณไม่มีสิทธิ์ใช้งานฟังก์ชันนี้`, ephemeral: true });
            }
            if (!sessionManager.actionLimiter.canRequest(interaction.user.id, interaction.guild.id)) {
                return interaction.reply({ content: `> ${config.emojis.warning}  คุณใช้งานบ่อยเกินไป กรุณารอสักครู่`, ephemeral: true });
            }
        }

        if (interaction.isButton()) {
            const PANEL_BTNS =["btn_start", "btn_status", "btn_stop"];
            if (PANEL_BTNS.includes(interaction.customId) && !panelMessages.has(interaction.channelId)) {
                panelMessages.set(interaction.channelId, interaction.message);
            }

            if (interaction.customId.startsWith("help_")) {
                const parts = interaction.customId.split("_");
                const newPage = parts[1] === "prev" ? parseInt(parts[2]) - 1 : parseInt(parts[2]) + 1;
                if (newPage >= 0 && newPage <= 2) return interaction.update({ embeds: [getHelpPages()[newPage]], components: [getHelpRow(newPage)] });
            }

            if (interaction.customId === "btn_start") {
                const modal = new Modal().setCustomId("setup_modal").setTitle("⚙️ เริ่มระบบออนช่องเสียง");
                modal.addComponents(
                    new MessageActionRow().addComponents(new TextInputComponent().setCustomId("token").setLabel("🔑  Token ของบัญชี").setStyle("SHORT").setRequired(true)),
                    new MessageActionRow().addComponents(new TextInputComponent().setCustomId("server").setLabel("🌐  Server ID (ไม่บังคับ)").setStyle("SHORT").setRequired(false)),
                    new MessageActionRow().addComponents(new TextInputComponent().setCustomId("voice").setLabel("🔊  Voice Channel ID").setStyle("SHORT").setRequired(true))
                );
                return interaction.showModal(modal);
            }

            if (interaction.customId === "btn_stop") {
                const modal = new Modal().setCustomId("modal_stop").setTitle("หยุดการทำงาน");
                modal.addComponents(new MessageActionRow().addComponents(new TextInputComponent().setCustomId("tail").setLabel("Token 8 ตัวท้าย").setStyle("SHORT").setRequired(true)));
                return interaction.showModal(modal);
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith("mod_")) {
                const targetId = interaction.customId.split("_")[1];
                const action = interaction.fields.getTextInputValue("reason").toLowerCase();
                const member = await interaction.guild.members.fetch(targetId).catch(()=>{});
                if (!member) return interaction.reply({ content: `> ${config.emojis.no_entry} หาคนไม่เจอ`, ephemeral: true });
                try {
                    if (action.includes("ban")) { await member.ban(); return interaction.reply({ content: `> ${config.emojis.hammer} แบนสำเร็จ` }); }
                    else if (action.includes("kick")) { await member.kick(); return interaction.reply({ content: `> ${config.emojis.sword} เตะสำเร็จ` }); }
                    else { await member.timeout(300000); return interaction.reply({ content: `> ${config.emojis.timer} ใบ้ 5 นาที` }); }
                } catch(e) { return interaction.reply({ content: `> ${config.emojis.warning} บอทสิทธิ์ไม่ถึง`, ephemeral: true }); }
            }

            if (interaction.customId === "setup_modal") {
                if (sessionManager.getAllSessions().size >= config.limits.maxSessions) {
                    return interaction.reply({ content: `> ${config.emojis.no_entry}  ถึงขีดจำกัด ${config.limits.maxSessions} เซสชัน`, ephemeral: true });
                }
                
                await interaction.deferReply({ ephemeral: true });
                const token = interaction.fields.getTextInputValue("token").trim();
                const serverId = interaction.fields.getTextInputValue("server").trim() || interaction.guild.id;
                const voiceId = interaction.fields.getTextInputValue("voice").trim();

                try {
                    await voiceWorker.startSession(token, serverId, voiceId);
                    sendLog(interaction.guild, new MessageEmbed().setColor(config.system.themeColor).setTitle(`${config.emojis.signal}  เซสชันใหม่เริ่มทำงาน`).setDescription("> **สถานะ**: กำลังเชื่อมต่อห้องเสียง").addFields({ name: "👤  ผู้ดำเนินการ", value: `${CB}yaml\nUser: ${interaction.user.tag}\nID: ${interaction.user.id}\n${CB}`, inline: false }, { name: "🌐  ข้อมูลการเชื่อมต่อ", value: `${CB}yaml\nServer ID: ${serverId}\nVoice ID: ${voiceId}\n${CB}`, inline: false }).setTimestamp());
                    await updatePanel();
                    return interaction.editReply({ content: `> ${config.emojis.signal}  เริ่มเซสชันสำเร็จ — กำลังเชื่อมต่อระบบออนช่องเสียง` });
                } catch (err) {
                    const errMsg = {
                        INVALID_TOKEN_FORMAT: `> ${config.emojis.no_entry}  รูปแบบ Token ไม่ถูกต้อง`,
                        SESSION_EXISTS: `> ${config.emojis.no_entry}  เซสชันนี้มีอยู่แล้วในระบบ`,
                        LOGIN_FAIL: `> ${config.emojis.fail}  Token ไม่ถูกต้อง หรือบัญชีถูกระงับ`,
                        LOGIN_TIMEOUT: `> ${config.emojis.hourglass}  หมดเวลาการเชื่อมต่อ — กรุณาลองใหม่อีกครั้ง`,
                        VOICE_NOT_FOUND: `> ${config.emojis.warning}  ไม่พบช่องเสียง หรือบอทไม่มีสิทธิ์เข้าห้อง`,
                    }[err.message] ?? `> ${config.emojis.warning}  เกิดข้อผิดพลาดที่ไม่คาดคิด: ${err.message}`;
                    return interaction.editReply({ content: errMsg });
                }
            }

            if (interaction.customId === "modal_stop") {
                await interaction.deferReply({ ephemeral: true });
                const tail = interaction.fields.getTextInputValue("tail").trim();
                const sid = `${tail}_${interaction.guild.id}`;
                if (!sessionManager.getSession(sid)) return interaction.editReply({ content: `> ${config.emojis.warning}  ไม่พบเซสชันของคุณ` });
                
                await voiceWorker.stopSession(sid);
                await updatePanel();
                return interaction.editReply({ content: `> ${config.emojis.stop}  ปิดระบบเรียบร้อย` });
            }
        }
    } catch (err) {
        console.error(`[SLASH] Error in /${interaction.commandName || 'interaction'}:`, err.message);
        const reply = { content: err.message === "NOT_FOUND" ? `> ${config.emojis.no_entry}  ไม่พบผู้ใช้นี้ในระบบ` : `> ${config.emojis.warning}  เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง`, ephemeral: true };
        if (interaction.deferred) return interaction.editReply(reply).catch(() => {});
        if (!interaction.replied) return interaction.reply(reply).catch(() => {});
    }
}

module.exports = { handleMessage, handleInteraction, updatePanel, slashCommandsData, getPanelMessages, snipes };
