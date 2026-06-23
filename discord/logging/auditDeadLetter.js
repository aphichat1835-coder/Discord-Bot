const { safeAuditText, safeAuditError } = require("./logCore");

function deadLetterIndexKey(guildId) {
    return `audit_dead_letter_index_${guildId}`;
}

function deadLetterRecordKey(guildId, id) {
    return `audit_dead_letter_${guildId}_${id}`;
}

function normalizeDeadLetter(input = {}) {
    const createdAt = Number(input.createdAt || Date.now());
    const id = safeAuditText(input.id || `${createdAt}_${Math.random().toString(36).slice(2, 8)}`, 120);
    return {
        id,
        guildId: String(input.guildId || "unknown"),
        category: safeAuditText(input.category || "server", 40),
        actionType: safeAuditText(input.actionType || input.type || "UNKNOWN", 120),
        reason: safeAuditText(input.reason || "send_failed", 240),
        attempts: Math.max(0, Number(input.attempts || 0) || 0),
        payload: input.payload && typeof input.payload === "object" ? input.payload : {},
        createdAt,
        updatedAt: Date.now()
    };
}

async function saveDeadLetter(sessionManager, input = {}) {
    if (!sessionManager?.setSetting || !sessionManager?.getSetting) return null;
    const record = normalizeDeadLetter(input);
    try {
        await sessionManager.setSetting(deadLetterRecordKey(record.guildId, record.id), record);
        const current = await sessionManager.getSetting(deadLetterIndexKey(record.guildId), []);
        const list = Array.isArray(current) ? current : [];
        const next = [record.id, ...list.filter(item => item !== record.id)].slice(0, 250);
        await sessionManager.setSetting(deadLetterIndexKey(record.guildId), next);
        return record;
    } catch (err) {
        console.warn(`[AUDIT_DEAD_LETTER] save failed: ${safeAuditError(err, 240)}`);
        return null;
    }
}

async function listDeadLetters(sessionManager, guildId, limit = 25) {
    if (!sessionManager?.getSetting || !guildId) return [];
    const ids = await sessionManager.getSetting(deadLetterIndexKey(guildId), []);
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, Math.max(1, Math.min(100, Number(limit) || 25)))) {
        const record = await sessionManager.getSetting(deadLetterRecordKey(guildId, id), null);
        if (record) out.push(record);
    }
    return out;
}

async function clearDeadLetter(sessionManager, guildId, id) {
    if (!sessionManager?.setSetting || !sessionManager?.getSetting || !guildId || !id) return false;
    const current = await sessionManager.getSetting(deadLetterIndexKey(guildId), []);
    const list = Array.isArray(current) ? current : [];
    await sessionManager.setSetting(deadLetterIndexKey(guildId), list.filter(item => item !== id));
    await sessionManager.setSetting(deadLetterRecordKey(guildId, id), null);
    return true;
}

module.exports = {
    deadLetterIndexKey,
    deadLetterRecordKey,
    normalizeDeadLetter,
    saveDeadLetter,
    listDeadLetters,
    clearDeadLetter
};
