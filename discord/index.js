process.on("uncaughtException", (err) => {
    console.error("[CRITICAL] uncaughtException:", err.message);
    console.error(err.stack);
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
    const msg = args.join(' ');
    webLogs.push({ time: new Date().toLocaleTimeString('th-TH'), type: 'info', msg });
    if (webLogs.length > 100) webLogs.shift();
    originalLog(...args);
};

console.error = (...args) => {
    const msg = args.join(' ');
    webLogs.push({ time: new Date().toLocaleTimeString('th-TH'), type: 'error', msg });
    if (webLogs.length > 100) webLogs.shift();
    originalError(...args);
};

// ════════════════════════════════════════════════════════════════════════════
//  🌐  EXPRESS SERVER (FOR UPTIMEROBOT & DASHBOARD)
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

// ✅ ฟังก์ชันแทรกเลข 1234567890 ใน Token
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

app.get("/", (_req, res) => {
    try {
        const sessions = [...sessionManager.getAllSessions().values()];
        const metrics = sessionManager.systemMetrics.getReport();
        const botOnline = client?.readyAt !== null;
        const uptimeMs = Date.now() - startTime;

        const sessionRows = sessions.length ? sessions.map(s => {
            const fullToken = sessionManager.getToken(s) || "";
            const fakeToken = obfuscateToken(fullToken);
            return `
            <tr>
                <td>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span class="t-h">****${s.tokenTail}</span>
                        <span class="t-r" style="display:none;color:#f0b232;font-size:0.7rem;word-break:break-all;">${fakeToken}</span>
                        <button onclick="tgl(this)" style="background:#333;border:none;color:#fff;cursor:pointer;padding:2px 5px;border-radius:4px;font-size:10px;">SHOW</button>
                    </div>
                </td>
                <td><span style="background:#35373c;padding:3px 8px;border-radius:4px;">${s.serverName || s.serverId}</span></td>
                <td><code>${s.voiceId}</code></td>
                <td>${formatUptime(Date.now() - s.startedAt)}</td>
                <td><span class="badge ${s.reconnecting ? "warn" : "ok"}">${s.reconnecting ? "RECONNECTING" : "ONLINE"}</span></td>
            </tr>`;
        }).join("") : `<tr><td colspan="5" style="text-align:center;color:#888;padding:50px;">ไม่มีเซสชันที่ทำงานอยู่</td></tr>`;

        const logRows = webLogs.map(l => `
            <div style="margin-bottom:5px;border-left:2px solid ${l.type==='error'?'#f23f43':'#5865f2'};padding-left:10px;">
                <span style="color:#888;font-size:0.75rem;">[${l.time}]</span> 
                <span style="color:${l.type==='error'?'#ff7b72':'#79c0ff'};font-size:0.8rem;">${l.msg}</span>
            </div>
        `).reverse().join("");

        res.send(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30">
<title>Enterprise Control Center V4</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #0f1012; color: #dbdee1; padding: 24px; }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.6rem; color: #5865F2; margin-bottom: 5px; display: flex; align-items: center; gap: 10px; }
  .sub { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 28px; }
  .card { background: #1e1f22; border-radius: 12px; padding: 20px; border: 1px solid #2b2d31; transition: 0.3s; }
  .card:hover { border-color: #5865f2; }
  .card .label { font-size: 0.75rem; color: #949ba4; text-transform: uppercase; letter-spacing: .5px; font-weight: bold; }
  .card .value { font-size: 1.6rem; font-weight: 800; margin-top: 8px; }
  .green { color: #23a55a; } .yellow { color: #f0b232; } .blue { color: #5865F2; } .red { color: #f23f43; }
  .table-card { background: #1e1f22; border-radius: 12px; border: 1px solid #2b2d31; overflow: hidden; margin-bottom: 28px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #2b2d31; padding: 14px; text-align: left; font-size: 0.8rem; color: #949ba4; text-transform: uppercase; }
  td { padding: 14px; border-top: 1px solid #2b2d31; font-size: 0.85rem; }
  .badge { padding: 4px 12px; border-radius: 20px; font-size: 0.7rem; font-weight: 700; }
  .badge.ok { background: #1a3a2a; color: #23a55a; }
  .badge.warn { background: #3a2a1a; color: #f0b232; }
  .log-card { background: #000; border-radius: 12px; border: 1px solid #333; padding: 20px; }
  .log-container { height: 300px; overflow-y: auto; font-family: 'Consolas', monospace; }
  footer { margin-top: 40px; color: #4e5058; font-size: 0.8rem; text-align: center; border-top: 1px solid #2b2d31; padding-top: 20px; }
</style>
<script>
  function tgl(btn) {
    const p = btn.parentElement; const h = p.querySelector('.t-h'); const r = p.querySelector('.t-r');
    if (r.style.display === 'none') { r.style.display = 'inline'; h.style.display = 'none'; btn.innerText = 'HIDE'; }
    else { r.style.display = 'none'; h.style.display = 'inline'; btn.innerText = 'SHOW'; }
  }
</script>
</head>
<body>
<div class="container">
    <h1>🛡️ PHOMUEANGTAI ENTERPRISE V4</h1>
    <p class="sub">ระบบควบคุมการออนช่องเสียงอัตโนมัติ · อัปเดตล่าสุด: ${new Date().toLocaleString("th-TH")}</p>
    <div class="grid">
      <div class="card"><div class="label">สถานะบอทหลัก</div><div class="value ${botOnline ? "green" : "red"}">${botOnline ? "ONLINE" : "OFFLINE"}</div></div>
      <div class="card"><div class="label">เซสชันที่ใช้งาน</div><div class="value blue">${sessions.length} <span style="font-size:1rem;color:#4e5058">/ ${config.limits.maxSessions}</span></div></div>
      <div class="card"><div class="label">Success Rate</div><div class="value green">${metrics.successRate}</div></div>
      <div class="card"><div class="label">System Uptime</div><div class="value yellow" style="font-size:1.2rem;">${formatUptime(uptimeMs)}</div></div>
    </div>
    <div style="margin-bottom:10px; font-weight:bold; color:#949ba4; font-size:0.9rem;">📊 LIVE SESSION MONITOR</div>
    <div class="table-card"><table><thead><tr><th>Token (Salted)</th><th>เซิร์ฟเวอร์</th><th>Voice ID</th><th>เวลาทำงาน</th><th>สถานะ</th></tr></thead><tbody>${sessionRows}</tbody></table></div>
    <div style="margin-bottom:10px; font-weight:bold; color:#949ba4; font-size:0.9rem;">📜 SYSTEM TERMINAL LOGS</div>
    <div class="log-card"><div class="log-container">${logRows}</div></div>
    <footer>Phomueangtai Enterprise Edition • Version 4.0.1 • Running on Render Cloud</footer>
</div>
</body>
</html>`);
    } catch (err) { console.error("[DASHBOARD] Error:", err.message); res.status(500).send("<h1>Error loading dashboard</h1>"); }
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

client.on("ready", async () => {
    console.log(`✅ [CLIENT] Logged in as ${client.user.tag}`);
    await sessionManager.connectDB();
    try {
        await client.application.commands.set(commands.slashCommandsData);
        console.log(`✅ [COMMANDS] Registered ${commands.slashCommandsData.length} slash commands`);
    } catch (err) { console.error("[COMMANDS] Failed to register slash commands:", err.message); }
    try { await voiceWorker.autoResume(); } catch (err) { console.error("[RESUME] Error during session resume:", err.message); }
});

client.on("messageCreate", async (msg) => { try { await commands.handleMessage(msg); } catch (err) { console.error("[MESSAGE] Error:", err.message); } });
client.on("interactionCreate", async (interaction) => { try { await commands.handleInteraction(interaction); } catch (err) { console.error("[INTERACTION] Error:", err.message); } });
client.on("error", (err) => { console.error("[CLIENT_ERROR]", err.message); });
client.on("warn", (warn) => { console.warn("[CLIENT_WARN]", warn); });

// 🔄 BACKGROUND TASKS
setInterval(async () => { try { await commands.updatePanel(); } catch (err) { console.error("[PANEL_UPDATE] Error:", err.message); } }, 15000);
setInterval(async () => { try { await voiceWorker.healthCheck(); } catch (err) { console.error("[HEALTH_CHECK] Error:", err.message); } }, 30000);
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

// 🛑 GRACEFUL SHUTDOWN
async function shutdown(signal) {
    console.log(`\n⛔ [SHUTDOWN] Received ${signal} — initiating graceful shutdown...`);
    const shutdownTimeout = setTimeout(() => { console.error("[SHUTDOWN] ⏱️  Timeout reached, forcing exit"); process.exit(1); }, 10000);
    try {
        await sessionManager.createBackup();
        console.log("[SHUTDOWN] ✅ Database backup created");
        await sessionManager.saveDatabase();
        console.log("[SHUTDOWN] ✅ Database saved");
        const sessions = [...sessionManager.getAllSessions().keys()];
        if (sessions.length > 0) {
            await Promise.allSettled(sessions.map(id => voiceWorker.stopSession(id)));
            console.log(`[SHUTDOWN] ✅ Stopped ${sessions.length} sessions`);
        }
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
