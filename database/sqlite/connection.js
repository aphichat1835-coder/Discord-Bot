"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Database = require("better-sqlite3");
const { applyPragmas } = require("./pragmas");
const {
    acquireProcessLock,
    releaseProcessLock,
    isRestoreLockActive
} = require("./maintenance/processLock");

let activeDb = null;
let currentDbPath = null;

function resolveDbPath(customPath = null) {
    if (customPath) {
        if (customPath === ":memory:") return ":memory:";
        return path.resolve(customPath);
    }
    if (process.env.SQLITE_DB_PATH?.trim()) {
        const envPath = process.env.SQLITE_DB_PATH.trim();
        if (envPath === ":memory:") return ":memory:";
        return path.resolve(envPath);
    }
    // Auto-detection: If host has mounted a writable /persistent volume, use it automatically
    try {
        if (fs.existsSync("/persistent")) {
            fs.accessSync("/persistent", fs.constants.R_OK | fs.constants.W_OK);
            return path.resolve("/persistent", "discordbot.sqlite");
        }
    } catch (_err) {
        // Ignored: /persistent volume is optional or not mounted
    }
    // Fallback: dedicated data directory in workspace root (avoiding source code collisions)
    return path.resolve(process.cwd(), "data", "discordbot.sqlite");
}

function openMemoryDatabase(options) {
    const db = new Database(":memory:", {
        timeout: options.timeout || 5000,
        verbose: options.verbose || null
    });
    applyPragmas(db, { isNew: true });
    activeDb = db;
    currentDbPath = ":memory:";
    return activeDb;
}

function validateDatabaseFile(dbPath) {
    if (!fs.existsSync(dbPath)) return;

    let stats;
    try {
        stats = fs.statSync(dbPath);
    } catch (err) {
        const error = new Error(`[SQLITE] ❌ Database path cannot be inspected: ${dbPath} (${err.message})`);
        error.code = "SQLITE_PATH_INACCESSIBLE";
        throw error;
    }
    if (stats.isDirectory()) {
        const error = new Error(`[SQLITE] ❌ Database path is a directory, not a database file: ${dbPath}`);
        error.code = "SQLITE_PATH_IS_DIRECTORY";
        throw error;
    }

    try {
        fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
        const error = new Error(`[SQLITE] ❌ Database file exists but is not readable/writable: ${dbPath} (${err.message})`);
        error.code = "SQLITE_FILE_NOT_WRITABLE";
        throw error;
    }
}

function validateParentDirectory(requestedPath, options) {
    let dbPath = requestedPath;
    let parentDir = path.dirname(dbPath);

    try {
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.accessSync(parentDir, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
        const allowTemp = Boolean(options.allowTempFallback || process.env.SQLITE_ALLOW_TEMP_FALLBACK === "true");
        if (allowTemp) {
            console.warn(`[SQLITE] ⚠️ Parent directory unwritable (${parentDir}). Explicit fallback allowed, switching to temp directory.`);
            dbPath = path.resolve(os.tmpdir(), path.basename(dbPath));
            parentDir = path.dirname(dbPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }
            fs.accessSync(parentDir, fs.constants.R_OK | fs.constants.W_OK);
        } else {
            const error = new Error(`[SQLITE] ❌ Database parent directory is not readable/writable: ${parentDir} (${err.message})`);
            error.code = "SQLITE_DIR_NOT_WRITABLE";
            throw error;
        }
    }
    return dbPath;
}

function assertDatabaseLocks(dbPath) {
    const restoreLock = isRestoreLockActive(dbPath);
    if (restoreLock.active && restoreLock.pid !== process.pid) {
        const error = new Error(`[SQLITE] ❌ Database is currently locked for maintenance/restore by PID ${restoreLock.pid}`);
        error.code = "SQLITE_RESTORE_LOCKED";
        throw error;
    }

    const lockRes = acquireProcessLock(dbPath);
    if (!lockRes.acquired) {
        const error = new Error(`[SQLITE] ❌ Failed to acquire process lock: database is already locked by active process PID ${lockRes.pid} (${dbPath})`);
        error.code = "SQLITE_PROCESS_LOCKED";
        throw error;
    }
}

function openDatabase(options = {}) {
    if (activeDb) {
        return activeDb;
    }

    const requestedPath = resolveDbPath(options.path);
    if (requestedPath === ":memory:") {
        return openMemoryDatabase(options);
    }

    validateDatabaseFile(requestedPath);
    const dbPath = validateParentDirectory(requestedPath, options);
    assertDatabaseLocks(dbPath);

    const isNew = !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0;

    let db;
    try {
        db = new Database(dbPath, {
            fileMustExist: options.fileMustExist || false,
            timeout: options.timeout || 5000,
            verbose: options.verbose || null
        });
        applyPragmas(db, { isNew });
    } catch (err) {
        releaseProcessLock(dbPath);
        throw err;
    }

    activeDb = db;
    currentDbPath = dbPath;

    return activeDb;
}

function getDatabase() {
    if (!activeDb) {
        return openDatabase();
    }
    return activeDb;
}

function closeDatabase() {
    if (activeDb) {
        const pathToUnlock = currentDbPath;
        try {
            // WAL checkpoint truncate on clean shutdown
            try {
                activeDb.pragma("wal_checkpoint(TRUNCATE)");
            } catch (_) {}
            try {
                activeDb.close();
            } catch (err) {
                console.warn(`[SQLITE] ⚠️ Error closing active database: ${err.message}`);
            }
        } finally {
            if (pathToUnlock && pathToUnlock !== ":memory:") {
                releaseProcessLock(pathToUnlock);
            }
            activeDb = null;
            currentDbPath = null;
        }
    }
}

function isDatabaseOpen() {
    return Boolean(activeDb?.open);
}

function getCurrentDbPath() {
    return currentDbPath;
}

module.exports = {
    openDatabase,
    getDatabase,
    closeDatabase,
    isDatabaseOpen,
    getCurrentDbPath,
    resolveDbPath
};
