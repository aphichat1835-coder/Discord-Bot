/*
 * Moderation Case Manager
 * Creates and stores moderation cases for command actions and future protection actions.
 * Uses Mongo-backed ModCase store when DB is connected; falls back to BotSettings storage.
 */

const mongoose = require("mongoose");
const { safeAuditText, safeAuditError, LOG_TYPES } = require("./logCore");
const { buildCaseEmbed } = require("./logFormat");
const modCaseStore = require("./modCaseStore");

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
    return safeAuditText(String(action || "unknown").toLowerCase(), 40);
}

function normalizeEvidence(evidence = []) {
    if (!Array.isArray(evidence)) return [];
    return evidence
        .filter(item => item !== undefined && item !== null)
        .slice(0, 25)
        .map(item => safeAuditText(typeof item === "string" ? item : JSON.stringify(item), 300));
}

async function nextCaseNumberFallback(sessionManager, guildId) {
    if (!sessionManager?.getSetting || !sessionManager?.setSetting) {
        throw new Error("SESSION_MANAGER_SETTINGS_UNAVAILABLE");
    }
    const key = counterKey(guildId);
    const current = Number(await sessionManager.getSetting(key, 0)) || 0;
    const next = current + 1;
    await sessionManager.setSetting(key, next);
    return next;
}

async function nextCaseNumber(sessionManager, guildId) {
    if (canUseMongoStore()) {
        try {
            return await modCaseStore.nextCaseNumber(guildId);
        } catch (err) {
            console.warn(`[MODCASE] Mongo counter unavailable, fallback settings: ${safeAuditError(err, 240)}`);
        }
    }
    return nextCaseNumberFallback(sessionManager, guildId);
}

async function saveCaseWithSettings(sessionManager, caseDoc) {
    if (!sessionManager?.setSetting || !sessionManager?.getSetting) return false;
    await sessionManager.setSetting(caseKey(caseDoc.guildId, caseDoc.caseNumber), caseDoc);

    const indexKey = userIndexKey(caseDoc.guildId, caseDoc.userId || "unknown");
    const current = await sessionManager.getSetting(indexKey, []);
    const list = Array.isArray(current) ? current : [];
    const next = [caseDoc.caseNumber, ...list.filter(n => n !== caseDoc.caseNumber)].slice(0, 50);
    await sessionManager.setSetting(indexKey, next);
    return true;
}

async function saveCase(sessionManager, caseDoc) {
    if (canUseMongoStore()) {
        try {
            return await modCaseStore.saveCase(caseDoc);
        } catch (err) {
            console.warn(`[MODCASE] Mongo save failed, fallback settings: ${safeAuditError(err, 240)}`);
        }
    }
    await saveCaseWithSettings(sessionManager, caseDoc);
    return caseDoc;
}

async function createCase(sessionManager, input = {}) {
    if (!input.guildId) throw new Error("CASE_GUILD_ID_REQUIRED");

    const caseNumber = input.caseNumber || await nextCaseNumber(sessionManager, input.guildId);
    const now = Date.now();
    const durationMs = input.durationMs ? Math.max(0, Number(input.durationMs) || 0) : null;
    const expiresAt = input.expiresAt || (durationMs ? now + durationMs : null);

    const caseDoc = {
        guildId: String(input.guildId),
        caseNumber,
        action: normalizeAction(input.action || input.type),
        type: normalizeAction(input.type || input.action),
        userId: input.userId ? String(input.userId) : null,
        moderatorId: input.moderatorId ? String(input.moderatorId) : null,
        reason: safeAuditText(input.reason || "ไม่มีเหตุผลระบุ", 500),
        durationMs,
        evidence: normalizeEvidence(input.evidence),
        source: safeAuditText(input.source || "command", 80),
        status: input.status || "active",
        createdAt: input.createdAt || now,
        updatedAt: now,
        expiresAt,
        metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
    };

    try {
        return await saveCase(sessionManager, caseDoc);
    } catch (err) {
        throw new Error(`CASE_SAVE_FAILED: ${safeAuditError(err, 240)}`);
    }
}

async function getCase(sessionManager, guildId, caseNumber) {
    if (!guildId || !caseNumber) return null;
    if (canUseMongoStore()) {
        try {
            const doc = await modCaseStore.getCase(guildId, caseNumber);
            if (doc) return doc;
        } catch (err) {
            console.warn(`[MODCASE] Mongo get failed, fallback settings: ${safeAuditError(err, 240)}`);
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
            console.warn(`[MODCASE] Mongo list failed, fallback settings: ${safeAuditError(err, 240)}`);
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
        reason: safeAuditText(reason || "ไม่มีเหตุผลระบุ", 500),
        amendedBy: amendedBy ? String(amendedBy) : null,
        amendedAt: Date.now(),
        updatedAt: Date.now()
    };

    if (canUseMongoStore()) {
        try {
            const updated = await modCaseStore.updateCase(guildId, caseNumber, patch);
            if (updated) return updated;
        } catch (err) {
            console.warn(`[MODCASE] Mongo update failed, fallback settings: ${safeAuditError(err, 240)}`);
        }
    }

    const updated = { ...existing, ...patch };
    await sessionManager.setSetting(caseKey(guildId, caseNumber), updated);
    return updated;
}

function buildModerationCaseEmbed(caseDoc, options = {}) {
    return buildCaseEmbed(caseDoc, {
        title: options.title || `🛡️ Case #${caseDoc.caseNumber} | ${String(caseDoc.action || "ACTION").toUpperCase()}`,
        severity: options.severity || "danger"
    });
}

function caseToLogEvent(caseDoc) {
    return {
        type: LOG_TYPES.MOD_CASE_CREATE,
        category: "moderation",
        severity: "danger",
        guildId: caseDoc.guildId,
        actorId: caseDoc.moderatorId,
        targetId: caseDoc.userId,
        reason: caseDoc.reason,
        evidence: caseDoc.evidence,
        metadata: {
            caseNumber: caseDoc.caseNumber,
            action: caseDoc.action,
            source: caseDoc.source,
            status: caseDoc.status
        },
        createdAt: caseDoc.createdAt
    };
}

module.exports = {
    createCase,
    getCase,
    listUserCases,
    updateCaseReason,
    buildModerationCaseEmbed,
    caseToLogEvent,
    _test: {
        counterKey,
        caseKey,
        userIndexKey,
        normalizeEvidence,
        normalizeAction,
        canUseMongoStore
    }
};
