const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { safeAuditText, safeAuditError } = require("./logCore");

function loadAuditLogStore() {
    const storePath = path.join(__dirname, "auditLogStore.js");
    return fs.existsSync(storePath) ? require("./auditLogStore") : null;
}

const auditLogStore = loadAuditLogStore();

function storageKey(guildId, eventId) {
    return `audit_event_${guildId}_${eventId}`;
}

function indexKey(guildId) {
    return `audit_event_index_${guildId}`;
}

function makeEventId(createdAt = Date.now()) {
    return `${createdAt}_${crypto.randomUUID().slice(0, 8)}`;
}

function textOrNull(value, max) {
    return value ? safeAuditText(value, max) : null;
}

function idOrNull(value) {
    return value ? String(value) : null;
}

function normalizeEvidence(value) {
    return Array.isArray(value) ? value.slice(0, 25).map(item => safeAuditText(item, 300)) : [];
}

function normalizeMetadata(value) {
    return value && typeof value === "object" ? value : {};
}

function normalizeAuditRecord(input = {}) {
    const createdAt = Number(input.createdAt || Date.now());
    const eventId = safeAuditText(input.eventId || input.id || makeEventId(createdAt), 120);
    return {
        eventId,
        guildId: String(input.guildId || "unknown"),
        source: safeAuditText(input.source || "audit", 40),
        category: safeAuditText(input.category || "server", 40),
        severity: safeAuditText(input.severity || "info", 40),
        actionType: safeAuditText(input.actionType || input.type || "UNKNOWN", 120),
        actorId: idOrNull(input.actorId),
        targetId: idOrNull(input.targetId),
        channelId: idOrNull(input.channelId),
        messageId: idOrNull(input.messageId),
        roleId: idOrNull(input.roleId),
        reason: textOrNull(input.reason, 500),
        summary: textOrNull(input.summary, 1000),
        evidence: normalizeEvidence(input.evidence),
        metadata: normalizeMetadata(input.metadata),
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
    makeEventId,
    normalizeAuditRecord,
    saveAuditRecord,
    getAuditRecord,
    listAuditRecords,
    _test: {
        saveFallback,
        listFallback,
        textOrNull,
        idOrNull,
        normalizeEvidence,
        normalizeMetadata
    }
};
