/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT MODIFY: crashShieldReady flag logic.
DO NOT REMOVE: process.on handlers — critical for stability.
DO NOT SIMPLIFY: Log capture ring buffer — prevents RAM bloat.
================================================================================
*/

const { WebhookClient } = require("discord.js");

// ════════════════════════════════════════════════════════════════════════════
//  🗂️  SHARED STATE (exported สำหรับ server.js / views.js ใช้)
// ════════════════════════════════════════════════════════════════════════════
const webLogs = [];
const MAX_LOGS_DEFAULT = 500;

let crashShieldReady = false;
let botReadyAt = null;

const originalLog   = console.log;
const originalError = console.error;
const originalWarn  = console.warn;

// ════════════════════════════════════════════════════════════════════════════
//  📜  LOG CAPTURE — Ring Buffer (กัน RAM บวม)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Overrides `console.log`, `console.error`, and `console.warn` to additionally
 * push each message into the shared `webLogs` ring buffer so it can be
 * surfaced on the dashboard. Older entries are evicted once `maxLogs` is reached.
 * @param {number} [maxLogs=500] - Maximum number of log entries to keep.
 */
function initLogCapture(maxLogs = MAX_LOGS_DEFAULT) {
    function pushLog(type, msg) {
        if (msg.length > 500) msg = msg.substring(0, 500) + '... [TRUNCATED]';
        webLogs.push({ time: new Date().toLocaleTimeString('th-TH'), type, msg });
        if (webLogs.length > maxLogs) webLogs.shift();
    }

    console.log = (...args) => {
        const msg = require('util').format(...args);
        pushLog('info', msg);
        originalLog(...args);
    };
    console.error = (...args) => {
        const msg = require('util').format(...args);
        pushLog('error', msg);
        originalError(...args);
    };
    console.warn = (...args) => {
        const msg = require('util').format(...args);
        pushLog('warn', msg);
        originalWarn(...args);
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  💥  CRASH SHIELD — Global Process Handlers
// ════════════════════════════════════════════════════════════════════════════
/**
 * Registers global `uncaughtException` and `unhandledRejection` process handlers.
 * Alerts are sent to the ALERT_WEBHOOK_URL Discord webhook.
 * Before `crashShieldReady` is set, fatal errors will terminate the process;
 * after it is set the process is kept alive to allow recovery.
 * @param {object} config - Application config (currently unused but kept for forward-compat).
 */
function initCrashShield(config) {
    process.on("uncaughtException", async (err) => {
        originalError("[CRITICAL] uncaughtException:", err.message, err.stack);
        if (process.env.ALERT_WEBHOOK_URL) {
            try {
                const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
                await wh.send({
                    content: `🚨 **[CRITICAL] uncaughtException**\n\`\`\`\n${err.message}\n${err.stack?.substring(0, 800)}\n\`\`\``
                }).catch(() => {});
                wh.destroy();
            } catch (e) {}
        }
        if (!crashShieldReady) {
            await new Promise(r => setTimeout(r, 1500));
            process.exit(1);
        }
    });

    process.on("unhandledRejection", async (reason) => {
        const msg = reason?.message ?? String(reason);
        originalError("[CRITICAL] unhandledRejection:", msg);
        if (process.env.ALERT_WEBHOOK_URL) {
            try {
                const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
                await wh.send({
                    content: `🚨 **[CRITICAL] unhandledRejection**\n\`\`\`\n${msg}\n\`\`\``
                }).catch(() => {});
                wh.destroy();
            } catch (e) {}
        }
        if (!crashShieldReady) {
            await new Promise(r => setTimeout(r, 1500));
            process.exit(1);
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  ⏱️  CRON JOBS
// ════════════════════════════════════════════════════════════════════════════
/**
 * Starts the application's periodic maintenance cron jobs:
 * - Every 30 s: prunes stale entries from spam/rate-limit/cooldown/debounce maps.
 * - Every 90 s: cleans up idle sessions, runs the voice health check, and saves
 *   the database. Uses a `_cronRunning` guard to prevent overlapping runs.
 * @param {object} opts
 * @param {Map} opts.spamTracking - Per-user spam timestamp map.
 * @param {Map} opts.requestCounts - Per-IP request timestamp map.
 * @param {Map} opts.commandCooldowns - Per-user/command cooldown map.
 * @param {Map} opts.toggleCooldowns - Per-IP/command toggle cooldown map.
 * @param {Map} opts.antiRaidLogDebounce - Debounce map for anti-raid log events.
 * @param {object} opts.sessionManager - Session manager for save/health operations.
 * @param {object} opts.voiceWorker - Voice worker for idle cleanup and health checks.
 * @param {object} opts.config - Application config; uses `config.limits.rateLimitWindowMs`.
 */
function initCronJobs({
    spamTracking, requestCounts,
    commandCooldowns, toggleCooldowns, antiRaidLogDebounce,
    sessionManager, voiceWorker, config
}) {
    // CRON 30s: ล้าง Map เก่า
    setInterval(async () => {
        try {
            const now = Date.now();
            const windowMs = config.limits.rateLimitWindowMs || 60000;

            for (const [uid, ts] of spamTracking.entries()) {
                const v = ts.filter(t => now - t < 60000);
                if (!v.length) spamTracking.delete(uid); else spamTracking.set(uid, v);
            }
            for (const [ip, ts] of requestCounts.entries()) {
                const v = ts.filter(t => now - t < windowMs);
                if (!v.length) requestCounts.delete(ip); else requestCounts.set(ip, v);
            }
            for (const [uid, cmds] of commandCooldowns.entries()) {
                for (const [cmd, ts] of cmds.entries()) {
                    if (now - ts > 30000) cmds.delete(cmd);
                }
                if (!cmds.size) commandCooldowns.delete(uid);
            }
            for (const [key, ts] of toggleCooldowns.entries()) {
                if (now - ts > 5000) toggleCooldowns.delete(key);
            }
            for (const [key, ts] of antiRaidLogDebounce.entries()) {
                if (now - ts > 10000) antiRaidLogDebounce.delete(key);
            }
        } catch (err) {
            console.error("[CRON] ❌ Map cleanup failed:", err.message);
        }
    }, 30000);

    // CRON 90s: Health + DB save (lock ป้องกัน overlap)
    let _cronRunning = false;
    setInterval(async () => {
        if (_cronRunning) { console.warn("[CRON] ⚠️ Previous cycle still running — skipped."); return; }
        _cronRunning = true;
        try {
            await voiceWorker.cleanupIdleSessions();
            await voiceWorker.healthCheck();
            await sessionManager.saveDatabase();
        } catch (err) {
            console.error("[CRON] ❌ Health/Save failed:", err.message);
            sessionManager.systemMetrics.increment('errors');
        } finally {
            _cronRunning = false;
        }
    }, 90000);
}

// ════════════════════════════════════════════════════════════════════════════
//  🛑  GRACEFUL SHUTDOWN
// ════════════════════════════════════════════════════════════════════════════
/**
 * Registers SIGTERM and SIGINT handlers that perform a graceful shutdown:
 * saves the database, pauses all voice sessions, destroys the Discord client,
 * and closes the Express server. A 10-second timeout forces exit if the
 * sequence does not complete in time.
 * @param {object} opts
 * @param {object} opts.sessionManager - Session manager; `saveDatabase()` is called first.
 * @param {object} opts.voiceWorker - Voice worker; `pauseAll()` is called to cleanly
 *   disconnect all voice sessions.
 * @param {import('discord.js').Client|null} opts.client - Discord client to destroy,
 *   or null if not yet initialised.
 */
function initShutdown({ sessionManager, voiceWorker, client }) {
    let isShuttingDownMain = false;

    async function shutdown(signal) {
        if (isShuttingDownMain) return;
        isShuttingDownMain = true;
        console.log(`\n⛔ [SHUTDOWN] ${signal} — graceful shutdown starting...`);
        voiceWorker.setShuttingDown(true);

        const timeout = setTimeout(() => {
            console.error("[SHUTDOWN] ⏱️ Timeout — forcing exit");
            process.exit(1);
        }, 10000);

        try {
            await sessionManager.saveDatabase();
            console.log("[SHUTDOWN] ✅ Database synced");
            await voiceWorker.pauseAll();
            console.log("[SHUTDOWN] ✅ Voice paused");
            if (client) { client.destroy(); console.log("[SHUTDOWN] ✅ Discord destroyed"); }
            if (global.server) global.server.close(() => console.log("[SHUTDOWN] ✅ Express closed"));
            clearTimeout(timeout);
            process.exit(0);
        } catch (err) {
            console.error("[SHUTDOWN] ❌ Error:", err.message);
            clearTimeout(timeout);
            process.exit(1);
        }
    }

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT",  () => shutdown("SIGINT"));
}

module.exports = {
    webLogs,
    get crashShieldReady() { return crashShieldReady; },
    set crashShieldReady(v) { crashShieldReady = v; },
    get botReadyAt() { return botReadyAt; },
    set botReadyAt(v) { botReadyAt = v; },
    originalLog, originalError, originalWarn,
    initLogCapture, initCrashShield, initCronJobs, initShutdown
};

