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
    buildWebhookEventPayload
} = require("../core/webhooks");
const { sanitizeLogText, safeError } = require("../core/safeLogger");
const { normalizeRuntimeLine } = require("../core/startupLogger");
const { readFiniteInteger } = require("../core/numbers");

// ════════════════════════════════════════════════════════════════════════════
//  🗂️  SHARED STATE (exported สำหรับ server.js / views.js ใช้)
// ════════════════════════════════════════════════════════════════════════════
const webLogs = [];
const MAX_LOGS_DEFAULT = 500;

let crashShieldReady = false;
let botReadyAt = null;
let fatalShutdownHandler = null;
let fatalShutdownStarted = false;
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
const CRITICAL_ALERT_COOLDOWN_MS = readFiniteInteger(process.env.CRITICAL_ALERT_COOLDOWN_MS, { fallback: 5 * 60 * 1000, min: 1000, max: 24 * 60 * 60 * 1000 });
const CRITICAL_ALERT_MAX_FINGERPRINTS = readFiniteInteger(process.env.CRITICAL_ALERT_MAX_FINGERPRINTS, { fallback: 100, min: 10, max: 10000 });
const REQUEST_COUNT_MAX_BUCKETS = readFiniteInteger(process.env.RATE_LIMIT_MAX_BUCKETS, { fallback: 5000, min: 100, max: 100000 });
const COMMAND_COOLDOWN_MAX_USERS = readFiniteInteger(process.env.COMMAND_COOLDOWN_MAX_USERS, { fallback: 5000, min: 100, max: 100000 });
const TOGGLE_COOLDOWN_MAX_KEYS = readFiniteInteger(process.env.TOGGLE_COOLDOWN_MAX_KEYS, { fallback: 1000, min: 100, max: 100000 });


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

function buildCriticalSummaryPayload(entry, cooldownMs) {
    return buildWebhookEventPayload({
        target: "ALERT",
        severity: "CRITICAL",
        category: "SYSTEM",
        code: `runtime.${entry.type}.repeated`,
        state: "UPDATE",
        title: "ข้อผิดพลาดระดับวิกฤตเกิดซ้ำ",
        description: entry.message,
        impact: "Process ยังพบข้อผิดพลาดชนิดเดิมซ้ำภายในช่วงควบคุมข้อความ",
        action: "ตรวจ Runtime Log และ Stack Trace ของเหตุการณ์แรก",
        context: {
            "ประเภท": entry.type,
            "เกิดซ้ำเพิ่ม": `${entry.duplicates} ครั้ง`,
            "ช่วงเวลา": `${Math.round(cooldownMs / 1000)} วินาที`
        }
    });
}

class CriticalAlertDispatcher {
    constructor(options = {}) {
        this.send = options.send || sendAlertWebhook;
        this.cooldownMs = Math.max(1000, Number(options.cooldownMs || CRITICAL_ALERT_COOLDOWN_MS));
        this.maxFingerprints = Math.max(1, Number(options.maxFingerprints || CRITICAL_ALERT_MAX_FINGERPRINTS));
        this.now = options.now || Date.now;
        this.setTimer = options.setTimer || setTimeout;
        this.clearTimer = options.clearTimer || clearTimeout;
        this.entries = new Map();
    }

    forgetOldestEntry() {
        if (this.entries.size < this.maxFingerprints) return;
        const oldestKey = this.entries.keys().next().value;
        const oldest = this.entries.get(oldestKey);
        if (oldest?.timer) this.clearTimer(oldest.timer);
        this.entries.delete(oldestKey);
    }

    async sendSummary(key) {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        if (entry.duplicates < 1) return;
        await this.send(buildCriticalSummaryPayload(entry, this.cooldownMs)).catch(() => {});
    }

    async dispatch(type, error, payload) {
        const key = criticalFingerprint(type, error);
        const existing = this.entries.get(key);
        if (existing && this.now() - existing.startedAt < this.cooldownMs) {
            existing.duplicates++;
            return false;
        }
        if (existing?.timer) this.clearTimer(existing.timer);
        if (existing) this.entries.delete(key);
        this.forgetOldestEntry();
        const entry = {
            type,
            message: safeError(error),
            startedAt: this.now(),
            duplicates: 0,
            timer: null
        };
        entry.timer = this.setTimer(() => {
            this.sendSummary(key).catch(() => {});
        }, this.cooldownMs);
        entry.timer?.unref?.();
        this.entries.set(key, entry);
        const delivered = await this.send(payload).catch(() => false);
        if (delivered !== true) {
            if (entry.timer) this.clearTimer(entry.timer);
            this.entries.delete(key);
            return false;
        }
        return true;
    }

    stop() {
        for (const entry of this.entries.values()) {
            if (entry.timer) this.clearTimer(entry.timer);
        }
        this.entries.clear();
    }
}

function createCriticalAlertDispatcher(options = {}) {
    const instance = new CriticalAlertDispatcher(options);
    return {
        dispatch: instance.dispatch.bind(instance),
        sendSummary: instance.sendSummary.bind(instance),
        stop: instance.stop.bind(instance),
        entries: instance.entries
    };
}

async function terminateAfterFatal(type, error) {
    if (fatalShutdownStarted) return;
    fatalShutdownStarted = true;

    if (typeof fatalShutdownHandler === "function") {
        try {
            await fatalShutdownHandler(`FATAL_${type}`, 1);
            return;
        } catch (shutdownError) {
            originalError(`[CRITICAL] fatal shutdown failed: ${shutdownError?.message || shutdownError}`);
        }
    }

    await new Promise(resolve => setTimeout(resolve, 250));
    process.exit(1);
}

function setFatalShutdownHandler(handler) {
    fatalShutdownHandler = typeof handler === "function" ? handler : null;
}

function initCrashShield(config) {
    const criticalAlerts = createCriticalAlertDispatcher();
    process.on("uncaughtException", async (err) => {
        originalError(sanitizeLogText(`[CRITICAL] uncaughtException: ${err.message}\n${err.stack || ""}`));
        await criticalAlerts.dispatch("uncaughtException", err, buildWebhookEventPayload({
            target: "ALERT",
            severity: "CRITICAL",
            category: "SYSTEM",
            code: "runtime.uncaught_exception",
            state: "OPEN",
            title: "Runtime เกิด Uncaught Exception",
            description: `${safeError(err)}\n\n${sanitizeLogText(err.stack || "").substring(0, 800)}`,
            impact: "Process อาจอยู่ในสถานะไม่สมบูรณ์หรือหยุดทำงานระหว่างเริ่มระบบ",
            action: "ตรวจ Stack Trace และ Runtime Log ทันที"
        }));
        if (!crashShieldReady) {
            await new Promise(r => setTimeout(r, 1500));
            process.exit(1);
        }
        await terminateAfterFatal("uncaughtException", err);
    });

    process.on("unhandledRejection", async (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        const msg = error.message;
        originalError(sanitizeLogText(`[CRITICAL] unhandledRejection: ${msg}`));
        await criticalAlerts.dispatch("unhandledRejection", error, buildWebhookEventPayload({
            target: "ALERT",
            severity: "CRITICAL",
            category: "SYSTEM",
            code: "runtime.unhandled_rejection",
            state: "OPEN",
            title: "Runtime พบ Promise ที่ไม่มีตัวจัดการข้อผิดพลาด",
            description: sanitizeLogText(msg).substring(0, 900),
            impact: "งานเบื้องหลังบางส่วนอาจหยุดหรือทิ้งสถานะไม่สมบูรณ์",
            action: "ตรวจ Runtime Log เพื่อหาต้นทางของ Promise"
        }));
        if (!crashShieldReady) {
            await new Promise(r => setTimeout(r, 1500));
            process.exit(1);
        }
        await terminateAfterFatal("unhandledRejection", error);
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
    commandCooldowns, toggleCooldowns,
    voiceWorker, config
}, now) {
    const windowMs = config.limits.rateLimitWindowMs || 60000;

    pruneTimestampListMap(spamTracking, now, 60000);
    pruneTimestampListMap(requestCounts, now, windowMs);
    pruneCommandCooldowns(commandCooldowns, now, 30000);
    pruneTimestampMap(toggleCooldowns, now, 5000);
    trimMapToMaxSize(spamTracking, config.limits.spamTrackingMaxUsers || 1000);
    trimMapToMaxSize(requestCounts, REQUEST_COUNT_MAX_BUCKETS);
    trimMapToMaxSize(commandCooldowns, COMMAND_COOLDOWN_MAX_USERS);
    trimMapToMaxSize(toggleCooldowns, TOGGLE_COOLDOWN_MAX_KEYS);
    voiceWorker.cleanupVolatileState?.(now);
}

function initCronJobs({
    spamTracking, requestCounts,
    commandCooldowns, toggleCooldowns,
    sessionManager, voiceWorker, config
}) {
    stopCronJobs();

    // CRON 30s: ล้าง Map เก่า
    const cleanupTimer = setInterval(async () => {
        try {
            const now = Date.now();
            cleanupVolatileMaps({
                spamTracking, requestCounts,
                commandCooldowns, toggleCooldowns,
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
async function stopRuntimeCleanups(runtimeCleanups = []) {
    let stopped = 0;
    let failed = 0;
    for (const cleanup of runtimeCleanups) {
        try {
            if (typeof cleanup?.stop !== "function") continue;
            await cleanup.stop();
            stopped++;
        } catch (err) {
            failed++;
            console.warn(`[SHUTDOWN] ⚠️ Runtime cleanup skipped: ${err?.message || "unknown error"}`);
        }
    }
    return { stopped, failed };
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
    initLogCapture, initCrashShield, initCronJobs, stopCronJobs, setFatalShutdownHandler, terminateAfterFatal,
    criticalFingerprint, createCriticalAlertDispatcher, stopRuntimeCleanups
};
