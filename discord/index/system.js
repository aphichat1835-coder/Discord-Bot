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
function isMutedLogLine(line) {
    if (line.includes("[WEBHOOK]") || line.includes("ALERT delivery unavailable")) return true;
    if (line.includes("[SHADOW")) return true;
    return line.includes("MongoDB Connection Lost") ||
        line.includes("MongoDB Error:") ||
        line.includes("MongoDB save failed:") ||
        (line.includes("[GATEWAY]") && (line.includes("event=error") || line.includes("event=shardError") || line.includes("event=shardDisconnect") || line.includes("event=shardResume"))) ||
        line.includes("[SLASH] ❌ Error in") ||
        line.includes("[CRITICAL] uncaughtException") ||
        line.includes("[CRITICAL] unhandledRejection");
}

const LOG_CATEGORY_RULES = Object.freeze([
    { category: "DATABASE", keywords: ["DATA", "MONGO", "SQLITE"] },
    { category: "VOICE", keywords: ["VOICE", "WORKER", "SESSION", "AUTODEAF", "NATURAL", "HEARTBEAT"] },
    { category: "VERIFICATION", keywords: ["VERIFY", "OAUTH", "SNAPSHOT"] },
    { category: "GATEWAY", keywords: ["GATEWAY", "SHARD"] },
    { category: "COMMAND", keywords: ["COMMAND", "SLASH", "ROLE"] },
    { category: "SECURITY", keywords: ["SECURITY", "PROTECTION", "RAID", "SPAM"] },
    { category: "QUEST", keywords: ["QUEST"] },
    { category: "MODERATION", keywords: ["MODCASE"] },
    { category: "RUNTIME", keywords: ["HTTP", "API", "ROUTE"] },
    { category: "SYSTEM", keywords: ["CRITICAL", "FATAL"] }
]);

function deriveLogCategory(rawTag) {
    if (typeof rawTag !== "string") return "RUNTIME";
    for (const rule of LOG_CATEGORY_RULES) {
        if (rule.keywords.some(keyword => rawTag.includes(keyword))) {
            return rule.category;
        }
    }
    return "RUNTIME";
}

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

        if (isMutedLogLine(line)) return;

        // Determine subsystem category from tags in log text (skipping generic BOT/LEVEL tags)
        const rawTag = [...line.matchAll(/\[([^[\]]{1,64})\]/g)]
            .map(m => m[1].trim().toUpperCase())
            .find(t => !["BOT", "OK", "INFO", "WARN", "FAIL", "ERROR", "CRITICAL"].includes(t.replace(/[^A-Z]/g, ""))) || "RUNTIME";
        const category = deriveLogCategory(rawTag);

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

const TRANSIENT_GATEWAY_CODES = new Set([
    "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED",
    "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ERR_STREAM_PREMATURE_CLOSE"
]);

const CLOUDFLARE_5XX_REGEX = /Unexpected server response:\s*(?:520|521|522|523|524|525|502|503|504)/i;
const WS_HANDSHAKE_TIMEOUT_REGEX = /Opening handshake has timed out|WebSocket was closed before the connection was established|Connection reset by peer|premature close/i;
const DISCORD_API_5XX_REGEX = /DiscordAPIError.*(?:500|502|503|504|520|521|522|523|524|525)/i;
const GATEWAY_CONTEXT_REGEX = /websocket|gateway|discord/i;

function _matchesAnyText(regex, ...texts) {
    return texts.some(text => regex.test(text));
}

function _isTransientSocketBlip(code, causeCode, stack, msg, causeMsg) {
    if (!TRANSIENT_GATEWAY_CODES.has(code) && !TRANSIENT_GATEWAY_CODES.has(causeCode)) {
        return false;
    }
    return _matchesAnyText(GATEWAY_CONTEXT_REGEX, stack, msg, causeMsg);
}

function isTransientGatewayError(err) {
    if (!err) return false;
    const msg = String(err?.message || "");
    const code = String(err?.code || "");
    const stack = String(err?.stack || "");
    const causeCode = String(err?.cause?.code || "");
    const causeMsg = String(err?.cause?.message || "");

    return _matchesAnyText(CLOUDFLARE_5XX_REGEX, msg, causeMsg) ||
        _isTransientSocketBlip(code, causeCode, stack, msg, causeMsg) ||
        _matchesAnyText(WS_HANDSHAKE_TIMEOUT_REGEX, msg, causeMsg) ||
        _matchesAnyText(DISCORD_API_5XX_REGEX, msg, causeMsg);
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
        // Uncaught synchronous exceptions corrupt process memory; they must never be shielded
        originalError(sanitizeLogText(`[CRITICAL] uncaughtException: ${err.message}\n${err.stack || ""}`));
        await criticalAlerts.dispatch("uncaughtException", err, buildWebhookEventPayload({
            target: "ALERT",
            severity: "CRITICAL",
            category: "RUNTIME",
            code: "runtime.uncaught_exception",
            state: "OPEN",
            title: "UNCAUGHT EXCEPTION",
            description: `${safeError(err)}\n\n${sanitizeLogText(err.stack || "").substring(0, 800)}`,
            impact: "Process อยู่ในสถานะไม่สมบูรณ์และจำเป็นต้องเริ่มระบบใหม่เพื่อความปลอดภัย",
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

        // Only true transient gateway errors (Cloudflare 5xx, socket disconnect, handshake timeout)
        // are shielded because Discord.js will automatically resume via shardResume
        if (isTransientGatewayError(error)) {
            originalWarn(sanitizeLogText(`[GATEWAY/RUNTIME] ⚠️ Transient gateway rejection shielded from fatal exit (gateway will resume): ${msg}`));
            await criticalAlerts.dispatch("transientGatewayRejection", error, buildWebhookEventPayload({
                target: "ALERT",
                severity: "WARNING",
                category: "GATEWAY",
                code: "gateway.transient_rejection_shielded",
                state: "UPDATE",
                title: "TRANSIENT GATEWAY REJECTION SHIELDED",
                description: `${sanitizeLogText(msg).substring(0, 900)}\n\nระบบตรวจพบข้อผิดพลาดเครือข่ายชั่วคราวของ Discord/Gateway และทำการป้องกันไม่ให้ระบบหยุดทำงาน โดย Gateway จะทำการ Reconnect/Resume อัตโนมัติ`,
                impact: "การเชื่อมต่อ Gateway อาจกระตุกชั่วขณะ แต่ระบบหลักยังคงทำงานต่อเนื่อง",
                action: "ระบบจะเชื่อมต่อใหม่โดยอัตโนมัติ ไม่จำเป็นต้องเริ่มระบบใหม่"
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
