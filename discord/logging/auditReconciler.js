const { routeAndSendLog, safeAuditError } = require("./logCore");
const { readEntryName, readActorId, readTargetId } = require("./auditGenericFormatter");
const { renderAuditEntry } = require("./auditSpecificRenderers");
const { categoryForAuditEvent, severityForAuditEvent } = require("./auditEventMap");
const { defaultAuditDedup, auditEntryKey } = require("./auditDedup");
const auditStorage = require("./auditStorage");

const cursorKey = guildId => `audit_reconciler_cursor_${guildId}`;
const seenKey = guildId => `audit_reconciler_seen_${guildId}`;

function entryCreatedAt(entry = {}) {
    return Number(entry.createdTimestamp || entry.created_at || entry.createdAt || Date.now());
}

function entryId(entry = {}) {
    return entry.id ? String(entry.id) : null;
}

async function getSeen(sessionManager, guildId) {
    const seen = await sessionManager?.getSetting?.(seenKey(guildId), []);
    return new Set(Array.isArray(seen) ? seen : []);
}

async function saveSeen(sessionManager, guildId, seen) {
    const next = Array.from(seen).slice(0, 500);
    await sessionManager?.setSetting?.(seenKey(guildId), next).catch(() => {});
}

async function saveCursor(sessionManager, guildId, lastEntryId) {
    if (!lastEntryId) return;
    await sessionManager?.setSetting?.(cursorKey(guildId), {
        lastEntryId,
        updatedAt: Date.now()
    }).catch(() => {});
}

async function getCursor(sessionManager, guildId) {
    return await sessionManager?.getSetting?.(cursorKey(guildId), null).catch(() => null);
}

function normalizeEntry(rawEntry) {
    const action = readEntryName(rawEntry);
    return {
        id: entryId(rawEntry),
        action,
        actorId: readActorId(rawEntry),
        targetId: readTargetId(rawEntry),
        channelId: rawEntry.options?.channel_id || rawEntry.extra?.channel?.id || null,
        messageId: rawEntry.options?.message_id || null,
        roleId: rawEntry.options?.role_id || null,
        reason: rawEntry.reason || null,
        createdAt: entryCreatedAt(rawEntry),
        category: categoryForAuditEvent(action),
        severity: severityForAuditEvent(action)
    };
}

async function processEntry({ guild, sessionManager, entry, seen }) {
    const id = entryId(entry);
    if (!id) return false;

    const dedupKey = auditEntryKey(guild.id, id);
    if (seen.has(id) || defaultAuditDedup.seen(dedupKey)) return false;

    const normalized = normalizeEntry(entry);
    const embed = renderAuditEntry(entry, {
        category: normalized.category,
        severity: normalized.severity,
        footer: "Audit reconciler"
    });

    const sent = await routeAndSendLog({
        guild,
        sessionManager,
        category: normalized.category,
        embed,
        debounceKey: dedupKey,
        debounceMs: 60 * 1000
    });

    await auditStorage.saveAuditRecord(sessionManager, {
        eventId: id,
        guildId: guild.id,
        source: "audit_reconciler",
        category: normalized.category,
        severity: normalized.severity,
        actionType: normalized.action,
        actorId: normalized.actorId,
        targetId: normalized.targetId,
        channelId: normalized.channelId,
        messageId: normalized.messageId,
        roleId: normalized.roleId,
        reason: normalized.reason,
        summary: normalized.action,
        metadata: {
            sent,
            renderer: "specialized_or_generic"
        },
        createdAt: normalized.createdAt
    });

    seen.add(id);
    return sent;
}

async function runAuditReconcile(guild, sessionManager, options = {}) {
    if (!guild?.fetchAuditLogs || !sessionManager) return { ok: false, reason: "missing_dependencies", processed: 0 };
    const limit = Math.max(1, Math.min(50, Number(options.limit || 10) || 10));
    const maxPages = Math.max(1, Math.min(20, Number(options.maxPages || 5) || 5));
    const seen = await getSeen(sessionManager, guild.id);
    const cursor = await getCursor(sessionManager, guild.id);

    try {
        const entries = [];
        let before = null;
        let reachedCursor = false;

        for (let pageIndex = 0; pageIndex < maxPages && !reachedCursor; pageIndex += 1) {
            const logs = await guild.fetchAuditLogs(before ? { limit, before } : { limit });
            const page = Array.from(logs?.entries?.values?.() || []);
            if (page.length === 0) break;

            for (const entry of page) {
                const id = entryId(entry);
                if (cursor?.lastEntryId && id === cursor.lastEntryId) {
                    reachedCursor = true;
                    break;
                }
                entries.push(entry);
            }

            before = page[page.length - 1]?.id || null;
            if (!before || !cursor?.lastEntryId) break;
        }

        entries.reverse();
        let processed = 0;
        let lastEntryId = null;

        for (const entry of entries) {
            const id = entryId(entry);
            if (id) lastEntryId = id;
            if (await processEntry({ guild, sessionManager, entry, seen })) processed += 1;
        }

        await saveSeen(sessionManager, guild.id, seen);
        await saveCursor(sessionManager, guild.id, lastEntryId);
        return { ok: true, processed, scanned: entries.length, lastEntryId, reachedCursor };
    } catch (err) {
        console.warn(`[AUDIT_RECONCILER] failed: ${safeAuditError(err, 240)}`);
        return { ok: false, reason: safeAuditError(err, 240), processed: 0 };
    }
}

module.exports = {
    cursorKey,
    seenKey,
    entryCreatedAt,
    normalizeEntry,
    processEntry,
    runAuditReconcile
};
