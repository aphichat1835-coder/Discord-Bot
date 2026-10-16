"use strict";

const fs = require("node:fs");
const path = require("node:path");

function isPidAlive(pid) {
    if (!pid || typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function getLockFilePath(dbPath) {
    return `${path.resolve(dbPath)}.lock`;
}

function getRestoreLockFilePath(dbPath) {
    return `${path.resolve(dbPath)}.restore.lock`;
}

function isProcessLockActive(dbPath) {
    const lockPath = getLockFilePath(dbPath);
    if (!fs.existsSync(lockPath)) return { active: false };

    try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const data = JSON.parse(raw);
        if (data.pid && isPidAlive(data.pid)) {
            return {
                active: true,
                pid: data.pid,
                createdAt: data.createdAt || null
            };
        }
        // Stale lock: PID is no longer alive
        try { fs.unlinkSync(lockPath); } catch (_) {}
        return { active: false, stale: true, oldPid: data.pid };
    } catch (_) {
        try { fs.unlinkSync(lockPath); } catch (_) {}
        return { active: false };
    }
}

function tryWriteLockFile(filePath, payload) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(payload), { flag: "wx" });
        return { success: true };
    } catch (err) {
        return { success: false, code: err.code, error: err.message };
    }
}

const activeLocks = new Set();
const activeRestoreLocks = new Set();

process.on("exit", () => {
    for (const lockPath of activeLocks) {
        try {
            const raw = fs.readFileSync(lockPath, "utf8");
            const data = JSON.parse(raw);
            if (data.pid === process.pid) fs.unlinkSync(lockPath);
        } catch (_) {
            // Ignore lock removal failure on process exit
        }
    }
    for (const restorePath of activeRestoreLocks) {
        try {
            const raw = fs.readFileSync(restorePath, "utf8");
            const data = JSON.parse(raw);
            if (data.pid === process.pid) fs.unlinkSync(restorePath);
        } catch (_) {
            // Ignore restore lock removal failure on process exit
        }
    }
});

function acquireProcessLock(dbPath) {
    const lockPath = getLockFilePath(dbPath);
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true });
    }

    const payload = {
        pid: process.pid,
        createdAt: Date.now()
    };

    // Attempt 1: Atomic exclusive create
    let writeRes = tryWriteLockFile(lockPath, payload);
    if (writeRes.success) {
        activeLocks.add(lockPath);
        return { acquired: true, pid: process.pid };
    }

    if (writeRes.code === "EEXIST") {
        // File exists, check if lock is active or stale
        try {
            const raw = fs.readFileSync(lockPath, "utf8");
            const data = JSON.parse(raw);
            if (data.pid === process.pid) {
                activeLocks.add(lockPath);
                return { acquired: true, pid: process.pid };
            }
            if (data.pid && isPidAlive(data.pid)) {
                return {
                    acquired: false,
                    pid: data.pid,
                    createdAt: data.createdAt || null,
                    reason: "active_process"
                };
            }
            // Stale lock: PID is dead or invalid
            try {
                fs.unlinkSync(lockPath);
            } catch (unlinkErr) {
                if (unlinkErr.code !== "ENOENT") {
                    console.warn(`[PROCESS_LOCK] ⚠️ Could not remove stale lock file: ${unlinkErr.message}`);
                }
            }
        } catch (readErr) {
            // Corrupt or unreadable lock file; remove it to allow reclamation
            try {
                fs.unlinkSync(lockPath);
            } catch (unlinkErr) {
                if (unlinkErr.code !== "ENOENT") {
                    console.warn(`[PROCESS_LOCK] ⚠️ Could not remove corrupt lock file: ${unlinkErr.message}`);
                }
            }
        }

        // Retry atomic exclusive create once after clearing stale lock
        writeRes = tryWriteLockFile(lockPath, payload);
        if (writeRes.success) {
            activeLocks.add(lockPath);
            return { acquired: true, pid: process.pid, reclaimedStale: true };
        }
    }

    return { acquired: false, error: writeRes.error || "Lock held or unavailable" };
}

function releaseProcessLock(dbPath) {
    if (!dbPath) return;
    const lockPath = getLockFilePath(dbPath);
    activeLocks.delete(lockPath);
    if (!fs.existsSync(lockPath)) return;

    try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const data = JSON.parse(raw);
        if (data.pid === process.pid) {
            fs.unlinkSync(lockPath);
        }
    } catch (_) {}
}

function isRestoreLockActive(dbPath) {
    const restorePath = getRestoreLockFilePath(dbPath);
    if (!fs.existsSync(restorePath)) return { active: false };

    try {
        const raw = fs.readFileSync(restorePath, "utf8");
        const data = JSON.parse(raw);
        if (data.pid && isPidAlive(data.pid)) {
            return {
                active: true,
                pid: data.pid,
                createdAt: data.createdAt || null
            };
        }
        try { fs.unlinkSync(restorePath); } catch { /* ignore lock file unlink error */ }
        return { active: false, stale: true };
    } catch {
        // Corrupted or unreadable lock file; clean up and treat lock as inactive
        try { fs.unlinkSync(restorePath); } catch { /* ignore lock file unlink error */ }
        return { active: false };
    }
}

function acquireRestoreLock(dbPath) {
    const restorePath = getRestoreLockFilePath(dbPath);
    const lockDir = path.dirname(restorePath);
    if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true });
    }

    const payload = {
        pid: process.pid,
        createdAt: Date.now()
    };

    // Attempt 1: Atomic exclusive create
    let writeRes = tryWriteLockFile(restorePath, payload);
    if (writeRes.success) {
        activeRestoreLocks.add(restorePath);
        return { acquired: true, pid: process.pid };
    }

    if (writeRes.code === "EEXIST") {
        try {
            const raw = fs.readFileSync(restorePath, "utf8");
            const data = JSON.parse(raw);
            if (data.pid === process.pid) {
                activeRestoreLocks.add(restorePath);
                return { acquired: true, pid: process.pid };
            }
            if (data.pid && isPidAlive(data.pid)) {
                return {
                    acquired: false,
                    pid: data.pid,
                    createdAt: data.createdAt || null,
                    reason: "active_restore"
                };
            }
            try {
                fs.unlinkSync(restorePath);
            } catch (unlinkErr) {
                if (unlinkErr.code !== "ENOENT") {
                    console.warn(`[PROCESS_LOCK] ⚠️ Could not remove stale restore lock file: ${unlinkErr.message}`);
                }
            }
        } catch (readErr) {
            // Corrupt or unreadable restore lock file; remove it to allow reclamation
            try {
                fs.unlinkSync(restorePath);
            } catch (unlinkErr) {
                if (unlinkErr.code !== "ENOENT") {
                    console.warn(`[PROCESS_LOCK] ⚠️ Could not remove corrupt restore lock file: ${unlinkErr.message}`);
                }
            }
        }

        writeRes = tryWriteLockFile(restorePath, payload);
        if (writeRes.success) {
            activeRestoreLocks.add(restorePath);
            return { acquired: true, pid: process.pid, reclaimedStale: true };
        }
    }

    return { acquired: false, error: writeRes.error || "Restore lock held or unavailable" };
}

function releaseRestoreLock(dbPath) {
    if (!dbPath) return;
    const restorePath = getRestoreLockFilePath(dbPath);
    activeRestoreLocks.delete(restorePath);
    if (!fs.existsSync(restorePath)) return;

    try {
        const raw = fs.readFileSync(restorePath, "utf8");
        const data = JSON.parse(raw);
        if (data.pid === process.pid) {
            fs.unlinkSync(restorePath);
        }
    } catch (_) {}
}

module.exports = {
    isPidAlive,
    getLockFilePath,
    getRestoreLockFilePath,
    isProcessLockActive,
    acquireProcessLock,
    releaseProcessLock,
    isRestoreLockActive,
    acquireRestoreLock,
    releaseRestoreLock
};
