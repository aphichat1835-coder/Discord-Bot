const auditStorage = require("../logging/auditStorage");
const auditExport = require("../logging/auditExport");
const auditHealth = require("../logging/auditHealth");

function filterRecords(records, query = {}) {
    return records.filter(record => {
        if (query.category && record.category !== query.category) return false;
        if (query.severity && record.severity !== query.severity) return false;
        if (query.actionType && record.actionType !== query.actionType) return false;
        if (query.actorId && record.actorId !== query.actorId) return false;
        if (query.targetId && record.targetId !== query.targetId) return false;
        if (query.channelId && record.channelId !== query.channelId) return false;
        return true;
    });
}

function registerAuditApiRoutes({ app, express, sessionManager, client, auditLogger, checkAuth }) {
    app.get("/api/audit/logs", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const guildId = String(req.query.guildId || client?.guilds?.cache?.first?.()?.id || "");
            if (!guildId) return res.status(400).json({ success: false, error: "guildId required" });
            const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));
            const records = await auditStorage.listAuditRecords(sessionManager, guildId, limit);
            res.json({ success: true, guildId, records: filterRecords(records, req.query) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get("/api/audit/export", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const guildId = String(req.query.guildId || client?.guilds?.cache?.first?.()?.id || "");
            if (!guildId) return res.status(400).json({ success: false, error: "guildId required" });
            const format = String(req.query.format || "json").toLowerCase();
            const records = await auditStorage.listAuditRecords(sessionManager, guildId, 200);
            const filtered = filterRecords(records, req.query);

            if (format === "csv") {
                res.setHeader("Content-Type", "text/csv; charset=utf-8");
                return res.send(auditExport.recordsToCsv(filtered));
            }
            if (format === "md" || format === "markdown") {
                res.setHeader("Content-Type", "text/markdown; charset=utf-8");
                return res.send(auditExport.recordsToMarkdown(filtered));
            }
            res.json({ success: true, guildId, records: filtered });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get("/api/audit/health", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const guildId = String(req.query.guildId || client?.guilds?.cache?.first?.()?.id || "");
            const guild = guildId ? client?.guilds?.cache?.get(guildId) : null;
            const health = await auditHealth.buildAuditHealth({ guild, sessionManager, auditLogger });
            res.json({ success: true, health });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

module.exports = {
    filterRecords,
    registerAuditApiRoutes
};
