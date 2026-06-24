const auditStorage = require("../logging/auditStorage");
const auditExport = require("../logging/auditExport");
const auditHealth = require("../logging/auditHealth");
const auditSettings = require("../logging/auditSettings");
const auditDeadLetter = require("../logging/auditDeadLetter");
const auditReconcilerScheduler = require("../logging/auditReconcilerScheduler");

const FILTER_KEYS = Object.freeze(["category", "severity", "actionType", "actorId", "targetId", "channelId", "roleId"]);

function readAuditFilters(query = {}) {
    const filters = {};
    for (const key of FILTER_KEYS) {
        if (query[key]) filters[key] = String(query[key]);
    }
    if (query.from) filters.from = Number(query.from);
    if (query.to) filters.to = Number(query.to);
    return filters;
}

function filterRecords(records, query = {}) {
    const filters = readAuditFilters(query);
    return records.filter(record => {
        for (const key of FILTER_KEYS) {
            if (filters[key] && String(record[key] || "") !== filters[key]) return false;
        }
        if (filters.from && Number(record.createdAt || 0) < filters.from) return false;
        if (filters.to && Number(record.createdAt || 0) > filters.to) return false;
        return true;
    });
}

function readGuildId(query = {}, client = {}) {
    return String(query.guildId || client?.guilds?.cache?.first?.()?.id || "");
}

function readLimit(query = {}, fallback = 50, max = 500) {
    return Math.max(1, Math.min(max, Number(query.limit || fallback) || fallback));
}

async function loadFilteredRecords(sessionManager, guildId, query = {}, limit = 50) {
    const filters = readAuditFilters(query);
    const records = await auditStorage.listAuditRecords(sessionManager, guildId, limit, filters);
    return filterRecords(records, filters);
}

async function loadDeadLetterRecords(sessionManager, guildId, query = {}) {
    return auditDeadLetter.listDeadLetters(sessionManager, guildId, readLimit(query, 25, 100));
}

async function anyGuildReconcilerEnabled(client, sessionManager) {
    for (const guild of Array.from(client?.guilds?.cache?.values?.() || [])) {
        const settings = await auditSettings.getAuditSettings(sessionManager, guild.id).catch(() => null);
        if (settings?.reconcilerEnabled === true) return true;
    }
    return false;
}

async function applyAuditRuntimeSettings({ client, sessionManager, settings }) {
    if (settings.reconcilerEnabled) {
        return auditReconcilerScheduler.start(client, sessionManager, {
            enabled: true,
            intervalMs: settings.reconcilerIntervalMs,
            limit: settings.reconcilerLimit
        });
    }

    if (!await anyGuildReconcilerEnabled(client, sessionManager)) {
        return { stopped: auditReconcilerScheduler.stop(), reason: "no_guild_reconciler_enabled" };
    }

    return { stopped: false, reason: "other_guilds_still_enabled" };
}

function registerAuditApiRoutes({ app, express, sessionManager, client, auditLogger, checkAuth }) {
    app.get("/api/audit/logs", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const guildId = readGuildId(req.query, client);
            if (!guildId) return res.status(400).json({ success: false, error: "guildId required" });
            const limit = readLimit(req.query, 50, 500);
            const records = await loadFilteredRecords(sessionManager, guildId, req.query, limit);
            res.json({ success: true, guildId, count: records.length, records });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get("/api/audit/export", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const guildId = readGuildId(req.query, client);
            if (!guildId) return res.status(400).json({ success: false, error: "guildId required" });
            const format = String(req.query.format || "json").toLowerCase();
            const records = await loadFilteredRecords(sessionManager, guildId, req.query, readLimit(req.query, 200, 500));

            if (format === "csv") {
                res.setHeader("Content-Type", "text/csv; charset=utf-8");
                return res.send(auditExport.recordsToCsv(records));
            }
            if (format === "md" || format === "markdown") {
                res.setHeader("Content-Type", "text/markdown; charset=utf-8");
                return res.send(auditExport.recordsToMarkdown(records));
            }
            if (format === "json") {
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                return res.send(auditExport.recordsToJson(records));
            }
            res.status(400).json({ success: false, error: "unsupported export format" });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get("/api/audit/health", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const guildId = readGuildId(req.query, client);
            const guild = guildId ? client?.guilds?.cache?.get(guildId) : null;
            const health = await auditHealth.buildAuditHealth({ guild, sessionManager, auditLogger });
            res.json({ success: true, health });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get("/api/audit/dead-letters", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const guildId = readGuildId(req.query, client);
            if (!guildId) return res.status(400).json({ success: false, error: "guildId required" });
            const records = await loadDeadLetterRecords(sessionManager, guildId, req.query);
            res.json({ success: true, guildId, count: records.length, records });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get("/api/audit/settings", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const guildId = readGuildId(req.query, client);
            if (!guildId) return res.status(400).json({ success: false, error: "guildId required" });
            const settings = await auditSettings.getAuditSettings(sessionManager, guildId);
            res.json({ success: true, guildId, settings });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post("/api/audit/settings", express.json({ limit: "16kb" }), async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const guildId = readGuildId(req.body || req.query, client);
            if (!guildId) return res.status(400).json({ success: false, error: "guildId required" });
            const settings = await auditSettings.saveAuditSettings(sessionManager, guildId, req.body || {});
            const runtime = await applyAuditRuntimeSettings({ client, sessionManager, settings });
            res.json({ success: true, guildId, settings, runtime });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

module.exports = {
    FILTER_KEYS,
    readAuditFilters,
    filterRecords,
    readGuildId,
    readLimit,
    loadFilteredRecords,
    loadDeadLetterRecords,
    anyGuildReconcilerEnabled,
    applyAuditRuntimeSettings,
    registerAuditApiRoutes
};
