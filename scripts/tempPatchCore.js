#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function read(file) {
    return fs.readFileSync(path.join(root, file), "utf8");
}

function write(file, content) {
    fs.writeFileSync(path.join(root, file), content);
}

function replaceOnce(file, search, replacement) {
    const source = read(file);
    const first = source.indexOf(search);
    if (first < 0) throw new Error(`PATCH_SOURCE_NOT_FOUND:${file}`);
    if (source.indexOf(search, first + search.length) >= 0) throw new Error(`PATCH_SOURCE_NOT_UNIQUE:${file}`);
    write(file, source.slice(0, first) + replacement + source.slice(first + search.length));
}

function replaceRegexOnce(file, regex, replacement) {
    const source = read(file);
    const matches = [...source.matchAll(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`))];
    if (matches.length !== 1) throw new Error(`PATCH_REGEX_COUNT:${file}:${matches.length}`);
    write(file, source.replace(regex, replacement));
}

replaceOnce(
    "discord/sessionManager.js",
`function numberEnv(name, fallback, min = 1) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, value);
}`,
`function numberEnv(name, fallback, min = 1) {
    return readFiniteInteger(process.env[name], {
        fallback,
        min,
        max: Number.MAX_SAFE_INTEGER
    });
}`
);

replaceOnce(
    "discord/core/runtimeLifecycle.js",
`    let shutdownPromise = null;

    function shutdown(signal, requestedExitCode = 0) {
        if (shutdownPromise) return shutdownPromise;`,
`    let shutdownPromise = null;
    let highestRequestedExitCode = 0;

    function shutdown(signal, requestedExitCode = 0) {
        const normalizedExitCode = Number(requestedExitCode) === 0 ? 0 : 1;
        highestRequestedExitCode = Math.max(highestRequestedExitCode, normalizedExitCode);
        if (shutdownPromise) return shutdownPromise;`
);
replaceOnce(
    "discord/core/runtimeLifecycle.js",
`            const finalExitCode = state.failures.length > 0 ? 1 : requestedExitCode;
            processRef.exit(finalExitCode);
            return {
                signal,
                requestedExitCode,`,
`            const finalExitCode = state.failures.length > 0 ? 1 : highestRequestedExitCode;
            processRef.exit(finalExitCode);
            return {
                signal,
                requestedExitCode: highestRequestedExitCode,`
);

replaceOnce(
    "discord/dm/service.js",
`let priorityBackfillComplete = false;
let databaseReadyOverride = null;`,
`let priorityBackfillComplete = false;
let databaseReadyOverride = null;
let workerPromise = null;
let accepting = true;`
);
replaceOnce(
    "discord/dm/service.js",
`async function send(input = {}) {
    diagnostics.candidates++;`,
`async function send(input = {}) {
    diagnostics.candidates++;
    if (!accepting) return { status: "failed", reason: "dm_service_stopping" };`
);
replaceRegexOnce(
    "discord/dm/service.js",
/async function processPending\(limit = 25\) \{[\s\S]*?\n\}\n\nfunction start\(\) \{/,
`function processPending(limit = 25) {
    if (!accepting || !databaseReady() || !client?.isReady?.()) return Promise.resolve({ processed: 0 });
    if (workerPromise) return workerPromise;

    workerBusy = true;
    const activePromise = (async () => {
        await backfillPriorityRanks();
        await persistVolatileOutbox();
        const pendingLimit = readFiniteInteger(limit, { fallback: 25, min: 1, max: 100 });
        const pending = await DmNotification.find({
            status: { $in: ["pending", "retrying", "sending"] },
            nextAttemptAt: { $lte: Date.now() }
        })
            .sort({ priorityRank: 1, createdAt: 1 })
            .limit(pendingLimit)
            .lean();
        for (const record of pending) await attempt(record);
        diagnostics.processed += pending.length;
        return { processed: pending.length };
    })();

    workerPromise = activePromise.finally(() => {
        workerBusy = false;
        if (workerPromise === activePromise || workerPromise === trackedPromise) workerPromise = null;
    });
    const trackedPromise = workerPromise;
    return trackedPromise;
}

function start() {`
);
replaceOnce(
    "discord/dm/service.js",
`function start() {
    if (workerTimer) return false;
    workerTimer = setInterval(() => processPending().catch(() => {}), 15_000);
    workerTimer.unref?.();
    processPending().catch(() => {});
    return true;
}

function stop() {
    if (!workerTimer) return false;
    clearInterval(workerTimer);
    workerTimer = null;
    return true;
}`,
`function start() {
    if (workerTimer) return false;
    accepting = true;
    workerTimer = setInterval(() => processPending().catch(() => {}), 15_000);
    workerTimer.unref?.();
    processPending().catch(() => {});
    return true;
}

async function stop(options = {}) {
    accepting = false;
    if (workerTimer) {
        clearInterval(workerTimer);
        workerTimer = null;
    }

    const timeoutMs = readFiniteInteger(options.timeoutMs, { fallback: 5000, min: 100, max: 30000 });
    if (workerPromise) {
        await Promise.race([
            workerPromise.catch(() => null),
            new Promise(resolve => {
                const timer = setTimeout(resolve, timeoutMs);
                timer.unref?.();
            })
        ]);
    }
    if (databaseReady()) await persistVolatileOutbox(500).catch(() => ({ persisted: 0 }));
    return !workerPromise;
}`
);
replaceOnce(
    "discord/dm/service.js",
`    databaseReadyOverride = null;
    workerBusy = false;`,
`    databaseReadyOverride = null;
    workerBusy = false;
    workerPromise = null;
    accepting = true;`
);
replaceOnce(
    "discord/dm/service.js",
`        workerRunning: Boolean(workerTimer),
        workerBusy,`,
`        workerRunning: Boolean(workerTimer),
        workerBusy,
        accepting,`
);

replaceOnce(
    "discord/core/http.js",
`    const originalGet = app.get.bind(app);
    originalGet("/health", (_req, res) => {
        const payload = buildHealthPayload();
        return res.status(payload.healthy ? 200 : 503).json(payload);
    });

    // Health belongs to the core HTTP contract. Ignore later duplicate route
    // registration while preserving Express setting reads and every other GET.
    app.get = (path, ...handlers) => {
        if (path === "/health" && handlers.length > 0) return app;
        return originalGet(path, ...handlers);
    };
    app[HEALTH_ROUTE_GUARD] = true;`,
`    app.get("/health", (_req, res) => {
        const payload = buildHealthPayload();
        return res.status(payload.healthy ? 200 : 503).json(payload);
    });
    app[HEALTH_ROUTE_GUARD] = true;`
);
replaceOnce(
    "discord/index/server.js",
`    app.get("/health", sendReadiness);
    app.get("/ready", sendReadiness);`,
`    app.get("/ready", sendReadiness);`
);

replaceOnce(
    "discord/features/protection.js",
`const { PermissionFlagsBits } = require("discord.js");
const sessionManager    = require('../sessionManager');`,
`const { PermissionFlagsBits } = require("discord.js");
const sessionManager = require('../sessionManager');
const { readFiniteInteger } = require('../core/numbers');`
);
replaceOnce(
    "discord/features/protection.js",
`// ── โหลด config จาก DB ──`,
`const PROTECTION_ACTIONS = new Set(['timeout', 'kick', 'ban']);

function normalizeDomain(value) {
    const domain = String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
    return domain;
}

function normalizeProtectionConfig(value = {}) {
    const merged = deepMerge(DEFAULT_CONFIG, value);
    merged.antiRaid.spamThreshold = readFiniteInteger(merged.antiRaid.spamThreshold, { fallback: 5, min: 2, max: 100 });
    merged.antiRaid.spamWindowMs = readFiniteInteger(merged.antiRaid.spamWindowMs, { fallback: 60000, min: 1000, max: 3600000 });
    merged.antiRaid.timeoutMinutes = readFiniteInteger(merged.antiRaid.timeoutMinutes, { fallback: 10, min: 1, max: 40320 });
    merged.antiRaid.newAccountDays = readFiniteInteger(merged.antiRaid.newAccountDays, { fallback: 7, min: 0, max: 3650 });
    merged.antiSpam.maxMessages = readFiniteInteger(merged.antiSpam.maxMessages, { fallback: 5, min: 2, max: 100 });
    merged.antiSpam.windowMs = readFiniteInteger(merged.antiSpam.windowMs, { fallback: 5000, min: 1000, max: 3600000 });
    merged.antiSpam.action = PROTECTION_ACTIONS.has(String(merged.antiSpam.action)) ? String(merged.antiSpam.action) : 'timeout';
    merged.linkFilter.allowedDomains = [...new Set((Array.isArray(merged.linkFilter.allowedDomains) ? merged.linkFilter.allowedDomains : [])
        .map(normalizeDomain)
        .filter(Boolean))];
    return merged;
}

// ── โหลด config จาก DB ──`
);
replaceOnce(
    "discord/features/protection.js",
`    return saved ? deepMerge(DEFAULT_CONFIG, saved) : deepMerge(DEFAULT_CONFIG, {});`,
`    return normalizeProtectionConfig(saved || {});`
);
replaceOnce(
    "discord/features/protection.js",
`async function setProtectionConfig(guildId, patch) {
    const current = await getProtectionConfig(guildId);
    const updated = deepMerge(current, patch);
    await sessionManager.setSetting(\`protection_\${guildId}\`, updated);
    return updated;
}`,
`async function setProtectionConfig(guildId, patch) {
    const current = await getProtectionConfig(guildId);
    const updated = normalizeProtectionConfig(deepMerge(current, patch));
    const persisted = await sessionManager.setSetting(\`protection_\${guildId}\`, updated);
    if (persisted !== true) {
        const error = new Error('Protection settings persistence failed');
        error.code = 'PROTECTION_PERSISTENCE_FAILED';
        throw error;
    }
    return updated;
}`
);
replaceOnce(
    "discord/features/protection.js",
`    buildProtectionResult,
    DEFAULT_CONFIG`,
`    buildProtectionResult,
    normalizeProtectionConfig,
    DEFAULT_CONFIG`
);

console.log("[TEMP-PATCH] core remediation applied");
