"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Database = require("better-sqlite3");

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const DmNotificationRepository = require("../../database/sqlite/repositories/core/DmNotificationRepository");
const VerificationRecoveryRepository = require("../../database/sqlite/repositories/core/VerificationRecoveryRepository");
const JoinCampaignRepository = require("../../database/sqlite/repositories/core/JoinCampaignRepository");
const VoiceAdminRepository = require("../../database/sqlite/repositories/core/VoiceAdminRepository");
const { getHealthStatus, incrementErrorCounter } = require("../../database/sqlite/maintenance/health");
const { cleanExpiredVoiceAdminNotices } = require("../../database/sqlite/maintenance/cleanup");

describe("Core SQLite Repositories Suite", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let db;
    let dmRepo;
    let recoveryRepo;
    let voiceAdminRepo;

    before(() => {
        db = new Database(":memory:");
        const migrationsDir = path.resolve(__dirname, "../../database/sqlite/migrations");
        runMigrations(db, { migrationsDir });

        dmRepo = new DmNotificationRepository(db);
        recoveryRepo = new VerificationRecoveryRepository(db);
        voiceAdminRepo = new VoiceAdminRepository(db);
    });

    after(() => {
        if (db && db.open) db.close();
    });

    describe("1. DmNotificationRepository", () => {
        test("creates and finds DM notification by id and eventKey", () => {
            const eventKey = "test_event_key_1";
            const created = dmRepo.create({
                eventKey,
                recipientId: "user_12345",
                category: "verification",
                priority: "high",
                priorityRank: 1,
                payload: { code: "123456" },
                status: "pending",
                attempts: 0
            });

            assert.ok(created);
            assert.equal(created.eventKey, eventKey);
            assert.equal(created.recipientId, "user_12345");
            assert.equal(created.status, "pending");

            // Find by ID
            const foundById = dmRepo.findById(created.id);
            assert.ok(foundById);
            assert.equal(foundById.eventKey, eventKey);

            // Find by eventKey
            const foundByKey = dmRepo.findOne({ eventKey });
            assert.ok(foundByKey);
            assert.equal(foundByKey.id, created.id);

            // Duplicate key throws E11000
            assert.throws(() => {
                dmRepo.create({
                    eventKey,
                    recipientId: "user_67890",
                    category: "verification"
                });
            }, (err) => err.code === 11000);
        });

        test("claims due candidates and single record", () => {
            const now = Date.now();
            const created = dmRepo.create({
                eventKey: "claim_test_key_2",
                recipientId: "user_222",
                category: "alert",
                status: "pending",
                nextAttemptAt: now - 1000,
                expiresAt: now + 3600000
            });

            const claimed = dmRepo.claimRecord(created, now);
            assert.ok(claimed);
            assert.equal(claimed.status, "sending");

            // Second claim should return null
            const secondClaim = dmRepo.claimRecord(created, now);
            assert.equal(secondClaim, null);

            // Claim due candidates
            dmRepo.create({
                eventKey: "batch_due_1",
                recipientId: "user_333",
                category: "system",
                status: "pending",
                nextAttemptAt: now - 1000,
                expiresAt: now + 3600000
            });

            const dueList = dmRepo.claimDueCandidates(5, now);
            assert.ok(Array.isArray(dueList));
            assert.ok(dueList.length >= 1);
            assert.ok(dueList.some(item => item.eventKey === "batch_due_1"));
        });

        test("updates record fields with updateOne", () => {
            const now = Date.now();
            const created = dmRepo.create({
                eventKey: "update_test_key_3",
                recipientId: "user_444",
                category: "notification",
                status: "pending"
            });

            const updateRes = dmRepo.updateOne({ id: created.id }, {
                status: "sent",
                attempts: 1,
                sentAt: now,
                lastError: null
            });

            assert.equal(updateRes.modifiedCount, 1);
            const updated = dmRepo.findById(created.id);
            assert.equal(updated.status, "sent");
            assert.equal(updated.attempts, 1);
            assert.equal(updated.sentAt, now);
        });

        test("finds records with $in, $nin and counts/deletes documents", () => {
            dmRepo.create({
                eventKey: "filter_key_1",
                recipientId: "user_f1",
                category: "cat_a",
                status: "pending"
            });
            dmRepo.create({
                eventKey: "filter_key_2",
                recipientId: "user_f2",
                category: "cat_b",
                status: "sending"
            });
            dmRepo.create({
                eventKey: "filter_key_3",
                recipientId: "user_f3",
                category: "cat_c",
                status: "failed"
            });

            // $in status and $nin category
            const results = dmRepo.find({
                status: { $in: ["pending", "sending"] },
                category: { $nin: ["cat_c"] }
            });
            assert.ok(results.length >= 2);

            // countDocuments
            const pendingCount = dmRepo.countDocuments({ status: "pending" });
            assert.ok(pendingCount >= 1);

            // deleteMany
            const delRes = dmRepo.deleteMany({ category: "cat_c" });
            assert.ok(delRes.deletedCount >= 1);
        });
    });

    describe("2. VerificationRecoveryRepository", () => {
        test("creates, queries, updates and deletes recovery records", () => {
            const requestId = "req_recovery_001";
            const created = recoveryRepo.create({
                requestId,
                guildId: "guild_111",
                userId: "user_222",
                roleId: "role_333",
                result: "pending",
                status: "pending",
                persistence: { verifiedAt: Date.now() },
                reason: "Initial verification"
            });

            assert.ok(created);
            assert.equal(created.requestId, requestId);
            assert.equal(created.status, "pending");

            // Find by requestId
            const found = recoveryRepo.findOne({ requestId });
            assert.ok(found);
            assert.equal(found.requestId, requestId);

            // Update record
            const updateRes = recoveryRepo.updateOne({ requestId }, {
                status: "completed",
                result: "success",
                roleApplied: true,
                reason: "Role assigned successfully"
            });

            assert.equal(updateRes.modifiedCount, 1);
            const byId = recoveryRepo.findById(created.id);
            assert.equal(byId.status, "completed");
            assert.equal(byId.roleApplied, true);

            // Count documents
            const count = recoveryRepo.countDocuments({ guildId: "guild_111" });
            assert.equal(count, 1);

            // Delete record
            const deleteRes = recoveryRepo.deleteMany({ guildId: "guild_111" });
            assert.equal(deleteRes.deletedCount, 1);
        });
    });

    describe("3. JoinCampaignRepository", () => {
        let joinRepo;

        before(() => {
            joinRepo = new JoinCampaignRepository(db);
        });

        test("manages full job lifecycle, counters, and reconciliation", () => {
            const jobId = "job_test_campaign_001";
            const created = joinRepo.createJob({
                id: jobId,
                mode: "ALL_TO_TARGET",
                sourceGuildId: "src_111",
                sourceGuildName: "Source Guild",
                targetGuildId: "tgt_222",
                targetGuildName: "Target Guild",
                status: "STAGE",
                requestedAmount: 50,
                selectedAmount: 50
            });

            assert.ok(created);
            assert.equal(created.id, jobId);
            assert.equal(created.status, "STAGE");

            // Find by ID and check active
            assert.ok(joinRepo.hasActiveJob());
            assert.equal(joinRepo.getActiveJob().id, jobId);
            assert.equal(joinRepo.findJobById(jobId).id, jobId);

            // Update job
            joinRepo.updateJob(jobId, { status: "RUNNING", joinedCount: 5, currentConcurrency: 12 });
            const running = joinRepo.findJobById(jobId);
            assert.equal(running.status, "RUNNING");
            assert.equal(running.joinedCount, 5);

            // Record items
            joinRepo.createItems(jobId, [
                { userId: "u_1", tokenField: "oauth" },
                { userId: "u_2", tokenField: "oauth" },
                { userId: "u_3", tokenField: "oauth" },
                { userId: "u_4", tokenField: "oauth" }
            ]);
            joinRepo.updateItemStatus(jobId, "u_1", "joined");
            joinRepo.updateItemStatus(jobId, "u_2", "already_member");
            joinRepo.updateItemStatus(jobId, "u_3", "failed", "Rate limited");

            // Processed & completed sets
            const processed = joinRepo.getProcessedUserIds(jobId);
            assert.ok(processed.has("u_1"));
            assert.ok(processed.has("u_2"));
            assert.ok(processed.has("u_3"));

            const completed = joinRepo.getCompletedUserIds(jobId);
            assert.ok(completed.has("u_1"));
            assert.ok(completed.has("u_2"));

            // Pending items, attempts, and claiming
            const pendingCount = joinRepo.countPendingItems(jobId);
            assert.ok(pendingCount >= 1);
            const claimed = joinRepo.claimNextPendingItem(jobId);
            assert.ok(claimed);
            assert.equal(claimed.userId, "u_4");
            joinRepo.incrementItemAttempt(jobId, "u_4", "timeout", 1000);

            // Reconcile counters
            const reconciled = joinRepo.reconcileJobCounters(jobId);
            assert.equal(reconciled.joinedCount, 1);
            assert.equal(reconciled.alreadyCount, 1);
            assert.equal(reconciled.failedCount, 1);

            // Orphan claim and Interrupted claim
            assert.equal(joinRepo.claimOrphanedRunningJob(jobId), true);
            assert.equal(joinRepo.claimInterruptedJob(jobId), true);

            // Mark completed
            joinRepo.markJobCompleted(jobId);
            assert.equal(joinRepo.findJobById(jobId).status, "COMPLETED");

            // List recent and metrics
            const recent = joinRepo.listRecentJobs({ limit: 5 });
            assert.ok(recent.length >= 1);
            const metrics = joinRepo.getMetrics();
            assert.ok(metrics.totalCampaigns >= 1);
        });

        test("manages panel state and bindings", () => {
            const panelData = {
                channelId: "chan_999",
                messageId: "msg_888",
                guildId: "guild_777",
                mode: "ALL_TO_TARGET",
                activeJobId: "job_panel_test"
            };

            joinRepo.savePanel(panelData);
            const foundByChannel = joinRepo.findPanelByChannelId("chan_999");
            assert.ok(foundByChannel);
            assert.equal(foundByChannel.messageId, "msg_888");

            const foundByMsg = joinRepo.findPanelByMessageId("msg_888");
            assert.ok(foundByMsg);
            assert.equal(foundByMsg.channelId, "chan_999");

            const foundByJob = joinRepo.findPanelByActiveJobId("job_panel_test");
            assert.ok(foundByJob);

            joinRepo.deletePanelByChannelId("chan_999");
            const cleared = joinRepo.findPanelByChannelId("chan_999");
            assert.equal(cleared, null);
        });
    });

    describe("4. SQLite Health Check & Diagnostics", () => {
        test("getHealthStatus reports correct status for open and closed DBs", () => {
            // 1. Open database
            const healthy = getHealthStatus(db, null);
            assert.equal(healthy.status, "ready");
            assert.equal(healthy.isReady, true);
            assert.ok(healthy.schemaVersion >= 1);
            assert.ok(healthy.tablesCount > 0);

            // 2. Closed database
            const closedHealth = getHealthStatus({ open: false }, null);
            assert.equal(closedHealth.status, "failed");
            assert.equal(closedHealth.isReady, false);
            assert.equal(closedHealth.reason, "connection_closed");

            // 3. Error counter
            incrementErrorCounter();
            const afterErr = getHealthStatus(db, null);
            assert.ok(afterErr.errorCount >= 1);
        });
    });

    describe("5. VoiceAdminRepository & Notices Lifecycle", () => {
        test("writeLock performs upsert, retrieves lock, and respects ownerForced", () => {
            const guildId = "guild_va_1";
            const userId = "user_va_1";

            const res = voiceAdminRepo.writeLock({
                guildId,
                userId,
                type: "mute",
                actorId: "owner_123",
                expectedVersion: undefined,
                ownerForced: true,
                lockedAt: 1000,
                version: "v_mute_1",
                now: 1000
            });

            assert.equal(res.acknowledged, true);
            assert.equal(res.changes, 1);

            const lock = voiceAdminRepo.getLock(guildId, userId);
            assert.ok(lock);
            assert.equal(lock.guildId, guildId);
            assert.equal(lock.userId, userId);
            assert.equal(lock.muteLocked, true);
            assert.equal(lock.deafLocked, false);
            assert.equal(lock.muteOwnerForced, true);
            assert.equal(lock.muteVersion, "v_mute_1");
            assert.equal(lock.muteLockedBy, "owner_123");

            const active = voiceAdminRepo.listActiveLocks();
            assert.ok(active.some(l => l.guildId === guildId && l.userId === userId));
        });

        test("writeLock version-bound update succeeds on matching version and fails on conflict", () => {
            const guildId = "guild_va_1";
            const userId = "user_va_1";

            // Conflict update with mismatched version
            const conflict = voiceAdminRepo.writeLock({
                guildId,
                userId,
                type: "mute",
                actorId: "admin_456",
                expectedVersion: "stale_version",
                ownerForced: false,
                lockedAt: 2000,
                version: "v_mute_conflict",
                now: 2000
            });
            assert.equal(conflict.matchedCount, 0);

            // Matching update
            const matched = voiceAdminRepo.writeLock({
                guildId,
                userId,
                type: "mute",
                actorId: "admin_456",
                expectedVersion: "v_mute_1",
                ownerForced: false,
                lockedAt: 2000,
                version: "v_mute_2",
                now: 2000
            });
            assert.equal(matched.matchedCount, 1);

            const lock = voiceAdminRepo.getLock(guildId, userId);
            assert.equal(lock.muteVersion, "v_mute_2");
            assert.equal(lock.muteOwnerForced, false);
        });

        test("clearLockField and clearBothLocks clear lock fields and owner forced flags", () => {
            const guildId = "guild_va_2";
            const userId = "user_va_2";

            // Lock deaf
            voiceAdminRepo.writeLock({
                guildId,
                userId,
                type: "deaf",
                actorId: "admin_1",
                version: "deaf_v1",
                now: 1000
            });

            const lockBefore = voiceAdminRepo.getLock(guildId, userId);
            assert.equal(lockBefore.deafLocked, true);

            // Clear deaf
            const clearRes = voiceAdminRepo.clearLockField(guildId, userId, "deaf", "deaf_v1", "deaf_v2", 2000);
            assert.equal(clearRes.matchedCount, 1);

            const lockAfter = voiceAdminRepo.getLock(guildId, userId);
            assert.equal(lockAfter.deafLocked, false);
            assert.equal(lockAfter.deafVersion, "deaf_v2");

            // Lock both
            voiceAdminRepo.writeLock({ guildId, userId, type: "mute", actorId: "a", version: "m_v1", now: 3000 });
            voiceAdminRepo.writeLock({ guildId, userId, type: "deaf", actorId: "a", version: "d_v1", now: 3000 });

            const bothRes = voiceAdminRepo.clearBothLocks(
                guildId,
                userId,
                { mute: "m_v1", deaf: "d_v1" },
                { mute: "m_v2", deaf: "d_v2" },
                4000
            );
            assert.equal(bothRes.matchedCount, 1);

            const lockCleared = voiceAdminRepo.getLock(guildId, userId);
            assert.equal(lockCleared.muteLocked, false);
            assert.equal(lockCleared.deafLocked, false);
            assert.equal(lockCleared.muteVersion, "m_v2");
            assert.equal(lockCleared.deafVersion, "d_v2");

            // Clear both when deaf was never locked (deaf_version is NULL in SQLite)
            voiceAdminRepo.writeLock({ guildId, userId: "u_mute_only", type: "mute", actorId: "a", version: "m_only_1", now: 3500 });
            const muteOnlyRes = voiceAdminRepo.clearBothLocks(
                guildId,
                "u_mute_only",
                { mute: "m_only_1", deaf: null },
                { mute: "m_only_2", deaf: "d_new_2" },
                4500
            );
            assert.equal(muteOnlyRes.matchedCount, 1);
        });

        test("deleteLock and deleteGuildLocks remove locks cleanly", () => {
            const guildId = "guild_va_del";
            voiceAdminRepo.writeLock({ guildId, userId: "u1", type: "mute", actorId: "a", version: "v1", now: 1000 });
            voiceAdminRepo.writeLock({ guildId, userId: "u2", type: "mute", actorId: "a", version: "v1", now: 1000 });

            const delSingle = voiceAdminRepo.deleteLock(guildId, "u1");
            assert.equal(delSingle.deletedCount, 1);
            assert.equal(voiceAdminRepo.getLock(guildId, "u1"), null);

            const delGuild = voiceAdminRepo.deleteGuildLocks(guildId);
            assert.equal(delGuild.deletedCount, 1);
            assert.equal(voiceAdminRepo.getLock(guildId, "u2"), null);
        });

        test("upsertNotice, listRecentNotices, cleanup and member notice deletion", () => {
            const guildId = "guild_va_notices";
            const now = Date.now();

            const res = voiceAdminRepo.upsertNotice({
                guildId,
                actorId: "actor_1",
                targetId: "target_1",
                channelId: "chan_1",
                messageId: "msg_1",
                notifiedAt: now
            });
            assert.equal(res.acknowledged, true);

            const recent = voiceAdminRepo.listRecentNotices(now - 1000);
            assert.ok(recent.some(n => n.guildId === guildId && n.actorId === "actor_1"));

            // Insert expired notice (>24h ago)
            voiceAdminRepo.upsertNotice({
                guildId,
                actorId: "actor_old",
                targetId: "target_old",
                channelId: "chan_1",
                messageId: "msg_old",
                notifiedAt: now - 30 * 60 * 60 * 1000
            });

            const deletedExpired = cleanExpiredVoiceAdminNotices(db, now);
            assert.ok(deletedExpired >= 1);

            // Delete member notices
            const delMember = voiceAdminRepo.deleteMemberNotices(guildId, "target_1");
            assert.equal(delMember.deletedCount, 1);

            // Delete guild notices
            voiceAdminRepo.upsertNotice({ guildId, actorId: "a2", targetId: "t2", channelId: "c", messageId: "m", notifiedAt: now });
            const delGuild = voiceAdminRepo.deleteGuildNotices(guildId);
            assert.equal(delGuild.deletedCount, 1);
        });
    });
});

