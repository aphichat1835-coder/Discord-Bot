const auditLogStore = require("./auditLogStore");
const { safeAuditError } = require("./logCore");
const auditSettings = require("./auditSettings");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = Math.max(1, Number(process.env.AUDIT_RETENTION_DAYS || 90) || 90);

function normalizeRetentionDays(value, fallback = DEFAULT_RETENTION_DAYS) {
    if (value === "forever" || value === 0 || value === "0") return 0;
    const days = Number(value);
    if (!Number.isFinite(days) || days < 0) return fallback;
    if (days === 0) return 0;
    return Math.max(1, Math.ceil(days));
}

function cutoffForRetention(days, now = Date.now()) {
    const safeDays = normalizeRetentionDays(days);
    if (safeDays === 0) return null;
    return now - safeDays * DAY_MS;
}

async function cleanupGuildAuditLogs(guildId, retentionDays = DEFAULT_RETENTION_DAYS) {
    const cutoff = cutoffForRetention(retentionDays);
    if (!cutoff) return { ok: true, skipped: true, reason: "forever" };
    try {
        const result = await auditLogStore.deleteOlderThan(guildId, cutoff);
        return {
            ok: true,
            guildId,
            retentionDays: normalizeRetentionDays(retentionDays),
            cutoff,
            deletedCount: result.deletedCount || 0
        };
    } catch (err) {
        return { ok: false, guildId, reason: safeAuditError(err, 240) };
    }
}

async function cleanupClientAuditLogs(client, sessionManager, options = {}) {
    const guilds = Array.from(client?.guilds?.cache?.values?.() || []);
    const results = [];
    for (const guild of guilds) {
        const setting = await auditSettings.getAuditSettings(sessionManager, guild.id)
            .then(saved => saved.retentionDays)
            .catch(() => options.retentionDays ?? DEFAULT_RETENTION_DAYS);
        results.push(await cleanupGuildAuditLogs(guild.id, setting));
    }
    return results;
}

module.exports = {
    DAY_MS,
    DEFAULT_RETENTION_DAYS,
    normalizeRetentionDays,
    cutoffForRetention,
    cleanupGuildAuditLogs,
    cleanupClientAuditLogs
};
