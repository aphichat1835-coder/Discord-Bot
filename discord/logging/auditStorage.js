const { safeAuditText, safeAuditError } = require("./logCore");
let auditLogStore = null;
try { auditLogStore = require("./auditLogStore"); } catch (_) {}

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

async function saveFallback(sessionManager, record) {
    if (!sessionManager?.setSetting || !sessionManager?.getSetting) return null;
    await sessionManager.setSetting(storageKey(record.guildId, record.eventId), record);
    const current = await sessionManager.getSetting(indexKey(record.guildId), []);
    const list = Array.isArray(current) ? current : [];
    const next = [record.eventId, ...list.filter(id => id !== record.eventId)].slice(0, 500);
    await sessionManager.setSetting(indexKey(record.guildId), next);
    return record;
}

async function saveAuditRecord(sessionManager, recordInput) {
    const record = normalizeAuditRecord(recordInput);
    try {
        if (auditLogStore?.saveRecord) await auditLogStore.saveRecord(record);
        await saveFallback(sessionManager, record).catch(() => null);
        return record;
    } catch (err) {
        console.warn(`[AUDIT_STORAGE] save failed: ${safeAuditError(err, 240)}`);
        return saveFallback(sessionManager, record).catch(() => null);
    }
}

async function getAuditRecord(sessionManager, guildId, eventId) {
    if (!guildId || !eventId) return null;
    try {
        const fromStore = auditLogStore?.getRecord ? await auditLogStore.getRecord(guildId, eventId) : null;
        if (fromStore) return fromStore;
    } catch (err) {
        console.warn(`[AUDIT_STORAGE] store get failed: ${safeAuditError(err, 240)}`);
    }
    if (!sessionManager?.getSetting) return null;
    return sessionManager.getSetting(storageKey(guildId, eventId), null);
}

async function listFallback(sessionManager, guildId, limit = 50) {
    if (!sessionManager?.getSetting || !guildId) return [];
    const ids = await sessionManager.getSetting(indexKey(guildId), []);
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))) {
        const record = await sessionManager.getSetting(storageKey(guildId, id), null);
        if (record) out.push(record);
    }
    return out;
}

async function listAuditRecords(sessionManager, guildId, limit = 50, filters = {}) {
    if (!guildId) return [];
    try {
        const fromStore = auditLogStore?.listRecords ? await auditLogStore.listRecords(guildId, limit, filters) : [];
        if (fromStore.length) return fromStore;
    } catch (err) {
        console.warn(`[AUDIT_STORAGE] store list failed: ${safeAuditError(err, 240)}`);
    }
    return listFallback(sessionManager, guildId, limit);
}

module.exports = {
    storageKey,
    indexKey,
    normalizeAuditRecord,
    saveAuditRecord,
    getAuditRecord,
    listAuditRecords,
    _test: {
        saveFallback,
        listFallback
    }
};
