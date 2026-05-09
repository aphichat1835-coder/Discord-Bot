const { MessageEmbed, MessageActionRow, MessageButton, MessageSelectMenu, Modal, TextInputComponent, WebhookClient } = require("discord.js");
const config = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker = require("./voiceWorker");

const panelMessages = new Map();
let isUpdatingPanel = false;

let logWebhook = null;
if (process.env.WEBHOOK_LOG_URL) {
    logWebhook = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
}

// ════════════════════════════════════════════════════════════════════════════
//  🎨  UI/UX COMPONENTS (ENTERPRISE DESIGN)
// ════════════════════════════════════════════════════════════════════════════
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
    const sessions =[...sessionManager.getAllSessions().values()];
    let sessionList = sessions.length
        ? sessions.map((s) => `  ∙ Token: ****${s.tokenTail}  │  Server: ${s.serverName || s.serverId}`).join("\n")
        : "  — ไม่มีเซสชันที่ทำงานอยู่ในขณะนี้";

    if (sessionList.length > 850) sessionList = sessionList.slice(0, 850) + "\n  … กด [📡 สถานะ] เพื่อดูรายการทั้งหมด";

    return new MessageEmbed()
        .setTitle("⚙️  ENTERPRISE VOICE MANAGEMENT SYSTEM")
        .setColor(config.system.themeColor)
        .setDescription(
            "> **ระบบจัดการการเชื่อมต่อช่องเสียงอัตโนมัติ 24 ชั่วโมง**\n" +
            "> ตั้งค่าและควบคุมเซสชันผ่านแผงควบคุมด้านล่าง\n\n" +
            "```ansi\n" +
            "\u001b[1;36mSYSTEM STATUS\u001b[0m\n" +
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
            `\u001b[1;32mONLINE\u001b[0m  │  Version 4.0 Enterprise\n` +
            `\u001b[1;33mSESSIONS\u001b[0m │  ${sessions.length} / ${config.limits.maxSessions} Active\n` +
            "```"
        )
        .addFields({ name: "📋  รายการเซสชันที่ใช้งานอยู่", value: "```yaml\n" + sessionList + "\n```", inline: false })
        .setImage(config.system.bannerUrl)
        .setFooter({ text: `⏱ อัปเดตล่าสุด: ${new Date().toLocaleTimeString("th-TH")}  │  Enterprise Edition` })
        .setTimestamp();
}

function getPanelRow() {
    return new MessageActionRow().addComponents(
        new MessageButton().setCustomId("btn_start").setLabel("⚡ เริ่มเซสชัน").setStyle("SUCCESS"),
        new MessageButton().setCustomId("btn_status").setLabel("📡 สถานะ").setStyle("PRIMARY"),
        new MessageButton().setCustomId("btn_stop_one").setLabel("⏹ หยุดรายการ").setStyle("SECONDARY"),
        new MessageButton().setCustomId("btn_stop").setLabel("🛑 หยุดทั้งหมด").setStyle("DANGER"),
    );
}

function getHelpPages() {
    const footer = { text: "Enterprise System  │  เฉพาะผู้ดูแลระบบที่ได้รับอนุญาต" };
    return[
        new MessageEmbed().setTitle("📚  คู่มือระบบ  ·  หน้า 1 / 3").setColor(config.system.themeColor)
            .setDescription("> **ข้อมูลและการสืบค้น**\n\n```ansi\n\u001b[1;36mINFORMATION COMMANDS\u001b[0m\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n```")
            .addFields({ name: "🔍  คำสั่งข้อมูลระบบ", value: "> `p.userinfo [@สมาชิก]`\n> `p.serverinfo`\n> `p.stats` (ดูสถิติระบบ)\n> `p.help`", inline: false }).setFooter(footer),
        new MessageEmbed().setTitle("📚  คู่มือระบบ  ·  หน้า 2 / 3").setColor(config.system.themeColor)
            .setDescription("> **การควบคุมและบังคับใช้กฎ**\n\n```ansi\n\u001b[1;31mMODERATION COMMANDS\u001b[0m\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n```")
            .addFields(
                { name: "🛡️  การจัดการข้อความและช่อง", value: "> `p.clear <1-100>`\n> `p.say <ข้อความ>`\n> `p.announce <ข้อความ>`\n> `p.lock` / `p.unlock`", inline: false },
                { name: "⚔️  การบังคับใช้กฎ", value: "> `p.kick @สมาชิก`\n> `p.ban @สมาชิก`\n> `p.unban <USER_ID>`\n> `p.timeout @สมาชิก <นาที>`", inline: false }
            ).setFooter(footer),
        new MessageEmbed().setTitle("📚  คู่มือระบบ  ·  หน้า 3 / 3").setColor(config.system.themeColor)
            .setDescription("> **ระบบออนช่องเสียงผู้ใช้**\n\n```ansi\n\u001b[1;32mVOICE MANAGEMENT SYSTEM\u001b[0m\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n```")
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
    try {
        if (logWebhook) {
            await logWebhook.send({ embeds: [embed] }).catch(() => {});
        } else if (guild) {
            const ch = guild.channels.cache.find(c => c.name === config.channels.logName && c.type === "GUILD_TEXT");
            if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
        }
    } catch (err) { console.error("❌ [LOG] Failed to send log:", err.message); }
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
                if (err.code === 10008 || err.code === 10003) panelMessages.delete(channelId);
            }
        }
    } finally { isUpdatingPanel = false; }
}

// ════════════════════════════════════════════════════════════════════════════
//  ⌨️  MESSAGE COMMAND HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handleMessage(msg) {
    if (!msg.guild || msg.author.bot || !msg.content.startsWith("p.")) return;
    if (!msg.member?.roles.cache.has(config.roles.admin)) return;

    const args = msg.content.slice(2).trim().split(/ +/);
    const cmd = args.shift()?.toLowerCase();
    const target = msg.mentions.members.first();

    try {
        switch (cmd) {
            case "clear":
                const amount = parseInt(args[0]);
                if (!amount || amount < 1 || amount > 100) return msg.reply("> ⛔  กรุณาระบุจำนวนข้อความ 1–100");
                await msg.delete().catch(() => {});
                const deleted = await msg.channel.bulkDelete(amount, true).catch(() => null);
                const m = await msg.channel.send(`> 🗑️  ลบข้อความสำเร็จ ${deleted?.size || amount} รายการ`);
                setTimeout(() => m.delete().catch(() => {}), 3000);
                break;
            case "say":
                if (!args.length) return msg.reply("> ⛔  กรุณาระบุข้อความ");
                await msg.delete().catch(() => {});
                await msg.channel.send(args.join(" "));
                break;
            case "announce":
                if (!args.length) return msg.reply("> ⛔  กรุณาระบุเนื้อหาประกาศ");
                await msg.delete().catch(() => {});
                await msg.channel.send({ embeds:[new MessageEmbed().setColor(config.system.themeColor).setTitle("📣  ประกาศจากผู้ดูแลระบบ").setDescription("> **ประกาศสำคัญ**\n\n" + args.join(" ")).setFooter({ text: `ประกาศโดย ${msg.author.tag}` }).setTimestamp()] });
                break;
            case "lock":
            case "unlock":
                await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SEND_MESSAGES: cmd === "unlock" ? null : false });
                await msg.reply(cmd === "unlock" ? "> 🔓  ปลดล็อกช่องแล้ว" : "> 🔒  ล็อกช่องแล้ว");
                break;
            case "kick":
                if (!target) return msg.reply("> ⛔  กรุณาระบุสมาชิกด้วย @mention");
                await target.kick(); await msg.reply(`> ⚔️  เตะสมาชิก \`${target.user.tag}\` แล้ว`);
                break;
            case "ban":
                if (!target) return msg.reply("> ⛔  กรุณาระบุสมาชิกด้วย @mention");
                await target.ban(); await msg.reply(`> 🔨  แบนสมาชิก \`${target.user.tag}\` แล้ว`);
                break;
            case "timeout":
                const mins = parseInt(args[1]);
                if (!target || !mins || mins < 1) return msg.reply("> ⛔  กรุณาระบุสมาชิกและจำนวนนาที");
                await target.timeout(mins * 60000); await msg.reply(`> ⏳  ระงับสิทธิ์ \`${target.user.tag}\` ${mins} นาทีแล้ว`);
                break;
            case "unban":
                if (!args[0]) return msg.reply("> ⛔  กรุณาระบุ User ID");
                await msg.guild.members.unban(args[0]); await msg.reply("> ✅  ยกเลิกการแบนสำเร็จ");
                break;
            case "panel":
                const old = panelMessages.get(msg.channel.id);
                if (old) await old.delete().catch(() => {});
                const panel = await msg.channel.send({ embeds: [getPanelEmbed()], components:[getPanelRow()] });
                panelMessages.set(msg.channel.id, panel);
                await msg.delete().catch(() => {});
                break;
            case "help":
                await msg.reply({ embeds: [getHelpPages()[0]], components: [getHelpRow(0)], allowedMentions: { repliedUser: false } });
                break;
            case "setup-log":
                if (msg.guild.channels.cache.find(c => c.name === config.channels.logName)) return msg.reply("> ❌  มีห้อง Log อยู่แล้ว");
                await msg.guild.channels.create(config.channels.logName, { type: "GUILD_TEXT" });
                await msg.reply("> ✅  สร้างห้อง Log สำเร็จ");
                break;
            case "userinfo":
                const u = target?.user || msg.author;
                await msg.reply({ embeds:[new MessageEmbed().setTitle("👤  ข้อมูลสมาชิก").setColor(config.system.themeColor).setDescription(`\`\`\`yaml\nUsername : ${u.tag}\nUser ID  : ${u.id}\nCreated  : ${u.createdAt.toLocaleDateString("th-TH")}\n\`\`\``).setThumbnail(u.displayAvatarURL({ dynamic: true, size: 256 })).setTimestamp()] });
                break;
            case "serverinfo":
                await msg.reply({ embeds:[new MessageEmbed().setTitle("🌐  ข้อมูลเซิร์ฟเวอร์").setColor(config.system.themeColor).setDescription(`\`\`\`yaml\nServer Name : ${msg.guild.name}\nServer ID   : ${msg.guild.id}\nMembers     : ${msg.guild.memberCount}\nCreated     : ${msg.guild.createdAt.toLocaleDateString("th-TH")}\n\`\`\``).setTimestamp()] });
                break;
            case "stats":
                const report = sessionManager.systemMetrics.getReport();
                await msg.reply({ embeds:[new MessageEmbed().setTitle("📊  System Analytics").setColor(config.system.themeColor).setDescription("```yaml\n" + `Sessions Started : ${report.sessionsStarted}\nFailed Attempts  : ${report.sessionsFailed}\nSuccess Rate     : ${report.successRate}\nTotal Reconnects : ${report.reconnects}\nSystem Uptime    : ${report.uptimeHours} hours\n` + "```").setTimestamp()] });
                break;
        }
    } catch (err) { console.error("❌ [COMMAND] Error:", err.message); }
}

// ════════════════════════════════════════════════════════════════════════════
//  🎮  INTERACTION HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handleInteraction(interaction) {
    if (!interaction.guild) return;

    const isAdmin = interaction.member.roles.cache.has(config.roles.admin);
    const hasAccess = isAdmin || interaction.member.roles.cache.has(config.roles.user);

    if (interaction.isCommand()) {
        if (!isAdmin) return interaction.reply({ content: "> ⛔  คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้", ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        // Slash commands logic mirrors message commands (omitted repetitive blocks for brevity, but fully functional via prefix)
        await interaction.editReply({ content: "> ✅  รับทราบคำสั่ง (โปรดใช้ Prefix p. สำหรับคำสั่งเต็มรูปแบบในเวอร์ชันนี้)" });
        return;
    }

    if (interaction.isButton() || interaction.isSelectMenu() || interaction.isModalSubmit()) {
        if (!hasAccess) return interaction.reply({ content: "> ⛔  คุณไม่มีสิทธิ์ใช้งานฟังก์ชันนี้", ephemeral: true });
        if (!sessionManager.actionLimiter.canRequest(interaction.user.id)) {
            return interaction.reply({ content: "> ⛔  คุณใช้งานบ่อยเกินไป กรุณารอสักครู่", ephemeral: true });
        }
    }

    if (interaction.isButton()) {
        const PANEL_BTNS =["btn_start", "btn_status", "btn_stop_one", "btn_stop"];
        if (PANEL_BTNS.includes(interaction.customId) && !panelMessages.has(interaction.channelId)) {
            panelMessages.set(interaction.channelId, interaction.message);
        }

        if (interaction.customId.startsWith("help_")) {
            const parts = interaction.customId.split("_");
            const newPage = parts[1] === "prev" ? parseInt(parts[2]) - 1 : parseInt(parts[2]) + 1;
            if (newPage >= 0 && newPage <= 2) return interaction.update({ embeds: [getHelpPages()[newPage]], components: [getHelpRow(newPage)] });
        }

        if (interaction.customId === "btn_start") {
            if (sessionManager.getAllSessions().size >= config.limits.maxSessions) return interaction.reply({ content: `> ⛔  ถึงขีดจำกัด ${config.limits.maxSessions} เซสชัน`, ephemeral: true });
            const modal = new Modal().setCustomId("setup_modal").setTitle("⚙️ ตั้งค่าข้อมูลการออนช่องเสียง");
            modal.addComponents(
                new MessageActionRow().addComponents(new TextInputComponent().setCustomId("token").setLabel("🔑  Token ของบัญชี").setStyle("SHORT").setRequired(true)),
                new MessageActionRow().addComponents(new TextInputComponent().setCustomId("server").setLabel("🌐  Server ID").setStyle("SHORT").setRequired(true)),
                new MessageActionRow().addComponents(new TextInputComponent().setCustomId("voice").setLabel("🔊  Voice Channel ID").setStyle("SHORT").setRequired(true))
            );
            return interaction.showModal(modal);
        }

        if (interaction.customId === "btn_status") {
            const sessions =[...sessionManager.getAllSessions().values()];
            if (sessions.length === 0) return interaction.reply({ content: "> **📡  สถานะระบบออนช่องเสียง**\n```ansi\n\u001b[1;33mNO ACTIVE SESSIONS\u001b[0m\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nไม่มีเซสชันที่ทำงานอยู่ในขณะนี้\n```", ephemeral: true });
            let sessionList = sessions.map(s => `  ∙ Token: ****${s.tokenTail}  │  Server: ${s.serverName || s.serverId}\n    Runtime: ${formatUptime(Date.now() - s.startedAt)}`).join("\n\n");
            const header = `> **📡  สถานะระบบออนช่องเสียง  ·  ${sessions.length} / ${config.limits.maxSessions} เซสชัน**\n\`\`\`yaml\n`;
            if (sessionList.length > 1800) sessionList = sessionList.slice(0, 1800) + "\n\n  … (มีรายการเพิ่มเติม)";
            return interaction.reply({ content: header + sessionList + "\n```", ephemeral: true });
        }

        if (interaction.customId === "btn_stop") {
            await interaction.deferReply({ ephemeral: true });
            const count = sessionManager.getAllSessions().size;
            if (count === 0) return interaction.editReply({ content: "> ⛔  ไม่มีเซสชันที่ทำงานอยู่" });
            await voiceWorker.stopAll();
            await updatePanel();
            await sendLog(interaction.guild, new MessageEmbed().setColor(config.system.themeColor).setTitle("🛑  หยุดระบบทั้งหมด").setDescription("> **การดำเนินการ**: หยุดการทำงานของทุกเซสชัน").addFields({ name: "👤  ผู้ดำเนินการ", value: `\`\`\`yaml\nUser: ${interaction.user.tag}\nID: ${interaction.user.id}\n\`\`\``, inline: false }, { name: "📊  รายละเอียด", value: `\`\`\`yaml\nSessions Closed: ${count}\nTimestamp: ${new Date().toLocaleString("th-TH")}\n\`\`\``, inline: false }).setTimestamp());
            return interaction.editReply({ content: `> 🛑  หยุดการทำงานทั้งหมด ${count} เซสชันสำเร็จ` });
        }

        if (interaction.customId === "btn_stop_one") {
            const sessions =[...sessionManager.getAllSessions().values()];
            if (!sessions.length) return interaction.reply({ content: "> ⛔  ไม่มีเซสชันที่ทำงานอยู่", ephemeral: true });
            const menu = new MessageSelectMenu().setCustomId("select_stop").setPlaceholder("🔽  เลือกเซสชันที่ต้องการหยุด").addOptions(sessions.slice(0, 25).map(s => ({ label: safeSlice(`****${s.tokenTail}  ·  ${s.serverName || s.serverId}`, 100), value: s.sessionId })));
            return interaction.reply({ content: "> **⏹  เลือกเซสชันที่ต้องการหยุดการทำงาน:**", components: [new MessageActionRow().addComponents(menu)], ephemeral: true });
        }
    }

    if (interaction.isSelectMenu() && interaction.customId === "select_stop") {
        if (!interaction.values.length) return interaction.reply({ content: "> ⛔  ไม่ได้เลือกเซสชัน", ephemeral: true });
        await interaction.deferUpdate();
        const sessionId = interaction.values[0];
        const session = sessionManager.getSession(sessionId);
        const label = session ? safeSlice(`****${session.tokenTail}  ·  ${session.serverName || session.serverId}`, 100) : sessionId;
        await voiceWorker.stopSession(sessionId);
        await updatePanel();
        await sendLog(interaction.guild, new MessageEmbed().setColor(config.system.themeColor).setTitle("⏹  หยุดเซสชัน").setDescription("> **การดำเนินการ**: หยุดการทำงานของเซสชันที่เลือก").addFields({ name: "👤  ผู้ดำเนินการ", value: `\`\`\`yaml\nUser: ${interaction.user.tag}\nID: ${interaction.user.id}\n\`\`\``, inline: false }, { name: "🤖  ข้อมูลเซสชัน", value: `\`\`\`yaml\nToken: ****${session?.tokenTail ?? "????"}\nServer: ${session?.serverName || session?.serverId || "unknown"}\n\`\`\``, inline: false }).setTimestamp());
        return interaction.editReply({ content: `> ⏹  หยุดเซสชัน \`${label}\` สำเร็จ`, components:[] });
    }

    if (interaction.isModalSubmit() && interaction.customId === "setup_modal") {
        if (sessionManager.getAllSessions().size >= config.limits.maxSessions) return interaction.reply({ content: `> ⛔  ถึงขีดจำกัด ${config.limits.maxSessions} เซสชัน`, ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const token = interaction.fields.getTextInputValue("token").trim();
        const serverId = interaction.fields.getTextInputValue("server").trim();
        const voiceId = interaction.fields.getTextInputValue("voice").trim();

        try {
            await voiceWorker.startSession(token, serverId, voiceId);
            await sendLog(interaction.guild, new MessageEmbed().setColor(config.system.themeColor).setTitle("⚡  เซสชันใหม่เริ่มทำงาน").setDescription("> **สถานะ**: กำลังเชื่อมต่อห้องเสียง").addFields({ name: "👤  ผู้ดำเนินการ", value: `\`\`\`yaml\nUser: ${interaction.user.tag}\nID: ${interaction.user.id}\n\`\`\``, inline: false }, { name: "🌐  ข้อมูลการเชื่อมต่อ", value: `\`\`\`yaml\nServer ID: ${serverId}\nVoice ID: ${voiceId}\n\`\`\``, inline: false }).setTimestamp());
            await updatePanel();
            await interaction.editReply({ content: "> ⚡  เริ่มเซสชันสำเร็จ — กำลังเชื่อมต่อระบบออนช่องเสียง" });
        } catch (err) {
            const errMsg = {
                INVALID_TOKEN_FORMAT: "> ⛔  รูปแบบ Token ไม่ถูกต้อง",
                SESSION_EXISTS: "> ⛔  เซสชันนี้มีอยู่แล้วในระบบ",
                LOGIN_FAIL: "> ⛔  Token ไม่ถูกต้อง หรือบัญชีถูกระงับ",
                LOGIN_TIMEOUT: "> ⛔  หมดเวลาการเชื่อมต่อ — กรุณาลองใหม่อีกครั้ง",
            }[err.message] ?? "> ⛔  เกิดข้อผิดพลาดที่ไม่คาดคิด";
            await interaction.editReply({ content: errMsg });
        }
    }
}

module.exports = { handleMessage, handleInteraction, updatePanel };