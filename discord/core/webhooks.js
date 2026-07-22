"use strict";

const { WebhookClient } = require("discord.js");
const crypto = require("node:crypto");
const { sanitizeLogText } = require("./safeLogger");
const { resolvePublicBaseUrl } = require("./publicUrl");

const WEBHOOK_TARGETS = Object.freeze({
    LOG: "WEBHOOK_LOG_URL",
    ALERT: "ALERT_WEBHOOK_URL"
});
const DISCORD_WEBHOOK_HOSTS = new Set([
    "discord.com",
    "discordapp.com",
    "canary.discord.com",
    "ptb.discord.com"
]);
const CONTENT_MAX = 2000;
const EMBED_TOTAL_MAX = 6000;
const EMBED_COUNT_MAX = 10;
const FIELD_COUNT_MAX = 25;
const DEFAULT_QUEUE_MAX = Math.max(10, Number(process.env.WEBHOOK_QUEUE_MAX || 500) || 500);
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.WEBHOOK_CONCURRENCY || 1) || 1));
const DEFAULT_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.WEBHOOK_MAX_ATTEMPTS || 3) || 3));
const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.WEBHOOK_SEND_TIMEOUT_MS || 15000) || 15000);
const ROUTINE_DEDUPE_MAX = Math.max(100, Number(process.env.WEBHOOK_ROUTINE_DEDUPE_MAX || 2000) || 2000);

function trimTrailingSlashes(value) {
    let clean = String(value || "").trim();
    while (clean.endsWith("/")) clean = clean.slice(0, -1);
    return clean;
}

function getWebhookUrl(target, env = process.env) {
    return trimTrailingSlashes(env[WEBHOOK_TARGETS[target] || target] || "") || null;
}

function validateWebhookUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return { configured: false, valid: false, code: "missing" };
    try {
        const parsed = new URL(raw);
        const validPath = /^\/api(?:\/v\d+)?\/webhooks\/\d{5,25}\/[A-Za-z0-9._-]{20,}$/.test(parsed.pathname);
        if (parsed.protocol !== "https:") return { configured: true, valid: false, code: "https_required" };
        if (!DISCORD_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) {
            return { configured: true, valid: false, code: "host_not_allowed" };
        }
        if (!validPath) return { configured: true, valid: false, code: "invalid_path" };
        if (parsed.username || parsed.password) return { configured: true, valid: false, code: "credentials_not_allowed" };
        return { configured: true, valid: true, code: "valid" };
    } catch {
        return { configured: true, valid: false, code: "invalid_url" };
    }
}

function normalizeWebhookUrlForCompare(url) {
    const validation = validateWebhookUrl(url);
    if (!validation.valid) return trimTrailingSlashes(url);
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return trimTrailingSlashes(parsed.toString()).toLowerCase();
}

function getOwnerDashboardBaseUrl(env = process.env) {
    const configured = resolvePublicBaseUrl(env, env.RENDER_EXTERNAL_URL || "");
    if (!configured) return null;

    try {
        const parsed = new URL(configured);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
        parsed.hash = "";
        parsed.search = "";
        return parsed.origin;
    } catch {
        return null;
    }
}

function getWebhookDiagnostics(env = process.env) {
    const logUrl = getWebhookUrl("LOG", env);
    const alertUrl = getWebhookUrl("ALERT", env);
    const log = validateWebhookUrl(logUrl);
    const alert = validateWebhookUrl(alertUrl);
    const sameTarget = log.valid && alert.valid &&
        normalizeWebhookUrlForCompare(logUrl) === normalizeWebhookUrlForCompare(alertUrl);
    return {
        hasLog: log.configured,
        hasAlert: alert.configured,
        logValid: log.valid,
        alertValid: alert.valid,
        logCode: log.code,
        alertCode: alert.code,
        sameTarget,
        logTarget: log.configured ? "WEBHOOK_LOG_URL" : null,
        alertTarget: alert.configured ? "ALERT_WEBHOOK_URL" : null
    };
}

function truncate(value, max) {
    const safeMax = Math.max(0, Number(max) || 0);
    if (safeMax === 0) return "";
    const clean = sanitizeLogText(String(value ?? ""));
    if (clean.length <= safeMax) return clean;
    const suffix = "… [TRUNCATED]";
    if (safeMax <= suffix.length) return clean.slice(0, safeMax);
    return `${clean.slice(0, safeMax - suffix.length)}${suffix}`;
}

function consumeText(value, limit, budget) {
    const max = Math.max(0, Math.min(limit, budget.remaining));
    const output = truncate(value, max);
    budget.remaining = Math.max(0, budget.remaining - output.length);
    return output;
}

function normalizeEmbed(embed, budget) {
    if (!embed || typeof embed !== "object" || budget.remaining <= 0) return null;
    const source = typeof embed.toJSON === "function" ? embed.toJSON() : { ...embed };
    const safe = { ...source };
    if (source.title != null) safe.title = consumeText(source.title, 256, budget);
    if (source.description != null) safe.description = consumeText(source.description, 4096, budget);
    if (source.author?.name != null) {
        safe.author = { ...source.author, name: consumeText(source.author.name, 256, budget) };
    }
    if (source.footer?.text != null) {
        safe.footer = { ...source.footer, text: consumeText(source.footer.text, 2048, budget) };
    }
    if (Array.isArray(source.fields)) {
        safe.fields = source.fields.slice(0, FIELD_COUNT_MAX).map(field => ({
            ...field,
            name: consumeText(field?.name || "-", 256, budget),
            value: consumeText(field?.value || "-", 1024, budget)
        })).filter(field => field.name && field.value);
    }
    return safe;
}

function normalizeWebhookPayload(payload) {
    let source;
    if (typeof payload === "string") {
        source = { content: payload };
    } else if (payload && typeof payload === "object") {
        source = { ...payload };
    } else {
        source = { content: String(payload || "") };
    }
    const normalized = { ...source };
    if (source.content !== undefined) normalized.content = truncate(source.content, CONTENT_MAX);
    const budget = { remaining: EMBED_TOTAL_MAX };
    if (Array.isArray(source.embeds)) {
        normalized.embeds = source.embeds
            .slice(0, EMBED_COUNT_MAX)
            .map(embed => normalizeEmbed(embed, budget))
            .filter(Boolean);
    }
    // Log content is partly user-controlled. Never let it generate Discord pings.
    normalized.allowedMentions = { parse: [] };
    return normalized;
}

function failureCode(error) {
    const status = Number(error?.status || error?.httpStatus || error?.response?.status || 0);
    if (status) return `http_${status}`;
    const code = String(error?.code || error?.name || "send_failed").toLowerCase();
    return truncate(code.replace(/[^a-z0-9_-]/g, "_"), 80) || "send_failed";
}

function retryable(error) {
    const status = Number(error?.status || error?.httpStatus || error?.response?.status || 0);
    const code = String(error?.code || "").toLowerCase();
    if (code === "send_timeout") return false;
    if (status === 429 || status >= 500) return true;
    return !status && !["invalid_webhook_url", "invalid_token"].includes(code);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error("webhook send timeout");
            error.code = "send_timeout";
            reject(error);
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createTargetMetrics() {
    return {
        queued: 0,
        sent: 0,
        failed: 0,
        dropped: 0,
        retried: 0,
        warningSuppressed: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureCode: null
    };
}

class WebhookDispatcher {
    constructor(options = {}) {
        this.ClientClass = options.WebhookClientClass || WebhookClient;
        this.env = options.env || process.env;
        this.maxDepth = Math.max(1, Number(options.maxDepth || DEFAULT_QUEUE_MAX));
        this.concurrency = Math.max(1, Number(options.concurrency || DEFAULT_CONCURRENCY));
        this.maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULT_ATTEMPTS));
        this.timeoutMs = Math.max(100, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
        this.delayFn = options.delayFn || delay;
        this.queue = [];
        this.active = 0;
        this.accepting = true;
        this.clients = new Map();
        this.metrics = { LOG: createTargetMetrics(), ALERT: createTargetMetrics() };
        this.lastFailureWarningAt = { LOG: 0, ALERT: 0 };
        this.idleWaiters = [];
    }

    warnFailure(target, code) {
        const metrics = this.metrics[target] || this.metrics.LOG;
        const now = Date.now();
        if (now - Number(this.lastFailureWarningAt[target] || 0) < 60 * 1000) {
            metrics.warningSuppressed++;
            return;
        }
        this.lastFailureWarningAt[target] = now;
        console.warn(`[WEBHOOK] ${target} delivery unavailable (${code}); inspect Owner diagnostics for counters.`);
    }

    insert(item) {
        if (item.target !== "ALERT") {
            this.queue.push(item);
            return;
        }
        const firstLog = this.queue.findIndex(queued => queued.target !== "ALERT");
        if (firstLog < 0) this.queue.push(item);
        else this.queue.splice(firstLog, 0, item);
    }

    makeRoomForAlert(metrics) {
        for (let index = this.queue.length - 1; index >= 0; index--) {
            const queued = this.queue[index];
            if (queued.target === "ALERT") continue;
            this.queue.splice(index, 1);
            const droppedMetrics = this.metrics[queued.target] || this.metrics.LOG;
            droppedMetrics.dropped++;
            droppedMetrics.lastFailureAt = Date.now();
            droppedMetrics.lastFailureCode = "preempted_by_alert";
            this.warnFailure(queued.target, droppedMetrics.lastFailureCode);
            queued.resolve(false);
            return true;
        }
        metrics.dropped++;
        metrics.lastFailureAt = Date.now();
        metrics.lastFailureCode = "queue_full";
        this.warnFailure("ALERT", metrics.lastFailureCode);
        return false;
    }

    enqueue(target, payload, options = {}) {
        const metrics = this.metrics[target] || this.metrics.LOG;
        const url = options.url || getWebhookUrl(target, options.env || this.env);
        const validation = validateWebhookUrl(url);
        if (!this.accepting || !validation.valid) {
            metrics.failed++;
            metrics.lastFailureAt = Date.now();
            metrics.lastFailureCode = this.accepting ? validation.code : "dispatcher_stopping";
            this.warnFailure(target, metrics.lastFailureCode);
            return Promise.resolve(false);
        }
        if (this.queue.length + this.active >= this.maxDepth) {
            if (target !== "ALERT" || !this.makeRoomForAlert(metrics)) return Promise.resolve(false);
        }
        metrics.queued++;
        return new Promise(resolve => {
            this.insert({ target, payload, options, url, resolve });
            this.drain();
        });
    }

    getClient(url) {
        const current = this.clients.get(url);
        if (current) return current;
        const client = new this.ClientClass({ url });
        this.clients.set(url, client);
        return client;
    }

    discardClient(url) {
        const client = this.clients.get(url);
        try { client?.destroy?.(); } catch {}
        this.clients.delete(url);
    }

    async deliver(item) {
        const metrics = this.metrics[item.target] || this.metrics.LOG;
        const normalized = normalizeWebhookPayload(item.payload);
        let lastError = null;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            try {
                const client = this.getClient(item.url);
                await withTimeout(client.send(normalized), this.timeoutMs);
                metrics.sent++;
                metrics.lastSuccessAt = Date.now();
                return true;
            } catch (error) {
                lastError = error;
                if (attempt >= this.maxAttempts || !retryable(error)) break;
                metrics.retried++;
                await this.delayFn(Math.min(500 * 2 ** (attempt - 1), 5000));
            }
        }
        metrics.failed++;
        metrics.lastFailureAt = Date.now();
        metrics.lastFailureCode = failureCode(lastError);
        this.warnFailure(item.target, metrics.lastFailureCode);
        return false;
    }

    drain() {
        while (this.active < this.concurrency && this.queue.length) {
            const item = this.queue.shift();
            this.active++;
            this.deliver(item)
                .then(item.resolve, () => item.resolve(false))
                .finally(() => {
                    this.active--;
                    this.resolveIdle();
                    this.drain();
                });
        }
    }

    resolveIdle() {
        if (this.active || this.queue.length) return;
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve(true);
    }

    async flush(timeoutMs = 5000) {
        if (!this.active && !this.queue.length) return true;
        return new Promise(resolve => {
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => finish(false), Math.max(100, Number(timeoutMs) || 5000));
            this.idleWaiters.push(() => finish(true));
        });
    }

    async shutdown(timeoutMs = 5000) {
        this.accepting = false;
        const flushed = await this.flush(timeoutMs);
        for (const url of this.clients.keys()) this.discardClient(url);
        return flushed;
    }

    stats() {
        return {
            accepting: this.accepting,
            queueDepth: this.queue.length,
            active: this.active,
            maxDepth: this.maxDepth,
            concurrency: this.concurrency,
            targets: structuredClone(this.metrics)
        };
    }
}

const defaultDispatcher = new WebhookDispatcher();
const routineDedupe = new Map();
const dispatcherIds = new WeakMap();
let nextDispatcherId = 1;

function dispatcherIdentity(dispatcher) {
    if (!dispatcher || (typeof dispatcher !== "object" && typeof dispatcher !== "function")) return "default";
    if (!dispatcherIds.has(dispatcher)) dispatcherIds.set(dispatcher, nextDispatcherId++);
    return `dispatcher:${dispatcherIds.get(dispatcher)}`;
}

function routineDestinationKey(options = {}) {
    const dispatcher = options.dispatcher || null;
    const env = options.env || dispatcher?.env || process.env;
    const url = normalizeWebhookUrlForCompare(options.url || getWebhookUrl("LOG", env) || "missing");
    return crypto.createHash("sha256")
        .update(`${dispatcherIdentity(dispatcher)}\u0000${url}`)
        .digest("hex")
        .slice(0, 20);
}

function trimRoutineDedupe() {
    while (routineDedupe.size > ROUTINE_DEDUPE_MAX) {
        const key = routineDedupe.keys().next().value;
        const entry = routineDedupe.get(key);
        if (entry?.timer) clearTimeout(entry.timer);
        routineDedupe.delete(key);
    }
}

async function sendRoutineDeduped(payload, options) {
    const baseKey = truncate(options.dedupeKey, 200) || "routine-event";
    const key = `${routineDestinationKey(options)}:${baseKey}`;
    const ttlMs = Math.max(1000, Number(options.dedupeMs || 5 * 60 * 1000));
    const existing = routineDedupe.get(key);
    if (existing) {
        const firstDelivered = await existing.pending;
        if (!firstDelivered) return sendRoutineDeduped(payload, options);
        existing.duplicates++;
        return true;
    }
    const entry = {
        duplicates: 0,
        timer: null,
        label: truncate(options.summaryLabel || "routine event", 120),
        options,
        pending: null
    };
    routineDedupe.set(key, entry);
    trimRoutineDedupe();
    entry.pending = sendWebhook("LOG", payload, options);
    const sent = await entry.pending;
    if (!sent) {
        routineDedupe.delete(key);
        return false;
    }
    entry.timer = setTimeout(() => {
        routineDedupe.delete(key);
        if (entry.duplicates > 0) {
            sendWebhook("LOG", {
                content: `📋 **[LOG SUMMARY]** ${entry.label}\nเกิดซ้ำเพิ่ม **${entry.duplicates}** ครั้งในช่วง ${Math.round(ttlMs / 1000)} วินาที`
            }, entry.options).catch(() => {});
        }
    }, ttlMs);
    entry.timer.unref?.();
    return true;
}

function sendWebhook(target, payload, options = {}) {
    if (options.dispatcher) return options.dispatcher.enqueue(target, payload, options);
    if (options.WebhookClientClass || options.env || options.url) {
        const isolated = new WebhookDispatcher({
            WebhookClientClass: options.WebhookClientClass,
            env: options.env,
            maxDepth: 1,
            concurrency: 1,
            maxAttempts: options.maxAttempts || 1,
            timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
            delayFn: options.delayFn
        });
        return isolated.enqueue(target, payload, options).finally(() => isolated.shutdown(100));
    }
    return defaultDispatcher.enqueue(target, payload, options);
}

function sendLogWebhook(payload, options = {}) {
    if (options.dedupeKey) return sendRoutineDeduped(payload, options);
    return sendWebhook("LOG", payload, options);
}

function sendAlertWebhook(payload, options = {}) {
    return sendWebhook("ALERT", payload, options);
}

async function flushWebhookQueue(timeoutMs = 5000) {
    for (const [key, entry] of routineDedupe.entries()) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.duplicates > 0) {
            sendWebhook("LOG", {
                content: `📋 **[LOG SUMMARY]** ${entry.label}\nเกิดซ้ำเพิ่ม **${entry.duplicates}** ครั้งก่อนระบบหยุด`
            }, entry.options).catch(() => {});
        }
        routineDedupe.delete(key);
    }
    return defaultDispatcher.flush(timeoutMs);
}

function shutdownWebhookDispatcher(timeoutMs = 5000) {
    return defaultDispatcher.shutdown(timeoutMs);
}

function getWebhookDeliveryDiagnostics() {
    return {
        ...defaultDispatcher.stats(),
        configuration: getWebhookDiagnostics(process.env),
        routineDedupeKeys: routineDedupe.size
    };
}

function buildStartupNotice({ clientTag, baseUrl, includeShadowPortal = true, timestamp = Date.now() }) {
    const safeBase = getOwnerDashboardBaseUrl({ PUBLIC_BASE_URL: baseUrl });
    const lines = [
        `✅ **Bot พร้อมแล้ว!** \`${clientTag || "unknown"}\``,
        ""
    ];
    if (safeBase) {
        lines.push(`🌐 **Dashboard:** ${safeBase}`);
        if (includeShadowPortal) lines.push(`👁️‍🗨️ **Shadow Portal:** ${safeBase}/shadow`);
    } else {
        lines.push("🌐 **Dashboard:** ยังไม่ได้ตั้งค่า public URL ที่ถูกต้อง");
    }
    lines.push("", `⏰ <t:${Math.floor(timestamp / 1000)}:F>`);
    return { content: lines.join("\n") };
}

module.exports = {
    WEBHOOK_TARGETS,
    DISCORD_WEBHOOK_HOSTS,
    WebhookDispatcher,
    getWebhookUrl,
    validateWebhookUrl,
    getOwnerDashboardBaseUrl,
    getWebhookDiagnostics,
    getWebhookDeliveryDiagnostics,
    normalizeWebhookPayload,
    sendWebhook,
    sendLogWebhook,
    sendAlertWebhook,
    flushWebhookQueue,
    shutdownWebhookDispatcher,
    buildStartupNotice,
    _test: { failureCode, retryable, withTimeout, routineDedupe }
};
