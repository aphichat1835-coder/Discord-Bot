const { runAuditReconcile } = require("./auditReconciler");
const { safeAuditError } = require("./logCore");
const auditSettings = require("./auditSettings");

const DEFAULT_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.AUDIT_RECONCILER_INTERVAL_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
const DEFAULT_LIMIT = Math.max(1, Math.min(50, Number(process.env.AUDIT_RECONCILER_LIMIT || 10) || 10));
let timer = null;
let lastRun = null;
let running = false;
let lastResults = [];

function isEnabled() {
    return String(process.env.AUDIT_RECONCILER_ENABLED || "false").toLowerCase() === "true";
}

function guildList(client) {
    return Array.from(client?.guilds?.cache?.values?.() || []);
}

async function guildSchedulerSettings(sessionManager, guildId) {
    return auditSettings.getAuditSettings(sessionManager, guildId).catch(() => auditSettings.DEFAULT_AUDIT_SETTINGS);
}

async function guildReconcilerEnabled(sessionManager, guildId, options = {}) {
    if (options.forceAll === true || isEnabled()) return true;
    const settings = await guildSchedulerSettings(sessionManager, guildId);
    return settings.reconcilerEnabled === true;
}

async function runOnce(client, sessionManager, options = {}) {
    if (running) return { ok: false, reason: "already_running", results: lastResults };
    running = true;
    const results = [];

    try {
        for (const guild of guildList(client)) {
            const settings = await guildSchedulerSettings(sessionManager, guild.id);
            if (!await guildReconcilerEnabled(sessionManager, guild.id, options)) {
                results.push({ guildId: guild.id, ok: true, skipped: true, reason: "reconciler_disabled" });
                continue;
            }
            const limit = options.limit || settings.reconcilerLimit || DEFAULT_LIMIT;
            const result = await runAuditReconcile(guild, sessionManager, { limit });
            results.push({ guildId: guild.id, ...result });
        }
        lastRun = Date.now();
        lastResults = results.slice(-25);
        return { ok: true, results: lastResults };
    } catch (err) {
        const result = { ok: false, reason: safeAuditError(err, 240) };
        lastResults = [result];
        return result;
    } finally {
        running = false;
    }
}

function start(client, sessionManager, options = {}) {
    if (timer) return { started: false, reason: "already_started" };
    const enabled = options.enabled === true || isEnabled();
    if (!enabled) return { started: false, reason: "disabled" };

    const intervalMs = Math.max(60 * 1000, Number(options.intervalMs || DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
    timer = setInterval(() => {
        runOnce(client, sessionManager, options).catch(err => {
            console.warn(`[AUDIT_RECONCILER_SCHEDULER] run failed: ${safeAuditError(err, 240)}`);
        });
    }, intervalMs);
    timer.unref?.();

    runOnce(client, sessionManager, options).catch(() => {});
    return { started: true, intervalMs };
}

function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
}

function stats() {
    return {
        enabled: isEnabled() || !!timer,
        envEnabled: isEnabled(),
        running,
        active: !!timer,
        lastRun,
        lastResults
    };
}

module.exports = {
    isEnabled,
    guildReconcilerEnabled,
    runOnce,
    start,
    stop,
    stats,
    _test: {
        guildList
    }
};
