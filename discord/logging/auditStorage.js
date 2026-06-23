const { safeAuditText, safeAuditError } = require("./logCore");

function storageKey(guildId, eventId) {
    return `audit_event_${guildId}_${eventId}`;
}

function indexKey(guildId) {
    return `audit_event_index_${guildId}`;
}

function normalizeAuditRecord(input = {}) {
    const createdAt = Number(input.createdAt || Date.now());
    const eventId = safeAuditText(input.eventId || input.id || `${createdAt}_${Math.random().toString(36).slice(2, 8)}`, 120);
    return {
        eventId,
        guildId: String(input.guildId || "unknown"),
        source: safeAuditText(input.source || "audit", 40),
        category: safeAuditText(input.category || "server", 40),
        severity: safeAuditText(input.severity || "info", 40),
        actionType: safeAuditText(input.actionType || input.type || "UNKNOWN", 120),
        actorId: input.actorId ? String(input.actorId) : null,
        targetId: input.targetId ? String(input.targetId) : null,
        channelId: input.channelId ? String(input.channelId) : null,
        messageId: input.messageId ? String(input.messageId) : null,
        roleId: input.roleId ? String(input.roleId) : null,
        reason: input.reason ? safeAuditText(input.reason, 500) : null,
        summary: input.summary ? safeAuditText(input.summary, 1000) : null,
        evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 25).map(item => safeAuditText(item, 300)) : [],
        metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
        createdAt,
        storedAt: Date.now()
    };
}

async function saveAuditRecord(sessionManager, recordInput) {
    if (!sessionManager?.setSetting || !sessionManager?.getSetting) return null;
    const record = normalizeAuditRecord(recordInput);
    try {
        await sessionManager.setSetting(storageKey(record.guildId, record.eventId), record);
        const current = await sessionManager.getSetting(indexKey(record.guildId), []);
        const list = Array.isArray(current) ? current : [];
        const next = [record.eventId, ...list.filter(id => id !== record.eventId)].slice(0, 500);
        await sessionManager.setSetting(indexKey(record.guildId), next);
        return record;
    } catch (err) {
        console.warn(`[AUDIT_STORAGE] save failed: ${safeAuditError(err, 240)}`);
        return null;
    }
}

async function getAuditRecord(sessionManager, guildId, eventId) {
    if (!sessionManager?.getSetting || !guildId || !eventId) return null;
    return sessionManager.getSetting(storageKey(guildId, eventId), null);
}

async function listAuditRecords(sessionManager, guildId, limit = 50) {
    if (!sessionManager?.getSetting || !guildId) return [];
    const ids = await sessionManager.getSetting(indexKey(guildId), []);
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))) {
        const record = await getAuditRecord(sessionManager, guildId, id);
        if (record) out.push(record);
    }
    return out;
}

module.exports = {
    storageKey,
    indexKey,
    normalizeAuditRecord,
    saveAuditRecord,
    getAuditRecord,
    listAuditRecords
};
