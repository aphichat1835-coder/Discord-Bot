"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const { runEmergencyTrim } = require("../../database/sqlite/maintenance/emergencyTrim");
const { createBackup } = require("../../database/sqlite/maintenance/backup");
const DmNotificationRepository = require("../../database/sqlite/repositories/core/DmNotificationRepository");
const { isFatalAuthError } = require("../../discord/quest/core/questSession");
const { stopScheduledJob } = require("../../discord/quest/core/runnerManager");
const { decryptToken, encryptToken } = require("../../discord/quest/core/tokenCrypto");
const scheduler = require("../../database/sqlite/maintenance/scheduler");
const { closeDatabase, isDatabaseOpen } = require("../../database/sqlite/connection");

describe("Deep Audit Hardening Suite", () => {
    let testDb;
    let tempDir;

    before(() => {
        tempDir = path.join(__dirname, "temp-audit-hardening-" + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });

        testDb = new Database(path.join(tempDir, "test.sqlite"));
        testDb.pragma("journal_mode = WAL");
        testDb.pragma("foreign_keys = ON");
        testDb.pragma("auto_vacuum = INCREMENTAL");
        runMigrations(testDb);
    });

    after(() => {
        if (testDb) {
            try { testDb.close(); } catch (_) {}
        }
        if (fs.existsSync(tempDir)) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    test("1. Migration Runner executes PRAGMA user_version after transaction commit", () => {
        const userVersion = testDb.pragma("user_version", { simple: true });
        assert.equal(userVersion, 9, "user_version should be version 9 after migration");
    });

    test("2. Emergency Trim invokes incremental vacuum and cleans up without errors", async () => {
        const result = await runEmergencyTrim(testDb, { reason: "test_trim", actor: "audit-test" });
        assert.ok(result);
        assert.equal(typeof result.isResolved, "boolean");
        assert.equal(typeof result.freedMb, "number");
    });

    test("3. Backup cleans up target file if backup fails mid-flight", async () => {
        const fakeDb = {
            name: "fake.sqlite",
            backup: async () => {
                // Simulate an I/O error mid-write
                throw new Error("Disk quota exceeded during backup stream");
            }
        };

        const backupDir = path.join(tempDir, "backups");
        fs.mkdirSync(backupDir, { recursive: true });
        const targetPath = path.join(backupDir, "failed_backup.sqlite");
        fs.writeFileSync(targetPath, "partial_corrupted_data");

        await assert.rejects(
            async () => {
                await createBackup(fakeDb, { backupDir, filename: "failed_backup.sqlite", skipSpaceCheck: true });
            },
            /การสำรองข้อมูล SQLite ล้มเหลวระหว่างเขียนไฟล์/
        );

        assert.equal(fs.existsSync(targetPath), false, "Partial backup file must be unlinked on failure");
    });

    test("4. DmNotificationRepository safely handles empty $in arrays without syntax error", () => {
        const repo = new DmNotificationRepository(testDb);

        // find with empty status.$in should return empty array
        const findStatus = repo.find({ status: { $in: [] } });
        assert.deepEqual(findStatus, []);

        // find with empty category.$in should return empty array
        const findCat = repo.find({ category: { $in: [] } });
        assert.deepEqual(findCat, []);

        // deleteMany with empty category.$in should return 0 deleted count without syntax error
        const delCat = repo.deleteMany({ category: { $in: [] } });
        assert.deepEqual(delCat, { deletedCount: 0 });

        // deleteMany with empty status.$in should return 0 deleted count
        const delStatus = repo.deleteMany({ status: { $in: [] } });
        assert.deepEqual(delStatus, { deletedCount: 0 });
    });

    test("5. Quest Session recognizes TOKEN_QUARANTINED as a fatal auth error", () => {
        const normalError = new Error("Gateway timeout");
        assert.equal(isFatalAuthError(normalError), false);

        const quarantinedError = Object.assign(new Error("Token is currently quarantined"), {
            code: "TOKEN_QUARANTINED"
        });
        assert.equal(isFatalAuthError(quarantinedError), true, "TOKEN_QUARANTINED must be fatal auth error");
    });

    test("6. Token Crypto decryptToken catches native crypto errors and throws structured message", () => {
        const validEncrypted = encryptToken("discord_token_test", "owner1", "acc1");
        // Tamper with ciphertext
        const tampered = { ...validEncrypted, ciphertext: Buffer.from("corrupted_payload").toString("base64") };

        assert.throws(
            () => decryptToken(tampered, "owner1", "acc1"),
            /Token decryption failed/
        );
    });

    test("7. Scheduler provides hasRunningTasks and drainSchedulerTasks", async () => {
        assert.equal(typeof scheduler.hasRunningTasks, "function");
        assert.equal(typeof scheduler.drainSchedulerTasks, "function");

        const drained = await scheduler.drainSchedulerTasks(100);
        assert.equal(drained, true);
    });

    test("8. Connection closeDatabase handles active close safely without unhandled throws", () => {
        assert.doesNotThrow(() => {
            closeDatabase();
        });
    });
});
