/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT MODIFY: crashShieldReady flag logic.
DO NOT REMOVE: process.on handlers — critical for stability.
DO NOT SIMPLIFY: Log capture ring buffer — prevents RAM bloat.
================================================================================
*/

const { sendAlertWebhook } = require("../core/webhooks");
const { sanitizeLogText, safeError } = require("../core/safeLogger");

// ════════════════════════════════════════════════════════════════════════════
//  🗂️  SHARED STATE (exported สำหรับ server.js / views.js ใช้)
// ════════════════════════════════════════════════════════════════════════════
const webLogs = [];
const MAX_LOGS_DEFAULT = 500;

let crashShieldReady = false;
let botReadyAt = null;
let isAppShuttingDown = global.__APP_SHUTTING_DOWN === true;


function markAppShuttingDown() {
    isAppShuttingDown = true;
    global.__APP_SHUTTING_DOWN = true;
}

function isShuttingDown() {
    return isAppShuttingDown || global.__APP_SHUTTING_DOWN === true;
}

const originalLog   = console.log;
const originalError = console.error;
const originalWarn  = console.warn;
const cronTimers = [];

// ════════════════════════════════════════════════════════════════════════════
//  📜  LOG CAPTURE — Ring Buffer (กัน RAM บวม)
// ════════════════════════════════════════════════════════════════════════════
function initLogCapture(maxLogs = MAX_LOGS_DEFAULT) {
    function pushLog(type, msg) {
        msg = sanitizeLogText(msg);
        if (msg.length > 500) msg = msg.substring(0, 500) + '... [TRUNCATED]';
        webLogs.push({ time: new Date().toLocaleTimeString('th-TH'), type, msg });
        if (webLogs.length > maxLogs) webLogs.shift();
    }

    console.log = (...args) => {
        const msg = require('util').format(...args);
        pushLog('info', msg);
        originalLog(sanitizeLogText(msg));
    };
    console.error = (...args) => {
        const msg = require('util').format(...args);
        pushLog('error', msg);
        originalError(sanitizeLogText(msg));
    };
    console.warn = (...args) => {
        const msg = require('util').format(...args);
        pushLog('warn', msg);
        originalWarn(sanitizeLogText(msg));
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  💥  CRASH SHIELD — Global Process Handlers
// ════════════════════════════════════════════════════════════════════════════
function initCrashShield(config) {
    process.on("uncaughtException", async (err) => {
        originalError(sanitizeLogText(`[CRITICAL] uncaughtException: ${err.message}\n${err.stack || ""}`));
        await sendAlertWebhook({
            content: `🚨 **[CRITICAL] uncaughtException**\n\`\`\`\n${safeError(err)}\n${sanitizeLogText(err.stack || "").substring(0, 800)}\n\`\`\``
        }).catch(() => {});
        if (!crashShieldReady) {
            await new Promise(r => setTimeout(r, 1500));
            process.exit(1);
        }
    });

    process.on("unhandledRejection", async (reason) => {
        const msg = reason?.message ?? String(reason);
        originalError(sanitizeLogText(`[CRITICAL] unhandledRejection: ${msg}`));
        await sendAlertWebhook({
            content: `🚨 **[CRITICAL] unhandledRejection**\n\`\`\`\n${sanitizeLogText(msg).substring(0, 900)}\n\`\`\``
        }).catch(() => {});
        if (!crashShieldReady) {
            await new Promise(r => setTimeout(r, 1500));
            process.exit(1);
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  ⏱️  CRON JOBS
// ════════════════════════════════════════════════════════════════════════════
function pruneTimestampListMap(map, now, ttlMs) {
    for (const [key, timestamps] of map.entries()) {
        const activeTimestamps = timestamps.filter(ts => now - ts < ttlMs);
        if (activeTimestamps.length) {
            map.set(key, activeTimestamps);
        } else {
            map.delete(key);
        }
    }
}

function pruneTimestampMap(map, now, ttlMs) {
    for (const [key, ts] of map.entries()) {
        if (now - ts > ttlMs) {
            map.delete(key);
        }
    }
}

function pruneCommandCooldowns(commandCooldowns, now, ttlMs) {
    for (const [uid, commands] of commandCooldowns.entries()) {
        pruneTimestampMap(commands, now, ttlMs);
        if (!commands.size) {
            commandCooldowns.delete(uid);
        }
    }
}

function cleanupVolatileMaps({
    spamTracking, requestCounts,
    commandCooldowns, toggleCooldowns, antiRaidLogDebounce,
    voiceWorker, config
}, now) {
    const windowMs = config.limits.rateLimitWindowMs || 60000;

    pruneTimestampListMap(spamTracking, now, 60000);
    pruneTimestampListMap(requestCounts, now, windowMs);
    pruneCommandCooldowns(commandCooldowns, now, 30000);
    pruneTimestampMap(toggleCooldowns, now, 5000);
    pruneTimestampMap(antiRaidLogDebounce, now, 10000);
    voiceWorker.cleanupVolatileState?.(now);
}

function initCronJobs({
    spamTracking, requestCounts,
    commandCooldowns, toggleCooldowns, antiRaidLogDebounce,
    sessionManager, voiceWorker, config
}) {
    stopCronJobs();

    // CRON 30s: ล้าง Map เก่า
    const cleanupTimer = setInterval(async () => {
        try {
            const now = Date.now();
            cleanupVolatileMaps({
                spamTracking, requestCounts,
                commandCooldowns, toggleCooldowns, antiRaidLogDebounce,
                voiceWorker, config
            }, now);
        } catch (err) {
            console.error("[CRON] ❌ Map cleanup failed:", err.message);
        }
    }, 30000);
    cleanupTimer.unref?.();
    cronTimers.push(cleanupTimer);

    // CRON 90s: Health + DB save (lock ป้องกัน overlap)
    let _cronRunning = false;
    const healthTimer = setInterval(async () => {
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
    healthTimer.unref?.();
    cronTimers.push(healthTimer);
}

function stopCronJobs() {
    while (cronTimers.length) {
        const timer = cronTimers.pop();
        clearInterval(timer);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🛑  GRACEFUL SHUTDOWN
// ════════════════════════════════════════════════════════════════════════════
async function closeServer() {
    if (!global.server) return;

    await new Promise((resolve) => {
        let resolved = false;
        const done = () => {
            if (resolved) return;
            resolved = true;
            resolve();
        };

        const fallback = setTimeout(done, 3000);
        fallback.unref?.();

        try {
            global.server.close(() => {
                clearTimeout(fallback);
                console.log("[SHUTDOWN] ✅ Express closed");
                done();
            });
        } catch (err) {
            clearTimeout(fallback);
            console.warn(`[SHUTDOWN] ⚠️ Express close skipped: ${err.message}`);
            done();
        }
    });
}

function initShutdown({ sessionManager, voiceWorker, client, memoryMonitor, auditLogger }) {
    let isShuttingDownMain = false;

    async function shutdown(signal) {
        if (isShuttingDownMain) return;
        isShuttingDownMain = true;
        markAppShuttingDown();
        console.log(`\n⛔ [SHUTDOWN] ${signal} — graceful shutdown starting...`);
        stopCronJobs();
        auditLogger?.stopAuditCleanup?.();
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
            if (memoryMonitor?.stopMemoryMonitor) memoryMonitor.stopMemoryMonitor();
            await closeServer();
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
    get shutdownRequested() { return isShuttingDown(); },
    markAppShuttingDown, isShuttingDown,
    originalLog, originalError, originalWarn,
    initLogCapture, initCrashShield, initCronJobs, stopCronJobs, initShutdown
};
