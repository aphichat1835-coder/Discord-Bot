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

app.get("/ping", (_req, res) => {
    try {
        res.status(200).send("PONG");
    } catch (err) {
        console.error("[PING] Error:", err.message);
        res.status(500).send("ERROR");
    }
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
    } catch (err) {
        console.error("[HEALTH] Error:", err.message);
        res.status(500).json({ status: "error", error: err.message });
    }
});

app.get("/", (_req, res) => {
    try {
        const sessions = [...sessionManager.getAllSessions().values()];
        const metrics = sessionManager.systemMetrics.getReport();
        const botOnline = client?.readyAt !== null;
        const uptimeMs = Date.now() - startTime;

        const sessionRows = sessions.length
            ? sessions.map(s => `
                <tr>
                    <td>****${s.tokenTail}</td>
                    <td>${s.serverName || s.serverId}</td>
                    <td>${s.voiceId}</td>
                    <td>${formatUptime(Date.now() - s.startedAt)}</td>
                    <td><span class="badge ${s.reconnecting ? "warn" : "ok"}">${s.reconnecting ? "กำลังเชื่อมต่อใหม่" : "ออนไลน์"}</span></td>
                </tr>`).join("")
            : `<tr><td colspan="5" style="text-align:center;color:#888">ไม่มีเซสชันที่ทำงานอยู่</td></tr>`;

        res.send(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Enterprise Voice System</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #1a1b1e; color: #e0e0e0; padding: 24px; }
  h1 { font-size: 1.4rem; color: #5865F2; margin-bottom: 4px; }
  .sub { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 28px; }
  .card { background: #2b2d31; border-radius: 10px; padding: 16px; border: 1px solid #3a3c42; }
  .card .label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: .5px; }
  .card .value { font-size: 1.6rem; font-weight: 700; margin-top: 4px; }
  .green { color: #57F287; } .yellow { color: #FEE75C; } .blue { color: #5865F2; } .red { color: #ED4245; }
  table { width: 100%; border-collapse: collapse; background: #2b2d31; border-radius: 10px; overflow: hidden; }
  th { background: #3a3c42; padding: 10px 14px; text-align: left; font-size: 0.8rem; color: #aaa; text-transform: uppercase; }
  td { padding: 10px 14px; border-top: 1px solid #3a3c42; font-size: 0.9rem; }
  .badge { padding: 3px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; }
  .badge.ok { background: #1a3a2a; color: #57F287; }
  .badge.warn { background: #3a2a1a; color: #FEE75C; }
  .section-title { font-size: 0.95rem; color: #aaa; margin-bottom: 10px; font-weight: 600; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot.green { background: #57F287; } .dot.red { background: #ED4245; }
  footer { margin-top: 24px; color: #555; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>⚙️ Enterprise Voice Management System</h1>
<p class="sub">อัปเดตอัตโนมัติทุก 30 วินาที · ${new Date().toLocaleString("th-TH")}</p>

<div class="grid">
  <div class="card">
    <div class="label">สถานะบอท</div>
    <div class="value ${botOnline ? "green" : "red"}" style="font-size:1rem;margin-top:8px">
      <span class="dot ${botOnline ? "green" : "red"}"></span>
      ${botOnline ? "ONLINE" : "OFFLINE"}
    </div>
  </div>
  <div class="card">
    <div class="label">เซสชันที่ใช้งาน</div>
    <div class="value blue">${sessions.length} <span style="font-size:1rem;color:#888">/ ${config.limits.maxSessions}</span></div>
  </div>
  <div class="card">
    <div class="label">Server Uptime</div>
    <div class="value yellow" style="font-size:1.1rem;margin-top:6px">${formatUptime(uptimeMs)}</div>
  </div>
  <div class="card">
    <div class="label">Success Rate</div>
    <div class="value green">${metrics.successRate}</div>
  </div>
  <div class="card">
    <div class="label">Reconnects</div>
    <div class="value yellow">${metrics.reconnects}</div>
  </div>
  <div class="card">
    <div class="label">Failed Sessions</div>
    <div class="value ${metrics.sessionsFailed > 0 ? "red" : "green"}">${metrics.sessionsFailed}</div>
  </div>
</div>

<div class="section-title">📋 รายการเซสชันทั้งหมด</div>
<table>
  <thead><tr><th>Token</th><th>เซิร์ฟเวอร์</th><th>Voice ID</th><th>เวลาทำงาน</th><th>สถานะ</th></tr></thead>
  <tbody>${sessionRows}</tbody>
</table>

<footer>Phomueangtai Enterprise · Version 4.0 · Bot: ${botOnline ? client?.user?.tag ?? "-" : "Offline"}</footer>
</body>
</html>`);
    } catch (err) {
        console.error("[DASHBOARD] Error:", err.message);
        res.status(500).send("<h1>Error loading dashboard</h1>");
    }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ [EXPRESS] Server online on port ${PORT}`);
    console.log(`🌐 [HEALTH] Check: http://localhost:${PORT}/health`);
    console.log(`📊 [DASHBOARD] View: http://localhost:${PORT}`);
});

// Handle express errors
app.use((err, req, res, next) => {
    console.error("[EXPRESS_ERROR]", err.message);
    res.status(500).json({ error: "Internal server error" });
});

// Validate TOKEN_MANAGER before starting bot
if (!process.env.TOKEN_MANAGER) {
    console.error("❌ [CONFIG] TOKEN_MANAGER environment variable is REQUIRED!");
    console.error("   Set it in your Render environment variables.");
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
    console.log(`📋 [CONFIG] Max Sessions: ${config.limits.maxSessions}`);

    try {
        await client.application.commands.set(commands.slashCommandsData);
        console.log(`✅ [COMMANDS] Registered ${commands.slashCommandsData.length} slash commands`);
    } catch (err) {
        console.error("[COMMANDS] Failed to register slash commands:", err.message);
    }

    try {
        await voiceWorker.autoResume();
    } catch (err) {
        console.error("[RESUME] Error during session resume:", err.message);
    }
});

client.on("messageCreate", async (msg) => {
    try {
        await commands.handleMessage(msg);
    } catch (err) {
        console.error("[MESSAGE] Error:", err.message);
    }
});

client.on("interactionCreate", async (interaction) => {
    try {
        await commands.handleInteraction(interaction);
    } catch (err) {
        console.error("[INTERACTION] Error:", err.message);
    }
});

client.on("error", (err) => {
    console.error("[CLIENT_ERROR]", err.message);
});

client.on("warn", (warn) => {
    console.warn("[CLIENT_WARN]", warn);
});

// ════════════════════════════════════════════════════════════════════════════
//  🔄  BACKGROUND TASKS (DAEMONS)
// ════════════════════════════════════════════════════════════════════════════

// Panel updates (every 15 seconds)
setInterval(async () => {
    try {
        await commands.updatePanel();
    } catch (err) {
        console.error("[PANEL_UPDATE] Error:", err.message);
    }
}, 15000);

// Health check (every 30 seconds)
setInterval(async () => {
    try {
        await voiceWorker.healthCheck();
    } catch (err) {
        console.error("[HEALTH_CHECK] Error:", err.message);
    }
}, 30000);

// Cleanup idle sessions (every 1 hour)
setInterval(async () => {
    try {
        await voiceWorker.cleanupIdleSessions();
    } catch (err) {
        console.error("[CLEANUP_IDLE] Error:", err.message);
    }
}, 3600000);

// Rate limiter cleanup (every 5 minutes)
setInterval(() => {
    try {
        sessionManager.actionLimiter.cleanup();
    } catch (err) {
        console.error("[LIMITER_CLEANUP] Error:", err.message);
    }
}, 300000);

// Database backup (every 1 hour)
setInterval(async () => {
    try {
        await sessionManager.createBackup();
    } catch (err) {
        console.error("[BACKUP] Error:", err.message);
    }
}, 3600000);

// Panel message validation (every 1 hour)
setInterval(async () => {
    try {
        const panelMessages = commands.getPanelMessages();
        for (const [channelId, msg] of panelMessages) {
            try {
                await msg.fetch();
            } catch (err) {
                if (err.code === 10008 || err.code === 10003) {
                    panelMessages.delete(channelId);
                    console.log(`[PANEL_CLEANUP] Removed stale message from ${channelId}`);
                }
            }
        }
    } catch (err) {
        console.error("[PANEL_VALIDATION] Error:", err.message);
    }
}, 3600000);

// ════════════════════════════════════════════════════════════════════════════
//  🛑  GRACEFUL SHUTDOWN
// ════════════════════════════════════════════════════════════════════════════
async function shutdown(signal) {
    console.log(`\n⛔ [SHUTDOWN] Received ${signal} — initiating graceful shutdown...`);

    const shutdownTimeout = setTimeout(() => {
        console.error("[SHUTDOWN] ⏱️  Timeout reached, forcing exit");
        process.exit(1);
    }, 10000);

    try {
        // 1. Create backup
        await sessionManager.createBackup();
        console.log("[SHUTDOWN] ✅ Database backup created");

        // 2. Save database
        await sessionManager.saveDatabase();
        console.log("[SHUTDOWN] ✅ Database saved");

        // 3. Stop all sessions
        const sessions = [...sessionManager.getAllSessions().keys()];
        if (sessions.length > 0) {
            await Promise.allSettled(sessions.map(id => voiceWorker.stopSession(id)));
            console.log(`[SHUTDOWN] ✅ Stopped ${sessions.length} sessions`);
        }

        // 4. Close Discord client
        if (client) {
            client.destroy();
            console.log("[SHUTDOWN] ✅ Discord client destroyed");
        }

        // 5. Close Express server
        server.close(() => {
            console.log("[SHUTDOWN] ✅ Express server closed");
        });

        console.log("[SHUTDOWN] ✅ Cleanup complete — exiting safely");
        clearTimeout(shutdownTimeout);
        process.exit(0);
    } catch (err) {
        console.error("[SHUTDOWN] ❌ Error:", err.message);
        clearTimeout(shutdownTimeout);
        process.exit(1);
    }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ════════════════════════════════════════════════════════════════════════════
//  🚀  BOT LOGIN
// ════════════════════════════════════════════════════════════════════════════
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
