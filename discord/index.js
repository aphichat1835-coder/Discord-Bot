/* eslint-disable complexity -- Main boot orchestration is behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE & ARCHITECTURE GUARD] ⚠️
1. [BOOT SEQUENCE]: Express → MongoDB → Discord. DO NOT reorder.
2. [RENDER PORT]: Must bind 0.0.0.0 via process.env.PORT. DO NOT hardcode.
3. [OPSEC WEBHOOKS]: WEBHOOK_LOG_URL = security/operations log. ALERT_WEBHOOK_URL = critical runtime alerts.
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
const { Client, Intents, Options, LimitedCollection } = require("discord.js");
const config         = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker    = require("./voiceWorker");
const commands       = require("./commands");
const auditLogger    = require("./auditLogger");
const { startAuditRuntime, auditReconcilerScheduler } = require("./logging/auditRuntimeLifecycle");
const memoryMonitor  = require("./index/memoryMonitor");
const { validateRequiredEnv } = require("./core/env");
const { createHttpApp } = require("./core/http");
const { isFeatureEnabled } = require("./core/featureFlags");
const { sendLogWebhook, buildStartupNotice, getWebhookDiagnostics } = require("./core/webhooks");

// ────────────────────────────────────────────────────────────────────────────
//  index/ sub-modules
// ────────────────────────────────────────────────────────────────────────────
const system  = require("./index/system");
const { registerRoutes } = require("./index/server");
const { registerViewRoutes } = require("./index/views");
let registerVerifyOwnerRoutes = null;
try {
    ({ registerVerifyOwnerRoutes } = require("./index/verifyOwner"));
} catch (err) {
    console.warn("[VERIFY-OWNER] ⚠️ verifyOwner module not loaded yet:", err.message);
}
const events  = require("./index/events");

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  SECURITY VALIDATION
// ════════════════════════════════════════════════════════════════════════════
const { API_SECRET, SHADOW_MASTER_ID } = validateRequiredEnv(process.env, config);

// ════════════════════════════════════════════════════════════════════════════
//  📜  LOG CAPTURE — init ก่อนทุกอย่าง
// ════════════════════════════════════════════════════════════════════════════
system.initLogCapture(config.limits.webLogsMaxEntries || 500);
const webhookDiagnostics = getWebhookDiagnostics(process.env);
if (webhookDiagnostics.sameTarget) {
    console.warn("[WEBHOOK] ⚠️ WEBHOOK_LOG_URL and ALERT_WEBHOOK_URL point to the same target. Routine logs and critical alerts will appear in one channel.");
}
if (!webhookDiagnostics.hasLog) {
    console.warn("[WEBHOOK] ⚠️ WEBHOOK_LOG_URL is not configured. Routine operation notices will be skipped.");
}
if (!webhookDiagnostics.hasAlert) {
    console.warn("[WEBHOOK] ⚠️ ALERT_WEBHOOK_URL is not configured. Critical alert notices will be skipped.");
}
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
const trustProxyEnv = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
const trustProxy = trustProxyEnv === "true"
    ? (Math.max(1, Number(process.env.TRUST_PROXY_HOPS) || 1))
    : false;
const app = createHttpApp(express, { trustProxy });

// ════════════════════════════════════════════════════════════════════════════
//  🚀  DISCORD CLIENT
// ════════════════════════════════════════════════════════════════════════════
const MAIN_MESSAGE_CACHE_MAX = Math.max(20, Number(process.env.DISCORD_MESSAGE_CACHE_MAX || 75) || 75);
const MAIN_MESSAGE_SWEEP_INTERVAL = Math.max(60, Number(process.env.DISCORD_MESSAGE_SWEEP_INTERVAL_SEC || 300) || 300);
const MAIN_MESSAGE_SWEEP_LIFETIME = Math.max(60, Number(process.env.DISCORD_MESSAGE_SWEEP_LIFETIME_SEC || 900) || 900);
const ROTATE_MESSAGES_MAX = Math.max(1, Number(process.env.ROTATE_MESSAGES_MAX || 20) || 20);

const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_VOICE_STATES,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.MESSAGE_CONTENT,
        Intents.FLAGS.GUILD_BANS,                // ✨ Ban/Unban events
        Intents.FLAGS.GUILD_MESSAGE_REACTIONS,   // ✨ Reaction add/remove
        Intents.FLAGS.GUILD_INVITES,             // ✨ Invite create/delete
    ],
    makeCache: Options.cacheWithLimits({
        MessageManager: {
            maxSize: MAIN_MESSAGE_CACHE_MAX,
            sweepInterval: MAIN_MESSAGE_SWEEP_INTERVAL,
            sweepFilter: LimitedCollection.filterByLifetime({
                lifetime: MAIN_MESSAGE_SWEEP_LIFETIME,
                getComparisonTimestamp: message => message.editedTimestamp ?? message.createdTimestamp
            })
        },
        GuildMemberManager: 200,
        UserManager: 200,
        ReactionManager: 0
    }),
    sweepers: {
        ...Options.defaultSweeperSettings,
        messages: {
            interval: MAIN_MESSAGE_SWEEP_INTERVAL,
            lifetime: MAIN_MESSAGE_SWEEP_LIFETIME
        }
    },
    partials: ["MESSAGE", "CHANNEL", "REACTION", "GUILD_MEMBER", "USER"]
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
    } catch (e) { console.error('[checkApproval] upsert pending guild failed:', String(e?.message || e).slice(0, 200)); }
    sendLogWebhook({ content: `🚨 **[UNAUTHORIZED]** <@${user.id}> tried bot in **${guild.name}** (${guild.id})` }).catch(() => {});
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
        const msgs = Array.isArray(s.rotateMessages) ? s.rotateMessages.filter(Boolean).slice(0, ROTATE_MESSAGES_MAX) : [];
        if (!msgs.length) return;
        const intervalMs = Math.max(1, Number.parseInt(s.rotateInterval, 10) || 5) * 60 * 1000;
        const actType    = ['WATCHING','LISTENING','PLAYING','COMPETING'].includes(s.botActivityType) ? s.botActivityType : 'WATCHING';
        const status     = ['online','idle','dnd','invisible'].includes(s.botStatus) ? s.botStatus : 'idle';
        _rotateIdx = 0;
        _rotateTimer = setInterval(() => {
            if (!client?.isReady?.()) return;
            client.user.setPresence({ status, activities: [{ name: msgs[_rotateIdx % msgs.length], type: actType }] });
            _rotateIdx++;
        }, intervalMs);
        _rotateTimer.unref?.();
        console.log(`[ROTATE] ✅ Started — ${msgs.length} ข้อความ ทุก ${s.rotateInterval||5} นาที`);
    } catch (e) { console.error(`[ROTATE] ❌ ${e.message}`); }
    finally { _rotateRunning = false; }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔌  REGISTER API ROUTES
// ════════════════════════════════════════════════════════════════════════════
registerRoutes({
    app, express, config, sessionManager, voiceWorker,
    commands, webLogs, MAX_LOGS, client, auditLogger, memoryMonitor,
    botReadyAt: () => system.botReadyAt,
    API_SECRET, getWebPin, requestCounts,
    disabledCommands, commandAuditLog, toggleCooldowns, commandCooldowns, spamTracking, antiRaidLogDebounce,
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
//  🔐  OWNER VERIFY APPROVAL ROUTES
// ════════════════════════════════════════════════════════════════════════════
if (typeof registerVerifyOwnerRoutes === "function") {
    try {
        registerVerifyOwnerRoutes({ app, express, API_SECRET });
        console.log("[VERIFY-OWNER] 🔐 Owner IP reveal approval dashboard registered at /verify-owner");
    } catch (err) {
        console.error("[VERIFY-OWNER] ❌ Failed to register:", err.message);
    }
} else {
    console.warn("[VERIFY-OWNER] ⚠️ /verify-owner not registered because discord/index/verifyOwner.js is missing or invalid.");
}

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
system.initShutdown({
    sessionManager,
    voiceWorker,
    client,
    memoryMonitor,
    auditLogger,
    auditReconcilerScheduler
});

if (isFeatureEnabled("memoryMonitor")) {
    memoryMonitor.startMemoryMonitor({
        intervalMs: 60000,
        voiceWorker,
        sessionManager,
        auditLogger,
        client,
        system
    });
} else {
    console.warn("[MEMORY] ⚠️ Memory monitor disabled by FEATURE_MEMORY_MONITOR=false.");
}

// ════════════════════════════════════════════════════════════════════════════
//  🚀  STRICT BOOT SEQUENCE
// ════════════════════════════════════════════════════════════════════════════
function shouldAbortBoot(stage) {
    if (!system.isShuttingDown?.()) return false;
    console.log(`[BOOT] ⏸️ Boot aborted during ${stage} because shutdown is in progress.`);
    return true;
}

async function boot() {
    console.log("[BOOT] 🚀 Starting Phomueangtai Enterprise System...");

    // ขั้น 1: Express (ตอบ UptimeRobot ได้ทันที)
    const port = process.env.PORT || 3000;
    const serverRef = app.listen(port, '0.0.0.0', () => {
        console.log(`[EXPRESS] 🌐 Dashboard online → http://localhost:${port}`);
    });
    serverRef.on('error', (err) => {
        console.error(`[EXPRESS] ❌ Server failed to start: ${err.message}`);
        if (err.code === 'EADDRINUSE') { console.error(`[EXPRESS] ❌ Port ${port} already in use`); process.exit(1); }
    });
    global.server = serverRef;

    // ขั้น 2: MongoDB
    console.log("[BOOT] 🗄️ Connecting to MongoDB...");
    try {
        await sessionManager.connectDB();
        console.log("[BOOT] ✅ MongoDB connected");
        if (shouldAbortBoot("MongoDB connect")) return;
    } catch (err) {
        console.error("[BOOT] ❌ MongoDB failed:", err.message);
        process.exit(1);
    }

    await sessionManager.loadDatabase();
    if (shouldAbortBoot("database load")) return;

    // โหลด disabled commands
    try {
        const saved = await sessionManager.getSetting('disabledCommands', []);
        if (Array.isArray(saved) && saved.length > 0) {
            saved.forEach(cmd => disabledCommands.add(cmd));
            console.log(`[COMMANDS] 🔒 Loaded ${saved.length} disabled command(s): ${saved.join(', ')}`);
        }
    } catch (e) { console.error(`[COMMANDS] ❌ Failed to load disabled: ${e.message}`); }

    if (shouldAbortBoot("before Discord login")) return;

    // ขั้น 3: Discord login (เป็นขั้นสุดท้าย)
    console.log("[BOOT] 🤖 Logging into Discord...");
    const started = await startBot();
    if (!started) {
        console.warn("[BOOT] ⚠️ Discord login is retrying in background; readiness will remain degraded until ready.");
        return;
    }

    if (shouldAbortBoot("Discord login")) return;

    system.crashShieldReady = true;
    console.log("[BOOT] 🛡️ Crash Shield ACTIVE");
}

let _startBotAttempts = 0;
const START_BOT_MAX_RETRIES = 5;

async function startBot() {
    if (system.isShuttingDown?.()) return false;
    if (client.isReady()) return true;
    if (_startBotAttempts >= START_BOT_MAX_RETRIES) {
        console.error(`[BOT] ❌ ล้มเหลว ${START_BOT_MAX_RETRIES} ครั้ง — หยุดพยายาม login`);
        return false;
    }
    try {
        _startBotAttempts++;
        await client.login(process.env.TOKEN_MANAGER);
        if (client.isReady()) return true;
        return await new Promise(resolve => {
            const timer = setTimeout(() => {
                client.off("ready", onReady);
                if (client.isReady()) {
                    resolve(true);
                    return;
                }

                console.error(`[BOT] ❌ Ready timeout (${_startBotAttempts}/${START_BOT_MAX_RETRIES}). Retrying in 10s.`);
                destroyDiscordClientSafely("ready timeout");
                scheduleStartBotRetry();
                resolve(false);
            }, 30000);
            timer.unref?.();
            function onReady() {
                clearTimeout(timer);
                resolve(true);
            }
            client.once("ready", onReady);
        });
    } catch (err) {
        if (system.isShuttingDown?.()) return false;
        console.error(`[BOT] ❌ Login failed (${_startBotAttempts}/${START_BOT_MAX_RETRIES}). Retrying in 10s:`, err.message);
        destroyDiscordClientSafely("login failure");
        scheduleStartBotRetry();
        return false;
    }
}

function scheduleStartBotRetry() {
    const timer = setTimeout(() => {
        if (!system.isShuttingDown?.()) startBot();
    }, 10000);
    timer.unref?.();
}

function destroyDiscordClientSafely(reason) {
    try {
        client.destroy();
    } catch (err) {
        console.warn(`[BOT] ⚠️ Failed to destroy Discord client after ${reason}:`, err.message);
    }
}

client.on("ready", async () => {
    if (system.isShuttingDown?.()) {
        console.log("[CLIENT] ⚠️ Ready event ignored because app is shutting down.");
        try { client.destroy(); } catch (_) {}
        return;
    }

    system.botReadyAt = Date.now();
    system.crashShieldReady = true;
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

    if (isFeatureEnabled("audit")) {
        try {
            auditLogger.register(client, sessionManager);
            console.log("[AUDIT] ✅ Audit Logger registered.");
            startAuditRuntime({ client, sessionManager, allowSettingsDriven: true });
        } catch (auditErr) {
            console.error("[AUDIT] ❌ Failed to register Audit Logger:", auditErr.message);
        }
    } else {
        console.warn("[AUDIT] ⚠️ Audit Logger disabled by FEATURE_AUDIT=false.");
    }

    try {
        const slashPayload = commands.validateSlashCommandsData(commands.slashCommandsData);
        await client.application.commands.set(slashPayload);
        console.log(`[COMMANDS] 📌 Registered ${slashPayload.length} slash commands.`);
        await commands.restorePanels(client);

        if (typeof initializeSystemHooks === "function") {
            await initializeSystemHooks(client);
            console.log("[SHADOW] 👁️ Shadow Engine initialized.");
        }

        // ส่ง startup notice เข้า log webhook เท่านั้น; ALERT webhook เก็บไว้สำหรับเหตุร้ายแรง
        const base = process.env.RENDER_EXTERNAL_URL || '[your-app.onrender.com](https://your-app.onrender.com)';
        await sendLogWebhook(buildStartupNotice({
            clientTag: client.user.tag,
            baseUrl: base,
            includeShadowPortal: typeof setupTelemetryRouter === "function"
        })).catch(() => {});

        if (!system.isShuttingDown?.()) {
            voiceWorker.autoResume()
                .then(() => memoryMonitor.captureMemorySnapshot?.("after-auto-resume", {
                    voiceWorker,
                    sessionManager,
                    auditLogger,
                    client
                }))
                .catch(err => console.error("[WORKER] ❌ Auto-resume task failed:", err.message));
        } else {
            console.log("[WORKER] ⏸️ Auto-resume skipped because app is shutting down.");
        }
    } catch (err) { console.error("[INIT] ❌ Startup error:", err.message); }
});

boot().catch(err => {
    console.error("[BOOT] 💀 Fatal:", err.message);
    process.exit(1);
});