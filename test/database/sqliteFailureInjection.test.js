"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
    openDatabase,
    closeDatabase,
    resolveDbPath,
    getCurrentDbPath,
    isDatabaseOpen
} = require("../../database/sqlite/connection");
const {
    acquireProcessLock,
    releaseProcessLock,
    acquireRestoreLock,
    releaseRestoreLock
} = require("../../database/sqlite/maintenance/processLock");

test("SQLite Failure Injection & Strict Path Enforcement Suite", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-fail-test-"));

    t.after(() => {
        closeDatabase();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test("1. Explicit SQLITE_DB_PATH unwritable fails fast without temp fallback", () => {
        closeDatabase();
        const nonExistentDeepPath = "/root/prohibited_dir_never_exist_12345/test.sqlite";

        assert.throws(
            () => {
                openDatabase({ path: nonExistentDeepPath });
            },
            (err) => {
                assert.equal(err.code, "SQLITE_DIR_NOT_WRITABLE");
                assert.ok(!err.message.includes("password"));
                return true;
            },
            "Should fail fast with SQLITE_DIR_NOT_WRITABLE when parent dir is prohibited"
        );

        // Verification: Must NOT open temp DB silently
        assert.equal(getCurrentDbPath(), null, "getCurrentDbPath must remain null on failure");
        assert.equal(isDatabaseOpen(), false, "Database must not be open");
    });

    await t.test("2. Path is a directory instead of a file throws SQLITE_PATH_IS_DIRECTORY", () => {
        closeDatabase();
        const dirPath = path.join(tempDir, "directory_as_db");
        fs.mkdirSync(dirPath, { recursive: true });

        assert.throws(
            () => {
                openDatabase({ path: dirPath });
            },
            (err) => {
                assert.equal(err.code, "SQLITE_PATH_IS_DIRECTORY");
                return true;
            },
            "Should throw SQLITE_PATH_IS_DIRECTORY"
        );

        assert.equal(getCurrentDbPath(), null);
    });

    await t.test("3. Existing database file without write permissions throws SQLITE_FILE_NOT_WRITABLE", () => {
        closeDatabase();
        const readOnlyDbFile = path.join(tempDir, "readonly.sqlite");
        fs.writeFileSync(readOnlyDbFile, "SQLite format 3\0");
        fs.chmodSync(readOnlyDbFile, 0o444);

        try {
            assert.throws(
                () => {
                    openDatabase({ path: readOnlyDbFile });
                },
                (err) => {
                    assert.equal(err.code, "SQLITE_FILE_NOT_WRITABLE");
                    return true;
                },
                "Should fail fast when file is not writable"
            );
        } finally {
            // Restore write permissions for cleanup
            fs.chmodSync(readOnlyDbFile, 0o666);
        }
    });

    await t.test("4. :memory: database opens successfully without touching filesystem", () => {
        closeDatabase();
        const db = openDatabase({ path: ":memory:" });
        assert.ok(db.open, "In-memory database should be open");
        assert.equal(getCurrentDbPath(), ":memory:");
        assert.equal(isDatabaseOpen(), true);

        // Tables can be created and queried in memory
        db.exec("CREATE TABLE mem_test (id INTEGER PRIMARY KEY, name TEXT);");
        db.prepare("INSERT INTO mem_test (name) VALUES (?)").run("testing");
        const row = db.prepare("SELECT name FROM mem_test WHERE id = 1").get();
        assert.equal(row.name, "testing");

        closeDatabase();
        assert.equal(isDatabaseOpen(), false);
        assert.equal(getCurrentDbPath(), null);
    });

    await t.test("5. resolveDbPath handles explicit path, :memory:, and persistent volume detection", () => {
        // Memory
        assert.equal(resolveDbPath(":memory:"), ":memory:");

        // Explicit custom path
        const custom = path.join(tempDir, "custom.sqlite");
        assert.equal(resolveDbPath(custom), path.resolve(custom));

        // When no persistent volume exists, defaults to data/discordbot.sqlite
        const origPersistent = fs.existsSync("/persistent");
        if (!origPersistent) {
            const resolved = resolveDbPath();
            assert.equal(resolved, path.resolve(process.cwd(), "data", "discordbot.sqlite"));
        }
    });

    await t.test("6. Active restore lock by another PID blocks openDatabase with SQLITE_RESTORE_LOCKED", () => {
        closeDatabase();
        const targetDb = path.join(tempDir, "restore_locked.sqlite");
        const otherPid = process.pid + 99999;

        // Write restore lock file simulating an active process doing restore
        const restoreLockFile = `${targetDb}.restore.lock`;
        fs.writeFileSync(restoreLockFile, JSON.stringify({ pid: otherPid, createdAt: Date.now() }));

        const origKill = process.kill;
        process.kill = (pid, signal) => {
            if (pid === otherPid && signal === 0) return true;
            return origKill.call(process, pid, signal);
        };

        try {
            assert.throws(
                () => {
                    openDatabase({ path: targetDb });
                },
                (err) => {
                    assert.equal(err.code, "SQLITE_RESTORE_LOCKED");
                    return true;
                },
                "Should block when restore lock is held by another process"
            );
        } finally {
            process.kill = origKill;
            try { fs.unlinkSync(restoreLockFile); } catch (_) {}
        }
    });

    await t.test("7. Active process lock by another PID blocks openDatabase with SQLITE_PROCESS_LOCKED", () => {
        closeDatabase();
        const targetDb = path.join(tempDir, "process_locked.sqlite");
        const otherPid = process.pid + 88888;

        // Manually write lock file simulating an active process
        const lockFile = `${targetDb}.lock`;
        fs.writeFileSync(lockFile, JSON.stringify({ pid: otherPid, acquiredAt: Date.now() }));

        // Mock process.kill to treat otherPid as alive
        const origKill = process.kill;
        process.kill = (pid, signal) => {
            if (pid === otherPid && signal === 0) return true;
            return origKill.call(process, pid, signal);
        };

        try {
            assert.throws(
                () => {
                    openDatabase({ path: targetDb });
                },
                (err) => {
                    assert.equal(err.code, "SQLITE_PROCESS_LOCKED");
                    return true;
                },
                "Should throw SQLITE_PROCESS_LOCKED when lock file is active"
            );
        } finally {
            process.kill = origKill;
            try { fs.unlinkSync(lockFile); } catch (_) {}
        }
    });

    await t.test("8. Process lock is cleanly released when opening fails", () => {
        closeDatabase();
        const targetDb = path.join(tempDir, "fail_open.sqlite");
        // Create an un-parseable corrupt file that better-sqlite3 cannot open
        fs.writeFileSync(targetDb, "INVALID NOT SQLITE HEADER");

        assert.throws(() => {
            openDatabase({ path: targetDb });
        });

        const lockFile = `${targetDb}.lock`;
        assert.equal(fs.existsSync(lockFile), false, "Process lock file must be released after open failure");
        assert.equal(getCurrentDbPath(), null);
    });
});
