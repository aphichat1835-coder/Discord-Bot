"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_SPOOL_BYTES = 5 * 1024 * 1024; // 5 MB ceiling
const DEFAULT_SPOOL_PATH = path.resolve(process.cwd(), "data", "p0_emergency_journal.jsonl");

function resolveJournalPath() {
    const custom = process.env.SQLITE_P0_JOURNAL_PATH;
    if (custom && custom.trim()) {
        return path.resolve(custom.trim());
    }
    const dbPath = process.env.SQLITE_DB_PATH;
    if (dbPath && dbPath.trim()) {
        return path.join(path.dirname(path.resolve(dbPath.trim())), "p0_emergency_journal.jsonl");
    }
    return DEFAULT_SPOOL_PATH;
}

function getStableEntryId(repositoryName, item) {
    if (!item) return crypto.randomUUID();
    if (item._journalEntryId) return item._journalEntryId;
    if (item.id) return `id_${item.id}`;
    const key = `${repositoryName}:${item.occurredAt || ""}:${item.commandName || item.eventType || item.sessionId || ""}:${item.actorId || item.accountId || ""}:${item.detailJson || item.detail || item.metadataJson || ""}`;
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    item._journalEntryId = hash;
    return hash;
}

/**
 * Spools a P0 event to the persistent emergency journal file when memory retry queue is full.
 * @param {string} repositoryName - "command_events" | "session_events" | "voice_events"
 * @param {object} item - The prepared event record
 */
function spoolP0Event(repositoryName, item) {
    if (!item) return false;
    try {
        const journalPath = resolveJournalPath();
        const dir = path.dirname(journalPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const entryId = getStableEntryId(repositoryName, item);
        const payload = JSON.stringify({
            id: entryId,
            repo: repositoryName,
            item,
            spooledAt: Date.now()
        }) + "\n";
        const payloadBytes = Buffer.byteLength(payload, "utf8");

        // Check journal file size limit to prevent runaway disk usage
        if (fs.existsSync(journalPath)) {
            const stat = fs.statSync(journalPath);
            if (stat.size + payloadBytes > MAX_SPOOL_BYTES) {
                console.error(`[P0_JOURNAL] ⚠️ Emergency journal reached size limit (${stat.size} + ${payloadBytes} bytes > ${MAX_SPOOL_BYTES}); rejecting new spool.`);
                try {
                    const { notifyP0SpoolFailed } = require("./telemetryAlert");
                    notifyP0SpoolFailed(repositoryName, "journal_size_limit_exceeded", {
                        currentBytes: stat.size,
                        payloadBytes,
                        maxBytes: MAX_SPOOL_BYTES
                    });
                } catch (_) {}
                return false;
            }
        } else if (payloadBytes > MAX_SPOOL_BYTES) {
            console.error(`[P0_JOURNAL] ⚠️ Event payload exceeds emergency journal ceiling (${payloadBytes} bytes > ${MAX_SPOOL_BYTES}); rejecting new spool.`);
            try {
                const { notifyP0SpoolFailed } = require("./telemetryAlert");
                notifyP0SpoolFailed(repositoryName, "payload_exceeds_max_ceiling", {
                    payloadBytes,
                    maxBytes: MAX_SPOOL_BYTES
                });
            } catch (_) {}
            return false;
        }

        fs.appendFileSync(journalPath, payload, "utf8");
        return true;
    } catch (err) {
        console.error(`[P0_JOURNAL] ❌ Failed to write P0 emergency spool: ${err.message}`);
        try {
            const { notifyP0SpoolFailed } = require("./telemetryAlert");
            notifyP0SpoolFailed(repositoryName, "write_error", {
                errorMessage: err.message
            });
        } catch (_) {}
        return false;
    }
}

function ensureReceiptsTable(db) {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS p0_journal_receipts (
                entry_id TEXT PRIMARY KEY,
                repo TEXT NOT NULL,
                replayed_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_p0_journal_receipts_replayed ON p0_journal_receipts(replayed_at);
        `);
    } catch (_) {}
}

/**
 * Drains and replays spooled P0 events into SQLite with idempotency and atomic rewrite.
 * @param {object} db - Active better-sqlite3 database
 * @param {object} repositories - { commandEvent, sessionEvent, voiceEvent }
 * @returns {number} Count of successfully replayed items
 */
function drainP0Spool(db, repositories = {}) {
    if (!db || !db.open) return 0;
    const journalPath = resolveJournalPath();
    if (!fs.existsSync(journalPath)) return 0;

    let content = "";
    try {
        content = fs.readFileSync(journalPath, "utf8");
    } catch (err) {
        console.warn(`[P0_JOURNAL] ⚠️ Failed to read emergency journal for replay: ${err.message}`);
        return 0;
    }

    if (!content.trim()) {
        try { fs.unlinkSync(journalPath); } catch (_) {}
        return 0;
    }

    const lines = content.split("\n").filter(l => l.trim().length > 0);
    if (lines.length === 0) {
        try { fs.unlinkSync(journalPath); } catch (_) {}
        return 0;
    }

    ensureReceiptsTable(db);

    let replayed = 0;
    let skippedDuplicates = 0;
    const failedLines = [];

    const replayTx = db.transaction(() => {
        const checkReceiptStmt = db.prepare("SELECT 1 FROM p0_journal_receipts WHERE entry_id = ?");
        const insertReceiptStmt = db.prepare("INSERT INTO p0_journal_receipts (entry_id, repo, replayed_at) VALUES (?, ?, ?)");

        for (const line of lines) {
            let entry;
            try {
                entry = JSON.parse(line);
            } catch (_) {
                // Keep corrupt line for diagnostic inspection if needed, or flag for retention
                failedLines.push(line);
                continue;
            }

            const repoKey = entry.repo;
            const repo = repositories[repoKey] || repositories[repoKey?.replace(/_events?$/, "Event")];
            if (!repo || typeof repo._insertSingle !== "function") {
                failedLines.push(line);
                continue;
            }

            const entryId = entry.id || getStableEntryId(repoKey, entry.item);

            // Check if already replayed (idempotency receipt)
            const alreadyProcessed = checkReceiptStmt.get(entryId);
            if (alreadyProcessed) {
                skippedDuplicates++;
                continue;
            }

            try {
                repo._insertSingle(entry.item);
                insertReceiptStmt.run(entryId, repoKey, Date.now());
                replayed++;
            } catch (insertErr) {
                failedLines.push(line);
            }
        }
    });

    try {
        replayTx();

        // Atomic rewrite / unlink
        if (failedLines.length > 0) {
            const tmpPath = `${journalPath}.${process.pid}.${Date.now()}.tmp`;
            try {
                fs.writeFileSync(tmpPath, failedLines.join("\n") + "\n", "utf8");
                fs.renameSync(tmpPath, journalPath);
            } catch (rewriteErr) {
                console.error(`[P0_JOURNAL] ❌ Failed to rewrite emergency journal atomically: ${rewriteErr.message}`);
                try { fs.unlinkSync(tmpPath); } catch (_) {}
            }
        } else {
            try { fs.unlinkSync(journalPath); } catch (_) {}
        }

        if (replayed > 0 || skippedDuplicates > 0) {
            console.log(`[P0_JOURNAL] 🔄 Replayed ${replayed} spooled P0 event(s) (skipped duplicates: ${skippedDuplicates}) to SQLite.`);
        }
    } catch (txErr) {
        console.warn(`[P0_JOURNAL] ⚠️ Emergency journal replay transaction failed: ${txErr.message}`);
    }

    return replayed;
}

/**
 * Returns statistics about the emergency journal.
 */
function getP0JournalStats() {
    const journalPath = resolveJournalPath();
    if (!fs.existsSync(journalPath)) {
        return { exists: false, count: 0, sizeBytes: 0, path: journalPath };
    }
    try {
        const stat = fs.statSync(journalPath);
        const content = fs.readFileSync(journalPath, "utf8");
        const count = content.split("\n").filter(l => l.trim().length > 0).length;
        return {
            exists: true,
            count,
            sizeBytes: stat.size,
            path: journalPath
        };
    } catch (_) {
        return { exists: false, count: 0, sizeBytes: 0, path: journalPath };
    }
}

module.exports = {
    spoolP0Event,
    drainP0Spool,
    getP0JournalStats,
    getStableEntryId,
    resolveJournalPath,
    MAX_SPOOL_BYTES
};
