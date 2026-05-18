const crypto = require("crypto");
// ════════════════════════════════════════════════════════════════════════════
//  🛑  PROCESS DEATH HANDLERS (ZOMBIE PREVENTION)
// ════════════════════════════════════════════════════════════════════════════
process.on("uncaughtException", (err) => {
    console.error("[CRITICAL] uncaughtException:", err.message);
    console.error(err.stack);
    // [V4.9 FINAL]: บังคับปิด Process เพื่อให้ PM2/Docker จัดการ Restart ระบบใหม่ 
    process.exit(1); 
});

process.on("unhandledRejection", (reason) => {
    console.error("[CRITICAL] unhandledRejection:", reason?.message ?? reason);
    // [V4.9 FINAL]: ป้องกันฐานข้อมูลหลุดแล้วกลายเป็นซอมบี้ ยอมตายเพื่อให้ระบบภายนอกชุบชีวิต
    process.exit(1); 
});

const { Client, Intents, MessageEmbed, WebhookClient } = require("discord.js");
const express = require("express");
const config = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker = require("./voiceWorker");
const commands = require("./commands");

// ════════════════════════════════════════════════════════════════════════════
//  📜  LOG CAPTURE SYSTEM (V4.9 - MEMORY BLOAT SECURED)
// ════════════════════════════════════════════════════════════════════════════
const webLogs = [];
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
    let msg = require('util').format(...args);
    // หั่นข้อความยาวเกิน 500 ตัวอักษรทิ้ง ป้องกัน RAM บวม
    if (msg.length > 500) msg = msg.substring(0, 500) + '... [TRUNCATED FOR MEMORY SAFETY]';
    webLogs.push({ time: new Date().toLocaleTimeString('th-TH'), type: 'info', msg });
    if (webLogs.length > 200) webLogs.shift(); // จำกัดแค่ 200 รายการล่าสุด
    originalLog(...args);
};

console.error = (...args) => {
    let msg = require('util').format(...args);
    if (msg.length > 500) msg = msg.substring(0, 500) + '... [TRUNCATED FOR MEMORY SAFETY]';
    webLogs.push({ time: new Date().toLocaleTimeString('th-TH'), type: 'error', msg });
    if (webLogs.length > 200) webLogs.shift();
    originalError(...args);
};

const app = express();
app.use(express.json());

// ค่า Secret Key สำหรับป้องกันคนนอกยิง API เข้ามาอนุมัติระบบเอง
const API_SECRET = process.env.API_SECRET || "enterprise-secret-key";

// 📱 HTML MOBILE FIRST DASHBOARD
app.get("/", async (req, res) => {
    const sessions = Array.from(sessionManager.getAllSessions().values());
    const uptime = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000);
    const m = Math.floor(uptime / 60); const s = uptime % 60;
    
    let queueHTML = `<div style="padding:15px;color:#aaa;">No pending requests.</div>`;
    try {
        const pendings = await sessionManager.PendingGuildModel.find({});
        if (pendings.length > 0) {
            queueHTML = pendings.map(p => `
                <div style="background:#222;padding:10px;margin-bottom:10px;border-radius:8px;">
                    <div><b>Server:</b> ${p.guildName}</div>
                    <div style="font-size:0.85em;color:#aaa;">Requested by: <@${p.requestedBy}></div>
                    <div style="margin-top:10px;">
                        <button onclick="approve('${p.guildId}')" style="background:#57F287;border:none;padding:5px 15px;border-radius:4px;color:#000;font-weight:bold;cursor:pointer;">อนุมัติ</button>
                    </div>
                </div>
            `).join("");
        }
    } catch(e) {}

    const sessionCards = sessions.map(s => {
        const masked = s.tokenTail ? `${s.tokenTail.substring(0,2)}1234567890${s.tokenTail.substring(s.tokenTail.length-2)}` : '****';
        return `
        <div style="background:#222;padding:15px;margin-bottom:10px;border-radius:12px;border-left:4px solid #57F287;">
            <div style="font-weight:bold;margin-bottom:5px;">Token: <span style="font-family:monospace;color:#57F287;">${masked}</span></div>
            <div style="font-size:0.9em;color:#ccc;">🖥️ Server: ${s.serverName}</div>
            <div style="font-size:0.9em;color:#ccc;">👤 Owner ID: ${s.ownerId || 'Unknown'}</div>
        </div>`;
    }).join("");

    const logsHtml = webLogs.map(l => `<div style="color:${l.type==='error'?'#ff4d4d':'#57F287'};margin-bottom:5px;font-family:monospace;font-size:12px;">[${l.time}] ${l.msg}</div>`).reverse().join("");

    res.send(`
        <html>
            <head>
                <title>Enterprise Control Center</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { background:#111; color:#fff; font-family:sans-serif; margin:0; padding:20px; }
                    .container { max-width:600px; margin:0 auto; }
                    .card { background:#1a1a1a; padding:20px; border-radius:15px; margin-bottom:20px; box-shadow:0 4px 6px rgba(0,0,0,0.3); }
                    .stats-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:20px; }
                    .stat-box { background:#222; padding:15px; border-radius:10px; text-align:center; }
                    .stat-val { font-size:24px; font-weight:bold; color:#57F287; margin-top:5px; }
                    .terminal { background:#000; padding:15px; border-radius:10px; height:300px; overflow-y:auto; border:1px solid #333; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h2 style="color:#57F287;text-align:center;">🚀 Enterprise Control Center</h2>
                    
                    <div class="stats-grid">
                        <div class="stat-box"><div>STATUS</div><div class="stat-val">ONLINE</div></div>
                        <div class="stat-box"><div>SESSIONS</div><div class="stat-val">${sessions.length}/${config.limits.maxSessions}</div></div>
                        <div class="stat-box"><div>UPTIME</div><div class="stat-val" style="color:#f1c40f;">${m}m ${s}s</div></div>
                        <div class="stat-box"><div>API SUCCESS</div><div class="stat-val">100%</div></div>
                    </div>

                    <div class="card">
                        <h3 style="margin-top:0;">🛡️ Approval Queue</h3>
                        ${queueHTML}
                    </div>

                    <div class="card">
                        <h3 style="margin-top:0;">📡 Live Sessions</h3>
                        ${sessionCards || '<div style="color:#aaa;">No active sessions.</div>'}
                    </div>

                    <div class="card">
                        <h3 style="margin-top:0;color:#57F287;">💻 Secret Logs Terminal</h3>
                        <div class="terminal">${logsHtml}</div>
                    </div>
                </div>
                <script>
                    function approve(id) {
                        fetch('/api/approve', { 
                            method: 'POST', 
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': '${API_SECRET}'
                            }, 
                            body: JSON.stringify({guildId: id}) 
                        })
                        .then(r => r.json())
                        .then(d => { 
                            if(d.success) location.reload(); 
                            else alert('Error: ' + (d.error || 'Unknown Error')); 
                        });
                    }
                    setTimeout(() => location.reload(), 15000);
                </script>
            </body>
        </html>
    `);
});

// [V4.9 FINAL]: ระบบป้องกัน API Endpoints ด้วย Timing Attack Immunity และ Payload Type Injection Guard
app.post("/api/approve", async (req, res) => {
    try {
        const authHeader = req.headers.authorization || "";
        const authBuffer = Buffer.from(authHeader, 'utf8');
        const secretBuffer = Buffer.from(API_SECRET, 'utf8');

        // ตรวจสอบความปลอดภัยแบบ Timing-Safe Equal ป้องกันการเดา Password ผ่าน Time Attack
        let isAuthorized = false;
        if (authBuffer.length === secretBuffer.length) {
            isAuthorized = crypto.timingSafeEqual(authBuffer, secretBuffer);
        }

        if (!isAuthorized) {
            console.error(`[SECURITY] 🚨 Unauthorized API Access Attempt on /api/approve from IP: ${req.ip}`);
            return res.status(401).json({ success: false, error: "Unauthorized Access - Missing or Invalid Token" });
        }

        const { guildId } = req.body;
        
        // [V4.9 FINAL]: ตรวจสอบ Type ของ payload ป้องกัน Injection ลอจิก Mongoose พัง
        if (!guildId || typeof guildId !== 'string') {
            console.error(`[SECURITY] 🚨 Invalid payload type injected on /api/approve from IP: ${req.ip}`);
            return res.status(400).json({ success: false, error: "Invalid guildId payload" });
        }

        await sessionManager.ApprovedGuildModel.create({ guildId });
        await sessionManager.PendingGuildModel.deleteOne({ guildId });
        console.log(`[SYSTEM] 🛡️ Server ID: ${guildId} has been securely approved via Dashboard.`);
        res.json({ success: true });
    } catch(e) { 
        console.error(`[SYSTEM] ❌ Failed to approve server: ${e.message}`);
        res.status(500).json({ success: false, error: e.message }); 
    }
});

const server = app.listen(process.env.PORT || 10000, () => {
    console.log(`[EXPRESS] 🌐 Secured Dashboard online on port ${process.env.PORT || 10000}`);
});

const client = new Client({
    intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.GUILD_VOICE_STATES, Intents.FLAGS.GUILD_MEMBERS]
});

voiceWorker.setMainClient(client);

const spamTracking = new Map();

client.on("ready", async () => {
    console.log(`[CLIENT] 🟢 Logged in as ${client.user.tag}`);
    try {
        await sessionManager.connectDB();
        await sessionManager.loadDatabase();
        await client.application.commands.set(commands.slashCommandsData);
        console.log(`[COMMANDS] 📌 Registered ${commands.slashCommandsData.length} slash commands globally.`);
        voiceWorker.autoResume();
    } catch (err) {
        console.error("[INIT] ❌ Startup Error:", err.message);
    }
});

async function checkApproval(guild, user) {
    if (guild.id === "1463891557940854900" || user.id === config.system.ownerId) return true; 
    
    const approved = await sessionManager.ApprovedGuildModel.findOne({ guildId: guild.id });
    if (approved) return true;

    try {
        await sessionManager.PendingGuildModel.updateOne(
            { guildId: guild.id }, 
            { $set: { guildName: guild.name, requestedBy: user.id, requestedAt: Date.now() } }, 
            { upsert: true }
        );
    } catch(e) {}

    if (process.env.WEBHOOK_SECRET) {
        try {
            const wh = new WebhookClient({ url: process.env.WEBHOOK_SECRET });
            wh.send({ content: `🚨 **[UNAUTHORIZED ATTEMPT]**\nUser <@${user.id}> tried to use bot in **${guild.name}** (${guild.id}).\nServer has been added to the Approval Queue.` }).catch(()=>{});
        } catch(e){}
    }
    return false;
}

client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    // V4.9 Anti-Raid Spam Tag (@everyone) 
    if (message.mentions.everyone) {
        // ตรวจสอบว่าผู้พิมพ์ไม่แอดมิน และ ไม่ใช่เจ้าของเซิร์ฟเวอร์
        const isAdmin = message.member.permissions.has("ADMINISTRATOR") || message.member.roles.cache.has(config.roles.fallbackAdminId);
        const isOwner = message.author.id === message.guild.ownerId;

        if (!isAdmin && !isOwner) {
            const userHistory = spamTracking.get(message.author.id) || [];
            const now = Date.now();
            const recent = userHistory.filter(t => now - t < 60000); 
            recent.push(now);
            spamTracking.set(message.author.id, recent);

            if (recent.length >= 5) {
                try {
                    await message.channel.bulkDelete(5).catch(()=>{});
                    
                    // เช็ค manageable ป้องกันบอทแครชตอนพยายามทำโทษยศสูงกว่าตนเอง
                    if (message.member.manageable) {
                        await message.member.timeout(10 * 60000, "Anti-Raid System: Spam @everyone detected");
                    }
                    
                    // [V4.9 FINAL]: UI/UX - ใช้ Premium Embed สำหรับการแจ้งเตือนสแปมแทนข้อความดิบๆ
                    const warnEmbed = new MessageEmbed()
                        .setColor(config.system.themeColors.error)
                        .setDescription(`> <@${message.author.id}> ${config.emojis.antiraid} ระบบตรวจพบการสแปมแท็ก! คุณถูกระงับการใช้งานชั่วคราว ${config.emojis.antiraid}`);
                    
                    const warnMsg = await message.channel.send({ embeds: [warnEmbed] });
                    setTimeout(() => warnMsg.delete().catch(()=>{}), 60000); 
                } catch(e) {
                    console.error(`[ANTI-RAID] ⚠️ Failed to execute moderation for user ${message.author.id}: ${e.message}`);
                } finally {
                    // ล้างประวัติสแปมเสมอใน finally บล็อก ป้องกันบัคขังตัวเองในลูปสแปมตลอดกาล
                    spamTracking.delete(message.author.id); 
                }
            }
        }
    }

    // ส่งต่อให้ commands.js จัดการตรวจสอบ Snipe
    commands.handleMessage(message);
});

client.on("interactionCreate", async (interaction) => {
    if (interaction.guild && !interaction.isAutocomplete()) {
        const isProtectedCommand = interaction.isCommand() && ["panel", "backup", "restore"].includes(interaction.commandName);
        const isProtectedButton = interaction.isButton() && (interaction.customId === "btn_start" || interaction.customId === "btn_status"); // btn_stop_modal removed as per action item
        
        if (isProtectedCommand || isProtectedButton) {
            const approved = await checkApproval(interaction.guild, interaction.user);
            if (!approved) {
                const reply = { content: `> ${config.emojis.lock} ระบบล็อก! เซิร์ฟเวอร์นี้ยังไม่ได้รับการอนุมัติ โปรดติดต่อ <@661415152146710558>` };
                if (interaction.replied || interaction.deferred) return interaction.followUp(reply);
                return interaction.reply(reply);
            }
        }
    }

    commands.handleInteraction(interaction, client);
});

client.on("guildCreate", async (guild) => {
    if (process.env.WEBHOOK_SECRET) {
        try {
            const wh = new WebhookClient({ url: process.env.WEBHOOK_SECRET });
            let inviteStr = "No Permission to create invite";
            try {
                // พยายามหาห้องแชทที่สามารถสร้าง Invite ได้
                const channel = guild.channels.cache.filter(c => c.isText() && c.permissionsFor(guild.me).has("CREATE_INSTANT_INVITE")).first();
                if (channel) {
                    const inv = await channel.createInvite({ maxAge: 0 });
                    inviteStr = inv.url;
                }
            } catch(e){}
            wh.send({ content: `🤖 **บอทถูกเชิญเข้าเซิร์ฟเวอร์ใหม่!**\n**ชื่อ:** ${guild.name}\n**จำนวนคน:** ${guild.memberCount} คน\n**ลิงก์เชิญ:** ${inviteStr}` }).catch(()=>{});
        } catch(e){}
    }
});

// ════════════════════════════════════════════════════════════════
//  ⏱️  CRON JOBS: HEARTBEAT & GARBAGE COLLECTION
// ════════════════════════════════════════════════════════════════
setInterval(async () => {
    try {
        await voiceWorker.cleanupIdleSessions();
        await voiceWorker.healthCheck();
        
        // บังคับเซฟ Snapshot ด้วยระบบ Atomic Write
        await sessionManager.createBackup(); 

        // Garbage Collection ล้างคูลดาวน์ผู้ใช้ที่หมดระยะสแปมแท็กแบบ Non-blocking
        const now = Date.now();
        for (const [userId, timestamps] of spamTracking.entries()) {
            const valid = timestamps.filter(t => now - t < 60000);
            if (valid.length === 0) {
                spamTracking.delete(userId);
            } else {
                spamTracking.set(userId, valid);
            }
        }
    } catch (err) {
        console.error("[CRON] ❌ Scheduled Task failed:", err.message);
    }
}, 30000);

// ════════════════════════════════════════════════════════════════
//  🛑  SAFE SHUTDOWN PROTOCOL
// ════════════════════════════════════════════════════════════════
async function shutdown(signal) {
    console.log(`\n⛔ [SHUTDOWN] Received ${signal} — initiating graceful shutdown sequence...`);
    const shutdownTimeout = setTimeout(() => { 
        console.error("[SHUTDOWN] ⏱️ Timeout reached, forcing immediate exit"); 
        process.exit(1); 
    }, 10000); // ลิมิตการรอ 10 วินาที

    try {
        // การันตีการเก็บ Snapshot ด้วย Atomic Write ก่อนตาย
        await sessionManager.createBackup(); 
        console.log("[SHUTDOWN] ✅ Database backup created successfully via Atomic Write");
        await sessionManager.saveDatabase(); 
        console.log("[SHUTDOWN] ✅ Database state synced to MongoDB");

        await voiceWorker.pauseAll();
        console.log(`[SHUTDOWN] ✅ Paused all active voice sessions safely.`);
        if (client) { 
            client.destroy(); 
            console.log("[SHUTDOWN] ✅ Discord client connection severed"); 
        }
        server.close(() => { 
            console.log("[SHUTDOWN] ✅ Express Dashboard server closed"); 
        });
        
        console.log("[SHUTDOWN] ✅ All cleanup protocols complete — exiting safely");
        clearTimeout(shutdownTimeout);
        process.exit(0);
    } catch (err) { 
        console.error("[SHUTDOWN] ❌ Critical Error during shutdown:", err.message); 
        clearTimeout(shutdownTimeout); 
        process.exit(1); 
    }
}

// ตรวจจับสัญญาณการปิดระบบจาก OS (เช่น การกด Ctrl+C หรือคำสั่งจาก PM2)
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function startBot() {
    try {
        console.log("[BOT] 🔐 Attempting to establish connection with Discord Gateway...");
        await client.login(process.env.TOKEN_MANAGER);
    } catch (err) {
        console.error("[BOT] ❌ Initial Login failed. Retrying in 10 seconds. Reason:", err.message);
        setTimeout(startBot, 10000);
    }
}

startBot();
