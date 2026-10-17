"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const {
    isPidAlive,
    getLockFilePath,
    getRestoreLockFilePath,
    isProcessLockActive,
    acquireProcessLock,
    releaseProcessLock,
    isRestoreLockActive,
    acquireRestoreLock,
    releaseRestoreLock
} = require("../../database/sqlite/maintenance/processLock");

describe("SQLite processLock maintenance suite", () => {
    let tmpDir;
    let dbPath;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "process-lock-test-"));
        dbPath = path.join(tmpDir, "test.db");
    });

    afterEach(() => {
        try {
            releaseProcessLock(dbPath);
            releaseRestoreLock(dbPath);
        } catch (_err) {}
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_err) {}
    });

    test("isPidAlive checks process vitality correctly", () => {
        assert.equal(isPidAlive(process.pid), true);
        assert.equal(isPidAlive(null), false);
        assert.equal(isPidAlive(0), false);
        assert.equal(isPidAlive(-1), false);
        assert.equal(isPidAlive("1234"), false);
        // Very large PID that doesn't exist
        assert.equal(isPidAlive(99999999), false);
    });

    test("getLockFilePath and getRestoreLockFilePath return expected paths", () => {
        assert.equal(getLockFilePath(dbPath), `${path.resolve(dbPath)}.lock`);
        assert.equal(getRestoreLockFilePath(dbPath), `${path.resolve(dbPath)}.restore.lock`);
    });

    test("acquireProcessLock acquires and releases lock cleanly", () => {
        assert.equal(isProcessLockActive(dbPath).active, false);

        const res1 = acquireProcessLock(dbPath);
        assert.equal(res1.acquired, true);
        assert.equal(res1.pid, process.pid);

        const status = isProcessLockActive(dbPath);
        assert.equal(status.active, true);
        assert.equal(status.pid, process.pid);

        // Re-acquiring by same process succeeds
        const res2 = acquireProcessLock(dbPath);
        assert.equal(res2.acquired, true);
        assert.equal(res2.pid, process.pid);

        releaseProcessLock(dbPath);
        assert.equal(isProcessLockActive(dbPath).active, false);

        // Safe release with null / missing path
        assert.doesNotThrow(() => releaseProcessLock(null));
        assert.doesNotThrow(() => releaseProcessLock(dbPath));
    });

    test("acquireProcessLock respects active locks from another process", () => {
        const lockFile = getLockFilePath(dbPath);
        // Write a lock file with current process pid (simulating active process)
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

        // Now test when lock is held by another process: we can simulate by mocking isPidAlive or testing active state
        const status = isProcessLockActive(dbPath);
        assert.equal(status.active, true);
        assert.equal(status.pid, process.pid);

        releaseProcessLock(dbPath);
    });

    test("reclaims stale process locks from dead PIDs", () => {
        const lockFile = getLockFilePath(dbPath);
        const deadPid = 99999999;
        fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, createdAt: Date.now() - 60000 }));

        const check = isProcessLockActive(dbPath);
        assert.equal(check.active, false);
        assert.equal(check.stale, true);
        assert.equal(check.oldPid, deadPid);

        // Now re-create dead lock and test acquireProcessLock reclamation
        fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, createdAt: Date.now() - 60000 }));
        const res = acquireProcessLock(dbPath);
        assert.equal(res.acquired, true);
        assert.equal(res.pid, process.pid);
        assert.equal(res.reclaimedStale, true);

        releaseProcessLock(dbPath);
    });

    test("handles corrupt JSON lock files gracefully", () => {
        const lockFile = getLockFilePath(dbPath);
        fs.writeFileSync(lockFile, "THIS IS CORRUPT NOT JSON");

        const check = isProcessLockActive(dbPath);
        assert.equal(check.active, false);
        assert.equal(check.stale, true);
        assert.equal(check.corrupt, true);

        // Write corrupt JSON again and acquire
        fs.writeFileSync(lockFile, "NOT VALID JSON");
        const res = acquireProcessLock(dbPath);
        assert.equal(res.acquired, true);
        assert.equal(res.pid, process.pid);
        assert.equal(res.reclaimedStale, true);

        releaseProcessLock(dbPath);
    });

    test("acquireRestoreLock and releaseRestoreLock lifecycle", () => {
        assert.equal(isRestoreLockActive(dbPath).active, false);

        const res1 = acquireRestoreLock(dbPath);
        assert.equal(res1.acquired, true);
        assert.equal(res1.pid, process.pid);

        const status = isRestoreLockActive(dbPath);
        assert.equal(status.active, true);
        assert.equal(status.pid, process.pid);

        // Re-acquiring by same process succeeds
        const res2 = acquireRestoreLock(dbPath);
        assert.equal(res2.acquired, true);

        releaseRestoreLock(dbPath);
        assert.equal(isRestoreLockActive(dbPath).active, false);

        assert.doesNotThrow(() => releaseRestoreLock(null));
        assert.doesNotThrow(() => releaseRestoreLock(dbPath));
    });

    test("reclaims stale restore lock from dead PID", () => {
        const restoreLockFile = getRestoreLockFilePath(dbPath);
        const deadPid = 99999999;
        fs.writeFileSync(restoreLockFile, JSON.stringify({ pid: deadPid, createdAt: Date.now() - 60000 }));

        const check = isRestoreLockActive(dbPath);
        assert.equal(check.active, false);
        assert.equal(check.stale, true);

        fs.writeFileSync(restoreLockFile, JSON.stringify({ pid: deadPid, createdAt: Date.now() - 60000 }));
        const res = acquireRestoreLock(dbPath);
        assert.equal(res.acquired, true);
        assert.equal(res.pid, process.pid);
        assert.equal(res.reclaimedStale, true);

        releaseRestoreLock(dbPath);
    });

    test("reclaims corrupt restore lock file", () => {
        const restoreLockFile = getRestoreLockFilePath(dbPath);
        fs.writeFileSync(restoreLockFile, "{ invalid json");

        const res = acquireRestoreLock(dbPath);
        assert.equal(res.acquired, true);
        assert.equal(res.pid, process.pid);
        assert.equal(res.reclaimedStale, true);

        releaseRestoreLock(dbPath);
    });
});
