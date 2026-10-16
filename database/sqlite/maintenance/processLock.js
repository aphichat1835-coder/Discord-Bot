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

function _tryUnlinkLock(filePath, errorDesc) {
    try {
        fs.unlinkSync(filePath);
        return true;
    } catch (unlinkErr) {
        if (unlinkErr.code !== "ENOENT") {
            console.warn(`[PROCESS_LOCK] ⚠️ Could not remove ${errorDesc}: ${unlinkErr.message}`);
        }
        return false;
    }
}

function _handleCorruptLock(filePath, readErr, lockType) {
    console.warn(`[PROCESS_LOCK] ⚠️ Corrupt JSON in ${lockType} lock file: ${readErr.message}`);
    _tryUnlinkLock(filePath, `corrupt ${lockType} lock during active check`);
    return { active: false, stale: true, corrupt: true };
}

function _handleFilesystemError(readErr, lockType) {
    console.error(`[PROCESS_LOCK] 🚨 Failed to inspect ${lockType} lock due to filesystem error: ${readErr.message}`);
    return {
        active: true,
        indeterminate: true,
        error: readErr.message,
        code: readErr.code
    };
}

function _checkLockActiveState(lockPath, lockType, includeOldPid = false) {
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
        _tryUnlinkLock(lockPath, `stale ${lockType} lock during active check`);
        const result = { active: false, stale: true };
        if (includeOldPid) result.oldPid = data.pid;
        return result;
    } catch (readErr) {
        if (readErr.code === "ENOENT") {
            return { active: false };
        }
        if (readErr instanceof SyntaxError) {
            return _handleCorruptLock(lockPath, readErr, lockType);
        }
        return _handleFilesystemError(readErr, lockType);
    }
}

function isProcessLockActive(dbPath) {
    return _checkLockActiveState(getLockFilePath(dbPath), "process", true);
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

function _inspectAndReclaimLock(lockPath, activeSet, lockType, activeReason, unreadableReason) {
    try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const data = JSON.parse(raw);
        if (data.pid === process.pid) {
            activeSet.add(lockPath);
            return { acquired: true, pid: process.pid };
        }
        if (data.pid && isPidAlive(data.pid)) {
            return {
                acquired: false,
                pid: data.pid,
                createdAt: data.createdAt || null,
                reason: activeReason
            };
        }
        // Stale lock: PID is dead or invalid
        _tryUnlinkLock(lockPath, `stale ${lockType} lock file`);
        return null;
    } catch (readErr) {
        if (readErr.code === "ENOENT") {
            return null;
        }
        if (readErr instanceof SyntaxError) {
            console.warn(`[PROCESS_LOCK] ⚠️ Corrupt JSON in ${lockType} lock file (${readErr.message}), attempting reclamation`);
            _tryUnlinkLock(lockPath, `corrupt ${lockType} lock file`);
            return null;
        }
        // Permission or filesystem error: Fail closed! Do not delete file or reclaim.
        console.error(`[PROCESS_LOCK] 🚨 ${lockType} lock file unreadable due to filesystem error (${readErr.message}); refusing to reclaim`);
        return { acquired: false, reason: unreadableReason, error: readErr.message };
    }
}

function inspectAndReclaimProcessLock(lockPath) {
    return _inspectAndReclaimLock(lockPath, activeLocks, "process", "active_process", "unreadable_lock");
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
    return _checkLockActiveState(getRestoreLockFilePath(dbPath), "restore", false);
}

function inspectAndReclaimRestoreLock(restorePath) {
    return _inspectAndReclaimLock(restorePath, activeRestoreLocks, "restore", "active_restore", "unreadable_restore_lock");
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
