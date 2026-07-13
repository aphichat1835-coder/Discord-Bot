const crypto = require("node:crypto");
const { sanitizeLogText } = require("../core/safeLogger");

const fallbackLocks = new Map();
const MAX_INDEX_RECORDS = 500;

function safeText(value, max = 500) {
    return sanitizeLogText(String(value ?? "")).slice(0, Math.max(1, Number(max) || 500));
}

function storageKey(guildId, eventId) {
    return `internal_event_${safeText(guildId || "unknown", 64)}_${safeText(eventId, 120)}`;
}

function indexKey(guildId) {
    return `internal_event_index_${safeText(guildId || "unknown", 64)}`;
}

function makeEventId(createdAt = Date.now()) {
    return `${Number(createdAt) || Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function textOrNull(value, max) {
    return value === undefined || value === null || value === "" ? null : safeText(value, max);
}

function idOrNull(value) {
    return value === undefined || value === null || value === "" ? null : safeText(value, 64);
}

function normalizeEvidence(value) {
    return Array.isArray(value) ? value.slice(0, 25).map(item => safeText(item, 300)) : [];
}

function normalizeMetadata(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeAuditRecord(input = {}) {
    const createdAt = Number(input.createdAt || Date.now());
    const eventId = safeText(input.eventId || input.id || makeEventId(createdAt), 120);
    return {
        eventId,
        guildId: idOrNull(input.guildId) || "unknown",
        source: safeText(input.source || "internal", 40),
        category: safeText(input.category || "system", 40),
        severity: safeText(input.severity || "info", 40),
        actionType: safeText(input.actionType || input.type || "UNKNOWN", 120),
        actorId: idOrNull(input.actorId),
        targetId: idOrNull(input.targetId),
        channelId: idOrNull(input.channelId),
        messageId: idOrNull(input.messageId),
        roleId: idOrNull(input.roleId),
        reason: textOrNull(input.reason, 500),
        summary: textOrNull(input.summary, 1000),
        evidence: normalizeEvidence(input.evidence),
        metadata: normalizeMetadata(input.metadata),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        storedAt: Date.now()
    };
}

async function withFallbackLock(guildId, fn) {
    const key = String(guildId || "unknown");
    const previous = fallbackLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const lock = previous.catch(() => {}).then(() => current);
    fallbackLocks.set(key, lock);

    try {
        await previous.catch(() => {});
        return await fn();
    } finally {
        release();
        if (fallbackLocks.get(key) === lock) fallbackLocks.delete(key);
    }
}

async function saveFallback(sessionManager, record) {
    if (!sessionManager?.setSetting || !sessionManager?.getSetting) return null;
    return withFallbackLock(record.guildId, async () => {
        const saved = await sessionManager.setSetting(storageKey(record.guildId, record.eventId), record);
        if (saved === false) return null;
        const current = await sessionManager.getSetting(indexKey(record.guildId), []);
        const list = Array.isArray(current) ? current : [];
        const next = [record.eventId, ...list.filter(id => id !== record.eventId)].slice(0, MAX_INDEX_RECORDS);
        const indexed = await sessionManager.setSetting(indexKey(record.guildId), next);
        return indexed === false ? null : record;
    });
}

async function saveAuditRecord(sessionManager, recordInput) {
    const record = normalizeAuditRecord(recordInput);
    try {
        return await saveFallback(sessionManager, record);
    } catch (err) {
        console.warn(`[INTERNAL_STORAGE] save failed: ${safeText(err?.code || err?.name || "write_failed", 80)}`);
        return null;
    }
}

async function getAuditRecord(sessionManager, guildId, eventId) {
    if (!sessionManager?.getSetting || !guildId || !eventId) return null;
    return sessionManager.getSetting(storageKey(guildId, eventId), null);
}

async function listFallback(sessionManager, guildId, limit = 50) {
    if (!sessionManager?.getSetting || !guildId) return [];
    const ids = await sessionManager.getSetting(indexKey(guildId), []);
    const out = [];
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, boundedLimit)) {
        const record = await sessionManager.getSetting(storageKey(guildId, id), null);
        if (record) out.push(record);
    }
    return out;
}

function matchesFilters(record, filters = {}) {
    for (const [key, value] of Object.entries(filters || {})) {
        if (value === undefined || value === null || value === "") continue;
        if (key === "from") {
            if (Number(record.createdAt || 0) < Number(value)) return false;
            continue;
        }
        if (key === "to") {
            if (Number(record.createdAt || 0) > Number(value)) return false;
            continue;
        }
        let actual;
        if (key === "source") actual = record.source;
        else if (key === "category") actual = record.category;
        else if (key === "severity") actual = record.severity;
        else if (key === "actionType") actual = record.actionType;
        else if (key === "actorId") actual = record.actorId;
        else if (key === "targetId") actual = record.targetId;
        else if (key === "channelId") actual = record.channelId;
        else return false;
        if (String(actual || "") !== String(value)) return false;
    }
    return true;
}

async function listAuditRecords(sessionManager, guildId, limit = 50, filters = {}) {
    const records = await listFallback(sessionManager, guildId, limit);
    return Object.keys(filters || {}).length
        ? records.filter(record => matchesFilters(record, filters))
        : records;
}

module.exports = {
    storageKey,
    indexKey,
    makeEventId,
    normalizeAuditRecord,
    canUseMongoStore: () => false,
    saveAuditRecord,
    getAuditRecord,
    listAuditRecords,
    _test: {
        saveFallback,
        listFallback,
        textOrNull,
        idOrNull,
        normalizeEvidence,
        normalizeMetadata,
        matchesFilters,
        withFallbackLock
    }
};
