"use strict";

const fs = require("node:fs");
const path = require("node:path");
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
    if (process.env.SQLITE_DB_PATH && process.env.SQLITE_DB_PATH.trim()) {
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
    } catch (_) {}
    // Fallback: dedicated data directory in workspace root (avoiding source code collisions)
    return path.resolve(process.cwd(), "data", "discordbot.sqlite");
}

function openDatabase(options = {}) {
    if (activeDb) {
        return activeDb;
    }

    const dbPath = resolveDbPath(options.path);

    if (dbPath === ":memory:") {
        const db = new Database(":memory:", {
            timeout: options.timeout || 5000,
            verbose: options.verbose || null
        });
        applyPragmas(db, { isNew: true });
        activeDb = db;
        currentDbPath = ":memory:";
        return activeDb;
    }

    const restoreLock = isRestoreLockActive(dbPath);
    if (restoreLock.active && restoreLock.pid !== process.pid) {
        throw new Error(`[SQLITE] ❌ Database is currently locked for maintenance/restore by PID ${restoreLock.pid}`);
    }

    const parentDir = path.dirname(dbPath);

    // Ensure parent directory exists and is writable
    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
    }

    try {
        fs.accessSync(parentDir, fs.constants.R_OK | fs.constants.W_OK);
        if (fs.existsSync(dbPath)) {
            fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
        }
    } catch (err) {
        throw new Error(`[SQLITE] ❌ Database target or parent directory is not readable/writable: ${parentDir} (${err.message})`);
    }

    // Atomic Process Lock: ensure no other bot process holds lock before opening
    const lockRes = acquireProcessLock(dbPath);
    if (!lockRes.acquired) {
        throw new Error(`[SQLITE] ❌ Failed to acquire process lock: database is already locked by active process PID ${lockRes.pid} (${dbPath})`);
    }

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
    return Boolean(activeDb && activeDb.open);
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
