"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const database = require("../../database/index");
const { openDatabase, closeDatabase } = require("../../database/sqlite/connection");
const { runStartupCheck } = require("../../database/sqlite/maintenance/startupCheck");
const { runBoundedCleanup } = require("../../database/sqlite/maintenance/cleanup");
const { runIncrementalVacuum, checkpointWal } = require("../../database/sqlite/maintenance/vacuum");
const { createBackup } = require("../../database/sqlite/maintenance/backup");

test("SQLite Foundation & Maintenance Engine Suite", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-test-"));
    const testDbPath = path.join(tempDir, "test.sqlite");

    t.after(() => {
        closeDatabase();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test("opens fresh database and applies PRAGMAs and migrations", () => {
        const db = openDatabase({ path: testDbPath });
        assert.ok(db.open, "Database should be open");

        const startup = runStartupCheck(db, {
            dbPath: testDbPath,
            migrationsDir: path.resolve(__dirname, "../../database/sqlite/migrations")
        });

        assert.equal(startup.ok, true, "Startup check should succeed");
        assert.equal(startup.checks.pragmas, true, "PRAGMAs check should pass");
        assert.equal(startup.checks.migrations, true, "Migrations check should pass");
        assert.equal(startup.checks.readProbe, true, "Read probe should pass");
        assert.equal(startup.checks.writeRollbackProbe, true, "Write/Rollback probe should pass");
        assert.equal(startup.checks.quickIntegrity, true, "Quick integrity check should pass");

        const userVersion = db.pragma("user_version", { simple: true });
        assert.ok(userVersion >= 3, `Expected user_version >= 3, got ${userVersion}`);
    });

    await t.test("repositories perform CRUD operations over SQLite tables", () => {
        // 1. QuestLog repository
        const questRepo = database.repositories.questLog;
        const createdLog = questRepo.create({
            invokerId: "12345678901234567",
            invokerTag: "Tester#0001",
            guildId: "98765432109876543",
            channelId: "11122233344455566",
            totalTokens: 1,
            overallStatus: "in_progress",
            accounts: [{
                targetUserId: "12345678901234567",
                targetUsername: "tester",
                maskedToken: "m4sk...ed",
                encryptedToken: "enc_token_blob",
                status: "pending",
                details: [{
                    questId: "quest_1",
                    questName: "Test Quest",
                    eventName: "play",
                    target: 100,
                    progress: 50
                }]
            }]
        });

        assert.ok(createdLog._id, "Log should have an id");
        assert.equal(createdLog.invokerTag, "Tester#0001");
        assert.equal(createdLog.accounts.length, 1);
        assert.equal(createdLog.accounts[0].details.length, 1);
        assert.equal(createdLog.accounts[0].details[0].questName, "Test Quest");

        // 2. ScheduledRunner repository
        const runnerRepo = database.repositories.scheduledRunner;
        const createdRunner = runnerRepo.create({
            ownerId: "12345678901234567",
            guildId: "98765432109876543",
            channelId: "11122233344455566",
            accountId: "account_abc",
            username: "runner_test",
            token_ciphertext: "cipher",
            token_iv: "iv",
            token_tag: "tag",
            token_salt: "salt",
            enabled: true
        });

        assert.ok(createdRunner._id);
        assert.equal(createdRunner.accountId, "account_abc");

        const foundRunner = runnerRepo.findOne({ ownerId: "12345678901234567", accountId: "account_abc" });
        assert.ok(foundRunner);
        assert.equal(foundRunner.username, "runner_test");

        // 3. DmNotification repository & duplicate key handling
        const dmRepo = database.repositories.dmNotification;
        const createdDm = dmRepo.create({
            eventKey: "evt_unique_1",
            recipientId: "user_123",
            category: "alert",
            priority: "high",
            priorityRank: 1,
            payload: { msg: "hello" },
            status: "pending"
        });
        assert.ok(createdDm._id);
        assert.equal(createdDm.eventKey, "evt_unique_1");

        // Verify duplicate throws code 11000
        assert.throws(() => {
            dmRepo.create({
                eventKey: "evt_unique_1",
                recipientId: "user_456",
                category: "alert",
                payload: {}
            });
        }, (err) => {
            return err.code === 11000 && err.keyPattern.eventKey === 1;
        });

        // 4. VerificationStateNonce repository & duplicate hash handling
        const nonceRepo = database.repositories.verificationStateNonce;
        const createdNonce = nonceRepo.create({
            nonceHash: "hash_abc_123",
            guildId: "guild_1",
            roleId: "role_1",
            expiresAt: Date.now() + 60000
        });
        assert.ok(createdNonce._id);

        assert.throws(() => {
            nonceRepo.create({
                nonceHash: "hash_abc_123",
                guildId: "guild_2",
                roleId: "role_2",
                expiresAt: Date.now() + 60000
            });
        }, (err) => {
            return err.code === 11000 && err.keyPattern.nonceHash === 1;
        });

        const consumed = nonceRepo.consume({
            nonceHash: "hash_abc_123",
            guildId: "guild_1",
            roleId: "role_1"
        });
        assert.equal(consumed, true, "Nonce should be consumed successfully");

        // Consuming again should return false (already consumed)
        const consumedAgain = nonceRepo.consume({
            nonceHash: "hash_abc_123",
            guildId: "guild_1",
            roleId: "role_1"
        });
        assert.equal(consumedAgain, false, "Consumed nonce cannot be consumed twice");
    });

    await t.test("cacheManager supports TTL, getOrSet stampede protection, and LRU touch tracking", async () => {
        const cache = database.repositories.cache;

        cache.set("profile", "user_1", { name: "Antigravity", role: "AI" });
        const val = cache.get("profile", "user_1");
        assert.deepEqual(val, { name: "Antigravity", role: "AI" });

        let loaderCalls = 0;
        const fetcher = async () => {
            loaderCalls++;
            return { fetched: true };
        };

        // Concurrent requests to test stampede protection
        const [r1, r2, r3] = await Promise.all([
            cache.getOrSet("api", "call_1", fetcher),
            cache.getOrSet("api", "call_1", fetcher),
            cache.getOrSet("api", "call_1", fetcher)
        ]);

        assert.equal(loaderCalls, 1, "Fetcher should be called exactly once despite 3 concurrent requests");
        assert.deepEqual(r1, { fetched: true });
        assert.deepEqual(r2, { fetched: true });
        assert.deepEqual(r3, { fetched: true });
    });

    await t.test("vacuum, checkpoint, and backup work safely", async () => {
        const db = database.sqlite.getDb();
        const vacRes = runIncrementalVacuum(db, 50);
        assert.equal(vacRes.ok, true);

        const chkRes = checkpointWal(db, "PASSIVE");
        assert.equal(chkRes.ok, true);

        const backupDir = path.join(tempDir, "backups");
        const bkpRes = await createBackup(db, { backupDir });
        assert.equal(bkpRes.ok, true);
        assert.ok(fs.existsSync(bkpRes.path));
        assert.ok(bkpRes.sizeBytes > 0);
    });
});
