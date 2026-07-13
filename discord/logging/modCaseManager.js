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

async function saveCaseWithSettings(sessionManager, caseDoc) {
    if (!sessionManager?.setSetting || !sessionManager?.getSetting) return false;
    return withFallbackLock(`user:${caseDoc.guildId}:${caseDoc.userId || "unknown"}`, async () => {
        if (await sessionManager.setSetting(caseKey(caseDoc.guildId, caseDoc.caseNumber), caseDoc) !== true) return false;

        const indexKey = userIndexKey(caseDoc.guildId, caseDoc.userId || "unknown");
        const current = await sessionManager.getSetting(indexKey, []);
        const list = Array.isArray(current) ? current : [];
        const next = [caseDoc.caseNumber, ...list.filter(n => n !== caseDoc.caseNumber)].slice(0, 50);
        if (await sessionManager.setSetting(indexKey, next) !== true) return false;
        return true;
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

async function getCase(sessionManager, guildId, caseNumber) {
    if (!guildId || !caseNumber) return null;
    if (canUseMongoStore()) {
        try {
            const doc = await modCaseStore.getCase(guildId, caseNumber);
            if (doc) return { ...doc, metadata: { ...doc.metadata, persistenceStore: doc.metadata?.persistenceStore || "mongo" } };
        } catch (err) {
            console.warn(`[MODCASE] Mongo get failed, fallback settings: ${safeErrorText(err, 240)}`);
        }
    }
    return sessionManager?.getSetting?.(caseKey(guildId, caseNumber), null) || null;
}

async function listUserCases(sessionManager, guildId, userId, limit = 10) {
    if (!guildId || !userId) return [];
    const max = Math.max(1, Math.min(50, Number(limit) || 10));

    if (canUseMongoStore()) {
        try {
            const docs = await modCaseStore.listUserCases(guildId, userId, max);
            if (docs.length) return docs;
        } catch (err) {
            console.warn(`[MODCASE] Mongo list failed, fallback settings: ${safeErrorText(err, 240)}`);
        }
    }

    const numbers = await sessionManager?.getSetting?.(userIndexKey(guildId, userId), []) || [];
    const cases = [];
    for (const number of numbers.slice(0, max)) {
        const doc = await getCase(sessionManager, guildId, number);
        if (doc) cases.push(doc);
    }
    return cases;
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

    if (canUseMongoStore()) {
        try {
            const updated = await modCaseStore.updateCase(guildId, caseNumber, patch);
            if (updated) return updated;
        } catch (err) {
            console.warn(`[MODCASE] Mongo update failed, fallback settings: ${safeErrorText(err, 240)}`);
        }
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
    const persistenceStore = existing.metadata?.persistenceStore || (canUseMongoStore() ? "mongo" : "settings");
    if (persistenceStore === "mongo" && canUseMongoStore()) {
        try {
            const updated = await modCaseStore.updateCase(guildId, caseNumber, patch);
            if (updated) return updated;
        } catch (err) {
            console.warn(`[MODCASE] Mongo status update failed, fallback settings: ${safeErrorText(err, 240)}`);
        }
        await sessionManager?.setSetting?.(`modcase_reconcile_${guildId}_${caseNumber}`, {
            guildId: String(guildId), caseNumber, intendedStatus: status,
            metadata: patch.metadata, createdAt: Date.now()
        }).catch(() => false);
        return null;
    }
    if (persistenceStore === "mongo") return null;
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
        nextCaseNumberFallback,
        withFallbackLock
    }
};
