"use strict";

/**
 * database/sqlite/pragmas.js
 * Applies performance, integrity, and safety PRAGMAs to an active SQLite connection.
 */
function applyPragmas(db, options = {}) {
    if (!db || typeof db.pragma !== "function") {
        throw new TypeError("applyPragmas requires a valid Database instance");
    }

    // 1. Incremental auto-vacuum to prevent file bloat without full blocking VACUUM
    // Note: MUST be issued before journal_mode or any write that commits the database header page.
    if (options.isNew) {
        db.pragma("auto_vacuum = INCREMENTAL");
    }

    // 2. WAL mode for concurrent non-blocking reads and high-throughput writes
    db.pragma("journal_mode = WAL");

    // 3. NORMAL synchronous is safe in WAL mode and drastically cuts disk sync latency
    db.pragma("synchronous = NORMAL");

    // 4. Strict foreign key enforcement
    db.pragma("foreign_keys = ON");

    // 5. Busy timeout (5000ms) to gracefully handle locks instead of throwing SQLITE_BUSY
    db.pragma("busy_timeout = 5000");

    // 6. Store temp tables and indices in memory
    db.pragma("temp_store = MEMORY");

    // 7. Page cache size (approx 64 MB: -64000 KB)
    db.pragma("cache_size = -64000");

    // 8. Memory-mapped I/O size for fast sequential reads
    db.pragma("mmap_size = 268435456");

    return {
        journalMode: db.pragma("journal_mode", { simple: true }),
        synchronous: db.pragma("synchronous", { simple: true }),
        foreignKeys: db.pragma("foreign_keys", { simple: true }),
        autoVacuum: db.pragma("auto_vacuum", { simple: true }),
        busyTimeout: db.pragma("busy_timeout", { simple: true }),
        userVersion: db.pragma("user_version", { simple: true })
    };
}

module.exports = { applyPragmas };
