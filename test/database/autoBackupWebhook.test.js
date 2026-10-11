"use strict";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const { createBackup, computeFileSha256 } = require("../../database/sqlite/maintenance/backup");

describe("Auto-Backup Metadata & Webhook Safety Suite", () => {
    let db;
    let tempDbFile;
    let testBackupDir;

    before(() => {
        const scratchDir = path.join(__dirname, "scratch-backup-test");
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
        fs.mkdirSync(scratchDir, { recursive: true });

        tempDbFile = path.join(scratchDir, "test-source.sqlite");
        testBackupDir = path.join(scratchDir, "test-backups");
        fs.mkdirSync(testBackupDir, { recursive: true });

        db = new Database(tempDbFile);
        runMigrations(db, { backupDir: testBackupDir });
    });

    after(() => {
        if (db) db.close();
        const scratchDir = path.join(__dirname, "scratch-backup-test");
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    });

    test("createBackup computes valid SHA-256 and returns required operational metadata", async () => {
        // Add sample data so the file has substance
        const now = Date.now();
        db.prepare("INSERT INTO cache_entries (namespace, cache_key, payload_json, created_at, updated_at, last_accessed_at) VALUES ('test', 'k1', '{\"val\":123}', ?, ?, ?)").run(now, now, now);

        const backupRes = await createBackup(db, { backupDir: testBackupDir, maxBackups: 2 });

        assert.equal(backupRes.ok, true);
        assert.ok(backupRes.filename.startsWith("sqlite_backup_"));
        assert.ok(backupRes.filename.endsWith(".sqlite"));
        assert.ok(fs.existsSync(backupRes.path));

        // SHA-256 Checksum assertion: exactly 64 hexadecimal characters
        assert.equal(typeof backupRes.sha256, "string");
        assert.equal(backupRes.sha256.length, 64);
        assert.match(backupRes.sha256, /^[a-f0-9]{64}$/i);

        // Verify independent checksum
        const directHash = crypto.createHash("sha256").update(fs.readFileSync(backupRes.path)).digest("hex");
        assert.equal(backupRes.sha256, directHash);

        // Duration in milliseconds must be a non-negative number
        assert.equal(typeof backupRes.durationMs, "number");
        assert.ok(backupRes.durationMs >= 0);

        // Size in MB
        assert.equal(typeof backupRes.sizeMb, "number");
    });

    test("computeFileSha256 correctly hashes arbitrary files", async () => {
        const dummyFile = path.join(testBackupDir, "dummy-test.txt");
        fs.writeFileSync(dummyFile, "Hello World from DiscordBot SQLite Backup Test!");

        const computed = await computeFileSha256(dummyFile);
        const expected = crypto.createHash("sha256").update("Hello World from DiscordBot SQLite Backup Test!").digest("hex");

        assert.equal(computed, expected);
        fs.unlinkSync(dummyFile);
    });
});
