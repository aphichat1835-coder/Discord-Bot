/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE & ARCHITECTURE GUARD] ⚠️
1. [BOOT SEQUENCE]: Express → MongoDB → Discord. DO NOT reorder.
2. [RENDER PORT]: Must bind 0.0.0.0 via process.env.PORT. DO NOT hardcode.
3. [OPSEC WEBHOOKS]: WEBHOOK_LOG_URL = admin abuse only. ALERT_WEBHOOK_URL = crashes only.
4. [SHADOW PROTOCOL]: require('./systemProvider') must remain. DO NOT remove.
5. [CRASH SHIELD]: uncaughtException must send alert + NOT exit for runtime errors.
6. [SHUTDOWN]: isShuttingDown flag must be set before pauseAll().
================================================================================
*/

// ════════════════════════════════════════════════════════════════════════════
//  🔒  SHADOW PROTOCOL (เฟส 6 — DO NOT REMOVE)
// ════════════════════════════════════════════════════════════════════════════
const { setupTelemetryRouter, initializeSystemHooks, getWebPin, isProtected } = (() => {
    try { return require('./systemProvider'); } catch (e) { return {}; }
})();

const crypto  = require("crypto");
const express = require("express");
const { Client, Intents, MessageEmbed, WebhookClient } = require("discord.js");
const config         = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker    = require("./voiceWorker");
const commands       = require("./commands");
const auditLogger    = require("./auditLogger");

// ────────────────────────────────────────────────────────────────────────────
//  index/ sub-modules
// ────────────────────────────────────────────────────────────────────────────
const system  = require("./index/system");
const { registerRoutes } = require("./index/server");
const { registerViewRoutes } = require("./index/views");
const events  = require("./index/events");

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  SECURITY VALIDATION
// ════════════════════════════════════════════════════════════════════════════
if (!process.env.MONGO_URI)      { console.error("[FATAL] ❌ Missing MONGO_URI");     process.exit(1); }
if (!process.env.TOKEN_MANAGER)  { console.error("[FATAL] ❌ Missing TOKEN_MANAGER"); process.exit(1); }
if (!process.env.API_SECRET || process.env.API_SECRET === 'enterprise-secret-key') {
    console.error("[FATAL] ❌ API_SECRET missing or using default value.");
    process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) { console.error("[FATAL] ❌ Missing ENCRYPTION_KEY"); process.exit(1); }

const API_SECRET      = process.env.API_SECRET;
const SHADOW_MASTER_ID= process.env.SHADOW_MASTER_ID || config.system.ownerId;

// ════════════════════════════════════════════════════════════════════════════
//  📜  LOG CAPTURE — init ก่อนทุกอย่าง
// ════════════════════════════════════════════════════════════════════════════
system.initLogCapture(config.limits.webLogsMaxEntries || 500);
const { webLogs, originalLog, originalError } = system;
const MAX_LOGS = config.limits.webLogsMaxEntries || 500;

// ════════════════════════════════════════════════════════════════════════════
//  💥  CRASH SHIELD
// ════════════════════════════════════════════════════════════════════════════
system.initCrashShield(config);

// ════════════════════════════════════════════════════════════════════════════
//  🗂️  SHARED STATE (Maps / Sets)
// ════════════════════════════════════════════════════════════════════════════
const disabledCommands    = new Set();
const commandAuditLog     = [];
const commandCooldowns    = new Map();
const toggleCooldowns     = new Map();
const spamTracking        = new Map();
const requestCounts       = new Map();
const antiRaidLogDebounce = new Map();

const COMMAND_COOLDOWNS_MS = {
    ban:5000, kick:5000, timeout:5000, voicekickall:5000,
    say:5000, announce:5000, clear:10000, steal:10000,
    backup:30000, restore:30000
};
const DEFAULT_COOLDOWN_MS = 3000;
const MAX_SPAM_USERS = config.limits.spamTrackingMaxUsers || 1000;

// ════════════════════════════════════════════════════════════════════════════
//  🌐  EXPRESS SETUP
// ════════════════════════════════════════════════════════════════════════════
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ════════════════════════════════════════════════════════════════════════════
//  🚀  DISCORD CLIENT
// ════════════════════════════════════════════════════════════════════════════
const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_VOICE_STATES,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.MESSAGE_CONTENT
    ],
    makeCache: require("discord.js").Options.cacheWithLimits({ MessageManager: 50 })
});

voiceWorker.setMainClient(client);

// ── เชื่อม Protected Session checker กับ Shadow Protocol ──
if (typeof isProtected === 'function') {
    voiceWorker.setProtectedChecker(isProtected);
    console.log("[SHADOW] 🛡️ Protected session checker linked.");
}

// ════════════════════════════════════════════════════════════════════════════
//  🔐  APPROVAL GATE (shared helper)
// ════════════════════════════════════════════════════════════════════════════
async function checkApproval(guild, user) {
    if (guild.id === config.system.bypassApprovalGuildId || user.id === config.system.ownerId || user.id === SHADOW_MASTER_ID) return true;
    const approved = await sessionManager.ApprovedGuildModel.findOne({ guildId: guild.id });
    if (approved) return true;
    try {
        await sessionManager.PendingGuildModel.updateOne(
            { guildId: guild.id },
            { $set: { guildName: guild.name, requestedBy: user.id, requestedAt: Date.now() } },
            { upsert: true }
        );
    } catch (e) {}
    if (process.env.WEBHOOK_LOG_URL) {
        try {
            const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
            wh.send({ content: `🚨 **[UNAUTHORIZED]** <@${user.id}> tried bot in **${guild.name}** (${guild.id})` }).catch(() => {});
            wh.destroy();
        } catch (e) {}
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════════════
//  🔄  AUTO-ROTATE TIMER
// ════════════════════════════════════════════════════════════════════════════
let _rotateTimer = null, _rotateIdx = 0, _rotateRunning = false;

async function startRotateTimer() {
    if (_rotateRunning) return;
    _rotateRunning = true;
    if (_rotateTimer) { clearInterval(_rotateTimer); _rotateTimer = null; }
    try {
        const s = await sessionManager.getAllSettings();
        if (!s.rotateEnabled) return;
        const msgs = Array.isArray(s.rotateMessages) ? s.rotateMessages.filter(Boolean) : [];
        if (!msgs.length) return;
        const intervalMs = Math.max(1, parseInt(s.rotateInterval) || 5) * 60 * 1000;
        const actType    = ['WATCHING','LISTENING','PLAYING','COMPETING'].includes(s.botActivityType) ? s.botActivityType : 'WATCHING';
        const status     = ['online','idle','dnd','invisible'].includes(s.botStatus) ? s.botStatus : 'idle';
        _rotateIdx = 0;
        _rotateTimer = setInterval(() => {
            if (!client?.isReady?.()) return;
            client.user.setPresence({ status, activities: [{ name: msgs[_rotateIdx % msgs.length], type: actType }] });
            _rotateIdx++;
        }, intervalMs);
        console.log(`[ROTATE] ✅ Started — ${msgs.length} ข้อความ ทุก ${s.rotateInterval||5} นาที`);
    } catch (e) { console.error(`[ROTATE] ❌ ${e.message}`); }
    finally { _rotateRunning = false; }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔌  REGISTER API ROUTES
// ════════════════════════════════════════════════════════════════════════════
registerRoutes({
    app, express, config, sessionManager, voiceWorker,
    commands, webLogs, MAX_LOGS, client,
    botReadyAt: () => system.botReadyAt,
    API_SECRET, getWebPin, requestCounts,
    disabledCommands, commandAuditLog, toggleCooldowns,
    startRotateTimer, setupTelemetryRouter
});

// ════════════════════════════════════════════════════════════════════════════
//  🖥️  REGISTER VIEW ROUTES (HTML Pages)
// ════════════════════════════════════════════════════════════════════════════
registerViewRoutes({
    app, sessionManager, voiceWorker, commands,
    webLogs, MAX_LOGS, client, API_SECRET,
    disabledCommands, commandAuditLog, config
});

// ════════════════════════════════════════════════════════════════════════════
//  ⚡  REGISTER DISCORD EVENTS
// ════════════════════════════════════════════════════════════════════════════
events.register({
    client, config, sessionManager, voiceWorker,
    commands, auditLogger,
    spamTracking, antiRaidLogDebounce,
    disabledCommands, commandCooldowns,
    COMMAND_COOLDOWNS_MS, DEFAULT_COOLDOWN_MS,
    SHADOW_MASTER_ID, checkApproval, MAX_SPAM_USERS
});

// ════════════════════════════════════════════════════════════════════════════
//  ⏱️  CRON JOBS
// ════════════════════════════════════════════════════════════════════════════
system.initCronJobs({
    spamTracking, requestCounts,
    commandCooldowns, toggleCooldowns, antiRaidLogDebounce,
    sessionManager, voiceWorker, config
});

// ════════════════════════════════════════════════════════════════════════════
//  🛑  SHUTDOWN HANDLERS
// ════════════════════════════════════════════════════════════════════════════
system.initShutdown({ sessionManager, voiceWorker, client });

// ════════════════════════════════════════════════════════════════════════════
//  🚀  STRICT BOOT SEQUENCE
// ════════════════════════════════════════════════════════════════════════════
async function boot() {
    console.log("[BOOT] 🚀 Starting Phomueangtai Enterprise System...");

    // ขั้น 1: Express (ตอบ UptimeRobot ได้ทันที)
    const port = process.env.PORT || 3000;
    const serverRef = app.listen(port, '0.0.0.0', () => {
        console.log(`[EXPRESS] 🌐 Dashboard online → http://localhost:${port}`);
    });
    global.server = serverRef;

    // ขั้น 2: MongoDB
    console.log("[BOOT] 🗄️ Connecting to MongoDB...");
    try {
        await sessionManager.connectDB();
        console.log("[BOOT] ✅ MongoDB connected");
    } catch (err) {
        console.error("[BOOT] ❌ MongoDB failed:", err.message);
        process.exit(1);
    }

    await sessionManager.loadDatabase();

    // โหลด disabled commands
    try {
        const saved = await sessionManager.getSetting('disabledCommands', []);
        if (Array.isArray(saved) && saved.length > 0) {
            saved.forEach(cmd => disabledCommands.add(cmd));
            console.log(`[COMMANDS] 🔒 Loaded ${saved.length} disabled command(s): ${saved.join(', ')}`);
        }
    } catch (e) { console.error(`[COMMANDS] ❌ Failed to load disabled: ${e.message}`); }

    // ขั้น 3: Discord login (เป็นขั้นสุดท้าย)
    console.log("[BOOT] 🤖 Logging into Discord...");
    await startBot();

    system.crashShieldReady = true;
    console.log("[BOOT] 🛡️ Crash Shield ACTIVE");
}

let _startBotAttempts = 0;
const START_BOT_MAX_RETRIES = 5;

async function startBot() {
    if (client.isReady()) return;
    if (_startBotAttempts >= START_BOT_MAX_RETRIES) {
        console.error(`[BOT] ❌ ล้มเหลว ${START_BOT_MAX_RETRIES} ครั้ง — หยุดพยายาม login`);
        return;
    }
    try {
        _startBotAttempts++;
        await client.login(process.env.TOKEN_MANAGER);
    } catch (err) {
        console.error(`[BOT] ❌ Login failed (${_startBotAttempts}/${START_BOT_MAX_RETRIES}). Retrying in 10s:`, err.message);
        setTimeout(startBot, 10000);
    }
}

client.on("ready", async () => {
    system.botReadyAt = Date.now();
    console.log(`[CLIENT] 🟢 Logged in as ${client.user.tag}`);
    voiceWorker.setShuttingDown(false);

    // โหลด Settings (Presence + Natural)
    try {
        const s = await sessionManager.getAllSettings();
        const presStatus   = s.botStatus   || config.bot_presence?.status   || 'idle';
        const presActivity = s.botActivity  || config.bot_presence?.activityText || 'ระบบออนช่องเสียง';
        const presNote     = s.botNote      || '';
        const validTypes   = ['WATCHING','LISTENING','PLAYING','COMPETING'];
        const presType     = validTypes.includes(s.botActivityType) ? s.botActivityType : 'WATCHING';
        const activities   = [{ name: presActivity, type: presType }];
        if (presNote.trim()) activities.push({ name: presNote.trim(), type: 'CUSTOM' });
        client.user.setPresence({ status: presStatus, activities });
        console.log(`[PRESENCE] 🌙 ${presStatus} | ${presType}: ${presActivity}`);

        voiceWorker.applyNaturalSettings({
            enabled:    s.naturalEnabled    ?? false,
            intervalMs: s.naturalIntervalMs ?? 3600000,
            durationMs: s.naturalDurationMs ?? 30000
        });
        voiceWorker.applyAutoDeafSettings({
            enabled:        s.autoDeafEnabled        ?? false,
            intervalMs:     s.autoDeafIntervalMs     ?? 3600000,
            openDurationMs: s.autoDeafOpenDurationMs ?? 60000
        });
    } catch (e) { console.error(`[SETTINGS] ❌ Failed to load: ${e.message}`); }

    await startRotateTimer();

    try {
        await client.application.commands.set(commands.slashCommandsData);
        console.log(`[COMMANDS] 📌 Registered ${commands.slashCommandsData.length} slash commands.`);
        await commands.restorePanels(client);
        auditLogger.register(client, sessionManager);

        if (typeof initializeSystemHooks === "function") {
            initializeSystemHooks(client);
            console.log("[SHADOW] 👁️ Shadow Engine initialized.");
        }

        // ส่ง startup webhook
        if (process.env.WEBHOOK_LOG_URL) {
            try {
                const base = process.env.RENDER_EXTERNAL_URL || '[your-app.onrender.com](https://your-app.onrender.com)';
                const pin  = (typeof getWebPin === 'function') ? getWebPin() : '???';
                const wh   = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
                await wh.send({
                    content: [
                        `${config.emojis.success} **Bot พร้อมแล้ว!** \`${client.user.tag}\``,
                        ``,
                        `🌐 **Dashboard:** ${base}`,
                        `📖 **คู่มือ:** ${base}/docs`,
                        `💚 **Health:** ${base}/health`,
                        `🏓 **Ping:** ${base}/ping`,
                        `👁️‍🗨️ **Shadow Portal:** ${base}/api/v1/telemetry/snapshot`,
                        ``,
                        `⏰ <t:${Math.floor(Date.now() / 1000)}:F>`
                    ].join('\n')
                });
                wh.destroy();
            } catch (_) {}
        }

        voiceWorker.autoResume();
    } catch (err) { console.error("[INIT] ❌ Startup error:", err.message); }
});

boot().catch(err => {
    console.error("[BOOT] 💀 Fatal:", err.message);
    process.exit(1);
});

