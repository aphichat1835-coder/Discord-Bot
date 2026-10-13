'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');

const { runMigrations } = require('../database/sqlite/migrations/migrationRunner');
const { applyPragmas } = require('../database/sqlite/pragmas');
const {
    runMemberPrivacyDeletion,
    recoverPendingPrivacyDeletions,
    verifyNoRemainingReferences
} = require('../discord/verification/services/privacyDeletion');
const p0Journal = require('../database/sqlite/repositories/history/p0Journal');
const { VoiceEventRepository } = require('../database/sqlite/repositories/history/VoiceEventRepository');
const { CommandEventRepository } = require('../database/sqlite/repositories/history/CommandEventRepository');
const { SessionEventRepository } = require('../database/sqlite/repositories/history/SessionEventRepository');
const { VerificationWebhookRepository } = require('../database/sqlite/repositories/core/VerificationWebhookRepository');
const { VerificationWebhookManager } = require('../discord/verification/services/webhook/verificationWebhookManager');
const GuildConfig = require('../discord/verification/models/GuildConfig');

function queryResult(value) {
    return {
        select() { return this; },
        session() { return this; },
        sort() { return this; },
        lean: async () => value
    };
}

function writeResult(count = 1) {
    return { acknowledged: true, modifiedCount: count, deletedCount: count, matchedCount: count };
}

function createModel(overrides = {}) {
    return {
        create: async () => ({}),
        updateOne: async () => writeResult(),
        updateMany: async () => writeResult(),
        deleteMany: async () => writeResult(),
        countDocuments: async () => 0,
        find: () => queryResult([]),
        findOne: () => queryResult(null),
        ...overrides
    };
}

function createModels(overrides = {}) {
    const base = {
        VerifyLog: createModel(),
        OAuthUser: createModel(),
        IpIdentityLink: createModel(),
        IpIdentityUserHistory: createModel(),
        IpIdentityDeviceHistory: createModel(),
        IpIdentityRoleHistory: createModel(),
        OAuthMemberSnapshot: createModel(),
        OAuthMemberRoleSnapshot: createModel(),
        OAuthObjectChunkSnapshot: createModel(),
        OAuthSnapshotRecovery: createModel(),
        VerificationMigrationArchive: createModel(),
        VerificationRecovery: createModel(),
        PrivacyDeletionJob: createModel()
    };
    return { ...base, ...overrides };
}

function fakeMongoose(options = {}) {
    return {
        async startSession() {
            if (options.startError) throw options.startError;
            return {
                async withTransaction(operation) {
                    if (options.transactionError) throw options.transactionError;
                    return operation();
                },
                async endSession() {}
            };
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3: Privacy Deletion Durable Saga Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PHASE 3 (PRIVACY-01): MongoDB transaction rollback leaves SQLite completely untouched', async () => {
    let sqliteDeleteCalled = false;
    const fakeSqliteModel = createModel({
        deleteMany: async () => {
            sqliteDeleteCalled = true;
            return writeResult(1);
        }
    });

    const txError = new Error('Simulated MongoDB Write Conflict');
    txError.code = 'WRITE_CONFLICT';

    const models = createModels({
        VerificationRecovery: fakeSqliteModel
    });

    await assert.rejects(
        runMemberPrivacyDeletion({
            guildId: 'guild-fail',
            userId: 'user-fail',
            requestedBy: 'owner',
            models,
            mongooseInstance: fakeMongoose({ transactionError: txError })
        }),
        (err) => {
            assert.equal(err.code, 'WRITE_CONFLICT');
            return true;
        }
    );

    assert.equal(sqliteDeleteCalled, false, 'SQLite delete must NEVER be called if MongoDB transaction aborted');
});

test('PHASE 3 (PRIVACY-02): MongoDB commit succeeds but SQLite delete fails -> Job status remains failed with phase tracking', async () => {
    const jobUpdates = [];
    const fakeJobModel = createModel({
        updateOne: async (_filter, update) => {
            jobUpdates.push(update);
            return writeResult(1);
        }
    });

    const sqliteErr = new Error('SQLite disk I/O failure');
    sqliteErr.code = 'SQLITE_IO_ERR';

    const fakeSqliteModel = createModel({
        deleteMany: async () => {
            throw sqliteErr;
        }
    });

    const models = createModels({
        VerificationRecovery: fakeSqliteModel,
        PrivacyDeletionJob: fakeJobModel
    });

    await assert.rejects(
        runMemberPrivacyDeletion({
            guildId: 'guild-a',
            userId: 'user-a',
            requestedBy: 'owner',
            models,
            mongooseInstance: fakeMongoose()
        }),
        (err) => {
            assert.equal(err.code, 'PRIVACY_DELETION_SQLITE_FAILED');
            return true;
        }
    );

    const completed = jobUpdates.find(u => u.$set?.status === 'completed');
    assert.equal(completed, undefined, 'Job must NOT be marked as completed when SQLite delete failed');

    const failed = jobUpdates.find(u => u.$set?.status === 'failed');
    assert.ok(failed, 'Job must be marked as failed');
    assert.equal(failed.$set.manifest.phases.mongo, 'completed', 'Mongo phase must be marked completed');
    assert.equal(failed.$set.manifest.phases.sqlite, 'failed', 'SQLite phase must be marked failed');
});

test('PHASE 3 (PRIVACY-03): recoverPendingPrivacyDeletions recovers uncompleted jobs and completes them', async () => {
    const recoveredJobs = [];
    let sqliteDeleted = 0;

    const uncompletedJob = {
        _id: 'job-pending-1',
        jobId: 'job-pending-1',
        guildId: 'guild-rec',
        userId: 'user-rec',
        manifest: {
            phases: { mongo: 'completed', sqlite: 'failed' },
            counts: {}
        }
    };

    const models = createModels({
        PrivacyDeletionJob: createModel({
            find: () => queryResult([uncompletedJob]),
            updateOne: async (filter, update) => {
                recoveredJobs.push({ filter, update });
                return writeResult(1);
            }
        }),
        VerificationRecovery: createModel({
            deleteMany: async () => {
                sqliteDeleted++;
                return writeResult(2);
            },
            countDocuments: async () => 0
        })
    });

    const summary = await recoverPendingPrivacyDeletions({ models, mongooseInstance: fakeMongoose() });
    assert.equal(summary.length, 1);
    assert.equal(summary[0].jobId, 'job-pending-1');
    assert.equal(summary[0].status, 'completed');
    assert.equal(sqliteDeleted, 1, 'Should invoke SQLite delete during recovery');

    const finalUpdate = recoveredJobs.find(r => r.update.$set?.status === 'completed');
    assert.ok(finalUpdate, 'Recovered job must be transitioned to completed');
    assert.equal(finalUpdate.update.$set.manifest.phases.sqlite, 'completed');
});

test('PHASE 3 (PRIVACY-04): verifyNoRemainingReferences rejects if references exist in either MongoDB or SQLite', async () => {
    // 1. References in Mongo
    const mongoModels = createModels({
        OAuthMemberSnapshot: createModel({ countDocuments: async () => 2 })
    });
    const mongoRes = await verifyNoRemainingReferences({
        guildId: 'guild-a',
        userId: 'user-a',
        models: mongoModels
    });
    assert.ok(mongoRes.remainingReferences > 0);
    assert.equal(mongoRes.checks.memberSnapshots, 2);

    // 2. References in SQLite
    const sqliteModels = createModels({
        VerificationRecovery: createModel({ countDocuments: async () => 1 })
    });
    const sqliteRes = await verifyNoRemainingReferences({
        guildId: 'guild-a',
        userId: 'user-a',
        models: sqliteModels
    });
    assert.ok(sqliteRes.remainingReferences > 0);
    assert.equal(sqliteRes.checks.verificationRecovery, 1);

    // 3. Clean
    const cleanModels = createModels();
    const cleanRes = await verifyNoRemainingReferences({
        guildId: 'guild-a',
        userId: 'user-a',
        models: cleanModels
    });
    assert.equal(cleanRes.remainingReferences, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4: P0 Journal Deduplication, Corrupt Entry Handling & Queue Bounding
// ─────────────────────────────────────────────────────────────────────────────

test('PHASE 4 (P0-01): Replay deduplication via p0_journal_receipts prevents duplicate insertions', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-dedup-test-'));
    const testDbPath = path.join(tempDir, 'p0_test.sqlite');
    const journalPath = path.join(tempDir, 'p0_test.jsonl');
    process.env.SQLITE_P0_JOURNAL_PATH = journalPath;

    try {
        const db = new Database(testDbPath);
        applyPragmas(db, { isNew: true });
        runMigrations(db);

        const voiceRepo = new VoiceEventRepository(db);
        voiceRepo.stopFlusher();

        const item = {
            priority: 'P1',
            sessionId: 'sess_123',
            actorId: 'user_456',
            guildId: 'guild_789',
            eventType: 'voice_join',
            occurredAt: 1700000000000
        };

        // Spool the event to the emergency journal
        const spooled = p0Journal.spoolP0Event('voice_events', item);
        assert.equal(spooled, true);

        // First replay: should insert event and write receipt
        const replayedFirst = p0Journal.drainP0Spool(db, { voice_events: voiceRepo });
        assert.equal(replayedFirst, 1);

        const rowCount = db.prepare('SELECT COUNT(*) as count FROM voice_events').get().count;
        assert.equal(rowCount, 1);

        // Simulate identical event re-spooled and drained
        p0Journal.spoolP0Event('voice_events', item);
        const replayedSecond = p0Journal.drainP0Spool(db, { voice_events: voiceRepo });
        assert.equal(replayedSecond, 0, 'Must not replay duplicate event');

        const rowCountAfter = db.prepare('SELECT COUNT(*) as count FROM voice_events').get().count;
        assert.equal(rowCountAfter, 1, 'Row count must remain 1 after second replay');

        db.close();
    } finally {
        delete process.env.SQLITE_P0_JOURNAL_PATH;
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
});

test('PHASE 4 (P0-02): Corrupt journal entries are skipped safely while valid entries are replayed', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-corrupt-test-'));
    const testDbPath = path.join(tempDir, 'p0_corrupt.sqlite');
    const journalPath = path.join(tempDir, 'p0_corrupt.jsonl');
    process.env.SQLITE_P0_JOURNAL_PATH = journalPath;

    try {
        const db = new Database(testDbPath);
        applyPragmas(db, { isNew: true });
        runMigrations(db);

        const commandRepo = new CommandEventRepository(db);
        commandRepo.stopFlusher();

        const validItem = {
            priority: 'P1',
            commandName: 'verify',
            actorId: 'user_corrupt_test',
            guildId: 'guild_test',
            channelId: 'ch_test',
            status: 'SUCCESS',
            occurredAt: 1700000050000
        };

        // Write corrupt and valid lines directly to journal
        const line1 = '{"CORRUPTED_JSON_BLOB\n';
        const line2 = JSON.stringify({
            id: 'valid_entry_abc',
            repo: 'command_events',
            item: validItem,
            spooledAt: Date.now()
        }) + '\n';
        const line3 = 'MALFORMED LINE WITHOUT JSON\n';

        fs.writeFileSync(journalPath, line1 + line2 + line3, 'utf8');

        // Drain spool
        const replayed = p0Journal.drainP0Spool(db, { command_events: commandRepo });
        assert.equal(replayed, 1, 'Valid entry must be replayed');

        const count = db.prepare('SELECT COUNT(*) as count FROM command_events WHERE actor_id = ?').get('user_corrupt_test').count;
        assert.equal(count, 1);

        // Journal should retain corrupted lines atomically without crashing
        assert.equal(fs.existsSync(journalPath), true);
        const remainingLines = fs.readFileSync(journalPath, 'utf8');
        assert.ok(remainingLines.includes('CORRUPTED_JSON_BLOB'));

        db.close();
    } finally {
        delete process.env.SQLITE_P0_JOURNAL_PATH;
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
});

test('PHASE 4 (P0-03): criticalRetryQueue is strictly bounded at 500 items and reports degraded status on double failure', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-queue-test-'));
    const testDbPath = path.join(tempDir, 'p0_queue.sqlite');

    try {
        const db = new Database(testDbPath);
        applyPragmas(db, { isNew: true });
        runMigrations(db);

        const sessionRepo = new SessionEventRepository(db);
        sessionRepo.stopFlusher();

        // Simulate double failure: SQLite insert fails AND spool fails
        sessionRepo._insertSingle = () => { throw new Error('DB write fail'); };
        const origSpool = p0Journal.spoolP0Event;
        p0Journal.spoolP0Event = () => false; // spool fails!

        try {
            // Add 520 critical P0 items
            for (let i = 0; i < 520; i++) {
                sessionRepo.record({
                    priority: 'P0',
                    sessionId: `sess_${i}`,
                    eventType: 'disconnect',
                    occurredAt: Date.now()
                });
            }

            assert.equal(sessionRepo.criticalRetryQueue.length, 500, 'criticalRetryQueue must be capped at 500 items');
            assert.equal(sessionRepo.p0StorageFailureCount, 20, '20 overflow items must increment p0StorageFailureCount');

            const bufferStats = sessionRepo.getBufferStats();
            assert.equal(bufferStats.p0Guaranteed, false, 'p0Guaranteed must report false under double storage failure');
            assert.equal(bufferStats.p0StorageFailureCount, 20);
        } finally {
            p0Journal.spoolP0Event = origSpool;
        }

        db.close();
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5: Webhook Backfill Worker Lifecycle & Cancellation Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PHASE 5 (BACKFILL-01): Missing Webhook URL cancels backfill job with webhook_url_missing reason', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-test-'));
    const testDbPath = path.join(tempDir, 'backfill_test.sqlite');

    const originalFindOne = GuildConfig.findOne;
    // Mock GuildConfig returning disabled/empty webhook
    GuildConfig.findOne = () => ({
        where: () => ({
            equals: () => ({
                lean: async () => ({
                    guildId: 'guild_no_url',
                    verification: {
                        webhookLog: {
                            enabled: false,
                            url: null,
                            mode: 'backfill_live'
                        }
                    }
                })
            })
        })
    });

    try {
        const db = new Database(testDbPath);
        applyPragmas(db, { isNew: true });
        runMigrations(db);

        const repo = new VerificationWebhookRepository(db);
        repo.createJob({
            jobId: 'job_cancel_url',
            guildId: 'guild_no_url',
            destinationVersion: 1,
            mode: 'BACKFILL_LIVE',
            totalEligible: 2
        });

        const manager = new VerificationWebhookManager(repo);
        const activeJob = repo.getJobById('job_cancel_url');

        await manager.executeBackfill('guild_no_url', activeJob, 'lease_worker_1');

        const updatedJob = repo.getJobById('job_cancel_url');
        assert.equal(updatedJob.status, 'FAILED', 'Job must be marked FAILED on cancel');
        assert.equal(updatedJob.error_message, 'webhook_url_missing');

        db.close();
    } finally {
        GuildConfig.findOne = originalFindOne;
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
});

test('PHASE 5 (BACKFILL-02): Destination version change cancels worker execution cleanly', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-ver-test-'));
    const testDbPath = path.join(tempDir, 'backfill_ver_test.sqlite');

    const originalFindOne = GuildConfig.findOne;
    // Mock GuildConfig returning destinationVersion 2 while job is version 1
    GuildConfig.findOne = () => ({
        where: () => ({
            equals: () => ({
                lean: async () => ({
                    guildId: 'guild_ver',
                    verification: {
                        webhookLog: {
                            enabled: true,
                            url: 'https://discord.com/api/webhooks/mock/test',
                            mode: 'backfill_live',
                            destinationVersion: 2
                        }
                    }
                })
            })
        })
    });

    try {
        const db = new Database(testDbPath);
        applyPragmas(db, { isNew: true });
        runMigrations(db);

        const repo = new VerificationWebhookRepository(db);
        repo.createJob({
            jobId: 'job_ver_mismatch',
            guildId: 'guild_ver',
            destinationVersion: 1,
            mode: 'BACKFILL_LIVE',
            totalEligible: 1
        });

        const manager = new VerificationWebhookManager(repo);
        const activeJob = repo.getJobById('job_ver_mismatch');

        await manager.executeBackfill('guild_ver', activeJob, 'lease_worker_ver');

        const updatedJob = repo.getJobById('job_ver_mismatch');
        assert.equal(updatedJob.status, 'FAILED', 'Job must be marked FAILED on cancel');
        assert.equal(updatedJob.error_message, 'destination_version_changed_to_2');

        db.close();
    } finally {
        GuildConfig.findOne = originalFindOne;
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
});

test('PHASE 5 (BACKFILL-03): Expired lease allows competing worker to acquire job without hanging in RUNNING', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-lease-test-'));
    const testDbPath = path.join(tempDir, 'backfill_lease.sqlite');

    try {
        const db = new Database(testDbPath);
        applyPragmas(db, { isNew: true });
        runMigrations(db);

        const repo = new VerificationWebhookRepository(db);
        repo.createJob({
            jobId: 'job_lease_test',
            guildId: 'guild_lease',
            destinationVersion: 1,
            mode: 'BACKFILL_LIVE',
            totalEligible: 1
        });

        // Worker A acquires lease for short duration (10ms)
        const leaseA = repo.acquireJobLease('job_lease_test', 'worker_A', 10);
        assert.equal(leaseA, true);

        // Immediate attempt by Worker B fails
        const leaseBImmediate = repo.acquireJobLease('job_lease_test', 'worker_B', 5000);
        assert.equal(leaseBImmediate, false, 'Competing worker rejected while lease active');

        // Advance SQLite time past lease expiration
        db.prepare("UPDATE verification_webhook_jobs SET lease_expires_at = ? WHERE job_id = ?")
            .run(Date.now() - 1000, 'job_lease_test');

        // Now Worker B attempts after expiration -> SUCCESS!
        const leaseBExpired = repo.acquireJobLease('job_lease_test', 'worker_B', 5000);
        assert.equal(leaseBExpired, true, 'Worker B must acquire expired lease');

        const job = repo.getJobById('job_lease_test');
        assert.equal(job.lease_token, 'worker_B');

        db.close();
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 7: Quest Legacy Models & SQLite Single Source of Truth
// ─────────────────────────────────────────────────────────────────────────────

test('PHASE 7 (QUEST-01): Quest repositories operate over SQLite as Single Source of Truth', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-repo-test-'));
    const testDbPath = path.join(tempDir, 'quest_test.sqlite');

    try {
        const db = new Database(testDbPath);
        applyPragmas(db, { isNew: true });
        runMigrations(db);

        const ScheduledRunnerRepository = require('../database/sqlite/repositories/core/ScheduledRunnerRepository');
        const QuestLogRepository = require('../database/sqlite/repositories/core/QuestLogRepository');

        const runnerRepo = new ScheduledRunnerRepository(db);
        const questLogRepo = new QuestLogRepository(db);

        // 1. ScheduledRunner CRUD over SQLite
        const createdRunner = runnerRepo.create({
            ownerId: 'owner_123',
            guildId: 'guild_123',
            channelId: 'ch_123',
            accountId: 'acc_123',
            username: 'test_user',
            token_ciphertext: 'enc_token',
            token_iv: 'iv_val',
            token_tag: 'tag_val',
            token_salt: 'salt_val',
            enabled: true
        });

        assert.ok(createdRunner._id);
        assert.equal(createdRunner.ownerId, 'owner_123');

        const found = runnerRepo.findOne({ ownerId: 'owner_123', accountId: 'acc_123' });
        assert.ok(found);
        assert.equal(found.username, 'test_user');

        // 2. QuestLog CRUD over SQLite
        const createdLog = questLogRepo.create({
            invokerId: 'invoker_123',
            invokerTag: 'invoker#0001',
            guildId: 'guild_123',
            channelId: 'ch_123',
            totalTokens: 1,
            overallStatus: 'completed',
            accounts: []
        });

        assert.ok(createdLog._id);
        assert.equal(createdLog.invokerTag, 'invoker#0001');

        const foundLog = questLogRepo.findById(createdLog._id);
        assert.ok(foundLog);
        assert.equal(foundLog.overallStatus, 'completed');

        // Verify compatibility exports require without throw
        const legacyScheduledRunner = require('../discord/quest/models/ScheduledRunner');
        const legacyQuestLog = require('../discord/quest/models/QuestLog');
        assert.ok(legacyScheduledRunner);
        assert.ok(legacyQuestLog);

        db.close();
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
});
