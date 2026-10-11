"use strict";

const fs = require("node:fs");
const path = require("node:path");

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

        // Check journal file size limit to prevent runaway disk usage
        if (fs.existsSync(journalPath)) {
            const stat = fs.statSync(journalPath);
            if (stat.size >= MAX_SPOOL_BYTES) {
                console.error(`[P0_JOURNAL] ⚠️ Emergency journal reached size limit (${stat.size} bytes >= ${MAX_SPOOL_BYTES}); dropping oldest entries is avoided, rejecting new spool.`);
                return false;
            }
        }

        const payload = JSON.stringify({
            repo: repositoryName,
            item,
            spooledAt: Date.now()
        }) + "\n";

        fs.appendFileSync(journalPath, payload, "utf8");
        return true;
    } catch (err) {
        console.error(`[P0_JOURNAL] ❌ Failed to write P0 emergency spool: ${err.message}`);
        return false;
    }
}

/**
 * Drains and replays spooled P0 events into SQLite when the database is healthy.
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

    let replayed = 0;
    const failedLines = [];

    const replayTx = db.transaction(() => {
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                const repoKey = entry.repo;
                const repo = repositories[repoKey] || repositories[repoKey.replace(/_events?$/, "Event")];
                if (repo && typeof repo._insertSingle === "function") {
                    repo._insertSingle(entry.item);
                    replayed++;
                } else {
                    failedLines.push(line);
                }
            } catch (parseOrInsertErr) {
                failedLines.push(line);
            }
        }
    });

    try {
        replayTx();
        if (failedLines.length > 0) {
            // Write back any un-replayed lines
            fs.writeFileSync(journalPath, failedLines.join("\n") + "\n", "utf8");
        } else {
            // All drained successfully, remove journal
            fs.unlinkSync(journalPath);
        }
        if (replayed > 0) {
            console.log(`[P0_JOURNAL] 🔄 Replayed ${replayed} spooled P0 event(s) to SQLite.`);
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
    resolveJournalPath
};
