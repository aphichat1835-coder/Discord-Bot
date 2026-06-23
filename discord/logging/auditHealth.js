const storage = require("./auditStorage");
let scheduler = null;
try { scheduler = require("./auditReconcilerScheduler"); } catch (_) {}

function permissionHealth(guild) {
    const me = guild?.members?.me || guild?.me || guild?.members?.cache?.get(guild?.client?.user?.id);
    const hasViewAuditLog = me?.permissions?.has?.("VIEW_AUDIT_LOG") === true;
    return { hasViewAuditLog };
}

async function buildAuditHealth({ guild, sessionManager, auditLogger } = {}) {
    const permission = permissionHealth(guild);
    const records = guild?.id ? await storage.listAuditRecords(sessionManager, guild.id, 5).catch(() => []) : [];
    return {
        ok: true,
        guildId: guild?.id || null,
        auditLogger: auditLogger?.getAuditStats?.() || null,
        permission,
        reconciler: scheduler?.stats?.() || null,
        storage: {
            recentRecords: records.length,
            latestEventId: records[0]?.eventId || null
        },
        checkedAt: Date.now()
    };
}

module.exports = {
    permissionHealth,
    buildAuditHealth
};
