/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT MODIFY: crashShieldReady flag logic.
DO NOT REMOVE: process.on handlers — critical for stability.
DO NOT SIMPLIFY: Log capture ring buffer — prevents RAM bloat.
================================================================================
*/

const {
    sendAlertWebhook,
    flushWebhookQueue,
    shutdownWebhookDispatcher
} = require("../core/webhooks");
const { sanitizeLogText, safeError } = require("../core/safeLogger");
const { normalizeRuntimeLine } = require("../core/startupLogger");

// ════════════════════════════════════════════════════════════════════════════
//  🗂️  SHARED STATE (exported สำหรับ server.js / views.js ใช้)
// ════════════════════════════════════════════════════════════════════════════
const webLogs = [];
const MAX_LOGS_DEFAULT = 500;

let crashShieldReady = false;
let botReadyAt = null;
let commandsReady = false;
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
const CRITICAL_ALERT_COOLDOWN_MS = Math.max(1000, Number(process.env.CRITICAL_ALERT_COOLDOWN_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
const CRITICAL_ALERT_MAX_FINGERPRINTS = Math.max(10, Number(process.env.CRITICAL_ALERT_MAX_FINGERPRINTS || 100) || 100);
const REQUEST_COUNT_MAX_BUCKETS = Math.max(100, Number(process.env.RATE_LIMIT_MAX_BUCKETS || 5000) || 5000);
const COMMAND_COOLDOWN_MAX_USERS = Math.max(100, Number(process.env.COMMAND_COOLDOWN_MAX_USERS || 5000) || 5000);
const TOGGLE_COOLDOWN_MAX_KEYS = Math.max(100, Number(process.env.TOGGLE_COOLDOWN_MAX_KEYS || 1000) || 1000);
const ANTI_RAID_DEBOUNCE_MAX_KEYS = Math.max(100, Number(process.env.ANTI_RAID_DEBOUNCE_MAX_KEYS || 5000) || 5000);

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
        const line = normalizeRuntimeLine('log', msg);
        pushLog('info', line);
        originalLog(line);
    };
    console.error = (...args) => {
        const msg = require('util').format(...args);
        const line = normalizeRuntimeLine('error', msg);
        pushLog('error', line);
        originalError(line);
    };
    console.warn = (...args) => {
        const msg = require('util').format(...args);
        const line = normalizeRuntimeLine('warn', msg);
        pushLog('warn', line);
        originalWarn(line);
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  💥  CRASH SHIELD — Global Process Handlers
// ════════════════════════════════════════════════════════════════════════════
function firstStackFrame(error) {
    return String(error?.stack || "")
        .split("\n")
        .slice(1)
        .map(line => line.trim())
        .find(Boolean) || "no-stack";
}

function criticalFingerprint(type, error) {
    return [type, safeError(error), sanitizeLogText(firstStackFrame(error))].join("|");
}

function createCriticalAlertDispatcher(options = {}) {
    const send = options.send || sendAlertWebhook;
    const cooldownMs = Math.max(1000, Number(options.cooldownMs || CRITICAL_ALERT_COOLDOWN_MS));
    const maxFingerprints = Math.max(1, Number(options.maxFingerprints || CRITICAL_ALERT_MAX_FINGERPRINTS));
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const entries = new Map();

    function forgetOldestEntry() {
        if (entries.size < maxFingerprints) return;
        const oldestKey = entries.keys().next().value;
        const oldest = entries.get(oldestKey);
        if (oldest?.timer) clearTimer(oldest.timer);
        entries.delete(oldestKey);
    }

    async function sendSummary(key) {
        const entry = entries.get(key);
        if (!entry) return;
        entries.delete(key);
        if (entry.duplicates < 1) return;
        await send({
            content: `🚨 **[CRITICAL SUMMARY] ${entry.type}**\n\`\`\`\n${entry.message}\nRepeated ${entry.duplicates} additional time(s) within ${Math.round(cooldownMs / 1000)}s.\n\`\`\``
        }).catch(() => {});
    }

    async function dispatch(type, error, payload) {
        const key = criticalFingerprint(type, error);
        const existing = entries.get(key);
        if (existing && now() - existing.startedAt < cooldownMs) {
            existing.duplicates++;
            return false;
        }
        if (existing?.timer) clearTimer(existing.timer);
        if (existing) entries.delete(key);
        forgetOldestEntry();
        const entry = {
            type,
            message: safeError(error),
            startedAt: now(),
            duplicates: 0,
            timer: null
        };
        entry.timer = setTimer(() => {
            sendSummary(key).catch(() => {});
        }, cooldownMs);
        entry.timer?.unref?.();
        entries.set(key, entry);
        const delivered = await send(payload).catch(() => false);
        if (delivered !== true) {
            if (entry.timer) clearTimer(entry.timer);
            entries.delete(key);
            return false;
        }
        return true;
    }

    function stop() {
        for (const entry of entries.values()) {
            if (entry.timer) clearTimer(entry.timer);
        }
        entries.clear();
    }

    return { dispatch, sendSummary, stop, entries };
}

function initCrashShield(config) {
    const criticalAlerts = createCriticalAlertDispatcher();
    process.on("uncaughtException", async (err) => {
        originalError(sanitizeLogText(`[CRITICAL] uncaughtException: ${err.message}\n${err.stack || ""}`));
        await criticalAlerts.dispatch("uncaughtException", err, {
            content: `🚨 **[CRITICAL] uncaughtException**\n\`\`\`\n${safeError(err)}\n${sanitizeLogText(err.stack || "").substring(0, 800)}\n\`\`\``
        });
        if (!crashShieldReady) {
            await new Promise(r => setTimeout(r, 1500));
            process.exit(1);
        }
    });

    process.on("unhandledRejection", async (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        const msg = error.message;
        originalError(sanitizeLogText(`[CRITICAL] unhandledRejection: ${msg}`));
        await criticalAlerts.dispatch("unhandledRejection", error, {
            content: `🚨 **[CRITICAL] unhandledRejection**\n\`\`\`\n${sanitizeLogText(msg).substring(0, 900)}\n\`\`\``
        });
        if (!crashShieldReady) {
            await new Promise(r => setTimeout(r, 1500));
            process.exit(1);
        }
    });
    return criticalAlerts;
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

function trimMapToMaxSize(map, maxSize) {
    if (!map || !Number.isFinite(maxSize) || maxSize <= 0 || map.size <= maxSize) return;

    while (map.size > maxSize) {
        const oldestKey = map.keys().next().value;
        if (!oldestKey) break;
        map.delete(oldestKey);
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
    commandCooldowns, toggleCooldowns, antiRaidDebounce,
    voiceWorker, config
}, now) {
    const windowMs = config.limits.rateLimitWindowMs || 60000;

    pruneTimestampListMap(spamTracking, now, 60000);
    pruneTimestampListMap(requestCounts, now, windowMs);
    pruneCommandCooldowns(commandCooldowns, now, 30000);
    pruneTimestampMap(toggleCooldowns, now, 5000);
    pruneTimestampMap(antiRaidDebounce, now, 10000);
    trimMapToMaxSize(spamTracking, config.limits.spamTrackingMaxUsers || 1000);
    trimMapToMaxSize(requestCounts, REQUEST_COUNT_MAX_BUCKETS);
    trimMapToMaxSize(commandCooldowns, COMMAND_COOLDOWN_MAX_USERS);
    trimMapToMaxSize(toggleCooldowns, TOGGLE_COOLDOWN_MAX_KEYS);
    trimMapToMaxSize(antiRaidDebounce, ANTI_RAID_DEBOUNCE_MAX_KEYS);
    voiceWorker.cleanupVolatileState?.(now);
}

function initCronJobs({
    spamTracking, requestCounts,
    commandCooldowns, toggleCooldowns, antiRaidDebounce,
    sessionManager, voiceWorker, config
}) {
    stopCronJobs();

    // CRON 30s: ล้าง Map เก่า
    const cleanupTimer = setInterval(async () => {
        try {
            const now = Date.now();
            cleanupVolatileMaps({
                spamTracking, requestCounts,
                commandCooldowns, toggleCooldowns, antiRaidDebounce,
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

function initShutdown({
    sessionManager,
    voiceWorker,
    client,
    memoryMonitor,
    verificationRuntime,
    dmService
}) {
    let isShuttingDownMain = false;

    async function shutdown(signal) {
        if (isShuttingDownMain) return;
        isShuttingDownMain = true;
        markAppShuttingDown();
        const timeout = setTimeout(() => {
            console.error("[SHUTDOWN] ⏱️ Timeout — forcing exit");
            process.exit(1);
        }, 10000);
        timeout.unref?.();
        console.log(`\n⛔ [SHUTDOWN] ${signal} — graceful shutdown starting...`);
        stopCronJobs();
        dmService?.stop?.();
        try {
            await verificationRuntime?.stopVerificationRuntime?.();
        } catch (err) {
            console.warn(`[SHUTDOWN] ⚠️ Verification runtime stop skipped: ${err.message}`);
        }
        voiceWorker.setShuttingDown(true);

        try {
            await sessionManager.saveDatabase();
            console.log("[SHUTDOWN] ✅ Database synced");
            await voiceWorker.pauseAll();
            console.log("[SHUTDOWN] ✅ Voice paused");
            if (client) { client.destroy(); console.log("[SHUTDOWN] ✅ Discord destroyed"); }
            if (memoryMonitor?.stopMemoryMonitor) memoryMonitor.stopMemoryMonitor();
            await closeServer();
            const webhookFlushed = await flushWebhookQueue(2500);
            if (!webhookFlushed) console.warn("[SHUTDOWN] ⚠️ Webhook queue did not fully drain before timeout");
            await shutdownWebhookDispatcher(500);
            await sessionManager.disconnectDB?.();
            console.log("[SHUTDOWN] ✅ MongoDB disconnected");
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
    get commandsReady() { return commandsReady; },
    set commandsReady(v) { commandsReady = v === true; },
    get shutdownRequested() { return isShuttingDown(); },
    markAppShuttingDown, isShuttingDown,
    originalLog, originalError, originalWarn,
    initLogCapture, initCrashShield, initCronJobs, stopCronJobs, initShutdown,
    criticalFingerprint, createCriticalAlertDispatcher
};
