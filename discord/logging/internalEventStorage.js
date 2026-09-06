const crypto = require("node:crypto");
const v8 = require("node:v8");
const { safeText, withFallbackLock } = require("./persistenceHelpers");
const { sanitizeSensitiveValue } = require("../core/sensitiveData");
const MAX_INDEX_RECORDS = 500;
const INLINE_RECORD_MAX_BYTES = 512 * 1024;
const CHUNK_RECORD_BYTES = 256 * 1024;
const CHUNK_FORMAT = "internal-event-chunks-v1";

function storageKey(guildId, eventId) {
    return `internal_event_${safeText(guildId || "unknown", 64)}_${safeText(eventId, 120)}`;
}

function indexKey(guildId) {
    return `internal_event_index_${safeText(guildId || "unknown", 64)}`;
}

function chunkKey(recordKey, storageId, index) {
    return `${recordKey}:chunk:${storageId}:${index}`;
}

function isChunkManifest(value) {
    return value?.format === CHUNK_FORMAT &&
        Number.isSafeInteger(value.chunkCount) && value.chunkCount > 0 &&
        typeof value.storageId === "string" && /^[a-f0-9-]{16,}$/i.test(value.storageId) &&
        typeof value.checksum === "string" && /^[a-f0-9]{64}$/i.test(value.checksum);
}

function buildChunkManifest(record) {
    const bytes = v8.serialize(record);
    if (bytes.length <= INLINE_RECORD_MAX_BYTES) return { inline: record, bytes: null, manifest: null };
    const storageId = crypto.randomUUID();
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_RECORD_BYTES) {
        chunks.push(bytes.subarray(offset, offset + CHUNK_RECORD_BYTES).toString("base64"));
    }
    return {
        inline: null,
        bytes: chunks,
        manifest: {
            format: CHUNK_FORMAT,
            storageId,
            chunkCount: chunks.length,
            byteLength: bytes.length,
            checksum: crypto.createHash("sha256").update(bytes).digest("hex"),
            eventId: record.eventId,
            guildId: record.guildId,
            createdAt: record.createdAt,
            storedAt: record.storedAt
        }
    };
}

async function readStoredRecord(sessionManager, recordKey, fallback = null) {
    const stored = await sessionManager.getSetting(recordKey, fallback);
    if (!isChunkManifest(stored)) return stored;
    const parts = [];
    for (let index = 0; index < stored.chunkCount; index++) {
        const encoded = await sessionManager.getSetting(chunkKey(recordKey, stored.storageId, index), null);
        if (typeof encoded !== "string") return null;
        parts.push(Buffer.from(encoded, "base64"));
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== stored.byteLength) return null;
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== stored.checksum) return null;
    try {
        const record = v8.deserialize(bytes);
        return record?.eventId === stored.eventId && record?.guildId === stored.guildId ? record : null;
    } catch {
        return null;
    }
}

async function deleteStoredRecord(sessionManager, recordKey, stored = undefined) {
    const current = stored === undefined ? await sessionManager.getSetting(recordKey, null) : stored;
    let complete = true;
    if (!await deleteStoredChunks(sessionManager, recordKey, current)) complete = false;
    if (!await deleteSettingWithRetry(sessionManager, recordKey)) complete = false;
    return complete;
}

async function deleteStoredChunks(sessionManager, recordKey, stored) {
    if (!isChunkManifest(stored)) return true;
    let complete = true;
    for (let index = 0; index < stored.chunkCount; index++) {
        if (!await deleteSettingWithRetry(sessionManager, chunkKey(recordKey, stored.storageId, index))) complete = false;
    }
    return complete;
}

async function writeStoredRecord(sessionManager, recordKey, record) {
    const encoded = buildChunkManifest(record);
    if (encoded.inline) return (await sessionManager.setSetting(recordKey, encoded.inline)) === true;
    for (let index = 0; index < encoded.bytes.length; index++) {
        const saved = await sessionManager.setSetting(chunkKey(recordKey, encoded.manifest.storageId, index), encoded.bytes[index]);
        if (saved !== true) {
            for (let cleanup = 0; cleanup < index; cleanup++) {
                await deleteSettingWithRetry(sessionManager, chunkKey(recordKey, encoded.manifest.storageId, cleanup));
            }
            return false;
        }
    }
    const savedManifest = await sessionManager.setSetting(recordKey, encoded.manifest);
    if (savedManifest !== true) {
        for (let index = 0; index < encoded.bytes.length; index++) {
            await deleteSettingWithRetry(sessionManager, chunkKey(recordKey, encoded.manifest.storageId, index));
        }
    }
    return savedManifest === true;
}

function makeEventId(createdAt = Date.now()) {
    return `${Number(createdAt) || Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function textOrNull(value) {
    return value === undefined || value === null || value === "" ? null : String(value);
}

function idOrNull(value) {
    return value === undefined || value === null || value === "" ? null : safeText(value, 64);
}

function normalizeEvidence(value) {
    return Array.isArray(value) ? sanitizeSensitiveValue(value) : [];
}

function normalizeMetadata(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? sanitizeSensitiveValue(value)
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
        reason: textOrNull(input.reason),
        summary: textOrNull(input.summary),
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
        const deleted = await deleteStoredRecord(sessionManager, storageKey(guildId, eventId));
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
        const saved = await writeStoredRecord(sessionManager, recordKey, record);
        if (saved !== true) return null;

        const list = Array.isArray(current) ? current.filter(Boolean).map(String) : [];
        const next = [record.eventId, ...list.filter(id => id !== record.eventId)].slice(0, MAX_INDEX_RECORDS);
        const indexed = await sessionManager.setSetting(indexKey(record.guildId), next);
        if (indexed !== true) {
            const rolledBack = previousRecord === null
                ? await deleteStoredRecord(sessionManager, recordKey)
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
        if (previousRecord !== null && isChunkManifest(previousRecord)) {
            await deleteStoredChunks(sessionManager, recordKey, previousRecord);
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
    return readStoredRecord(sessionManager, storageKey(guildId, eventId), null);
}

async function listFallback(sessionManager, guildId, limit = 50) {
    if (!sessionManager?.getSetting || !guildId) return [];
    const ids = await sessionManager.getSetting(indexKey(guildId), []);
    const out = [];
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, boundedLimit)) {
        const record = await getInternalEvent(sessionManager, guildId, id);
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
        chunkKey,
        isChunkManifest,
        buildChunkManifest,
        readStoredRecord,
        writeStoredRecord,
        deleteStoredRecord,
        deleteStoredChunks,
    makeEventId,
    normalizeInternalEvent,
    canUseMongoStore: () => false,
    saveInternalEvent,
    getInternalEvent,
    listInternalEvents,
    _test: {
        chunkKey,
        isChunkManifest,
        buildChunkManifest,
        readStoredRecord,
        writeStoredRecord,
        deleteStoredRecord,
        deleteStoredChunks,
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
