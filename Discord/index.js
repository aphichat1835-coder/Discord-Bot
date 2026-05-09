// ════════════════════════════════════════════════════════════════════════════
//  🛡️  ENTERPRISE CRASH PROTECTION
// ════════════════════════════════════════════════════════════════════════════
process.on("uncaughtException", (err) => {
    console.error("❌ [CRITICAL] uncaughtException:", err.message);
    console.error(err.stack);
});

process.on("unhandledRejection", (reason) => {
    console.error("❌[CRITICAL] unhandledRejection:", reason?.message ?? reason);
    if (reason?.stack) console.error(reason.stack);
});

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  SYSTEM CONFIGURATION (ตั้งค่าระบบที่นี่)
// ════════════════════════════════════════════════════════════════════════════
const SYSTEM_CONFIG = {
    roles: {
        admin: "1501863007427235972", // 🔴 เปลี่ยนเป็น ID ยศแอดมินของคุณ
        user: "1501878510032257104"   // 🔴 เปลี่ยนเป็น ID ยศผู้ใช้งานของคุณ
    },
    limits: {
        maxSessions: Math.max(1, parseInt(process.env.MAX_SESSIONS || "20", 10)),
        rateLimitRequests: 5,         // กดปุ่มได้สูงสุด 5 ครั้ง
        rateLimitWindow: 60000        // ภายใน 1 นาที (60000 ms)
    },
    channels: {
        logName: "manager-logs"
    }
};

// ════════════════════════════════════════════════════════════════════════════
//  📦  CORE DEPENDENCIES
// ════════════════════════════════════════════════════════════════════════════
const {
    Client,
    Intents,
    MessageEmbed,
    MessageActionRow,
    MessageButton,
    MessageSelectMenu,
    Modal,
    TextInputComponent,
    WebhookClient
} = require("discord.js");

const express = require("express");
const voiceWorker = require("./voiceWorker");
const sessionManager = require("./sessionManager");

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  RATE LIMITER (ป้องกันสแปมปุ่ม)
// ════════════════════════════════════════════════════════════════════════════
class RateLimiter {
    constructor(maxRequests, windowMs) {
        this.max = maxRequests;
        this.window = windowMs;
        this.requests = new Map();
    }

    canRequest(key) {
        const now = Date.now();
        const userRequests = this.requests.get(key) ||[];
        const validRequests = userRequests.filter(time => now - time < this.window);

        if (validRequests.length >= this.max) return false;

        validRequests.push(now);
        this.requests.set(key, validRequests);
        return true;
    }
}
const actionLimiter = new RateLimiter(SYSTEM_CONFIG.limits.rateLimitRequests, SYSTEM_CONFIG.limits.rateLimitWindow);

// ════════════════════════════════════════════════════════════════════════════
//  🌐  EXPRESS SERVER
// ════════════════════════════════════════════════════════════════════════════
const app = express();

app.get("/", (_req, res) => res.send("🟢 Phomueangtai V3 Enterprise Edition"));
app.get("/ping", (_req, res) => res.send("🟢 PONG"));
app.get("/health", (_req, res) => {
    res.json({
        status: "operational",
        uptime: Math.floor(process.uptime()),
        sessions: {
            active: sessionManager.getAllSessions().size,
            maximum: SYSTEM_CONFIG.limits.maxSessions,
        },
        timestamp: new Date().toISOString(),
    });
});

app.listen(3000, () => console.log("✅[EXPRESS] Server online on port 3000")).on(
    "error",
    (err) => console.error("❌ [EXPRESS] Fatal error:", err.message),
);

// ════════════════════════════════════════════════════════════════════════════
//  💚  KEEP ALIVE HEARTBEAT
// ════════════════════════════════════════════════════════════════════════════
setInterval(() => {
    const sessionCount = sessionManager.getAllSessions().size;
    console.log(`💚 [HEARTBEAT] System operational | Active sessions: ${sessionCount}/${SYSTEM_CONFIG.limits.maxSessions}`);
}, 5 * 60_000);

// ════════════════════════════════════════════════════════════════════════════
//  🔐  ENVIRONMENT VALIDATION
// ════════════════════════════════════════════════════════════════════════════
if (!process.env.TOKEN_MANAGER) {
    console.error("❌ [CONFIG] TOKEN_MANAGER not configured in environment");
    process.exit(1);
}
console.log(`ℹ️  [CONFIG] Maximum concurrent sessions: ${SYSTEM_CONFIG.limits.maxSessions}`);

// ════════════════════════════════════════════════════════════════════════════
//  🤖  DISCORD CLIENT INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════
const client = new Client({
    intents:[
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.GUILD_VOICE_STATES,
        Intents.FLAGS.MESSAGE_CONTENT,
    ],
});

// ตั้งค่า Webhook Logging (ถ้ามี)
let logWebhook = null;
if (process.env.WEBHOOK_LOG_URL) {
    logWebhook = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
    console.log("✅ [LOG] Webhook logging enabled");
}

// ════════════════════════════════════════════════════════════════════════════
//  🧠  STATE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════
const panelMessages = new Map();
let clientReady = false;
let isUpdatingPanel = false;

// ════════════════════════════════════════════════════════════════════════════
//  🔧  UTILITY FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════
function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sc = s % 60;
    if (h > 0) return `${h} ชม. ${m} นาที`;
    if (m > 0) return `${m} นาที ${sc} วินาที`;
    return `${sc} วินาที`;
}

function safeSlice(str, max) {
    if (!str || str.length <= max) return str;
    let i = max;
    while (i > 0 && str.charCodeAt(i) >= 0xdc00 && str.charCodeAt(i) <= 0xdfff) i--;
    return str.slice(0, i) + "…";
}

async function sendLog(guild, embed) {
    try {
        if (logWebhook) {
            await logWebhook.send({ embeds: [embed] }).catch(() => {});
        } else if (guild) {
            const ch = guild.channels.cache.find(
                (c) => c.name === SYSTEM_CONFIG.channels.logName && c.type === "GUILD_TEXT",
            );
            if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
        }
    } catch (err) {
        console.error("❌ [LOG] Failed to send log:", err.message);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📊  CONTROL PANEL INTERFACE
// ════════════════════════════════════════════════════════════════════════════
function getPanelEmbed() {
    try {
        const sessions = [...sessionManager.getAllSessions().values()];
        const LIMIT = 850;

        let sessionList = sessions.length
            ? sessions
                  .map((s) => `  ∙ Token: ****${s.tokenTail}  │  Server: ${s.serverName || s.serverId}`)
                  .join("\n")
            : "  — ไม่มีเซสชันที่ทำงานอยู่ในขณะนี้";

        if (sessionList.length > LIMIT) {
            sessionList = sessionList.slice(0, LIMIT) + "\n  … กด [📡 สถานะ] เพื่อดูรายการทั้งหมด";
        }

        return new MessageEmbed()
            .setTitle("⚡  ระบบออนช่องเสียงผู้ใช้  ·  ENTERPRISE CONTROL PANEL")
            .setColor("#2b2d31")
            .setDescription(
                "> **บริการรับออนช่องเสียงฟรี ตลอด 24 ชั่วโมง**\n" +
                "> ตั้งค่าข้อมูลการออนช่องเสียงผ่านแผงควบคุมด้านล่าง\n\n" +
                "```ansi\n" +
                "\u001b[1;36mSYSTEM STATUS\u001b[0m\n" +
                "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                `\u001b[1;32mONLINE\u001b[0m  │  Version 3.0 Enterprise\n` +
                `\u001b[1;33mSESSIONS\u001b[0m │  ${sessions.length} / ${SYSTEM_CONFIG.limits.maxSessions} Active\n` +
                "```"
            )
            .addFields({
                name: "📋  จัดการออนช่องเสียง  ·  รายการเซสชันที่ใช้งานอยู่",
                value: "```yaml\n" + sessionList + "\n```",
                inline: false,
            })
            .setImage("https://i.imgur.com/PLACEHOLDER.gif")
            .setFooter({
                text: `⏱ อัปเดตล่าสุด: ${new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}  │  Phomueangtai Enterprise`,
            })
            .setTimestamp();
    } catch (err) {
        console.error("❌ [PANEL] Failed to build embed:", err.message);
        return new MessageEmbed()
            .setTitle("⚠️  ระบบออนช่องเสียงผู้ใช้")
            .setColor("#2b2d31")
            .setDescription("> ⛔  เกิดข้อผิดพลาดในการโหลดข้อมูล กรุณาลองใหม่อีกครั้ง");
    }
}

function getPanelRow() {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId("btn_start")
            .setLabel("⚡ เริ่มเซสชัน")
            .setStyle("SUCCESS"),
        new MessageButton()
            .setCustomId("btn_status")
            .setLabel("📡 สถานะ")
            .setStyle("PRIMARY"),
        new MessageButton()
            .setCustomId("btn_stop_one")
            .setLabel("⏹ หยุดรายการ")
            .setStyle("SECONDARY"),
        new MessageButton()
            .setCustomId("btn_stop")
            .setLabel("🛑 หยุดทั้งหมด")
            .setStyle("DANGER"),
    );
}

async function updatePanel() {
    if (!clientReady || isUpdatingPanel) return;
    if (panelMessages.size === 0) return;

    isUpdatingPanel = true;

    try {
        const embed = getPanelEmbed();
        const row = getPanelRow();

        for (const [channelId, msg] of panelMessages) {
            try {
                await msg.edit({ embeds: [embed], components: [row] });
                await new Promise((r) => setTimeout(r, 600));
            } catch (err) {
                if (err.code === 10008 || err.code === 10003) {
                    panelMessages.delete(channelId);
                }
            }
        }
    } catch (err) {
        console.error("❌ [PANEL] Update failed:", err.message);
    } finally {
        isUpdatingPanel = false;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📖  HELP DOCUMENTATION SYSTEM
// ════════════════════════════════════════════════════════════════════════════
function getHelpPages() {
    try {
        const footer = {
            text: "Phomueangtai Enterprise System  │  เฉพาะผู้ดูแลระบบที่ได้รับอนุญาต",
        };

        return[
            new MessageEmbed()
                .setTitle("📚  คู่มือระบบ  ·  หน้า 1 / 3")
                .setColor("#2b2d31")
                .setDescription(
                    "> **ข้อมูลและการสืบค้น**\n" +
                    "> คำสั่งสำหรับการตรวจสอบข้อมูลระบบและสมาชิก\n\n" +
                    "```ansi\n" +
                    "\u001b[1;36mINFORMATION COMMANDS\u001b[0m\n" +
                    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                    "```"
                )
                .addFields(
                    {
                        name: "🔍  คำสั่งข้อมูลระบบ",
                        value:
                            "> `p.userinfo [@สมาชิก]`\n" +
                            "> แสดงข้อมูลโปรไฟล์ของสมาชิก\n\n" +
                            "> `p.serverinfo`\n" +
                            "> แสดงข้อมูลรายละเอียดของเซิร์ฟเวอร์\n\n" +
                            "> `p.stats`\n" +
                            "> ดูสถิติการทำงานของระบบ (ใหม่!)\n\n" +
                            "> `p.help`\n" +
                            "> เปิดคู่มือการใช้งานระบบฉบับนี้",
                        inline: false,
                    }
                )
                .setFooter(footer)
                .setTimestamp(),

            new MessageEmbed()
                .setTitle("📚  คู่มือระบบ  ·  หน้า 2 / 3")
                .setColor("#2b2d31")
                .setDescription(
                    "> **การควบคุมและบังคับใช้กฎ**\n" +
                    "> คำสั่งสำหรับการจัดการเนื้อหาและสมาชิก\n\n" +
                    "```ansi\n" +
                    "\u001b[1;31mMODERATION COMMANDS\u001b[0m\n" +
                    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                    "```"
                )
                .addFields(
                    {
                        name: "🛡️  การจัดการข้อความและช่อง",
                        value:
                            "> `p.clear <1-100>`\n" +
                            "> ลบข้อความในช่องปัจจุบัน\n\n" +
                            "> `p.say <ข้อความ>`\n" +
                            "> ส่งข้อความในนามระบบ\n\n" +
                            "> `p.announce <ข้อความ>`\n" +
                            "> เผยแพร่ประกาศสำคัญ\n\n" +
                            "> `p.lock` / `p.unlock`\n" +
                            "> ล็อกหรือปลดล็อกช่องข้อความ",
                        inline: false,
                    },
                    {
                        name: "⚔️  การบังคับใช้กฎ",
                        value:
                            "> `p.kick @สมาชิก`\n" +
                            "> เตะสมาชิกออกจากเซิร์ฟเวอร์\n\n" +
                            "> `p.ban @สมาชิก`\n" +
                            "> แบนสมาชิกถาวร\n\n" +
                            "> `p.unban <USER_ID>`\n" +
                            "> ยกเลิกการแบน\n\n" +
                            "> `p.timeout @สมาชิก <นาที>`\n" +
                            "> ระงับสิทธิ์การพิมพ์ชั่วคราว",
                        inline: false,
                    }
                )
                .setFooter(footer)
                .setTimestamp(),

            new MessageEmbed()
                .setTitle("📚  คู่มือระบบ  ·  หน้า 3 / 3")
                .setColor("#2b2d31")
                .setDescription(
                    "> **ระบบออนช่องเสียงผู้ใช้**\n" +
                    "> บริการรับออนช่องเสียงฟรี ตลอด 24 ชั่วโมง\n\n" +
                    "```ansi\n" +
                    "\u001b[1;32mVOICE MANAGEMENT SYSTEM\u001b[0m\n" +
                    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                    "```"
                )
                .addFields(
                    {
                        name: "🎧  คำสั่งระบบเสียง",
                        value:
                            "> `p.panel`\n" +
                            "> เรียกแผงควบคุมระบบออนช่องเสียง\n\n" +
                            "> `p.setup-log`\n" +
                            "> สร้างห้อง Log สำหรับบันทึกกิจกรรม",
                        inline: false,
                    },
                    {
                        name: "⚡  วิธีใช้งานแผงควบคุม",
                        value:
                            "> **⚡ เริ่มเซสชัน**\n" +
                            "> กรอก Token, Server ID และ Voice Channel ID\n" +
                            "> เพื่อเริ่มต้นการออนช่องเสียง\n\n" +
                            "> **📡 สถานะ**\n" +
                            "> ตรวจสอบเซสชันที่กำลังทำงานอยู่ทั้งหมด\n\n" +
                            "> **⏹ หยุดรายการ**\n" +
                            "> เลือกหยุดการทำงานของเซสชันเฉพาะรายการ\n\n" +
                            "> **🛑 หยุดทั้งหมด**\n" +
                            "> ปิดการทำงานของทุกเซสชันทันที",
                        inline: false,
                    }
                )
                .setFooter(footer)
                .setTimestamp(),
        ];
    } catch (err) {
        console.error("❌ [HELP] Failed to build pages:", err.message);
        return[
            new MessageEmbed()
                .setTitle("📚 คู่มือระบบ")
                .setColor("#2b2d31")
                .setDescription("> ⛔  เกิดข้อผิดพลาด กรุณาลองใหม่"),
        ];
    }
}

function getHelpRow(page) {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(`help_prev_${page}`)
            .setLabel("◀  ก่อนหน้า")
            .setStyle("SECONDARY")
            .setDisabled(page === 0),
        new MessageButton()
            .setCustomId(`help_page_${page}`)
            .setLabel(`หน้า ${page + 1} / 3`)
            .setStyle("PRIMARY")
            .setDisabled(true),
        new MessageButton()
            .setCustomId(`help_next_${page}`)
            .setLabel("ถัดไป  ▶")
            .setStyle("SECONDARY")
            .setDisabled(page === 2),
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  ⌨️  PREFIX COMMAND HANDLER
// ════════════════════════════════════════════════════════════════════════════
client.on("messageCreate", async (msg) => {
    try {
        if (!msg.guild || msg.author.bot) return;
        if (!msg.content.startsWith("p.")) return;
        if (!msg.member?.roles.cache.has(SYSTEM_CONFIG.roles.admin)) return;

        const args = msg.content.slice(2).trim().split(/ +/);
        const cmd = args.shift()?.toLowerCase();
        const target = msg.mentions.members.first();

        switch (cmd) {
            case "clear": {
                const amount = parseInt(args[0]);
                if (!amount || amount < 1 || amount > 100) {
                    return msg.reply("> ⛔  กรุณาระบุจำนวนข้อความ 1–100");
                }
                await msg.delete().catch(() => {});
                const deleted = await msg.channel.bulkDelete(amount, true).catch(() => null);
                const m = await msg.channel.send(`> ✅  ลบข้อความสำเร็จ ${deleted?.size || amount} รายการ`);
                setTimeout(() => m.delete().catch(() => {}), 3000);
                break;
            }

            case "say": {
                const text = args.join(" ");
                if (!text) return msg.reply("> ⛔  กรุณาระบุข้อความที่ต้องการส่ง");
                await msg.delete().catch(() => {});
                await msg.channel.send(text);
                break;
            }

            case "announce": {
                const text = args.join(" ");
                if (!text) return msg.reply("> ⛔  กรุณาระบุเนื้อหาประกาศ");
                await msg.delete().catch(() => {});
                await msg.channel.send({
                    embeds:[
                        new MessageEmbed()
                            .setColor("#2b2d31")
                            .setTitle("📣  ประกาศจากผู้ดูแลระบบ")
                            .setDescription(
                                "> **ประกาศสำคัญ**\n\n" + text
                            )
                            .setFooter({
                                text: `ประกาศโดย ${msg.author.tag}  │  ${new Date().toLocaleString("th-TH")}`,
                            })
                            .setTimestamp(),
                    ],
                });
                break;
            }

            case "lock":
            case "unlock": {
                await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, {
                    SEND_MESSAGES: cmd === "unlock" ? null : false,
                });
                await msg.reply(cmd === "unlock" ? "> 🔓  ปลดล็อกช่องแล้ว" : "> 🔒  ล็อกช่องแล้ว");
                break;
            }

            case "kick": {
                if (!target) return msg.reply("> ⛔  กรุณาระบุสมาชิกด้วย @mention");
                try {
                    await target.kick();
                    await msg.reply(`> ⚔️  เตะสมาชิก \`${target.user.tag}\` ออกจากเซิร์ฟเวอร์แล้ว`);
                } catch {
                    await msg.reply("> ⛔  ไม่สามารถเตะได้ — ตรวจสอบสิทธิ์หรือยศของบอท");
                }
                break;
            }

            case "ban": {
                if (!target) return msg.reply("> ⛔  กรุณาระบุสมาชิกด้วย @mention");
                try {
                    await target.ban();
                    await msg.reply(`> 🔨  แบนสมาชิก \`${target.user.tag}\` แล้ว`);
                } catch {
                    await msg.reply("> ⛔  ไม่สามารถแบนได้ — ตรวจสอบสิทธิ์หรือยศของบอท");
                }
                break;
            }

            case "timeout": {
                const minutes = parseInt(args[1]);
                if (!target) return msg.reply("> ⛔  กรุณาระบุสมาชิกด้วย @mention");
                if (!minutes || minutes < 1) return msg.reply("> ⛔  กรุณาระบุจำนวนนาที");
                try {
                    await target.timeout(minutes * 60_000);
                    await msg.reply(`> ⏳  ระงับสิทธิ์สมาชิก \`${target.user.tag}\` เป็นเวลา ${minutes} นาทีแล้ว`);
                } catch {
                    await msg.reply("> ⛔  ไม่สามารถระงับสิทธิ์ได้ — ตรวจสอบสิทธิ์หรือยศของบอท");
                }
                break;
            }

            case "unban": {
                const id = args[0];
                if (!id) return msg.reply("> ⛔  กรุณาระบุ User ID");
                try {
                    await msg.guild.members.unban(id);
                    await msg.reply("> ✅  ยกเลิกการแบนสำเร็จ");
                } catch {
                    await msg.reply("> ⛔  ไม่พบในรายการแบน หรือ User ID ไม่ถูกต้อง");
                }
                break;
            }

            case "panel": {
                const old = panelMessages.get(msg.channel.id);
                if (old) await old.delete().catch(() => {});
                const panel = await msg.channel.send({
                    embeds: [getPanelEmbed()],
                    components: [getPanelRow()],
                });
                panelMessages.set(msg.channel.id, panel);
                await msg.delete().catch(() => {});
                break;
            }

            case "help": {
                const pages = getHelpPages();
                await msg.reply({
                    embeds: [pages[0]],
                    components:[getHelpRow(0)],
                    allowedMentions: { repliedUser: false },
                });
                break;
            }

            case "setup-log": {
                const exists = msg.guild.channels.cache.find((c) => c.name === SYSTEM_CONFIG.channels.logName);
                if (exists) return msg.reply("> ❌  มีห้อง Log อยู่แล้ว");
                await msg.guild.channels.create(SYSTEM_CONFIG.channels.logName, { type: "GUILD_TEXT" });
                await msg.reply("> ✅  สร้างห้อง Log สำเร็จ");
                break;
            }

            case "userinfo": {
                const u = target?.user || msg.author;
                await msg.reply({
                    embeds:[
                        new MessageEmbed()
                            .setTitle("👤  ข้อมูลสมาชิก")
                            .setColor("#2b2d31")
                            .setDescription(
                                "```yaml\n" +
                                `Username : ${u.tag}\n` +
                                `User ID  : ${u.id}\n` +
                                `Created  : ${u.createdAt.toLocaleDateString("th-TH")}\n` +
                                "```"
                            )
                            .setThumbnail(u.displayAvatarURL({ dynamic: true, size: 256 }))
                            .setTimestamp(),
                    ],
                });
                break;
            }

            case "serverinfo": {
                await msg.reply({
                    embeds:[
                        new MessageEmbed()
                            .setTitle("🌐  ข้อมูลเซิร์ฟเวอร์")
                            .setColor("#2b2d31")
                            .setDescription(
                                "```yaml\n" +
                                `Server Name : ${msg.guild.name}\n` +
                                `Server ID   : ${msg.guild.id}\n` +
                                `Members     : ${msg.guild.memberCount}\n` +
                                `Created     : ${msg.guild.createdAt.toLocaleDateString("th-TH")}\n` +
                                "```"
                            )
                            .setTimestamp(),
                    ],
                });
                break;
            }

            case "stats": {
                const report = sessionManager.systemMetrics.getReport();
                await msg.reply({
                    embeds:[
                        new MessageEmbed()
                            .setTitle("📊  System Analytics")
                            .setColor("#2b2d31")
                            .setDescription(
                                "```yaml\n" + 
                                `Sessions Started : ${report.sessionsStarted}\n` +
                                `Failed Attempts  : ${report.sessionsFailed}\n` +
                                `Success Rate     : ${report.successRate}\n` +
                                `Total Reconnects : ${report.reconnects}\n` +
                                `System Uptime    : ${report.uptimeHours} hours\n` +
                                "```"
                            )
                            .setTimestamp()
                    ]
                });
                break;
            }
        }
    } catch (err) {
        console.error("❌ [PREFIX] Command error:", err.message);
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  🚀  CLIENT READY & SLASH COMMANDS
// ════════════════════════════════════════════════════════════════════════════
client.on("ready", async () => {
    try {
        console.log(`✅ [CLIENT] Logged in as ${client.user.tag}`);
        clientReady = true;

        const commands =[
            { name: "panel", description: "⚡ เรียกแผงควบคุมระบบออนช่องเสียง" },
            { name: "help", description: "📚 แสดงคู่มือการใช้งานระบบ" },
            { name: "lock", description: "🔒 ล็อกช่องข้อความ" },
            { name: "unlock", description: "🔓 ปลดล็อกช่องข้อความ" },
            { name: "serverinfo", description: "🌐 แสดงข้อมูลเซิร์ฟเวอร์" },
            { name: "setup-log", description: "📁 สร้างห้อง Log ระบบ" },
            { name: "stats", description: "📊 ดูสถิติการทำงานของระบบ" },
            {
                name: "clear",
                description: "🗑️ ลบข้อความ 1–100 รายการ",
                options:[
                    {
                        name: "amount",
                        type: "INTEGER",
                        required: true,
                        description: "จำนวนข้อความที่ต้องการลบ (1–100)",
                    },
                ],
            },
            {
                name: "say",
                description: "📢 ส่งข้อความในนามระบบ",
                options:[
                    {
                        name: "text",
                        type: "STRING",
                        required: true,
                        description: "ข้อความที่ต้องการส่ง",
                    },
                ],
            },
            {
                name: "announce",
                description: "📣 เผยแพร่ประกาศสำคัญ",
                options:[
                    {
                        name: "text",
                        type: "STRING",
                        required: true,
                        description: "เนื้อหาประกาศ",
                    },
                ],
            },
            {
                name: "userinfo",
                description: "👤 แสดงข้อมูลสมาชิก",
                options:[
                    {
                        name: "target",
                        type: "USER",
                        description: "สมาชิกที่ต้องการดูข้อมูล (ไม่เลือก = ตัวเอง)",
                    },
                ],
            },
            {
                name: "kick",
                description: "⚔️ เตะสมาชิกออกจากเซิร์ฟเวอร์",
                options:[
                    {
                        name: "target",
                        type: "USER",
                        required: true,
                        description: "สมาชิกที่ต้องการเตะ",
                    },
                ],
            },
            {
                name: "ban",
                description: "🔨 แบนสมาชิกถาวร",
                options:[
                    {
                        name: "target",
                        type: "USER",
                        required: true,
                        description: "สมาชิกที่ต้องการแบน",
                    },
                ],
            },
            {
                name: "timeout",
                description: "⏳ ระงับสิทธิ์การพิมพ์ชั่วคราว",
                options:[
                    {
                        name: "target",
                        type: "USER",
                        required: true,
                        description: "สมาชิกที่ต้องการระงับสิทธิ์",
                    },
                    {
                        name: "minutes",
                        type: "INTEGER",
                        required: true,
                        description: "จำนวนนาที",
                    },
                ],
            },
            {
                name: "unban",
                description: "✅ ยกเลิกการแบน",
                options:[
                    {
                        name: "id",
                        type: "STRING",
                        required: true,
                        description: "User ID ของผู้ที่ต้องการยกเลิกแบน",
                    },
                ],
            },
        ];

        await client.application.commands.set(commands);
        console.log("✅ [COMMANDS] Slash commands registered successfully");
    } catch (err) {
        console.error("❌ [READY] Initialization error:", err.message);
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  🎮  INTERACTION HANDLER
// ════════════════════════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
    try {
        if (!interaction.guild) return;

        const isAdmin = interaction.member.roles.cache.has(SYSTEM_CONFIG.roles.admin);
        const hasAccess = isAdmin || interaction.member.roles.cache.has(SYSTEM_CONFIG.roles.user);

        // ────────────────────────────────────────────────────────────────────
        //  SLASH COMMANDS
        // ────────────────────────────────────────────────────────────────────
        if (interaction.isCommand()) {
            if (!isAdmin) {
                return interaction.reply({
                    content: "> ⛔  คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้",
                    ephemeral: true,
                });
            }

            await interaction.deferReply({ ephemeral: true });
            const cmd = interaction.commandName;

            if (cmd === "panel") {
                const old = panelMessages.get(interaction.channel.id);
                if (old) await old.delete().catch(() => {});
                const panel = await interaction.channel.send({
                    embeds: [getPanelEmbed()],
                    components: [getPanelRow()],
                });
                panelMessages.set(interaction.channel.id, panel);
                await interaction.editReply({ content: "> ⚡  เปิดแผงควบคุมระบบแล้ว" });
            } else if (cmd === "help") {
                const pages = getHelpPages();
                await interaction.editReply({
                    embeds: [pages[0]],
                    components:[getHelpRow(0)],
                });
            } else if (cmd === "clear") {
                const amount = interaction.options.getInteger("amount");
                if (amount < 1 || amount > 100) {
                    return interaction.editReply({ content: "> ⛔  กรุณาระบุจำนวน 1–100" });
                }
                const deleted = await interaction.channel.bulkDelete(amount, true).catch(() => null);
                await interaction.editReply({ content: `> 🗑️  ลบข้อความสำเร็จ ${deleted?.size || amount} รายการ` });
            } else if (cmd === "say") {
                await interaction.channel.send(interaction.options.getString("text"));
                await interaction.editReply({ content: "> 📢  ส่งข้อความสำเร็จ" });
            } else if (cmd === "announce") {
                const text = interaction.options.getString("text");
                await interaction.channel.send({
                    embeds:[
                        new MessageEmbed()
                            .setColor("#2b2d31")
                            .setTitle("📣  ประกาศจากผู้ดูแลระบบ")
                            .setDescription("> **ประกาศสำคัญ**\n\n" + text)
                            .setFooter({
                                text: `ประกาศโดย ${interaction.user.tag}  │  ${new Date().toLocaleString("th-TH")}`,
                            })
                            .setTimestamp(),
                    ],
                });
                await interaction.editReply({ content: "> 📣  เผยแพร่ประกาศสำเร็จ" });
            } else if (cmd === "lock" || cmd === "unlock") {
                await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                    SEND_MESSAGES: cmd === "unlock" ? null : false,
                });
                await interaction.editReply({
                    content: cmd === "unlock" ? "> 🔓  ปลดล็อกช่องแล้ว" : "> 🔒  ล็อกช่องแล้ว",
                });
            } else if (cmd === "kick") {
                const target = interaction.options.getMember("target");
                if (!target) return interaction.editReply({ content: "> ⛔  ไม่พบสมาชิก" });
                try {
                    await target.kick();
                    await interaction.editReply({ content: `> ⚔️  เตะสมาชิก \`${target.user.tag}\` แล้ว` });
                } catch {
                    await interaction.editReply({ content: "> ⛔  ไม่สามารถเตะได้" });
                }
            } else if (cmd === "ban") {
                const target = interaction.options.getMember("target");
                if (!target) return interaction.editReply({ content: "> ⛔  ไม่พบสมาชิก" });
                try {
                    await target.ban();
                    await interaction.editReply({ content: `> 🔨  แบนสมาชิก \`${target.user.tag}\` แล้ว` });
                } catch {
                    await interaction.editReply({ content: "> ⛔  ไม่สามารถแบนได้" });
                }
            } else if (cmd === "timeout") {
                const target = interaction.options.getMember("target");
                const minutes = interaction.options.getInteger("minutes");
                if (!target) return interaction.editReply({ content: "> ⛔  ไม่พบสมาชิก" });
                if (minutes < 1) return interaction.editReply({ content: "> ⛔  กรุณาระบุจำนวนนาที" });
                try {
                    await target.timeout(minutes * 60_000);
                    await interaction.editReply({
                        content: `> ⏳  ระงับสิทธิ์สมาชิก \`${target.user.tag}\` เป็นเวลา ${minutes} นาทีแล้ว`,
                    });
                } catch {
                    await interaction.editReply({ content: "> ⛔  ไม่สามารถระงับสิทธิ์ได้" });
                }
            } else if (cmd === "unban") {
                try {
                    await interaction.guild.members.unban(interaction.options.getString("id"));
                    await interaction.editReply({ content: "> ✅  ยกเลิกการแบนสำเร็จ" });
                } catch {
                    await interaction.editReply({ content: "> ⛔  ไม่พบในรายการแบน หรือ ID ไม่ถูกต้อง" });
                }
            } else if (cmd === "setup-log") {
                const exists = interaction.guild.channels.cache.find((c) => c.name === SYSTEM_CONFIG.channels.logName);
                if (exists) return interaction.editReply({ content: "> ⛔  มีห้อง Log อยู่แล้ว" });
                await interaction.guild.channels.create(SYSTEM_CONFIG.channels.logName, { type: "GUILD_TEXT" });
                await interaction.editReply({ content: "> ✅  สร้างห้อง Log สำเร็จ" });
            } else if (cmd === "userinfo") {
                const u = interaction.options.getMember("target")?.user || interaction.user;
                await interaction.editReply({
                    embeds:[
                        new MessageEmbed()
                            .setTitle("👤  ข้อมูลสมาชิก")
                            .setColor("#2b2d31")
                            .setDescription(
                                "```yaml\n" +
                                `Username : ${u.tag}\n` +
                                `User ID  : ${u.id}\n` +
                                `Created  : ${u.createdAt.toLocaleDateString("th-TH")}\n` +
                                "```"
                            )
                            .setThumbnail(u.displayAvatarURL({ dynamic: true, size: 256 }))
                            .setTimestamp(),
                    ],
                });
            } else if (cmd === "serverinfo") {
                await interaction.editReply({
                    embeds:[
                        new MessageEmbed()
                            .setTitle("🌐  ข้อมูลเซิร์ฟเวอร์")
                            .setColor("#2b2d31")
                            .setDescription(
                                "```yaml\n" +
                                `Server Name : ${interaction.guild.name}\n` +
                                `Server ID   : ${interaction.guild.id}\n` +
                                `Members     : ${interaction.guild.memberCount}\n` +
                                `Created     : ${interaction.guild.createdAt.toLocaleDateString("th-TH")}\n` +
                                "```"
                            )
                            .setTimestamp(),
                    ],
                });
            } else if (cmd === "stats") {
                const report = sessionManager.systemMetrics.getReport();
                await interaction.editReply({
                    embeds:[
                        new MessageEmbed()
                            .setTitle("📊  System Analytics")
                            .setColor("#2b2d31")
                            .setDescription(
                                "```yaml\n" + 
                                `Sessions Started : ${report.sessionsStarted}\n` +
                                `Failed Attempts  : ${report.sessionsFailed}\n` +
                                `Success Rate     : ${report.successRate}\n` +
                                `Total Reconnects : ${report.reconnects}\n` +
                                `System Uptime    : ${report.uptimeHours} hours\n` +
                                "```"
                            )
                            .setTimestamp()
                    ]
                });
            }

            return;
        }

        // ────────────────────────────────────────────────────────────────────
        //  BUTTONS & MODALS (With Rate Limiter)
        // ────────────────────────────────────────────────────────────────────
        if (interaction.isButton() || interaction.isSelectMenu() || interaction.isModalSubmit()) {
            // เช็คสิทธิ์การใช้งาน
            if (!hasAccess) {
                return interaction.reply({
                    content: "> ⛔  คุณไม่มีสิทธิ์ใช้งานฟังก์ชันนี้",
                    ephemeral: true,
                });
            }

            // เช็ค Rate Limit ป้องกันการสแปม
            if (!actionLimiter.canRequest(interaction.user.id)) {
                return interaction.reply({
                    content: "> ⛔  คุณใช้งานบ่อยเกินไป กรุณารอสักครู่",
                    ephemeral: true,
                });
            }
        }

        if (interaction.isButton()) {
            const PANEL_BTNS =["btn_start", "btn_status", "btn_stop_one", "btn_stop"];
            if (PANEL_BTNS.includes(interaction.customId) && !panelMessages.has(interaction.channelId)) {
                panelMessages.set(interaction.channelId, interaction.message);
            }

            // HELP PAGINATION
            if (interaction.customId.startsWith("help_prev_") || interaction.customId.startsWith("help_next_")) {
                const parts = interaction.customId.split("_");
                const dir = parts[1];
                const current = parseInt(parts[2]);
                const newPage = dir === "prev" ? current - 1 : current + 1;
                if (newPage < 0 || newPage > 2) return;
                const pages = getHelpPages();
                return interaction.update({
                    embeds: [pages[newPage]],
                    components: [getHelpRow(newPage)],
                });
            }

            // START SESSION
            if (interaction.customId === "btn_start") {
                if (sessionManager.getAllSessions().size >= SYSTEM_CONFIG.limits.maxSessions) {
                    return interaction.reply({
                        content: `> ⛔  ถึงขีดจำกัด ${SYSTEM_CONFIG.limits.maxSessions} เซสชัน — กรุณาปิดเซสชันเก่าก่อน`,
                        ephemeral: true,
                    });
                }

                const modal = new Modal()
                    .setCustomId("setup_modal")
                    .setTitle("⚡ ตั้งค่าข้อมูลการออนช่องเสียง");

                modal.addComponents(
                    new MessageActionRow().addComponents(
                        new TextInputComponent()
                            .setCustomId("token")
                            .setLabel("🔑  Token ของบัญชี")
                            .setStyle("SHORT")
                            .setPlaceholder("กรอก Token ที่ต้องการใช้งาน")
                            .setRequired(true)
                    ),
                    new MessageActionRow().addComponents(
                        new TextInputComponent()
                            .setCustomId("server")
                            .setLabel("🌐  Server ID")
                            .setStyle("SHORT")
                            .setPlaceholder("กรอก ID ของเซิร์ฟเวอร์")
                            .setRequired(true)
                    ),
                    new MessageActionRow().addComponents(
                        new TextInputComponent()
                            .setCustomId("voice")
                            .setLabel("🔊  Voice Channel ID")
                            .setStyle("SHORT")
                            .setPlaceholder("กรอก ID ของช่องเสียง")
                            .setRequired(true)
                    ),
                );
                return interaction.showModal(modal);
            }

            // STATUS
            if (interaction.customId === "btn_status") {
                const sessions =[...sessionManager.getAllSessions().values()];

                if (sessions.length === 0) {
                    return interaction.reply({
                        content:
                            "> **📡  สถานะระบบออนช่องเสียง**\n" +
                            "```ansi\n" +
                            "\u001b[1;33mNO ACTIVE SESSIONS\u001b[0m\n" +
                            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                            "ไม่มีเซสชันที่ทำงานอยู่ในขณะนี้\n" +
                            "```",
                        ephemeral: true,
                    });
                }

                let sessionList = sessions
                    .map((s) => {
                        const uptime = formatUptime(Date.now() - (s.startedAt || Date.now()));
                        return `  ∙ Token: ****${s.tokenTail}  │  Server: ${s.serverName || s.serverId}\n    Runtime: ${uptime}`;
                    })
                    .join("\n\n");

                const header = 
                    `> **📡  สถานะระบบออนช่องเสียง  ·  ${sessions.length} / ${SYSTEM_CONFIG.limits.maxSessions} เซสชัน**\n` +
                    "```yaml\n";
                const footer = "\n```";
                const maxContent = 1900 - header.length - footer.length;

                if (sessionList.length > maxContent) {
                    sessionList = sessionList.slice(0, maxContent) + "\n\n  … (มีรายการเพิ่มเติม)";
                }

                return interaction.reply({
                    content: header + sessionList + footer,
                    ephemeral: true,
                });
            }

            // STOP ALL
            if (interaction.customId === "btn_stop") {
                await interaction.deferReply({ ephemeral: true });
                const count = sessionManager.getAllSessions().size;

                if (count === 0) {
                    return interaction.editReply({ content: "> ⛔  ไม่มีเซสชันที่ทำงานอยู่" });
                }

                await voiceWorker.stopAll();
                await updatePanel();

                await sendLog(
                    interaction.guild,
                    new MessageEmbed()
                        .setColor("#2b2d31")
                        .setTitle("🛑  หยุดระบบทั้งหมด")
                        .setDescription(
                            "> **การดำเนินการ**: หยุดการทำงานของทุกเซสชัน\n" +
                            "> **สถานะ**: ดำเนินการสำเร็จ"
                        )
                        .addFields(
                            {
                                name: "👤  ผู้ดำเนินการ",
                                value: `\`\`\`yaml\nUser: ${interaction.user.tag}\nID: ${interaction.user.id}\n\`\`\``,
                                inline: false,
                            },
                            {
                                name: "📊  รายละเอียด",
                                value: `\`\`\`yaml\nSessions Closed: ${count}\nTimestamp: ${new Date().toLocaleString("th-TH")}\n\`\`\``,
                                inline: false,
                            }
                        )
                        .setTimestamp(),
                );

                return interaction.editReply({ content: `> 🛑  หยุดการทำงานทั้งหมด ${count} เซสชันสำเร็จ` });
            }

            // STOP ONE
            if (interaction.customId === "btn_stop_one") {
                const sessions = [...sessionManager.getAllSessions().values()];
                if (!sessions.length) {
                    return interaction.reply({
                        content: "> ⛔  ไม่มีเซสชันที่ทำงานอยู่",
                        ephemeral: true,
                    });
                }

                const menuSessions = sessions.slice(0, 25);
                const menu = new MessageSelectMenu()
                    .setCustomId("select_stop")
                    .setPlaceholder("🔽  เลือกเซสชันที่ต้องการหยุด")
                    .addOptions(
                        menuSessions.map((s) => {
                            const raw = `****${s.tokenTail}  ·  ${s.serverName || s.serverId}`;
                            return {
                                label: safeSlice(raw, 100),
                                value: s.sessionId,
                            };
                        })
                    );

                return interaction.reply({
                    content: "> **⏹  เลือกเซสชันที่ต้องการหยุดการทำงาน:**",
                    components: [new MessageActionRow().addComponents(menu)],
                    ephemeral: true,
                });
            }
        }

        // ────────────────────────────────────────────────────────────────────
        //  SELECT MENU
        // ────────────────────────────────────────────────────────────────────
        if (interaction.isSelectMenu() && interaction.customId === "select_stop") {
            if (!interaction.values || interaction.values.length === 0) {
                return interaction.reply({
                    content: "> ⛔  ไม่ได้เลือกเซสชัน",
                    ephemeral: true,
                });
            }

            await interaction.deferUpdate();

            const sessionId = interaction.values[0];
            const session = sessionManager.getSession(sessionId);
            const label = session
                ? safeSlice(`****${session.tokenTail}  ·  ${session.serverName || session.serverId}`, 100)
                : sessionId;

            await voiceWorker.stopSession(sessionId);
            await updatePanel();

            await sendLog(
                interaction.guild,
                new MessageEmbed()
                    .setColor("#2b2d31")
                    .setTitle("⏹  หยุดเซสชัน")
                    .setDescription(
                        "> **การดำเนินการ**: หยุดการทำงานของเซสชันที่เลือก\n" +
                        "> **สถานะ**: ดำเนินการสำเร็จ"
                    )
                    .addFields(
                        {
                            name: "👤  ผู้ดำเนินการ",
                            value: `\`\`\`yaml\nUser: ${interaction.user.tag}\nID: ${interaction.user.id}\n\`\`\``,
                            inline: false,
                        },
                        {
                            name: "🤖  ข้อมูลเซสชัน",
                            value:
                                `\`\`\`yaml\n` +
                                `Token: ****${session?.tokenTail ?? "????"}\n` +
                                `Server: ${session?.serverName || session?.serverId || "unknown"}\n` +
                                `Timestamp: ${new Date().toLocaleString("th-TH")}\n` +
                                `\`\`\``,
                            inline: false,
                        }
                    )
                    .setTimestamp(),
            );

            return interaction.editReply({
                content: `> ⏹  หยุดเซสชัน \`${label}\` สำเร็จ`,
                components:[],
            });
        }

        // ────────────────────────────────────────────────────────────────────
        //  MODAL SUBMIT
        // ────────────────────────────────────────────────────────────────────
        if (interaction.isModalSubmit() && interaction.customId === "setup_modal") {
            if (sessionManager.getAllSessions().size >= SYSTEM_CONFIG.limits.maxSessions) {
                return interaction.reply({
                    content: `> ⛔  ถึงขีดจำกัด ${SYSTEM_CONFIG.limits.maxSessions} เซสชัน`,
                    ephemeral: true,
                });
            }

            await interaction.deferReply({ ephemeral: true });

            const token = interaction.fields.getTextInputValue("token").trim();
            const serverId = interaction.fields.getTextInputValue("server").trim();
            const voiceId = interaction.fields.getTextInputValue("voice").trim();

            if (!token || !serverId || !voiceId) {
                return interaction.editReply({ content: "> ⛔  กรุณากรอกข้อมูลให้ครบทุกช่อง" });
            }

            try {
                await voiceWorker.startSession(token, serverId, voiceId);

                await sendLog(
                    interaction.guild,
                    new MessageEmbed()
                        .setColor("#2b2d31")
                        .setTitle("⚡  เซสชันใหม่เริ่มทำงาน")
                        .setDescription(
                            "> **การดำเนินการ**: สร้างและเริ่มต้นเซสชันใหม่\n" +
                            "> **สถานะ**: กำลังเชื่อมต่อห้องเสียง"
                        )
                        .addFields(
                            {
                                name: "👤  ผู้ดำเนินการ",
                                value: `\`\`\`yaml\nUser: ${interaction.user.tag}\nID: ${interaction.user.id}\n\`\`\``,
                                inline: false,
                            },
                            {
                                name: "🌐  ข้อมูลการเชื่อมต่อ",
                                value:
                                    `\`\`\`yaml\n` +
                                    `Server ID: ${serverId}\n` +
                                    `Voice ID: ${voiceId}\n` +
                                    `Timestamp: ${new Date().toLocaleString("th-TH")}\n` +
                                    `\`\`\``,
                                inline: false,
                            }
                        )
                        .setFooter({ text: interaction.guild.name })
                        .setTimestamp(),
                );

                await updatePanel();
                await interaction.editReply({
                    content: "> ⚡  เริ่มเซสชันสำเร็จ — กำลังเชื่อมต่อระบบออนช่องเสียง",
                });
            } catch (err) {
                console.error("❌ [SESSION] Start error:", err.message);
                const errMsg = {
                    INVALID_TOKEN_FORMAT: "> ⛔  รูปแบบ Token ไม่ถูกต้อง",
                    SESSION_EXISTS: "> ⛔  เซสชันนี้มีอยู่แล้วในระบบ",
                    LOGIN_FAIL: "> ⛔  Token ไม่ถูกต้อง หรือบัญชีถูกระงับ",
                    LOGIN_TIMEOUT: "> ⛔  หมดเวลาการเชื่อมต่อ — กรุณาลองใหม่อีกครั้ง",
                    SESSION_NOT_FOUND: "> ⛔  เกิดข้อผิดพลาดภายใน — กรุณาลองใหม่",
                }[err.message] ?? "> ⛔  เกิดข้อผิดพลาดที่ไม่คาดคิด — กรุณาลองใหม่อีกครั้ง";

                await interaction.editReply({ content: errMsg });
            }
        }
    } catch (err) {
        console.error("❌ [INTERACTION] Handler error:", err.message);
        try {
            if (interaction.deferred) {
                await interaction.editReply({ content: "> ⛔  เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง" });
            } else if (!interaction.replied) {
                await interaction.reply({
                    content: "> ⛔  เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง",
                    ephemeral: true,
                });
            }
        } catch {}
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  🔄  PANEL AUTO-UPDATE DAEMON
// ════════════════════════════════════════════════════════════════════════════
setInterval(() => {
    updatePanel().catch((err) => console.error("❌ [PANEL] Auto-update error:", err.message));
}, 15_000);

// ════════════════════════════════════════════════════════════════════════════
//  💓  VOICE HEALTH CHECK DAEMON
// ════════════════════════════════════════════════════════════════════════════
setInterval(() => {
    if (!clientReady) return;
    voiceWorker.healthCheck().catch((err) => console.error("❌[HEALTH] Check error:", err.message));
}, 30_000);

// ════════════════════════════════════════════════════════════════════════════
//  🧹  AUTO-CLEANUP DAEMON (เคลียร์เซสชันค้าง)
// ════════════════════════════════════════════════════════════════════════════
setInterval(() => {
    // เคลียร์เซสชันที่ทำงานเกิน 24 ชั่วโมง (86400000 ms)
    sessionManager.cleanupIdleSessions(24 * 60 * 60 * 1000);
}, 3600_000); // เช็คทุกๆ 1 ชั่วโมง

// ════════════════════════════════════════════════════════════════════════════
//  🔁  CLIENT ERROR HANDLERS
// ════════════════════════════════════════════════════════════════════════════
client.on("error", (err) => console.error("❌ [CLIENT] Error:", err.message));
client.on("warn", (msg) => console.warn("⚠️  [CLIENT] Warning:", msg));

// ════════════════════════════════════════════════════════════════════════════
//  🛑  GRACEFUL SHUTDOWN
// ════════════════════════════════════════════════════════════════════════════
async function shutdown(signal) {
    console.log(`\n⚠️  [SHUTDOWN] Received ${signal} — initiating cleanup...`);
    clientReady = false;

    try {
        await voiceWorker.stopAll();
        client.destroy();
        console.log("✅ [SHUTDOWN] Cleanup complete");
    } catch (err) {
        console.error("❌ [SHUTDOWN] Error during cleanup:", err.message);
    }

    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ════════════════════════════════════════════════════════════════════════════
//  🔐  CLIENT LOGIN WITH AUTO-RETRY
// ════════════════════════════════════════════════════════════════════════════
async function startBot() {
    try {
        await client.login(process.env.TOKEN_MANAGER);
    } catch (err) {
        console.error("❌ [LOGIN] Authentication failed:", err.message);
        console.log("🔁 [LOGIN] Retrying in 10 seconds...");
        setTimeout(startBot, 10_000);
    }
}

startBot();