const crypto = require("node:crypto");
const { safeText, withFallbackLock } = require("./persistenceHelpers");
const { sanitizeSensitiveValue } = require("../core/sensitiveData");
const MAX_INDEX_RECORDS = 500;

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
    return value && typeof value === "object" && !Array.isArray(value)
        ? sanitizeSensitiveValue(value, { maxDepth: 5, maxKeys: 100, maxArray: 50, maxString: 1000 })
        : {};
}

function normalizeInternalEvent(input = {}) {
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

async function deleteSettingWithRetry(sessionManager, key, attempts = 3) {
    if (!sessionManager?.deleteSetting) return false;
    const boundedAttempts = Math.max(1, Math.min(5, Number(attempts) || 3));
    for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
        if (await sessionManager.deleteSetting(key) === true) return true;
        if (attempt < boundedAttempts) {
            await new Promise(resolve => setTimeout(resolve, 25 * attempt));
        }
    }
    return false;
}

async function deleteStoredEvents(sessionManager, guildId, eventIds) {
    if (!sessionManager?.deleteSetting) return false;
    let complete = true;
    for (const eventId of new Set(eventIds.filter(Boolean))) {
        const deleted = await deleteSettingWithRetry(sessionManager, storageKey(guildId, eventId));
        if (!deleted) complete = false;
    }
    return complete;
}

async function readSettingStrict(sessionManager, key) {
    if (typeof sessionManager?.getSettingStrict !== "function") {
        const error = new Error("STRICT_SETTING_READ_UNAVAILABLE");
        error.code = "strict_setting_read_unavailable";
        throw error;
    }
    return sessionManager.getSettingStrict(key);
}

async function saveFallback(sessionManager, record) {
    if (!sessionManager?.setSetting || !sessionManager?.getSettingStrict) return null;
    return withFallbackLock(`internal-event:${record.guildId}`, async () => {
        const recordKey = storageKey(record.guildId, record.eventId);
        const previousRecordRead = await readSettingStrict(sessionManager, recordKey);
        const previousRecord = previousRecordRead.found ? previousRecordRead.value : null;
        const indexRead = await readSettingStrict(sessionManager, indexKey(record.guildId));
        const current = indexRead.found ? indexRead.value : [];
        const saved = await sessionManager.setSetting(recordKey, record);
        if (saved !== true) return null;

        const list = Array.isArray(current) ? current.filter(Boolean).map(String) : [];
        const next = [record.eventId, ...list.filter(id => id !== record.eventId)].slice(0, MAX_INDEX_RECORDS);
        const indexed = await sessionManager.setSetting(indexKey(record.guildId), next);
        if (indexed !== true) {
            const rolledBack = previousRecord === null
                ? await deleteSettingWithRetry(sessionManager, recordKey)
                : await sessionManager.setSetting(recordKey, previousRecord);
            if (rolledBack !== true) {
                console.warn('[INTERNAL_STORAGE] index write failed and record rollback was not acknowledged');
            }
            return null;
        }

        const retained = new Set(next);
        const evicted = list.filter(eventId => !retained.has(eventId));
        if (evicted.length) {
            const cleaned = await deleteStoredEvents(sessionManager, record.guildId, evicted);
            if (!cleaned) console.warn('[INTERNAL_STORAGE] one or more evicted records could not be deleted');
        }
        return record;
    });
}

async function saveInternalEvent(sessionManager, recordInput) {
    const record = normalizeInternalEvent(recordInput);
    try {
        return await saveFallback(sessionManager, record);
    } catch (err) {
        console.warn(`[INTERNAL_STORAGE] save failed: ${safeText(err?.code || err?.name || "write_failed", 80)}`);
        return null;
    }
}

async function getInternalEvent(sessionManager, guildId, eventId) {
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

function isEmptyFilterValue(value) {
    return value === undefined || value === null || value === "";
}

function matchesCreatedAt(record, key, value) {
    const createdAt = Number(record.createdAt || 0);
    if (key === "from") return createdAt >= Number(value);
    if (key === "to") return createdAt <= Number(value);
    return null;
}

function filterFieldValue(record, key) {
    if (key === "source") return record.source;
    if (key === "category") return record.category;
    if (key === "severity") return record.severity;
    if (key === "actionType") return record.actionType;
    if (key === "actorId") return record.actorId;
    if (key === "targetId") return record.targetId;
    if (key === "channelId") return record.channelId;
    return undefined;
}

function matchesFilter(record, key, value) {
    if (isEmptyFilterValue(value)) return true;
    const timeMatch = matchesCreatedAt(record, key, value);
    if (timeMatch !== null) return timeMatch;
    const actual = filterFieldValue(record, key);
    return actual !== undefined && String(actual || "") === String(value);
}

function matchesFilters(record, filters = {}) {
    return Object.entries(filters || {}).every(([key, value]) => matchesFilter(record, key, value));
}

async function listInternalEvents(sessionManager, guildId, limit = 50, filters = {}) {
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const hasFilters = Object.keys(filters || {}).length > 0;
    const records = await listFallback(sessionManager, guildId, hasFilters ? MAX_INDEX_RECORDS : boundedLimit);
    const matched = hasFilters ? records.filter(record => matchesFilters(record, filters)) : records;
    return matched.slice(0, boundedLimit);
}

module.exports = {
    storageKey,
    indexKey,
    makeEventId,
    normalizeInternalEvent,
    canUseMongoStore: () => false,
    saveInternalEvent,
    getInternalEvent,
    listInternalEvents,
    _test: {
        saveFallback,
        readSettingStrict,
        deleteStoredEvents,
        deleteSettingWithRetry,
        listFallback,
        textOrNull,
        idOrNull,
        normalizeEvidence,
        normalizeMetadata,
        isEmptyFilterValue,
        matchesCreatedAt,
        filterFieldValue,
        matchesFilter,
        matchesFilters,
        withFallbackLock
    }
};
