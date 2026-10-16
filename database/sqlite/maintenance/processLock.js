"use strict";

const fs = require("node:fs");
const path = require("node:path");

function isPidAlive(pid) {
    if (!pid || typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM indicates process is alive under another user; ESRCH indicates dead process
        return err.code === "EPERM";
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
        try {
            fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
            if (unlinkErr.code !== "ENOENT") {
                console.warn(`[PROCESS_LOCK] ⚠️ Could not remove stale lock during active check: ${unlinkErr.message}`);
            }
        }
        return { active: false, stale: true, oldPid: data.pid };
    } catch (readErr) {
        if (readErr.code === "ENOENT") {
            // Lock file was removed concurrently between existsSync and readFileSync
            return { active: false };
        }
        if (readErr instanceof SyntaxError) {
            // Corrupt JSON: log diagnostic and safely attempt cleanup of invalid lock payload
            console.warn(`[PROCESS_LOCK] ⚠️ Corrupt JSON in process lock file: ${readErr.message}`);
            try {
                fs.unlinkSync(lockPath);
            } catch (unlinkErr) {
                if (unlinkErr.code !== "ENOENT") {
                    console.warn(`[PROCESS_LOCK] ⚠️ Could not remove corrupt lock during active check: ${unlinkErr.message}`);
                }
            }
            return { active: false, stale: true, corrupt: true };
        }
        // EACCES, EPERM, EIO or unexpected filesystem error: Fail closed!
        // Never assume lock is free and never delete lock file on permission/IO errors.
        console.error(`[PROCESS_LOCK] 🚨 Failed to inspect process lock due to filesystem error: ${readErr.message}`);
        return {
            active: true,
            indeterminate: true,
            error: readErr.message,
            code: readErr.code
        };
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
        } catch (_err) {
            // Process is exiting synchronously; best-effort unlinking of lock files
        }
    }
    for (const restorePath of activeRestoreLocks) {
        try {
            const raw = fs.readFileSync(restorePath, "utf8");
            const data = JSON.parse(raw);
            if (data.pid === process.pid) fs.unlinkSync(restorePath);
        } catch (_err) {
            // Process is exiting synchronously; best-effort unlinking of restore lock files
        }
    }
});

function inspectAndReclaimProcessLock(lockPath) {
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
        if (readErr.code === "ENOENT") {
            return null;
        }
        if (readErr instanceof SyntaxError) {
            console.warn(`[PROCESS_LOCK] ⚠️ Corrupt JSON in process lock file (${readErr.message}), attempting reclamation`);
            try {
                fs.unlinkSync(lockPath);
            } catch (unlinkErr) {
                if (unlinkErr.code !== "ENOENT") {
                    console.warn(`[PROCESS_LOCK] ⚠️ Could not remove corrupt lock file: ${unlinkErr.message}`);
                }
            }
            return null;
        }
        // Permission or filesystem error: Fail closed! Do not delete file or reclaim.
        console.error(`[PROCESS_LOCK] 🚨 Lock file unreadable due to filesystem error (${readErr.message}); refusing to reclaim`);
        return { acquired: false, reason: "unreadable_lock", error: readErr.message };
    }
    return null;
}

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
        const reclaimResult = inspectAndReclaimProcessLock(lockPath);
        if (reclaimResult) return reclaimResult;

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
    } catch (err) {
        // Best effort release: lock file may have been removed concurrently or unreadable
        if (err.code !== "ENOENT") {
            console.warn(`[PROCESS_LOCK] ⚠️ Could not verify lock ownership on release: ${err.message}`);
        }
    }
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
        try {
            fs.unlinkSync(restorePath);
        } catch (unlinkErr) {
            if (unlinkErr.code !== "ENOENT") {
                console.warn(`[PROCESS_LOCK] ⚠️ Could not remove inactive restore lock: ${unlinkErr.message}`);
            }
        }
        return { active: false, stale: true };
    } catch (readErr) {
        if (readErr.code === "ENOENT") {
            return { active: false };
        }
        if (readErr instanceof SyntaxError) {
            console.warn(`[PROCESS_LOCK] ⚠️ Corrupt JSON in restore lock file: ${readErr.message}`);
            try {
                fs.unlinkSync(restorePath);
            } catch (unlinkErr) {
                if (unlinkErr.code !== "ENOENT") {
                    console.warn(`[PROCESS_LOCK] ⚠️ Could not remove corrupt restore lock: ${unlinkErr.message}`);
                }
            }
            return { active: false, stale: true, corrupt: true };
        }
        // EACCES, EPERM, EIO or unexpected filesystem error: Fail closed!
        console.error(`[PROCESS_LOCK] 🚨 Failed to inspect restore lock due to filesystem error: ${readErr.message}`);
        return {
            active: true,
            indeterminate: true,
            error: readErr.message,
            code: readErr.code
        };
    }
}

function inspectAndReclaimRestoreLock(restorePath) {
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
        if (readErr.code === "ENOENT") {
            return null;
        }
        if (readErr instanceof SyntaxError) {
            console.warn(`[PROCESS_LOCK] ⚠️ Corrupt JSON in restore lock file (${readErr.message}), attempting reclamation`);
            try {
                fs.unlinkSync(restorePath);
            } catch (unlinkErr) {
                if (unlinkErr.code !== "ENOENT") {
                    console.warn(`[PROCESS_LOCK] ⚠️ Could not remove corrupt restore lock file: ${unlinkErr.message}`);
                }
            }
            return null;
        }
        console.error(`[PROCESS_LOCK] 🚨 Restore lock file unreadable due to filesystem error (${readErr.message}); refusing to reclaim`);
        return { acquired: false, reason: "unreadable_restore_lock", error: readErr.message };
    }
    return null;
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
        const reclaimResult = inspectAndReclaimRestoreLock(restorePath);
        if (reclaimResult) return reclaimResult;

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
    } catch (err) {
        // Best effort release: lock file may have been removed concurrently or unreadable
        if (err.code !== "ENOENT") {
            console.warn(`[PROCESS_LOCK] ⚠️ Could not verify restore lock ownership on release: ${err.message}`);
        }
    }
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
