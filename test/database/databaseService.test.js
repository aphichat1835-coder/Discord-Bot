"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { openDatabase, closeDatabase } = require("../../database/sqlite/connection");
const databaseService = require("../../database/services/databaseService");

test("DatabaseService Comprehensive Suite", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-svc-test-"));
    const testDbPath = path.join(tempDir, "test.sqlite");

    process.env.SQLITE_DB_PATH = testDbPath;
    process.env.SQLITE_BACKUP_DIR = path.join(tempDir, "backups");

    t.after(() => {
        closeDatabase();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test("initializes test db and runs migrations", () => {
        const db = openDatabase({ path: testDbPath });
        assert.ok(db.open);
        const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
        runMigrations(db, { migrationsDir: path.resolve(__dirname, "../../database/sqlite/migrations") });
    });

    await t.test("getDatabaseOverview returns combined SQLite & MongoDB metrics", async () => {
        const overview = await databaseService.getDatabaseOverview();
        assert.ok(overview.databases);
        assert.ok(overview.databases.sqlite);
        assert.ok(overview.databases.mongodb);

        const sq = overview.databases.sqlite;
        assert.equal(sq.status, "ok");
        assert.equal(typeof sq.footprintMb, "number");
        assert.equal(typeof sq.hardLimitMb, "number");
        assert.ok(sq.records);
        assert.equal(typeof sq.records.total, "number");
        assert.equal(typeof sq.records.core, "number");
        assert.equal(typeof sq.records.cache, "number");
        assert.equal(typeof sq.records.history, "number");
        assert.equal(typeof sq.records.temp, "number");

        const mg = overview.databases.mongodb;
        assert.equal(typeof mg.connected, "boolean");
        assert.equal(typeof mg.modelsCount, "number");
    });

    await t.test("getSqliteDetailedStatus returns categories and storage breakdown", async () => {
        const details = await databaseService.getSqliteDetailedStatus();
        assert.equal(details.open, true);
        assert.ok(details.pragmas);
        assert.equal(details.pragmas.journalMode.toLowerCase(), "wal");
        assert.equal(details.pragmas.foreignKeys, true);

        assert.ok(details.categories);
        assert.ok(details.categories.core);
        assert.ok(details.categories.temporary);
        assert.ok(details.categories.history);
        assert.ok(details.categories.cache);

        // Core tables presence
        assert.ok(details.categories.core.tables.quest_logs);
        assert.ok(details.categories.core.tables.scheduled_runners);
        assert.ok(details.categories.core.tables.dm_notifications);
        assert.ok(details.categories.core.tables.verification_recovery);

        // Storage metrics
        assert.ok(details.storage);
        assert.equal(typeof details.storage.totalMb, "number");
        assert.equal(details.storage.limits.hardMb, 4096);
    });

    await t.test("executeSqliteAction handles integrity, vacuum, checkpoint, and backup", async () => {
        // 1. Integrity check
        const intRes = await databaseService.executeSqliteAction("integrity");
        assert.equal(intRes.ok, true);
        assert.match(intRes.message, /Integrity/);

        // 2. Checkpoint
        const chkRes = await databaseService.executeSqliteAction("checkpoint");
        assert.equal(chkRes.ok, true);

        // 3. Vacuum
        const vacRes = await databaseService.executeSqliteAction("vacuum");
        assert.equal(vacRes.ok, true);

        // 4. Backup (rotates to max 2)
        const bkp1 = await databaseService.executeSqliteAction("backup");
        assert.equal(bkp1.ok, true);
        assert.ok(fs.existsSync(bkp1.backup.path));

        const bkp2 = await databaseService.executeSqliteAction("backup");
        assert.equal(bkp2.ok, true);

        const bkp3 = await databaseService.executeSqliteAction("backup");
        assert.equal(bkp3.ok, true);

        // Verify rotation kept only 2 backups
        const { listBackups } = require("../../database/sqlite/maintenance/backup");
        const storedBackups = listBackups(process.env.SQLITE_BACKUP_DIR);
        assert.equal(storedBackups.length, 2, "Should retain exactly 2 backups per rotation policy");

        // 5. Unsupported action
        const badRes = await databaseService.executeSqliteAction("unknown_action");
        assert.equal(badRes.ok, false);
        assert.match(badRes.error, /ไม่รองรับคำสั่ง/);
    });

    await t.test("executeDatabaseConsole executes allowlisted commands and blocks shell injection", async () => {
        // Valid commands
        const cmdStatus = await databaseService.executeDatabaseConsole("status");
        assert.equal(cmdStatus.ok, true);
        assert.match(cmdStatus.output, /สถานะระบบฐานข้อมูล/);

        const cmdStats = await databaseService.executeDatabaseConsole("stats");
        assert.equal(cmdStats.ok, true);
        assert.match(cmdStats.output, /ข้อมูลหลัก \(Core\)/);

        const cmdTables = await databaseService.executeDatabaseConsole("tables");
        assert.equal(cmdTables.ok, true);
        assert.match(cmdTables.output, /ตารางทั้งหมดใน SQLite/);

        const cmdIntegrity = await databaseService.executeDatabaseConsole("integrity");
        assert.equal(cmdIntegrity.ok, true);
        assert.match(cmdIntegrity.output, /ผ่านการตรวจสอบ Integrity/);

        const cmdMigrations = await databaseService.executeDatabaseConsole("migrations");
        assert.equal(cmdMigrations.ok, true);
        assert.match(cmdMigrations.output, /ประวัติ Schema Migrations/);
        assert.match(cmdMigrations.output, /v1/);

        const cmdFullCheck = await databaseService.executeDatabaseConsole("full-check");
        assert.equal(cmdFullCheck.ok, true);
        assert.match(cmdFullCheck.output, /Full Health Check/);

        // Verify maintenance_runs record
        const detailed = await databaseService.getSqliteDetailedStatus();
        assert.ok(Array.isArray(detailed.maintenanceHistory));
        assert.ok(detailed.maintenanceHistory.length > 0);
        assert.ok(detailed.maintenanceHistory[0].run_type);
        assert.ok(detailed.maintenanceHistory[0].status);

        // Shell Injection Guard
        const dangerousCommands = [
            "rm -rf /",
            "curl http://malicious.site",
            "wget http://malicious.site",
            "bash -c whoami",
            "cat /etc/passwd",
            "ls -la ; rm -f data"
        ];

        for (const badCmd of dangerousCommands) {
            const res = await databaseService.executeDatabaseConsole(badCmd);
            assert.equal(res.ok, false);
            assert.match(res.output, /ไม่อนุญาตให้รันคำสั่ง OS Shell/);
        }

        // Unknown command
        const unknownRes = await databaseService.executeDatabaseConsole("delete database");
        assert.equal(unknownRes.ok, false);
        assert.match(unknownRes.output, /ไม่รู้จักคำสั่ง/);
    });

    await t.test("maskSensitiveValue redacts tokens, secrets, IPs, and emails recursively", () => {
        const raw = {
            botToken: "sensitive-token-abcdef123456",
            password: "supersecretpassword",
            ipAddress: "192.168.1.50",
            email: "owner@discordbot.test",
            safeName: "Public Name",
            count: 42,
            nested: {
                encryptionKey: "aes256secretkey12345",
                userIp: "10.0.0.1",
                childEmail: "support@phomueangtai.test"
            },
            tags: ["normal", "secret-item-xyz"]
        };

        const masked = databaseService.maskSensitiveValue("root", raw);

        // Tokens/secrets
        assert.equal(masked.botToken, "sens...456 [PROTECTED]");
        assert.equal(masked.password, "supe...ord [PROTECTED]");
        assert.equal(masked.nested.encryptionKey, "aes2...345 [PROTECTED]");

        // IPs
        assert.equal(masked.ipAddress, "192.168.***.***");
        assert.equal(masked.nested.userIp, "10.0.***.***");

        // Emails
        assert.equal(masked.email, "o***@discordbot.test");
        assert.equal(masked.nested.childEmail, "s***@phomueangtai.test");

        // Non-sensitive preserved
        assert.equal(masked.safeName, "Public Name");
        assert.equal(masked.count, 42);
        assert.equal(masked.tags[0], "normal");
    });
});
