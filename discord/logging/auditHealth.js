const storage = require("./auditStorage");
const deadLetter = require("./auditDeadLetter");
const channelRepair = require("./auditChannelRepair");
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
    const deadLetters = guild?.id ? await deadLetter.listDeadLetters(sessionManager, guild.id, 10).catch(() => []) : [];
    const repair = channelRepair.buildAuditChannelRepairPlan(guild);
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
        delivery: {
            deadLetters: deadLetters.length,
            latestDeadLetterId: deadLetters[0]?.id || null
        },
        channels: {
            ok: repair.ok,
            missing: repair.missing.map(item => item.category)
        },
        checkedAt: Date.now()
    };
}

module.exports = {
    permissionHealth,
    buildAuditHealth
};
