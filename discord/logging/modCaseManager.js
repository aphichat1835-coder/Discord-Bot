/*
 * Moderation Case Manager
 * Creates and stores moderation cases for command actions and future protection actions.
 * Uses Mongo-backed ModCase store when DB is connected; falls back to BotSettings storage.
 */

const mongoose = require("mongoose");
const { sanitizeLogText, safeError } = require("../core/safeLogger");
const modCaseStore = require("./modCaseStore");
const fallbackLocks = new Map();

function safeText(value, max = 500) {
    return sanitizeLogText(String(value ?? "")).slice(0, Math.max(1, Number(max) || 500)) || "-";
}

function safeErrorText(err, max = 500) {
    return safeText(safeError(err), max);
}

async function withFallbackLock(key, fn) {
    const lockKey = String(key || "global");
    const previous = fallbackLocks.get(lockKey) || Promise.resolve();
    let release;
    const current = new Promise(resolve => {
        release = resolve;
    });
    const lock = previous.catch(() => {}).then(() => current);
    fallbackLocks.set(lockKey, lock);

    try {
        await previous.catch(() => {});
        return await fn();
    } finally {
        release();
        if (fallbackLocks.get(lockKey) === lock) fallbackLocks.delete(lockKey);
    }
}

function counterKey(guildId) {
    return `modcase_counter_${guildId}`;
}

function caseKey(guildId, caseNumber) {
    return `modcase_${guildId}_${caseNumber}`;
}

function userIndexKey(guildId, userId) {
    return `modcase_index_${guildId}_${userId}`;
}

function canUseMongoStore() {
    return mongoose.connection?.readyState === 1;
}

function withPersistenceStore(doc, persistenceStore) {
    if (!doc || typeof doc !== "object") return doc || null;
    return {
        ...doc,
        metadata: {
            ...(doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {}),
            persistenceStore
        }
    };
}

function normalizeAction(action) {
    return safeText(String(action || "unknown").toLowerCase(), 40);
}

function normalizeEvidence(evidence = []) {
    if (!Array.isArray(evidence)) return [];
    return evidence
        .filter(item => item !== undefined && item !== null)
        .slice(0, 25)
        .map(item => safeText(typeof item === "string" ? item : JSON.stringify(item), 300));
}

function normalizeDuration(input = {}) {
    const durationMs = input.durationMs ? Math.max(0, Number(input.durationMs) || 0) : null;
    const expiresAt = input.expiresAt || (durationMs ? Date.now() + durationMs : null);
    return { durationMs, expiresAt };
}

function buildCaseDoc(input, caseNumber, createdAt = Date.now()) {
    const { durationMs, expiresAt } = normalizeDuration(input);
    return {
        guildId: String(input.guildId),
        caseNumber,
        action: normalizeAction(input.action || input.type),
        type: normalizeAction(input.type || input.action),
        userId: input.userId ? String(input.userId) : null,
        moderatorId: input.moderatorId ? String(input.moderatorId) : null,
        reason: safeText(input.reason || "ไม่มีเหตุผลระบุ", 500),
        durationMs,
        evidence: normalizeEvidence(input.evidence),
        source: safeText(input.source || "command", 80),
        status: input.status || "active",
        createdAt: input.createdAt || createdAt,
        updatedAt: createdAt,
        expiresAt,
        metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
    };
}

async function nextCaseNumberFallback(sessionManager, guildId) {
    if (!sessionManager?.getSetting || !sessionManager?.setSetting) {
        throw new Error("SESSION_MANAGER_SETTINGS_UNAVAILABLE");
    }
    return withFallbackLock(`counter:${guildId}`, async () => {
        const key = counterKey(guildId);
        const current = Number(await sessionManager.getSetting(key, 0)) || 0;
        const next = current + 1;
        if (await sessionManager.setSetting(key, next) !== true) {
            throw new Error("CASE_COUNTER_SAVE_FAILED");
        }
        return next;
    });
}

async function nextCaseNumber(sessionManager, guildId) {
    if (canUseMongoStore()) {
        try {
            return await modCaseStore.nextCaseNumber(guildId);
        } catch (err) {
            console.warn(`[MODCASE] Mongo counter unavailable, fallback settings: ${safeErrorText(err, 240)}`);
        }
    }
    return nextCaseNumberFallback(sessionManager, guildId);
}

async function restoreSettingsCaseWrite(sessionManager, key, previous) {
    try {
        if (previous !== null && previous !== undefined) {
            return await sessionManager.setSetting(key, previous) === true;
        }
        if (typeof sessionManager?.deleteSetting !== "function") return false;
        return await sessionManager.deleteSetting(key) === true;
    } catch (err) {
        console.warn(`[MODCASE] Settings rollback failed: ${safeErrorText(err, 160)}`);
        return false;
    }
}

async function saveCaseWithSettings(sessionManager, caseDoc) {
    if (!sessionManager?.setSetting || !sessionManager?.getSetting) return false;
    return withFallbackLock(`user:${caseDoc.guildId}:${caseDoc.userId || "unknown"}`, async () => {
        const recordKey = caseKey(caseDoc.guildId, caseDoc.caseNumber);
        const previous = await sessionManager.getSetting(recordKey, null);
        if (await sessionManager.setSetting(recordKey, caseDoc) !== true) return false;

        const indexKey = userIndexKey(caseDoc.guildId, caseDoc.userId || "unknown");
        let indexSaved = false;
        try {
            const current = await sessionManager.getSetting(indexKey, []);
            const list = Array.isArray(current) ? current : [];
            const next = [caseDoc.caseNumber, ...list.filter(n => n !== caseDoc.caseNumber)].slice(0, 50);
            indexSaved = await sessionManager.setSetting(indexKey, next) === true;
        } catch (err) {
            console.warn(`[MODCASE] Settings index write failed: ${safeErrorText(err, 160)}`);
        }
        if (indexSaved) return true;

        const rolledBack = await restoreSettingsCaseWrite(sessionManager, recordKey, previous);
        if (!rolledBack) console.warn("[MODCASE] Settings case rollback was not persisted");
        return false;
    });
}

async function saveCase(sessionManager, caseDoc) {
    if (canUseMongoStore()) {
        try {
            caseDoc.metadata = { ...caseDoc.metadata, persistenceStore: "mongo" };
            return await modCaseStore.saveCase(caseDoc);
        } catch (err) {
            console.warn(`[MODCASE] Mongo save failed, fallback settings: ${safeErrorText(err, 240)}`);
        }
    }
    caseDoc.metadata = { ...caseDoc.metadata, persistenceStore: "settings" };
    if (!await saveCaseWithSettings(sessionManager, caseDoc)) throw new Error("CASE_SETTINGS_SAVE_FAILED");
    return caseDoc;
}

async function createCase(sessionManager, input = {}) {
    if (!input.guildId) throw new Error("CASE_GUILD_ID_REQUIRED");
    const caseNumber = input.caseNumber || await nextCaseNumber(sessionManager, input.guildId);
    const caseDoc = buildCaseDoc(input, caseNumber);

    try {
        return await saveCase(sessionManager, caseDoc);
    } catch (err) {
        throw new Error(`CASE_SAVE_FAILED: ${safeErrorText(err, 240)}`);
    }
}

async function getSettingsCase(sessionManager, guildId, caseNumber) {
    if (typeof sessionManager?.getSetting !== "function") return null;
    try {
        const doc = await sessionManager.getSetting(caseKey(guildId, caseNumber), null);
        return doc ? withPersistenceStore(doc, "settings") : null;
    } catch (err) {
        console.warn(`[MODCASE] Settings get failed: ${safeErrorText(err, 240)}`);
        return null;
    }
}

async function getCase(sessionManager, guildId, caseNumber) {
    if (!guildId || !caseNumber) return null;

    // Prefer an explicitly persisted fallback case. Mongo and settings counters can
    // temporarily overlap after an outage, and a settings-backed legacy case must
    // not be mistaken for a different Mongo document with the same case number.
    const settingsDoc = await getSettingsCase(sessionManager, guildId, caseNumber);
    if (settingsDoc) return settingsDoc;

    if (canUseMongoStore()) {
        try {
            const doc = await modCaseStore.getCase(guildId, caseNumber);
            if (doc) return withPersistenceStore(doc, doc.metadata?.persistenceStore || "mongo");
        } catch (err) {
            console.warn(`[MODCASE] Mongo get failed: ${safeErrorText(err, 240)}`);
        }
    }
    return null;
}

async function listSettingsUserCases(sessionManager, guildId, userId, max) {
    if (typeof sessionManager?.getSetting !== "function") return [];
    let numbers;
    try {
        numbers = await sessionManager.getSetting(userIndexKey(guildId, userId), []);
    } catch (err) {
        console.warn(`[MODCASE] Settings index read failed: ${safeErrorText(err, 240)}`);
        return [];
    }
    const cases = [];
    for (const number of (Array.isArray(numbers) ? numbers : []).slice(0, max)) {
        const doc = await getSettingsCase(sessionManager, guildId, number);
        if (doc) cases.push(doc);
    }
    return cases;
}

function mergeCaseLists(settingsCases, mongoCases, max) {
    const byCaseNumber = new Map();
    // Settings wins a number collision because it is the explicit outage fallback
    // record that callers previously addressed by that case number.
    for (const doc of mongoCases || []) byCaseNumber.set(String(doc.caseNumber), doc);
    for (const doc of settingsCases || []) byCaseNumber.set(String(doc.caseNumber), doc);
    return [...byCaseNumber.values()]
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0) || Number(b.caseNumber || 0) - Number(a.caseNumber || 0))
        .slice(0, max);
}

async function listUserCases(sessionManager, guildId, userId, limit = 10) {
    if (!guildId || !userId) return [];
    const max = Math.max(1, Math.min(50, Number(limit) || 10));
    const settingsCases = await listSettingsUserCases(sessionManager, guildId, userId, max);
    let mongoCases = [];

    if (canUseMongoStore()) {
        try {
            const docs = await modCaseStore.listUserCases(guildId, userId, max);
            mongoCases = (docs || []).map(doc => withPersistenceStore(doc, doc.metadata?.persistenceStore || "mongo"));
        } catch (err) {
            console.warn(`[MODCASE] Mongo list failed: ${safeErrorText(err, 240)}`);
        }
    }

    return mergeCaseLists(settingsCases, mongoCases, max);
}

async function persistCaseReconciliation(sessionManager, guildId, caseNumber, operation, patch) {
    if (typeof sessionManager?.setSetting !== "function") return false;
    try {
        const persisted = await sessionManager.setSetting(`modcase_reconcile_${guildId}_${caseNumber}`, {
            guildId: String(guildId),
            caseNumber,
            operation,
            patch,
            createdAt: Date.now()
        }) === true;
        if (!persisted) console.warn(`[MODCASE] Reconciliation marker was not persisted for ${operation}`);
        return persisted;
    } catch (err) {
        console.warn(`[MODCASE] Reconciliation write failed: ${safeErrorText(err, 160)}`);
        return false;
    }
}

async function updateCaseReason(sessionManager, guildId, caseNumber, reason, amendedBy = null) {
    const existing = await getCase(sessionManager, guildId, caseNumber);
    if (!existing) return null;

    const patch = {
        reason: safeText(reason || "ไม่มีเหตุผลระบุ", 500),
        amendedBy: amendedBy ? String(amendedBy) : null,
        amendedAt: Date.now(),
        updatedAt: Date.now()
    };

    const persistenceStore = existing.metadata?.persistenceStore || "settings";
    if (persistenceStore === "mongo") {
        if (canUseMongoStore()) {
            try {
                const updated = await modCaseStore.updateCase(guildId, caseNumber, patch);
                if (updated) return withPersistenceStore(updated, "mongo");
            } catch (err) {
                console.warn(`[MODCASE] Mongo update failed: ${safeErrorText(err, 240)}`);
            }
        }
        await persistCaseReconciliation(sessionManager, guildId, caseNumber, "update_reason", patch);
        return null;
    }

    const updated = { ...existing, ...patch };
    return await sessionManager.setSetting(caseKey(guildId, caseNumber), updated) === true ? updated : null;
}

async function updateCaseStatus(sessionManager, guildId, caseNumber, status, metadata = {}) {
    const allowed = new Set(["pending", "completed", "failed"]);
    if (!allowed.has(status)) throw new Error("CASE_STATUS_INVALID");
    const existing = await getCase(sessionManager, guildId, caseNumber);
    if (!existing) return null;
    const patch = {
        status,
        metadata: { ...existing.metadata, ...metadata },
        evidence: metadata.dmSent === undefined
            ? existing.evidence
            : normalizeEvidence([
                ...(existing.evidence || []).filter(item => !String(item).startsWith("DM sent:")),
                `DM sent: ${metadata.dmSent ? "yes" : "no"}`
            ]),
        updatedAt: Date.now()
    };
    const persistenceStore = existing.metadata?.persistenceStore || "settings";
    if (persistenceStore === "mongo") {
        if (canUseMongoStore()) {
            try {
                const updated = await modCaseStore.updateCase(guildId, caseNumber, patch);
                if (updated) return withPersistenceStore(updated, "mongo");
            } catch (err) {
                console.warn(`[MODCASE] Mongo status update failed: ${safeErrorText(err, 240)}`);
            }
        }
        await persistCaseReconciliation(sessionManager, guildId, caseNumber, "update_status", patch);
        return null;
    }
    const updated = { ...existing, ...patch };
    return await sessionManager.setSetting(caseKey(guildId, caseNumber), updated) === true ? updated : null;
}

module.exports = {
    createCase,
    getCase,
    listUserCases,
    updateCaseReason,
    updateCaseStatus,
    _test: {
        counterKey,
        caseKey,
        userIndexKey,
        normalizeEvidence,
        normalizeAction,
        normalizeDuration,
        buildCaseDoc,
        canUseMongoStore,
        withPersistenceStore,
        restoreSettingsCaseWrite,
        getSettingsCase,
        listSettingsUserCases,
        mergeCaseLists,
        persistCaseReconciliation,
        nextCaseNumberFallback,
        withFallbackLock
    }
};
