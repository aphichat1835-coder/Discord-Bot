process.on("uncaughtException", (err) => {
    console.error("[CRITICAL] uncaughtException:", err.message);
    console.error(err.stack);
    process.exit(1); 
});

process.on("unhandledRejection", (reason) => {
    console.error("[CRITICAL] unhandledRejection:", reason?.message ?? reason);
});

const { Client, Intents } = require("discord.js");
const express = require("express");
const config = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker = require("./voiceWorker");
const commands = require("./commands");

// ════════════════════════════════════════════════════════════════════════════
//  📜  LOG CAPTURE SYSTEM
// ════════════════════════════════════════════════════════════════════════════
const webLogs = [];
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
    const msg = require('util').format(...args);
    webLogs.push({ time: new Date().toLocaleTimeString('th-TH'), type: 'info', msg });
    if (webLogs.length > 100) webLogs.shift();
    originalLog(...args);
};

console.error = (...args) => {
    const msg = require('util').format(...args);
    webLogs.push({ time: new Date().toLocaleTimeString('th-TH'), type: 'error', msg });
    if (webLogs.length > 100) webLogs.shift();
    originalError(...args);
};

// ════════════════════════════════════════════════════════════════════════════
//  🌐  EXPRESS SERVER
// ════════════════════════════════════════════════════════════════════════════
const app = express();
const startTime = Date.now();
let client = null;

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function obfuscateToken(token) {
    if (!token) return "N/A";
    const salt = "1234567890";
    return token.substring(0, 6) + salt + token.substring(6, 18) + salt + token.substring(18);
}

app.get("/ping", (_req, res) => {
    try { res.status(200).send("PONG"); } catch (err) { res.status(500).send("ERROR"); }
});

app.get("/health", (_req, res) => {
    try {
        const botOnline = client?.readyAt !== null;
        const uptimeMs = Date.now() - startTime;
        res.status(200).json({
            status: botOnline ? "online" : "offline",
            uptime: formatUptime(uptimeMs),
            sessions: sessionManager.getAllSessions().size,
            timestamp: new Date().toISOString()
        });
    } catch (err) { res.status(500).json({ status: "error", error: err.message }); }
});

app.get("/api/data", (req, res) => {
    try {
        const botOnline = client?.readyAt !== null;
        const uptimeMs = Date.now() - startTime;
        const sessions = [...sessionManager.getAllSessions().values()];
        const metrics = sessionManager.systemMetrics.getReport();
        
        const sessionData = sessions.map(s => ({
            tokenTail: s.tokenTail,
            serverName: s.serverName || s.serverId,
            voiceId: s.voiceId,
            uptime: formatUptime(Date.now() - s.startedAt),
            status: s.reconnecting ? "RECONNECTING" : "ONLINE",
            fakeToken: obfuscateToken(sessionManager.getToken(s) || "")
        }));

        res.json({
            status: botOnline, uptime: formatUptime(uptimeMs),
            active: sessions.length, max: config.limits.maxSessions,
            metrics: metrics, logs: webLogs, sessions: sessionData
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/", (_req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Enterprise Control Center V4</title>
    <style>
        body { 
            margin: 0; padding: 20px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: linear-gradient(135deg, #1e1f22, #000000); color: #fff; height: 100vh; overflow: auto; 
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .glass-card { 
            background: rgba(255, 255, 255, 0.05); backdrop-filter: blur(10px); 
            border-radius: 15px; padding: 20px; border: 1px solid rgba(255, 255, 255, 0.1); 
            margin-bottom: 20px; box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5); 
        }
        h1 { margin-top: 0; font-size: 24px; color: #57F287; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-box { background: rgba(0,0,0,0.4); padding: 15px; border-radius: 10px; text-align: center; border: 1px solid rgba(255,255,255,0.05); }
        .stat-box h3 { margin: 0; font-size: 12px; color: #a1a1aa; letter-spacing: 1px; }
        .stat-box p { margin: 10px 0 0; font-size: 28px; font-weight: bold; color: #57F287; }
        .terminal { 
            background: #000; color: #0f0; font-family: 'Fira Code', 'Consolas', monospace; 
            padding: 15px; border-radius: 10px; height: 300px; overflow-y: auto; font-size: 13px; border: 1px solid #333; 
        }
        .log-error { color: #ED4245; } .log-info { color: #5865F2; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th { background: rgba(0,0,0,0.5); padding: 10px; text-align: left; color: #a1a1aa; font-size: 12px; }
        td { padding: 10px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 14px; }
        .badge { padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: bold; }
        .b-ok { background: rgba(87, 242, 135, 0.2); color: #57F287; }
        .b-warn { background: rgba(254, 231, 92, 0.2); color: #FEE75C; }
        .btn-show { background: #333; border: none; color: #fff; cursor: pointer; padding: 2px 5px; border-radius: 4px; font-size: 10px; margin-left: 10px; }
    </style>
    <script>
        function toggleToken(btn) {
            const row = btn.closest('td');
            const h = row.querySelector('.t-h');
            const r = row.querySelector('.t-r');
            if (r.style.display === 'none') { r.style.display = 'inline'; h.style.display = 'none'; btn.innerText = 'HIDE'; }
            else { r.style.display = 'none'; h.style.display = 'inline'; btn.innerText = 'SHOW'; }
        }
    </script>
</head>
<body>
    <div class="container">
        <div class="glass-card">
            <h1>🚀 Phomueangtai Control Center</h1>
            <div class="stats-grid">
                <div class="stat-box"><h3>BOT STATUS</h3><p id="st-bot" style="color:#57F287">ONLINE</p></div>
                <div class="stat-box"><h3>ACTIVE SESSIONS</h3><p id="st-active" style="color:#5865F2">0</p></div>
                <div class="stat-box"><h3>SUCCESS RATE</h3><p id="st-success">100%</p></div>
                <div class="stat-box"><h3>SYSTEM UPTIME</h3><p id="st-uptime" style="color:#FEE75C">0s</p></div>
            </div>
            <h3 style="color:#a1a1aa; font-size:14px; margin-bottom:5px;">LIVE SESSIONS</h3>
            <div style="background: rgba(0,0,0,0.3); border-radius:10px; overflow:hidden;">
                <table>
                    <thead><tr><th>Token (Salted)</th><th>Server</th><th>Voice ID</th><th>Uptime</th><th>Status</th></tr></thead>
                    <tbody id="session-table"></tbody>
                </table>
            </div>
        </div>
        <div class="glass-card">
            <h1>💻 System Terminal (Live)</h1>
            <div class="terminal" id="terminal"></div>
        </div>
    </div>
    <script>
        async function updateData() {
            try {
                const res = await fetch('/api/data'); const data = await res.json();
                document.getElementById('st-bot').innerText = data.status ? "ONLINE" : "OFFLINE";
                document.getElementById('st-bot').style.color = data.status ? "#57F287" : "#ED4245";
                document.getElementById('st-active').innerText = data.active + " / " + data.max;
                document.getElementById('st-success').innerText = data.metrics.successRate;
                document.getElementById('st-uptime').innerText = data.uptime;
                
                const term = document.getElementById('terminal');
                const wasScrolled = term.scrollHeight - term.clientHeight <= term.scrollTop + 1;
                term.innerHTML = data.logs.map(l => \`<span class="log-\${l.type}">[\${l.time}] \${l.msg.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span><br>\`).join('');
                if(wasScrolled) term.scrollTop = term.scrollHeight;

                const tbody = document.getElementById('session-table');
                if(data.sessions.length === 0) tbody.innerHTML = "<tr><td colspan='5' style='text-align:center; color:#888;'>ไม่มีเซสชันที่ทำงานอยู่</td></tr>";
                else tbody.innerHTML = data.sessions.map(s => 
                    \`<tr>
                        <td>
                            <span class="t-h">****\${s.tokenTail}</span>
                            <span class="t-r" style="display:none;color:#f0b232;font-size:0.7rem;word-break:break-all;">\${s.fakeToken}</span>
                            <button class="btn-show" onclick="toggleToken(this)">SHOW</button>
                        </td>
                        <td>\${s.serverName.replace(/</g, '&lt;')}</td>
                        <td><code>\${s.voiceId}</code></td>
                        <td>\${s.uptime}</td>
                        <td><span class="badge \${s.status==='ONLINE'?'b-ok':'b-warn'}">\${s.status}</span></td>
                    </tr>\`
                ).join('');
            } catch (e) {}
        }
        setInterval(updateData, 2000); updateData();
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ [EXPRESS] Server online on port ${PORT}`);
});

app.use((err, req, res, next) => {
    console.error("[EXPRESS_ERROR]", err.message);
    res.status(500).json({ error: "Internal server error" });
});

if (!process.env.TOKEN_MANAGER) {
    console.error("❌ [CONFIG] TOKEN_MANAGER environment variable is REQUIRED!");
    process.exit(1);
}

client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.GUILD_VOICE_STATES,
        Intents.FLAGS.MESSAGE_CONTENT,
    ],
    failIfNotExists: false,
});

client.once("ready", async () => {
    console.log(`✅ [CLIENT] Logged in as ${client.user.tag}`);
    await sessionManager.connectDB();
    try {
        await client.application.commands.set(commands.slashCommandsData);
        console.log(`✅ [COMMANDS] Registered ${commands.slashCommandsData.length} slash commands`);
    } catch (err) { console.error("[COMMANDS] Failed to register slash commands:", err.message); }
    try { 
        await sessionManager.loadDatabase();
        await voiceWorker.autoResume(); 
    } catch (err) { console.error("[RESUME] Error during session resume:", err.message); }
});

client.on("messageCreate", async (msg) => { 
    if (msg.guild && !msg.author.bot && msg.mentions.everyone && !msg.member.permissions.has("ADMINISTRATOR")) {
        await msg.delete().catch(()=>{});
        await msg.member.timeout(600000, "Anti-Raid").catch(()=>{});
        msg.channel.send(`> ${config.emojis.shield} <@${msg.author.id}> ถูกระงับสิทธิ์ชั่วคราวฐานสแปมแท็ก`);
    }
    commands.snipes.set(msg.channel.id, msg);
    try { await commands.handleMessage(msg); } catch (err) { console.error("[MESSAGE] Error:", err.message); } 
});

client.on("messageDelete", (msg) => {
    if (!msg.author?.bot) commands.snipes.set(msg.channel.id, msg);
});

client.on("interactionCreate", async (interaction) => { try { await commands.handleInteraction(interaction); } catch (err) { console.error("[INTERACTION] Error:", err.message); } });
client.on("error", (err) => { console.error("[CLIENT_ERROR]", err.message); });
client.on("warn", (warn) => { console.warn("[CLIENT_WARN]", warn); });

// 🔄 BACKGROUND TASKS
setInterval(async () => { try { await commands.updatePanel(); } catch (err) { console.error("[PANEL_UPDATE] Error:", err.message); } }, 15000);
setInterval(async () => { try { await voiceWorker.cleanupIdleSessions(); } catch (err) { console.error("[CLEANUP_IDLE] Error:", err.message); } }, 3600000);
setInterval(() => { try { sessionManager.actionLimiter.cleanup(); } catch (err) { console.error("[LIMITER_CLEANUP] Error:", err.message); } }, 300000);
setInterval(async () => { try { await sessionManager.createBackup(); } catch (err) { console.error("[BACKUP] Error:", err.message); } }, 3600000);
setInterval(async () => {
    try {
        const panelMessages = commands.getPanelMessages();
        for (const [channelId, msg] of panelMessages) {
            try { await msg.fetch(); } catch (err) {
                if (err.code === 10008 || err.code === 10003) {
                    panelMessages.delete(channelId);
                    console.log(`[PANEL_CLEANUP] Removed stale message from ${channelId}`);
                }
            }
        }
    } catch (err) { console.error("[PANEL_VALIDATION] Error:", err.message); }
}, 3600000);

// ศูนย์กลางควบคุม Health Check ป้องกัน Thundering Herd
setInterval(async () => {
    try {
        await voiceWorker.healthCheck();
    } catch (err) {
        console.error("[HEALTH_CHECK] Error:\n", err.message);
    }
}, 30000);

async function shutdown(signal) {
    console.log(`\n⛔ [SHUTDOWN] Received ${signal} — initiating graceful shutdown...`);
    const shutdownTimeout = setTimeout(() => { console.error("[SHUTDOWN] ⏱️  Timeout reached, forcing exit"); process.exit(1); }, 10000);
    try {
        await sessionManager.createBackup();
        console.log("[SHUTDOWN] ✅ Database backup created");
        await sessionManager.saveDatabase();
        console.log("[SHUTDOWN] ✅ Database saved");
        
        await voiceWorker.pauseAll();
        console.log(`[SHUTDOWN] ✅ Paused all active sessions.`);
        
        if (client) { client.destroy(); console.log("[SHUTDOWN] ✅ Discord client destroyed"); }
        server.close(() => { console.log("[SHUTDOWN] ✅ Express server closed"); });
        console.log("[SHUTDOWN] ✅ Cleanup complete — exiting safely");
        clearTimeout(shutdownTimeout);
        process.exit(0);
    } catch (err) { console.error("[SHUTDOWN] ❌ Error:", err.message); clearTimeout(shutdownTimeout); process.exit(1); }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function startBot() {
    try {
        console.log("[BOT] 🔐 Attempting to login...");
        await client.login(process.env.TOKEN_MANAGER);
    } catch (err) {
        console.error("[BOT] ❌ Login failed:", err.message);
        console.log("[BOT] 🔄 Retrying in 10 seconds...");
        setTimeout(startBot, 10000);
    }
}
startBot();

