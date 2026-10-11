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
        return { acquired: true, pid: process.pid };
    }

    if (writeRes.code === "EEXIST") {
        // File exists, check if lock is active or stale
        try {
            const raw = fs.readFileSync(lockPath, "utf8");
            const data = JSON.parse(raw);
            if (data.pid === process.pid) {
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
            try { fs.unlinkSync(lockPath); } catch (_) {}
        } catch (_) {
            try { fs.unlinkSync(lockPath); } catch (_) {}
        }

        // Retry atomic exclusive create once after clearing stale lock
        writeRes = tryWriteLockFile(lockPath, payload);
        if (writeRes.success) {
            return { acquired: true, pid: process.pid, reclaimedStale: true };
        }
    }

    return { acquired: false, error: writeRes.error || "Lock held or unavailable" };
}

function releaseProcessLock(dbPath) {
    if (!dbPath) return;
    const lockPath = getLockFilePath(dbPath);
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
        try { fs.unlinkSync(restorePath); } catch (_) {}
        return { active: false, stale: true };
    } catch (_) {
        try { fs.unlinkSync(restorePath); } catch (_) {}
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
        return { acquired: true, pid: process.pid };
    }

    if (writeRes.code === "EEXIST") {
        try {
            const raw = fs.readFileSync(restorePath, "utf8");
            const data = JSON.parse(raw);
            if (data.pid === process.pid) {
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
            try { fs.unlinkSync(restorePath); } catch (_) {}
        } catch (_) {
            try { fs.unlinkSync(restorePath); } catch (_) {}
        }

        writeRes = tryWriteLockFile(restorePath, payload);
        if (writeRes.success) {
            return { acquired: true, pid: process.pid, reclaimedStale: true };
        }
    }

    return { acquired: false, error: writeRes.error || "Restore lock held or unavailable" };
}

function releaseRestoreLock(dbPath) {
    if (!dbPath) return;
    const restorePath = getRestoreLockFilePath(dbPath);
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
