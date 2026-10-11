"use strict";

const VALID_CHECKPOINT_MODES = Object.freeze(new Set(["PASSIVE", "FULL", "RESTART", "TRUNCATE"]));

function runIncrementalVacuum(db, pages = 100) {
    if (!db) throw new TypeError("runIncrementalVacuum requires an active database");
    const autoVacuum = db.pragma("auto_vacuum", { simple: true });
    // auto_vacuum = 2 corresponds to INCREMENTAL
    if (autoVacuum === 2 || autoVacuum === "INCREMENTAL") {
        const clampedPages = Math.min(10000, Math.max(1, parseInt(pages, 10) || 100));
        db.pragma(`incremental_vacuum(${clampedPages})`);
        return { ok: true, pagesVacuumed: clampedPages };
    }
    return { ok: false, reason: "auto_vacuum_not_incremental", autoVacuum };
}

function checkpointWal(db, mode = "PASSIVE") {
    if (!db) throw new TypeError("checkpointWal requires an active database");
    const normalizedMode = String(mode || "PASSIVE").trim().toUpperCase();
    if (!VALID_CHECKPOINT_MODES.has(normalizedMode)) {
        return {
            ok: false,
            error: `Invalid checkpoint mode '${mode}'. Allowed modes: ${Array.from(VALID_CHECKPOINT_MODES).join(", ")}`
        };
    }
    try {
        const result = db.pragma(`wal_checkpoint(${normalizedMode})`);
        return { ok: true, result, mode: normalizedMode };
    } catch (err) {
        return { ok: false, error: err.message, mode: normalizedMode };
    }
}

module.exports = {
    VALID_CHECKPOINT_MODES,
    runIncrementalVacuum,
    checkpointWal
};
