/**
 * System Stability & Process Lifecycle
 * - Transient Gateway Crash Shield & global process error handlers.
 * - In-memory log capture ring buffer (prevents RAM bloat).
 * - Scheduled cron maintenance tasks and map pruning.
 */

const webhooks = require("../core/webhooks");
const {
    sendAlertWebhook,
    buildWebhookEventPayload
} = webhooks;
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

    const alertDedupe = new Map();
    const DEDUPE_WINDOW_MS = 2 * 60 * 1000;
    const MAX_DEDUPE_ENTRIES = 500;
    let isForwardingAlert = false;

    function forwardConsoleAlert(level, line) {
        if (isForwardingAlert) return;
        if (typeof line !== "string" || !line.trim()) return;

        // Skip internal webhook transport and delivery warnings to avoid feedback loops
        if (line.includes("[WEBHOOK]") || line.includes("ALERT delivery unavailable")) return;

        // Skip protected shadow operational logs to preserve policy
        if (line.includes("[SHADOW")) return;

        // Skip events that already have dedicated rich webhooks dispatched
        if (line.includes("MongoDB Connection Lost") ||
            line.includes("MongoDB Error:") ||
            line.includes("MongoDB save failed:") ||
            (line.includes("[GATEWAY]") && (line.includes("event=error") || line.includes("event=shardError") || line.includes("event=shardDisconnect") || line.includes("event=shardResume"))) ||
            line.includes("[SLASH] ❌ Error in") ||
            line.includes("[CRITICAL] uncaughtException") ||
            line.includes("[CRITICAL] unhandledRejection")) {
            return;
        }

        // Determine subsystem category from tags in log text (skipping generic BOT/LEVEL tags)
        const tagMatches = [...line.matchAll(/\[([^\]]+)\]/g)]
            .map(m => m[1].trim().toUpperCase())
            .filter(t => !["BOT", "OK", "INFO", "WARN", "FAIL", "ERROR", "CRITICAL"].includes(t.replace(/[^A-Z]/g, "")));
        const rawTag = tagMatches[0] || "RUNTIME";

        let category = "RUNTIME";
        if (rawTag.includes("DATA") || rawTag.includes("MONGO") || rawTag.includes("SQLITE")) category = "DATABASE";
        else if (rawTag.includes("VOICE") || rawTag.includes("WORKER") || rawTag.includes("SESSION") || rawTag.includes("AUTODEAF") || rawTag.includes("NATURAL") || rawTag.includes("HEARTBEAT")) category = "VOICE";
        else if (rawTag.includes("VERIFY") || rawTag.includes("OAUTH") || rawTag.includes("SNAPSHOT")) category = "VERIFICATION";
        else if (rawTag.includes("GATEWAY") || rawTag.includes("SHARD")) category = "GATEWAY";
        else if (rawTag.includes("COMMAND") || rawTag.includes("SLASH") || rawTag.includes("ROLE")) category = "COMMAND";
        else if (rawTag.includes("SECURITY") || rawTag.includes("PROTECTION") || rawTag.includes("RAID") || rawTag.includes("SPAM")) category = "SECURITY";
        else if (rawTag.includes("QUEST")) category = "QUEST";
        else if (rawTag.includes("MODCASE")) category = "MODERATION";
        else if (rawTag.includes("HTTP") || rawTag.includes("API") || rawTag.includes("ROUTE")) category = "RUNTIME";
        else if (rawTag.includes("CRITICAL") || rawTag.includes("FATAL")) category = "SYSTEM";

        // Clean message text for dedupe key and embed
        const cleanMsg = line.replace(/^\[(?:BOT|GATEWAY|DATABASE|WORKER|SESSION|SLASH|SECURITY|VERIFY|QUEST|PROTECTION|RUNTIME|AUTODEAF|NATURAL|HEARTBEAT|MODCASE|ROLE_BTN|HTTP|API)[^\]]*\]\s*/i, "").trim();

        // Fingerprint for deduplication
        const fingerprint = `${level}:${category}:${cleanMsg.slice(0, 120)}`;
        const now = Date.now();
        const lastSent = alertDedupe.get(fingerprint);
        if (lastSent && (now - lastSent) < DEDUPE_WINDOW_MS) {
            return;
        }

        if (alertDedupe.size >= MAX_DEDUPE_ENTRIES) {
            const oldestKey = alertDedupe.keys().next().value;
            alertDedupe.delete(oldestKey);
        }
        alertDedupe.set(fingerprint, now);

        isForwardingAlert = true;
        try {
            const isError = level === "error";
            const severity = isError ? "ERROR" : "WARNING";
            const title = isError ? `${category} ERROR DETECTED` : `${category} WARNING DETECTED`;
            const code = `${category.toLowerCase()}.${isError ? "log_error" : "log_warning"}`;

            webhooks.sendAlertWebhook(webhooks.buildWebhookEventPayload({
                target: "ALERT",
                severity,
                category,
                code,
                state: "OPEN",
                title,
                description: line.slice(0, 1000),
                impact: isError ? "พบข้อผิดพลาดในระบบ Runtime หรือฐานข้อมูล ซึ่งอาจกระทบต่อบริการ" : "ระบบตรวจพบการแจ้งเตือนที่ควรเฝ้าระวังความเสถียร",
                action: "ตรวจสอบข้อความแจ้งเตือนและบริบทการทำงานในระบบ",
                context: {
                    "ประเภท": isError ? "ข้อผิดพลาด (Error)" : "คำเตือน (Warning)",
                    "หมวดหมู่": category
                }
            })).catch(() => {});
        } catch {
            // Logging must never crash the bot process
        } finally {
            isForwardingAlert = false;
        }
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
        forwardConsoleAlert('error', line);
    };
    console.warn = (...args) => {
        const msg = require('util').format(...args);
        const line = normalizeRuntimeLine('warn', msg);
        pushLog('warn', line);
        originalWarn(line);
        forwardConsoleAlert('warn', line);
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

function isTransientGatewayError(err) {
    if (!err) return false;
    const msg = String(err?.message || "");
    const code = String(err?.code || "");
    const stack = String(err?.stack || "");
    const causeCode = String(err?.cause?.code || "");
    const causeMsg = String(err?.cause?.message || "");

    // 1. Cloudflare / Discord gateway HTTP response errors on WebSocket handshake
    if (/Unexpected server response:\s*(?:520|521|522|523|524|525|502|503|504)/i.test(msg) ||
        /Unexpected server response:\s*(?:520|521|522|523|524|525|502|503|504)/i.test(causeMsg)) {
        return true;
    }

    // 2. Common transient socket/DNS blips on gateway connection
    const transientCodes = [
        "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED",
        "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ERR_STREAM_PREMATURE_CLOSE"
    ];
    if (transientCodes.includes(code) || transientCodes.includes(causeCode)) {
        if (/websocket|gateway|discord/i.test(stack) || /websocket|gateway|discord/i.test(msg) || /websocket|gateway|discord/i.test(causeMsg)) {
            return true;
        }
    }

    // 3. WS handshake timeout or connection abort or premature close
    if (/Opening handshake has timed out|WebSocket was closed before the connection was established|Connection reset by peer|premature close/i.test(msg) ||
        /Opening handshake has timed out|WebSocket was closed before the connection was established|Connection reset by peer|premature close/i.test(causeMsg)) {
        return true;
    }

    // 4. Discord REST 5xx transient server outages (DiscordAPIError 500, 502, 503, 504, 520-525)
    if (/DiscordAPIError.*(?:500|502|503|504|520|521|522|523|524|525)/i.test(msg) ||
        /DiscordAPIError.*(?:500|502|503|504|520|521|522|523|524|525)/i.test(causeMsg)) {
        return true;
    }

    return false;
}

function isRecoverableRuntimeError(err) {
    if (!err) return false;
    if (isTransientGatewayError(err)) return true;
    const msg = String(err?.message || "");
    const name = String(err?.name || "");

    // 1. Any DiscordAPIError (e.g. 10062 Unknown interaction, 10008 Unknown Message, 50007 Cannot DM, 50013 Missing Permissions, 40060, etc.)
    if (name === "DiscordAPIError" || /DiscordAPIError/i.test(msg) || /DiscordAPIError/i.test(name)) {
        return true;
    }

    // 2. Common non-fatal Discord interaction/messaging errors
    if (/Unknown interaction|Unknown message|Cannot send messages to this user|Missing Permissions|Missing Access|Interaction has already been acknowledged/i.test(msg)) {
        return true;
    }

    // 3. Transient MongoDB connection/buffering drops (Mongoose will auto-reconnect)
    if (/MongoNetworkError|buffering timed out|MongoServerSelectionError/i.test(name) ||
        /MongoNetworkError|buffering timed out|MongoServerSelectionError/i.test(msg)) {
        return true;
    }

    return false;
}

function initCrashShield(config) {
    const criticalAlerts = createCriticalAlertDispatcher();
    process.on("uncaughtException", async (err) => {
        if (isRecoverableRuntimeError(err)) {
            originalWarn(sanitizeLogText(`[GATEWAY/RUNTIME] ⚠️ Recoverable exception shielded from fatal exit (keeping process alive): ${err.message}`));
            await criticalAlerts.dispatch("recoverableException", err, buildWebhookEventPayload({
                target: "ALERT",
                severity: "WARNING",
                category: "RUNTIME",
                code: "runtime.recoverable_exception",
                state: "UPDATE",
                title: "RECOVERABLE EXCEPTION SHIELDED",
                description: `${safeError(err)}\n\nระบบตรวจพบข้อผิดพลาดที่ไม่ร้ายแรงและทำการป้องกันไม่ให้ระบบหยุดทำงาน`,
                impact: "งานหรือคำสั่งที่เกิดข้อผิดพลาดอาจไม่สำเร็จ แต่บอทและระบบหลักยังคงทำงานต่อเนื่อง",
                action: "ตรวจสอบข้อผิดพลาดใน Runtime Log เพื่อปรับปรุงคำสั่งที่เกี่ยวข้อง"
            })).catch(() => {});
            return;
        }

        originalError(sanitizeLogText(`[CRITICAL] uncaughtException: ${err.message}\n${err.stack || ""}`));
        await criticalAlerts.dispatch("uncaughtException", err, buildWebhookEventPayload({
            target: "ALERT",
            severity: "CRITICAL",
            category: "RUNTIME",
            code: "runtime.uncaught_exception",
            state: "OPEN",
            title: "UNCAUGHT EXCEPTION",
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

        if (isRecoverableRuntimeError(error)) {
            originalWarn(sanitizeLogText(`[GATEWAY/RUNTIME] ⚠️ Recoverable rejection shielded from fatal exit (keeping process alive): ${msg}`));
            await criticalAlerts.dispatch("recoverableRejection", error, buildWebhookEventPayload({
                target: "ALERT",
                severity: "WARNING",
                category: "RUNTIME",
                code: "runtime.recoverable_rejection",
                state: "UPDATE",
                title: "RECOVERABLE REJECTION SHIELDED",
                description: `${sanitizeLogText(msg).substring(0, 900)}\n\nระบบตรวจพบข้อผิดพลาดที่ไม่ร้ายแรงและทำการป้องกันไม่ให้ระบบหยุดทำงาน เพื่อรักษาความต่อเนื่องของบริการ`,
                impact: "งานหรือคำสั่งที่เกิดข้อผิดพลาดอาจไม่สำเร็จ แต่บอทและระบบหลักยังคงทำงานต่อเนื่องได้ 100%",
                action: "ไม่ต้องดำเนินการใดๆ ระบบจัดการทรัพยากรให้อัตโนมัติ"
            })).catch(() => {});
            return;
        }

        originalError(sanitizeLogText(`[CRITICAL] unhandledRejection: ${msg}`));
        await criticalAlerts.dispatch("unhandledRejection", error, buildWebhookEventPayload({
            target: "ALERT",
            severity: "CRITICAL",
            category: "RUNTIME",
            code: "runtime.unhandled_rejection",
            state: "OPEN",
            title: "UNHANDLED REJECTION",
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

    // CRON 180s: Health + DB save (lock ป้องกัน overlap)
    // Fix #2: เพิ่มจาก 90s → 180s ให้มากกว่า RECOVERY_COOLDOWN_MS (120s) ป้องกัน recovery queue ซ้อนกัน
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
    }, 180000);
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
    criticalFingerprint, createCriticalAlertDispatcher, stopRuntimeCleanups, isTransientGatewayError,
    isRecoverableRuntimeError
};
