"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const Database = require("better-sqlite3");
const { applyPragmas } = require("../database/sqlite/pragmas");
const { runStartupCheck } = require("../database/sqlite/maintenance/startupCheck");
const { VerificationWebhookRepository } = require("../database/sqlite/repositories/core/VerificationWebhookRepository");
const {
    buildWebhookPayload,
    chunkLinesToFields,
    chunkStringToFields,
    splitEmbedFields,
    fitEmbedsIntoMessages,
    deliverWebhookEvent,
    postWebhookMessage,
    isEligibleVerifyLog,
    VerificationWebhookManager
} = require("../discord/verification/services/webhook/verificationWebhookManager");

test("Webhook Manager & Delivery Engine Integration Suite", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-int-test-"));
    const testDbPath = path.join(tempDir, "test.sqlite");

    const db = new Database(testDbPath);
    applyPragmas(db, { isNew: true });
    runStartupCheck(db, {
        dbPath: testDbPath,
        migrationsDir: path.resolve(__dirname, "../database/sqlite/migrations"),
        backupDir: path.join(tempDir, "backups")
    });

    const repo = new VerificationWebhookRepository(db);
    const manager = new VerificationWebhookManager(repo);

    t.after(async () => {
        try {
            if (manager.activeWorkers && manager.activeWorkers.size > 0) {
                await Promise.allSettled(Array.from(manager.activeWorkers.values()));
            }
            for (const timer of manager.retryTimers.values()) {
                clearTimeout(timer);
            }
        } catch (_) {}
        try {
            db.close();
        } catch (_) {}
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test("1. P0-1: Live dispatch rejects blocked, failed, or unassigned events", async () => {
        // Blocked event
        const blockedRes = await manager.dispatchLiveEvent({
            guildId: "123456",
            userId: "user_blocked",
            logId: "log_blocked",
            eventData: { result: "blocked" }
        });
        assert.equal(blockedRes, null, "Blocked event must not be dispatched");

        // Failed event
        const failedRes = await manager.dispatchLiveEvent({
            guildId: "123456",
            userId: "user_failed",
            logId: "log_failed",
            eventData: { result: "failed" }
        });
        assert.equal(failedRes, null, "Failed event must not be dispatched");

        // Unassigned role event
        const unassignedRes = await manager.dispatchLiveEvent({
            guildId: "123456",
            userId: "user_no_role",
            logId: "log_no_role",
            eventData: { result: "success", roleAssignResult: { ok: false } }
        });
        assert.equal(unassignedRes, null, "Event with failed role assignment must not be dispatched");
    });

    const runNonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    await t.test("2. P1-3: Deterministic deliveryId and SQLite unique constraint deduplicate events", () => {
        const guildId = "g1_" + runNonce;
        const eventId = "log_succ_001_" + runNonce;
        const userId = "user_001_" + runNonce;
        const destinationVersion = 1;

        const deliveryId = `del_${guildId}_v${destinationVersion}_${eventId}`;

        // First insert
        const res1 = repo.enqueueDelivery({
            deliveryId,
            guildId,
            destinationVersion,
            eventId,
            userId
        });
        assert.equal(res1.changes, 1, "First delivery should be enqueued");

        // Duplicate insert with same guild, version, and event
        const res2 = repo.enqueueDelivery({
            deliveryId,
            guildId,
            destinationVersion,
            eventId,
            userId
        });
        assert.equal(res2.changes, 0, "Duplicate delivery must be ignored cleanly (INSERT OR IGNORE)");

        const existing = repo.getDeliveryByEventId(guildId, destinationVersion, eventId);
        assert.ok(existing);
        assert.equal(existing.delivery_id, deliveryId);
    });

    await t.test("3. P1-6: Recovery identifies and resets stuck SENDING deliveries", () => {
        const guildId = "g2_" + runNonce;
        const eventId = "stuck_event_01_" + runNonce;
        const deliveryId = "del_stuck_01_" + runNonce;

        repo.enqueueDelivery({
            deliveryId,
            guildId,
            destinationVersion: 1,
            eventId,
            userId: "user_stuck"
        });

        // Simulate delivery claimed and marked SENDING in the past (e.g. 10 minutes ago)
        const tenMinsAgo = Date.now() - 600000;
        db.prepare(`
            UPDATE verification_webhook_deliveries
            SET status = 'SENDING', last_attempt_at = ?
            WHERE delivery_id = ?
        `).run(tenMinsAgo, deliveryId);

        // Run recovery with maxAgeMs = 300000 (5 mins)
        const recoveredCount = repo.recoverStuckSendingDeliveries(300000);
        assert.ok(recoveredCount >= 1, "Should recover at least 1 stuck delivery");

        const row = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(deliveryId);
        assert.equal(row.status, "RETRY", "Recovered delivery status must be RETRY");
        assert.equal(row.error_code, "sending_stuck_recovered");
    });

    await t.test("4. P1-7: Retry query finds minimum next_retry_at for worker scheduling", () => {
        const guildId = "g3_" + runNonce;
        const eventId1 = "retry_event_01_" + runNonce;
        const deliveryId1 = "del_retry_01_" + runNonce;
        const futureRetry = Date.now() + 15000;

        repo.enqueueDelivery({
            deliveryId: deliveryId1,
            guildId,
            destinationVersion: 1,
            eventId: eventId1,
            userId: "user_retry"
        });
        repo.markDeliveryRetry(deliveryId1, 15000, "temp_error", "Simulated temporary failure");

        const nextRetry = repo.getNextRetryTimestamp(guildId);
        assert.ok(nextRetry);
        assert.ok(nextRetry >= Date.now());
        assert.ok(nextRetry <= futureRetry + 2000);
    });

    await t.test("5. P1-5: Job lifecycle supports version tracking and cancellation on URL change", () => {
        const guildId = "g4_" + runNonce;
        const jobId = "job_v1_" + runNonce;

        const job = repo.createJob({
            jobId,
            guildId,
            destinationVersion: 1,
            mode: "BACKFILL_LIVE",
            totalEligible: 50
        });
        assert.equal(job.status, "RUNNING");
        assert.equal(job.destination_version, 1);

        // Simulate webhook URL change: cancels active jobs
        repo.cancelOrFailOldJobs(guildId, "webhook_url_changed");

        const updatedJob = repo.getJobById(jobId);
        assert.equal(updatedJob.status, "FAILED");
        assert.equal(updatedJob.error_message, "webhook_url_changed");
    });

    await t.test("6. P1-1: Backfill job completion distinguishes COMPLETED vs COMPLETED_WITH_FAILURES", () => {
        const guildId = "g5_" + runNonce;
        const jobCleanId = "job_clean_" + runNonce;
        const jobFailedId = "job_with_failures_" + runNonce;

        repo.createJob({ jobId: jobCleanId, guildId, destinationVersion: 1, mode: "BACKFILL_LIVE", totalEligible: 10 });
        repo.completeJob(jobCleanId, "COMPLETED");
        const cleanJob = repo.getJobById(jobCleanId);
        assert.equal(cleanJob.status, "COMPLETED");

        // Release job lock by completing
        const activeCheck = repo.getActiveJob(guildId);
        assert.equal(activeCheck, null);

        repo.createJob({ jobId: jobFailedId, guildId, destinationVersion: 1, mode: "BACKFILL_LIVE", totalEligible: 10 });
        repo.completeJob(jobFailedId, "COMPLETED_WITH_FAILURES");
        const failedJob = repo.getJobById(jobFailedId);
        assert.equal(failedJob.status, "COMPLETED_WITH_FAILURES");
    });

    await t.test("7. P1-8: Embed chunking and splitting preserves long data without truncation", () => {
        // Generate 35 connections (exceeding typical single field limit)
        const connections = Array.from({ length: 35 }, (_, i) => ({
            type: `Platform_${i + 1}`,
            name: `UserAccount_${i + 1}`,
            verified: i % 2 === 0
        }));

        // Generate long findings string
        const findings = Array.from({ length: 20 }, (_, i) => `SecurityFinding_${i + 1}: Flagged behavioral anomaly score`);

        const [embed1, embed2] = buildWebhookPayload({
            eventId: "event_large_test",
            profile: {
                id: "998877665544",
                username: "SuperActiveUser",
                displayTag: "SuperActiveUser#0001",
                badgeFlags: ["HYPESQUAD_BRAVERY", "VERIFIED_DEVELOPER"]
            },
            connections,
            guildSummary: { totalGuilds: 150, ownerGuildsCount: 5 },
            findings,
            ipInfo: {
                ipHash: "hash123",
                city: "Bangkok",
                country: "Thailand",
                isp: "True Internet",
                isVPN: false
            },
            device: {
                browser: "Chrome 120",
                os: "Windows 11",
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ExtremelyLongHeaderStringForVerificationTestingOnly"
            },
            tokens: {
                accessToken: "token_abc_123",
                refreshToken: "refresh_xyz_456"
            },
            roleId: "role_999",
            roleName: "Member",
            result: "success"
        });

        // Assert no field was truncated with "..."
        for (const f of embed1.fields) {
            assert.ok(f.value.length <= 1024, `Field ${f.name} value must not exceed 1024 chars`);
            assert.ok(!f.value.endsWith("..."), `Field ${f.name} must not be truncated with ellipsis`);
        }
        for (const f of embed2.fields) {
            assert.ok(f.value.length <= 1024, `Field ${f.name} value must not exceed 1024 chars`);
        }

        // Test field splitting for embeds having > 25 fields
        const split1 = splitEmbedFields(embed1);
        for (const emb of split1) {
            assert.ok(emb.fields.length <= 25, "Embed must have at most 25 fields");
        }

        // Test message packaging
        const messages = fitEmbedsIntoMessages([...split1, embed2]);
        assert.ok(messages.length >= 1, "Must generate valid message packages");
        for (const msg of messages) {
            assert.ok(Array.isArray(msg.embeds));
            assert.ok(msg.embeds.length <= 10);
        }

        // Assert footers preserve Event ID and User ID
        assert.match(embed1.footer.text, /Event: event_large_test/);
        assert.match(embed1.footer.text, /User: 998877665544/);
    });

    await t.test("8. P1-9: Historical connectionsSnapshot is preserved over current state", () => {
        const historicalConnections = [
            { type: "Steam", verified: true },
            { type: "GitHub", verified: false }
        ];

        const [embed1] = buildWebhookPayload({
            eventId: "event_history_01",
            profile: { id: "user_hist_01", username: "HistUser" },
            connections: historicalConnections,
            result: "success"
        });

        const connField = embed1.fields.find(f => f.name.includes("บัญชีที่เชื่อมต่อ"));
        assert.ok(connField);
        assert.match(connField.value, /Steam/);
        assert.match(connField.value, /GitHub/);
    });

    await t.test("9. Orchestrator Live Dispatch 4 Scenarios & Fail-Closed Guard", async () => {
        const GuildConfig = require("../discord/verification/models/GuildConfig");
        const originalFindOne = GuildConfig.findOne;
        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => ({
                    lean: async () => ({
                        verification: {
                            webhookLog: {
                                enabled: true,
                                url: "https://discord.com/api/webhooks/999999999/abcdefghijklmnopqrstuvwxyz0123456789_ABCDEFGH",
                                destinationVersion: 1
                            }
                        }
                    })
                })
            })
        });

        try {
            // Scenario 1: Verification success & role assigned ok
            const res1 = await manager.dispatchLiveEvent({
                guildId: "g_orch_1_" + runNonce,
                userId: "user_orch_1",
                logId: "log_orch_1",
                eventData: {
                    result: "success",
                    roleAssignResult: { ok: true }
                }
            });
            assert.ok(res1, "Scenario 1: Should return deliveryId for success + role ok");
            assert.match(res1, /^del_/);

            // Scenario 2: Verification success but log/eventData is not success or missing
            const res2 = await manager.dispatchLiveEvent({
                guildId: "g_orch_2_" + runNonce,
                userId: "user_orch_2",
                eventData: null,
                logId: null
            });
            assert.equal(res2, null, "Scenario 2: Should return null when eventData and logId are null");

            // Scenario 3: Verification success with alreadyHadRole: true
            const res3 = await manager.dispatchLiveEvent({
                guildId: "g_orch_3_" + runNonce,
                userId: "user_orch_3",
                logId: "log_orch_3",
                eventData: {
                    result: "success",
                    roleAssignResult: { ok: true, alreadyHadRole: true }
                }
            });
            assert.ok(res3, "Scenario 3: Should return deliveryId for alreadyHadRole: true");

            // Scenario 4: Role assignment failed (ok: false)
            const res4 = await manager.dispatchLiveEvent({
                guildId: "g_orch_4_" + runNonce,
                userId: "user_orch_4",
                logId: "log_orch_4",
                eventData: {
                    result: "success",
                    roleAssignResult: { ok: false, error: "role_failed" }
                }
            });
            assert.equal(res4, null, "Scenario 4: Should return null when role assignment failed");
        } finally {
            GuildConfig.findOne = originalFindOne;
        }
    });

    await t.test("10. Atomic Job Lease Protection prevents lease on FAILED or COMPLETED jobs", () => {
        const gLease = "g_lease_" + runNonce;
        const jId = "j_lease_" + runNonce;
        repo.createJob({ jobId: jId, guildId: gLease, destinationVersion: 1, mode: "BACKFILL_LIVE" });

        // Acquire lease on RUNNING job succeeds
        const acquired = repo.acquireJobLease(jId, "token_1", 30000);
        assert.equal(acquired, true, "Should acquire lease on RUNNING job");

        // Renew lease on RUNNING job succeeds
        const renewed = repo.renewJobLease(jId, "token_1", 30000);
        assert.equal(renewed, true, "Should renew lease on RUNNING job");

        // Mark job FAILED
        repo.failJob(jId, "manual_failure_test");

        // Attempting to acquire lease on FAILED job must fail
        const failedAcquire = repo.acquireJobLease(jId, "token_2", 30000);
        assert.equal(failedAcquire, false, "Must not acquire lease on FAILED job");

        // Attempting to renew lease on FAILED job must fail
        const failedRenew = repo.renewJobLease(jId, "token_1", 30000);
        assert.equal(failedRenew, false, "Must not renew lease on FAILED job");
    });

    await t.test("11. Webhook URL Change & Version Cancellation cascades to old deliveries", () => {
        const gVer = "g_ver_" + runNonce;
        const jVer = "j_ver_" + runNonce;
        repo.createJob({ jobId: jVer, guildId: gVer, destinationVersion: 1, mode: "BACKFILL_LIVE" });

        // Enqueue version 1 delivery
        const d1 = "del_v1_" + runNonce;
        repo.enqueueDelivery({
            deliveryId: d1,
            jobId: jVer,
            guildId: gVer,
            destinationVersion: 1,
            eventId: "ev_v1_" + runNonce,
            userId: "u_v1"
        });

        // URL changes -> new version is 2, cancel older jobs and deliveries
        repo.cancelOrFailOldJobs(gVer, "webhook_url_changed", 2);

        const jRow = repo.getJobById(jVer);
        assert.equal(jRow.status, "FAILED");

        const dRow = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(d1);
        assert.equal(dRow.status, "FAILED");
        assert.equal(dRow.error_code, "destination_version_changed");
    });

    await t.test("12. SQLite Queue Recovery returns affected guildIds and coerces to number", () => {
        const gRec1 = "g_rec1_" + runNonce;
        const gRec2 = "g_rec2_" + runNonce;
        const dRec1 = "d_rec1_" + runNonce;
        const dRec2 = "d_rec2_" + runNonce;

        repo.enqueueDelivery({ deliveryId: dRec1, guildId: gRec1, destinationVersion: 1, eventId: "e1", userId: "u1" });
        repo.enqueueDelivery({ deliveryId: dRec2, guildId: gRec2, destinationVersion: 1, eventId: "e2", userId: "u2" });

        // Set both to SENDING 10 minutes ago
        const past = Date.now() - 600000;
        db.prepare("UPDATE verification_webhook_deliveries SET status = 'SENDING', last_attempt_at = ? WHERE delivery_id IN (?, ?)").run(past, dRec1, dRec2);

        const result = repo.recoverStuckSendingDeliveries(300000);
        // Numeric coercion works
        assert.ok(result >= 2, "Numeric comparison (>= 2) should pass");
        assert.ok(Number(result) >= 2, "Number(result) should be at least 2");

        // guildIds is an array containing both guilds
        assert.ok(Array.isArray(result.guildIds));
        assert.ok(result.guildIds.includes(gRec1));
        assert.ok(result.guildIds.includes(gRec2));
    });

    await t.test("13. Comprehensive Discord Limits: field name/value clamping and embed/message batching", () => {
        // 1. Extreme field name length (>256 chars)
        const longName = "A".repeat(400);
        const nameFields = chunkLinesToFields(longName, ["Normal value line"]);
        for (const f of nameFields) {
            assert.ok(f.name.length <= 256, "Field name must never exceed 256 characters");
            assert.ok(f.name.length <= 250, "Field name should be clamped within 250 chars");
        }

        // 2. Extreme string length (>3000 chars) in single value
        const longString = "B".repeat(3500);
        const strFields = chunkStringToFields("LongStringTest", longString, 1000);
        assert.ok(strFields.length >= 4, "Should chunk 3500 chars into at least 4 fields");
        for (const f of strFields) {
            assert.ok(f.value.length <= 1000, "Field value chunk must not exceed 1000 chars");
        }

        // 3. Huge single line (>2500 chars) in chunkLinesToFields
        const hugeLine = "C".repeat(2500);
        const hugeLineFields = chunkLinesToFields("HugeLineTest", [hugeLine], 1000);
        assert.ok(hugeLineFields.length >= 3, "Huge line must be broken up into multiple fields");
        for (const f of hugeLineFields) {
            assert.ok(f.value.length <= 1000, "Field value must not exceed 1000 chars");
        }

        // 4. Extreme embed with 65 fields
        const manyFields = Array.from({ length: 65 }, (_, i) => ({
            name: `Field_${i + 1}`,
            value: `Value_${i + 1}`
        }));
        const hugeEmbed = {
            title: "HugeEmbedWithManyFields",
            fields: manyFields,
            footer: { text: "Event: ev_stress • User: u_stress" }
        };
        const splitEmbeds = splitEmbedFields(hugeEmbed);
        assert.ok(splitEmbeds.length >= 3, "65 fields must be split into at least 3 embeds");
        for (const emb of splitEmbeds) {
            assert.ok(emb.fields.length <= 25, "Each embed must have <= 25 fields");
        }

        // 5. Embed with total characters > 6,000
        const heavyFields = Array.from({ length: 20 }, (_, i) => ({
            name: `HeavyField_${i + 1}`,
            value: "X".repeat(500) // 20 * 500 = 10,000 characters!
        }));
        const charHeavyEmbed = {
            title: "CharHeavyEmbed",
            fields: heavyFields,
            footer: { text: "Event: ev_heavy • User: u_heavy" }
        };
        const charSplits = splitEmbedFields(charHeavyEmbed);
        assert.ok(charSplits.length >= 2, "Embed exceeding 5800 chars must be split into sequential embeds");

        // 6. Message batching with 25 embeds (exceeding 10 embeds per message limit)
        const twentyFiveEmbeds = Array.from({ length: 25 }, (_, i) => ({
            title: `Embed_${i + 1}`,
            fields: [{ name: "K", value: "V" }],
            footer: { text: "Event: ev_multi • User: u_multi" }
        }));
        const batches = fitEmbedsIntoMessages(twentyFiveEmbeds);
        assert.ok(batches.length >= 3, "25 embeds must be packaged into at least 3 messages");
        for (const msg of batches) {
            assert.ok(msg.embeds.length <= 10, "Every message must contain at most 10 embeds");
        }
    });

    await t.test("14. P1-1: Unified Backfill & Live eligibility checker (isEligibleVerifyLog)", () => {
        // Ineligible: null or non-object
        assert.equal(isEligibleVerifyLog(null), false);
        assert.equal(isEligibleVerifyLog("string"), false);

        // Ineligible: result !== "success"
        assert.equal(isEligibleVerifyLog({ result: "blocked", roleAssignResult: { ok: true } }), false);
        assert.equal(isEligibleVerifyLog({ result: "failed", roleAssignResult: { ok: true } }), false);

        // Ineligible: result === "success" but no roleAssignResult
        assert.equal(isEligibleVerifyLog({ result: "success" }), false);
        assert.equal(isEligibleVerifyLog({ result: "success", roleAssignResult: null }), false);
        assert.equal(isEligibleVerifyLog({ result: "success", roleAssignResult: { ok: false } }), false);

        // Eligible: concrete role assignment outcomes
        assert.equal(isEligibleVerifyLog({ result: "success", roleAssignResult: { ok: true } }), true);
        assert.equal(isEligibleVerifyLog({ result: "success", roleAssignResult: { alreadyHadRole: true } }), true);
        assert.equal(isEligibleVerifyLog({ result: "success", roleAssignResult: { joinedWithRole: true } }), true);
    });

    await t.test("15. P1-3: Standardized Delivery ID across Live and Backfill prevents duplicate deliveries", () => {
        const guildId = "g_std_" + runNonce;
        const destinationVersion = 1;
        const eventId = "ev_shared_" + runNonce;
        const userId = "u_shared_" + runNonce;

        // 1. Live enqueues delivery first
        const liveDeliveryId = `del_${guildId}_v${destinationVersion}_${eventId}`;
        const liveEnqueue = repo.enqueueDelivery({
            deliveryId: liveDeliveryId,
            guildId,
            destinationVersion,
            eventId,
            userId
        });
        assert.equal(liveEnqueue.changes, 1, "Live delivery row inserted");

        // 2. Backfill finds existing delivery
        const existing = repo.getDeliveryByEventId(guildId, destinationVersion, eventId);
        assert.ok(existing, "Backfill finds existing delivery row");
        assert.equal(existing.delivery_id, liveDeliveryId, "Existing row has identical standardized deliveryId");
        assert.equal(existing.status, "PENDING", "Initial status is PENDING");

        // 3. Backfill uses existing deliveryId when sending
        const targetDeliveryId = existing.delivery_id;
        repo.markDeliverySent(targetDeliveryId);

        // 4. Verification: delivery is now SENT, exactly 1 row exists
        const updated = repo.getDeliveryByEventId(guildId, destinationVersion, eventId);
        assert.equal(updated.status, "SENT", "Status successfully updated to SENT on shared deliveryId");
        const stats = repo.getDeliveryStats(guildId, destinationVersion);
        assert.equal(stats.total, 1, "Exactly one delivery row exists across live and backfill");
        assert.equal(stats.sent, 1, "Row is marked SENT");
    });

    await t.test("16. P1-4: Switching to Live-only mode while Backfill is RUNNING cancels the job", () => {
        const guildId = "g_switch_" + runNonce;
        const jobId = "job_switch_" + runNonce;

        // Create running backfill job
        repo.createJob({
            jobId,
            guildId,
            destinationVersion: 1,
            mode: "BACKFILL_LIVE",
            totalEligible: 50
        });

        const activeBefore = repo.getActiveJob(guildId);
        assert.ok(activeBefore, "Active job exists");
        assert.equal(activeBefore.status, "RUNNING");

        // Simulate cancelJob when switching to live mode
        repo.cancelJob(jobId, "switched_to_live_only");

        const activeAfter = repo.getActiveJob(guildId);
        assert.equal(activeAfter, null, "No active job remains after switching to live mode");

        const jobRecord = repo.getJobById(jobId);
        assert.equal(jobRecord.status, "FAILED", "Job is marked FAILED");
        assert.equal(jobRecord.error_message, "switched_to_live_only");
    });

    await t.test("17. P1-6 & P1-7: Startup recovery recovers PENDING, due RETRY, and future RETRY", () => {
        const gPending = "g_pending_" + runNonce;
        const gRetryDue = "g_retry_due_" + runNonce;
        const gRetryFuture = "g_retry_fut_" + runNonce;

        // Insert PENDING
        repo.enqueueDelivery({
            deliveryId: `del_${gPending}_v1_ev1`,
            guildId: gPending,
            destinationVersion: 1,
            eventId: "ev1",
            userId: "u1"
        });

        // Insert RETRY due now
        repo.enqueueDelivery({
            deliveryId: `del_${gRetryDue}_v1_ev2`,
            guildId: gRetryDue,
            destinationVersion: 1,
            eventId: "ev2",
            userId: "u2"
        });
        repo.markDeliveryRetry(`del_${gRetryDue}_v1_ev2`, 1000, "temp_err", "Retry due");
        // Backdate next_retry_at to past
        db.prepare("UPDATE verification_webhook_deliveries SET next_retry_at = ? WHERE delivery_id = ?")
            .run(Date.now() - 5000, `del_${gRetryDue}_v1_ev2`);

        // Insert RETRY due in future
        repo.enqueueDelivery({
            deliveryId: `del_${gRetryFuture}_v1_ev3`,
            guildId: gRetryFuture,
            destinationVersion: 1,
            eventId: "ev3",
            userId: "u3"
        });
        repo.markDeliveryRetry(`del_${gRetryFuture}_v1_ev3`, 60000, "temp_err", "Retry in future");

        // Probe recovery queries
        const pendingOrDue = repo.getPendingOrRetryGuildIds();
        assert.ok(pendingOrDue.includes(gPending), "Finds guild with PENDING delivery");
        assert.ok(pendingOrDue.includes(gRetryDue), "Finds guild with due RETRY delivery");

        const allRetry = repo.getAllRetryGuildIds();
        assert.ok(allRetry.includes(gRetryDue), "Finds guild with due retry");
        assert.ok(allRetry.includes(gRetryFuture), "Finds guild with future retry");

        // Schedule timer for future retry
        manager.scheduleNextRetry(gRetryFuture);
        assert.ok(manager.retryTimers.has(gRetryFuture), "Retry timer is scheduled for future retry guild");
    });

    await t.test("18. P1-5 & P1-6: Startup recovery cleans up active/orphaned backfill jobs", () => {
        const guildId = "g_orphan_" + runNonce;
        const jobId = "job_orphan_" + runNonce;

        repo.createJob({
            jobId,
            guildId,
            destinationVersion: 1,
            mode: "BACKFILL_LIVE",
            totalEligible: 20
        });

        const activeJobs = repo.getAllActiveJobs();
        assert.ok(activeJobs.some(j => j.job_id === jobId), "Active job discovered by getAllActiveJobs");

        repo.cancelJob(jobId, "orphan_job_recovered_on_startup");
        const afterCancel = repo.getJobById(jobId);
        assert.equal(afterCancel.status, "FAILED", "Orphaned job successfully transitioned to FAILED");
        assert.equal(afterCancel.error_message, "orphan_job_recovered_on_startup");
    });

    await t.test("19. P1-7: Lost-wakeup prevention in triggerWorker loops when wakeup is pending", async () => {
        const guildId = "g_wake_" + runNonce;
        assert.ok(manager.pendingWakeups instanceof Set, "pendingWakeups is a Set");

        let runCount = 0;
        const originalRunWorker = manager.runWorker;
        manager.runWorker = async (gId) => {
            runCount++;
            if (runCount === 1) {
                // While worker is executing first iteration, trigger another wakeup
                manager.triggerWorker(gId);
            }
        };

        try {
            manager.triggerWorker(guildId);
            await manager.activeWorkers.get(guildId);

            assert.equal(runCount, 2, "Worker must loop and execute a second time to drain pending wakeup");
            assert.equal(manager.pendingWakeups.has(guildId), false, "pendingWakeups must be cleared after second iteration");
            assert.equal(manager.activeWorkers.has(guildId), false, "activeWorkers must be cleared after worker completes");
        } finally {
            manager.runWorker = originalRunWorker;
            manager.pendingWakeups.delete(guildId);
            manager.activeWorkers.delete(guildId);
        }
    });

    await t.test("20. P2-8: Data contract fidelity: Guild Summary displays actual collector output", () => {
        // Case 1: Collector output format with totalCount / ownedCount
        const payloadFromCollector = buildWebhookPayload({
            eventId: "ev_collector",
            profile: { id: "123", username: "collectorUser" },
            guildSummary: { totalCount: 42, ownedCount: 7 },
            result: "success"
        });
        const guildField1 = payloadFromCollector[0].fields.find(f => f.name === "ข้อมูลเซิร์ฟเวอร์ Discord");
        assert.ok(guildField1, "Discord server stats field must exist");
        assert.ok(guildField1.value.includes("เซิร์ฟเวอร์ที่เข้าร่วมทั้งหมด: 42"), "Correct total count from totalCount");
        assert.ok(guildField1.value.includes("เซิร์ฟเวอร์ที่เป็นเจ้าของ: 7"), "Correct owner count from ownedCount");

        // Case 2: Legacy format with totalGuilds / ownerGuildsCount
        const payloadLegacy = buildWebhookPayload({
            eventId: "ev_legacy",
            profile: { id: "456", username: "legacyUser" },
            guildSummary: { totalGuilds: 15, ownerGuildsCount: 3 },
            result: "success"
        });
        const guildField2 = payloadLegacy[0].fields.find(f => f.name === "ข้อมูลเซิร์ฟเวอร์ Discord");
        assert.ok(guildField2.value.includes("เซิร์ฟเวอร์ที่เข้าร่วมทั้งหมด: 15"), "Correct total count from totalGuilds");
        assert.ok(guildField2.value.includes("เซิร์ฟเวอร์ที่เป็นเจ้าของ: 3"), "Correct owner count from ownerGuildsCount");

        // Case 3: Null guild summary
        const payloadNull = buildWebhookPayload({
            eventId: "ev_null",
            profile: { id: "789", username: "nullUser" },
            guildSummary: null,
            result: "success"
        });
        const guildField3 = payloadNull[0].fields.find(f => f.name === "ข้อมูลเซิร์ฟเวอร์ Discord");
        assert.equal(guildField3.value, "ไม่มีข้อมูลสรุปเซิร์ฟเวอร์", "Handles null summary gracefully");
    });

    await t.test("21. P1-5: URL change cascades to cancel active deliveries including SENDING", () => {
        const guildId = "g_url_change_" + runNonce;
        const d1 = `del_${guildId}_v1_pending`;
        const d2 = `del_${guildId}_v1_sending`;

        repo.enqueueDelivery({
            deliveryId: d1,
            guildId,
            destinationVersion: 1,
            eventId: "ev_d1",
            userId: "u1"
        });

        repo.enqueueDelivery({
            deliveryId: d2,
            guildId,
            destinationVersion: 1,
            eventId: "ev_d2",
            userId: "u2"
        });

        // Mark d2 as SENDING
        db.prepare("UPDATE verification_webhook_deliveries SET status = 'SENDING' WHERE delivery_id = ?").run(d2);

        // Cancel old jobs/deliveries for new destination version 2
        repo.cancelOrFailOldJobs(guildId, "webhook_url_changed", 2);

        const check1 = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(d1);
        const check2 = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(d2);

        assert.equal(check1.status, "FAILED", "Pending delivery from version 1 is FAILED");
        assert.equal(check2.status, "FAILED", "SENDING delivery from version 1 is FAILED");
    });

    await t.test("22. P1-8: Multi-part messages are annotated with part numbers for at-least-once traceability", () => {
        // Create 15 embeds so they exceed the 10 embeds per message limit
        const embeds = Array.from({ length: 15 }, (_, i) => ({
            title: `Embed ${i + 1}`,
            description: "Test description"
        }));

        const splitEmbeds = [];
        for (const emb of embeds) {
            splitEmbeds.push(...splitEmbedFields(emb));
        }
        const messages = fitEmbedsIntoMessages(splitEmbeds);
        assert.equal(messages.length, 2, "15 embeds split into exactly 2 messages");

        // Annotate like deliverWebhookEvent
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            for (const emb of msg.embeds) {
                const partTag = `ส่วนที่ ${i + 1}/${messages.length}`;
                if (emb.footer && emb.footer.text) {
                    emb.footer.text = `${emb.footer.text} • ${partTag}`;
                } else {
                    emb.footer = { text: partTag };
                }
            }
        }

        assert.ok(messages[0].embeds[0].footer.text.includes("ส่วนที่ 1/2"), "First batch annotated with part 1/2");
        assert.ok(messages[1].embeds[0].footer.text.includes("ส่วนที่ 2/2"), "Second batch annotated with part 2/2");
    });

    await t.test("23. P1-3: Switching to Live-only cancels pending and retry backfill deliveries via startLiveMode", async () => {
        const guildId = "g_live_cancel_" + runNonce;
        const jobId = "job_backfill_cancel_" + runNonce;

        repo.createJob({
            jobId,
            guildId,
            destinationVersion: 1,
            mode: "BACKFILL_LIVE",
            totalEligible: 5
        });

        const delPending = `del_${guildId}_v1_pending_backfill`;
        const delRetry = `del_${guildId}_v1_retry_backfill`;
        const delLive = `del_${guildId}_v1_live_pending`;

        repo.enqueueDelivery({
            deliveryId: delPending,
            jobId,
            guildId,
            destinationVersion: 1,
            eventId: "ev_bp",
            userId: "u_bp"
        });

        repo.enqueueDelivery({
            deliveryId: delRetry,
            jobId,
            guildId,
            destinationVersion: 1,
            eventId: "ev_br",
            userId: "u_br"
        });
        repo.markDeliveryRetry(delRetry, 60000, "backfill_fail", "Temporary error");

        // Live delivery (no jobId)
        repo.enqueueDelivery({
            deliveryId: delLive,
            jobId: null,
            guildId,
            destinationVersion: 1,
            eventId: "ev_live",
            userId: "u_live"
        });

        const GuildConfig = require("../discord/verification/models/GuildConfig");
        const originalFindOne = GuildConfig.findOne;
        const originalUpdateOne = GuildConfig.updateOne;
        let updatedMode = null;

        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => Promise.resolve({
                    verification: {
                        webhookLog: {
                            url: "https://discord.com/api/webhooks/111111111111111111/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            enabled: true,
                            mode: "backfill_live",
                            destinationVersion: 1
                        }
                    }
                })
            })
        });
        GuildConfig.updateOne = async (filter, update) => {
            updatedMode = update.$set?.["verification.webhookLog.mode"];
            return { acknowledged: true, modifiedCount: 1 };
        };

        try {
            const startRes = await manager.startLiveMode(guildId);
            assert.equal(startRes.ok, true);
            assert.equal(startRes.mode, "live");
            assert.equal(updatedMode, "live", "GuildConfig mode updated to live");

            const checkJob = repo.getJobById(jobId);
            assert.equal(checkJob.status, "FAILED", "Job is marked FAILED by startLiveMode");

            const checkPending = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(delPending);
            const checkRetry = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(delRetry);
            const checkLive = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(delLive);

            assert.equal(checkPending.status, "FAILED", "Backfill PENDING delivery is cancelled by live mode");
            assert.equal(checkPending.error_code, "cancelled_by_live_mode");
            assert.equal(checkRetry.status, "FAILED", "Backfill RETRY delivery is cancelled by live mode");
            assert.equal(checkRetry.error_code, "cancelled_by_live_mode");
            assert.equal(checkLive.status, "PENDING", "Live delivery without jobId is preserved and remains PENDING");
        } finally {
            GuildConfig.findOne = originalFindOne;
            GuildConfig.updateOne = originalUpdateOne;
        }
    });

    await t.test("24. P1-5: Conditional status update prevents overwriting FAILED after URL change", () => {
        const guildId = "g_cond_update_" + runNonce;
        const deliveryId = `del_${guildId}_v1_race`;

        repo.enqueueDelivery({
            deliveryId,
            guildId,
            destinationVersion: 1,
            eventId: "ev_race",
            userId: "u_race"
        });

        // Claim it -> status becomes SENDING
        const claimed = repo.claimNextDeliveries(guildId, 1);
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].status, "PENDING"); // was pending before claim update

        const checkSending = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(deliveryId);
        assert.equal(checkSending.status, "SENDING");

        // While HTTP request is in-flight, destination URL changes to version 2
        repo.cancelOrFailOldJobs(guildId, "destination_version_changed", 2);

        const checkFailed = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(deliveryId);
        assert.equal(checkFailed.status, "FAILED", "In-flight delivery marked FAILED by URL change");

        // Late response finishes and attempts to mark SENT with version 1
        const sentResult = repo.markDeliverySent(deliveryId, 1);
        assert.equal(sentResult.changes, 0, "markDeliverySent MUST NOT update a row that is no longer SENDING");

        const checkAfter = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(deliveryId);
        assert.equal(checkAfter.status, "FAILED", "Delivery remains FAILED and is not overwritten");
    });

    await t.test("25. P1-2: recoverStuckSendingDeliveries with maxAgeMs=0 resets all orphaned SENDING deliveries", () => {
        const guildId = "g_stuck_" + runNonce;
        const d1 = `del_${guildId}_v1_stuck`;

        repo.enqueueDelivery({
            deliveryId: d1,
            guildId,
            destinationVersion: 1,
            eventId: "ev_stuck",
            userId: "u_stuck"
        });

        // Claim it to SENDING
        repo.claimNextDeliveries(guildId, 1);

        // Immediate startup recovery with maxAgeMs = 0
        const recResult = repo.recoverStuckSendingDeliveries(0);
        assert.ok(recResult.recoveredCount >= 1, "At least 1 stuck delivery recovered");

        const check = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(d1);
        assert.equal(check.status, "RETRY", "Stuck SENDING delivery recovered to RETRY");
        assert.equal(check.error_code, "sending_stuck_recovered");
    });

    await t.test("26. Section 5: getDeliveryStats filters accurately by destinationVersion", () => {
        const guildId = "g_stats_ver_" + runNonce;
        const d_v1 = `del_${guildId}_v1_f`;
        const d_v2 = `del_${guildId}_v2_s`;

        repo.enqueueDelivery({ deliveryId: d_v1, guildId, destinationVersion: 1, eventId: "e1", userId: "u1" });
        repo.markDeliveryFailed(d_v1, "v1_error", "Old URL failure");

        repo.enqueueDelivery({ deliveryId: d_v2, guildId, destinationVersion: 2, eventId: "e2", userId: "u2" });
        db.prepare("UPDATE verification_webhook_deliveries SET status = 'SENDING' WHERE delivery_id = ?").run(d_v2);
        repo.markDeliverySent(d_v2, 2);

        // Version 1 stats
        const statsV1 = repo.getDeliveryStats(guildId, 1);
        assert.equal(statsV1.failed, 1, "V1 has 1 failed");
        assert.equal(statsV1.sent, 0, "V1 has 0 sent");

        // Version 2 stats
        const statsV2 = repo.getDeliveryStats(guildId, 2);
        assert.equal(statsV2.failed, 0, "V2 has 0 failed");
        assert.equal(statsV2.sent, 1, "V2 has 1 sent");
    });

    await t.test("27. P1-2: performStartupRecovery end-to-end recovers orphaned jobs and stuck sending deliveries", async () => {
        const guildId = "g_full_rec_" + runNonce;
        const jobId = "job_full_rec_" + runNonce;

        // 1. Stuck SENDING delivery
        const delSending = `del_${guildId}_v1_sending`;
        repo.enqueueDelivery({
            deliveryId: delSending,
            guildId,
            destinationVersion: 1,
            eventId: "ev_rec_sending",
            userId: "u_rec_s"
        });
        repo.claimNextDeliveries(guildId, 1); // turns to SENDING

        // 2. Active backfill job
        repo.createJob({
            jobId,
            guildId,
            destinationVersion: 1,
            mode: "BACKFILL_LIVE",
            totalEligible: 10
        });

        // 3. Future retry delivery
        const delRetryFuture = `del_${guildId}_v1_future_retry`;
        repo.enqueueDelivery({
            deliveryId: delRetryFuture,
            guildId,
            destinationVersion: 1,
            eventId: "ev_rec_future",
            userId: "u_rec_f"
        });
        repo.markDeliveryRetry(delRetryFuture, 60000, "tmp_err", "retry later");

        // Mock GuildConfig
        const mongoose = require("mongoose");
        const origReadyState = mongoose.connection.readyState;
        Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });

        const GuildConfig = require("../discord/verification/models/GuildConfig");
        const originalFindOne = GuildConfig.findOne;
        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => ({
                    lean: () => Promise.resolve({
                        verification: {
                            webhookLog: {
                                enabled: true,
                                mode: "live", // Guild is now in live mode -> orphan job should be cancelled!
                                destinationVersion: 1
                            }
                        }
                    })
                })
            })
        });

        let triggeredGuilds = [];
        const originalTriggerWorker = manager.triggerWorker;
        manager.triggerWorker = (gId) => {
            triggeredGuilds.push(gId);
        };

        try {
            await manager.performStartupRecovery();

            // Check SENDING delivery was reset to RETRY
            const checkSending = db.prepare("SELECT * FROM verification_webhook_deliveries WHERE delivery_id = ?").get(delSending);
            assert.equal(checkSending.status, "RETRY", "Stuck SENDING delivery recovered to RETRY");
            assert.equal(checkSending.error_code, "sending_stuck_recovered");

            // Check orphaned backfill job was cancelled because guild is in live mode
            const checkJob = repo.getJobById(jobId);
            assert.equal(checkJob.status, "FAILED", "Orphaned job cancelled");
            assert.equal(checkJob.error_message, "orphan_job_recovered_on_startup");

            // Check retry timer was scheduled for future retry
            assert.ok(manager.retryTimers.has(guildId), "Retry timer scheduled for future retry");

            // Check worker was triggered for recovered deliveries
            assert.ok(triggeredGuilds.includes(guildId), "Worker triggered for recovered guild");
        } finally {
            Object.defineProperty(mongoose.connection, "readyState", { value: origReadyState, configurable: true, writable: true });
            GuildConfig.findOne = originalFindOne;
            manager.triggerWorker = originalTriggerWorker;
        }
    });

    await t.test("28. P1-4: executeBackfill enqueues deliveries and drains through unified queue worker", async () => {
        const guildId = "g_backfill_unified_" + runNonce;
        const jobId = "job_bf_uni_" + runNonce;

        repo.createJob({
            jobId,
            guildId,
            destinationVersion: 1,
            mode: "BACKFILL_LIVE",
            totalEligible: 2
        });

        const VerifyLog = require("../discord/verification/models/VerifyLog");
        const originalFind = VerifyLog.find;
        const log1Id = "507f1f77bcf86cd799439011";
        const log2Id = "507f1f77bcf86cd799439012";

        let findCalls = 0;
        VerifyLog.find = () => ({
            sort: () => ({
                limit: () => ({
                    lean: () => {
                        findCalls++;
                        if (findCalls === 1) {
                            return Promise.resolve([
                                { _id: log1Id, guildId, userId: "u1", result: "success", roleAssignResult: { ok: true } },
                                { _id: log2Id, guildId, userId: "u2", result: "success", roleAssignResult: { ok: true } }
                            ]);
                        }
                        return Promise.resolve([]); // end of stream
                    }
                })
            })
        });

        const GuildConfig = require("../discord/verification/models/GuildConfig");
        const originalFindOne = GuildConfig.findOne;
        const originalUpdateOne = GuildConfig.updateOne;
        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => ({
                    lean: () => Promise.resolve({
                        verification: {
                            webhookLog: {
                                url: "https://discord.com/api/webhooks/123/mock",
                                enabled: true,
                                mode: "backfill_live",
                                destinationVersion: 1
                            }
                        }
                    })
                })
            })
        });
        GuildConfig.updateOne = () => Promise.resolve({ acknowledged: true });

        let drainedCalls = 0;
        const originalDrain = manager.drainDeliveries;
        manager.drainDeliveries = async (gId) => {
            drainedCalls++;
        };

        try {
            const job = repo.getJobById(jobId);
            await manager.executeBackfill(guildId, job, "test-lease-token");

            // Verify both items were enqueued into SQLite with the job's ID
            const d1 = repo.getDeliveryByEventId(guildId, 1, log1Id);
            const d2 = repo.getDeliveryByEventId(guildId, 1, log2Id);
            assert.ok(d1, "Log 1 enqueued into deliveries table");
            assert.equal(d1.job_id, jobId, "Delivery 1 belongs to backfill job");
            assert.ok(d2, "Log 2 enqueued into deliveries table");
            assert.equal(d2.job_id, jobId, "Delivery 2 belongs to backfill job");

            // Verify drainDeliveries was called to process them via the queue worker
            assert.ok(drainedCalls >= 1, "drainDeliveries called to drain through unified queue worker");
        } finally {
            VerifyLog.find = originalFind;
            GuildConfig.findOne = originalFindOne;
            GuildConfig.updateOne = originalUpdateOne;
            manager.drainDeliveries = originalDrain;
        }
    });

    await t.test("29. Section 5: getReadiness returns lastError and destination-filtered stats", async () => {
        const guildId = "g_readiness_" + runNonce;
        const GuildConfig = require("../discord/verification/models/GuildConfig");
        const originalFindOne = GuildConfig.findOne;

        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => ({
                    lean: () => Promise.resolve({
                        verification: {
                            webhookLog: {
                                url: "https://discord.com/api/webhooks/123/mock",
                                enabled: true,
                                mode: "live",
                                destinationVersion: 2,
                                lastStatus: "running",
                                lastError: "Rate limited by Discord API"
                            }
                        }
                    })
                })
            })
        });

        try {
            const readiness = await manager.getReadiness(guildId);
            assert.equal(readiness.destinationVersion, 2);
            assert.equal(readiness.lastError, "Rate limited by Discord API", "lastError is returned to caller");
            assert.equal(readiness.enabled, true);
        } finally {
            GuildConfig.findOne = originalFindOne;
        }
    });

    await t.test("30. P1: Multi-message chunking resumes from sent_parts without duplicating sent parts", async () => {
        const origFetch = global.fetch;
        const sentRequests = [];
        global.fetch = async (url, options) => {
            sentRequests.push(JSON.parse(options.body));
            return {
                ok: true,
                status: 200,
                text: async () => "ok"
            };
        };

        try {
            // Create an event that splits into 2 distinct messages (exceeding single embed char limits)
            const hugeFields = Array.from({ length: 30 }, (_, i) => ({
                name: `Field ${i}`,
                value: "X".repeat(200)
            }));
            const largeEmbed = {
                title: "Test Large Payload",
                fields: hugeFields
            };

            const deliveredParts = [];
            await deliverWebhookEvent("https://discord.com/api/webhooks/test/url", [largeEmbed], {
                startPart: 1, // Simulate resuming after part 1 was already acknowledged
                onPartSent: async (partIndex, totalParts) => {
                    deliveredParts.push({ partIndex, totalParts });
                }
            });

            // If it split into 2 messages, starting from 1 means only 1 message was transmitted
            assert.equal(sentRequests.length, 1, "Only remaining unacknowledged part was transmitted");
            assert.ok(deliveredParts.length >= 1, "onPartSent callback fired for completed part");

            // Also test SQLite sent_parts persistence
            const guildId = "g_parts_" + runNonce;
            const eventId = "ev_parts_" + runNonce;
            const deliveryId = "del_parts_" + runNonce;
            repo.enqueueDelivery({
                deliveryId,
                guildId,
                destinationVersion: 1,
                eventId,
                userId: "user_parts"
            });

            repo.updateDeliverySentParts(deliveryId, 2);
            const saved = repo.getDeliveryByEventId(guildId, 1, eventId);
            assert.equal(saved.sent_parts, 2, "SQLite properly records updated sent_parts");
        } finally {
            global.fetch = origFetch;
        }
    });

    await t.test("31. P1: Backfill job remains RUNNING when delivery retries and completes only after retry succeeds", async () => {
        const guildId = "g_backfill_retry_" + runNonce;
        const jobId = "job_retry_" + runNonce;
        const eventId = "ev_retry_" + runNonce;
        const deliveryId = "del_retry_" + runNonce;

        repo.createJob({
            jobId,
            guildId,
            destinationVersion: 1,
            mode: "backfill",
            totalEligible: 1
        });

        repo.enqueueDelivery({
            deliveryId,
            guildId,
            destinationVersion: 1,
            eventId,
            userId: "user_retry",
            jobId
        });

        // Claim and mark retry
        repo.claimNextDeliveries(guildId, 1);
        repo.markDeliveryRetry(deliveryId, 5000, "temp_network_blip", "Simulated transient failure", 1);

        // Count pending deliveries must count RETRY items
        const pendingCount = repo.countPendingDeliveriesForJob(jobId);
        assert.equal(pendingCount, 1, "Pending deliveries count includes RETRY items");

        const stats = repo.getJobDeliveryStats(jobId);
        assert.equal(stats.retryCount, 1, "Stats reflect RETRY delivery");

        // Calling checkAndCompleteJobIfDone while items are in RETRY must NOT complete the job
        await manager.checkAndCompleteJobIfDone(jobId, guildId);
        const jobStillRunning = repo.getJobById(jobId);
        assert.equal(jobStillRunning.status, "RUNNING", "Job must stay RUNNING while deliveries are pending retry");

        // Now simulate retry completion
        const GuildConfig = require("../discord/verification/models/GuildConfig");
        const origFindOne = GuildConfig.findOne;
        const origUpdateOne = GuildConfig.updateOne;
        let modeSwitchedToLive = false;

        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => ({
                    lean: () => Promise.resolve({
                        verification: {
                            webhookLog: {
                                url: "https://discord.com/api/webhooks/123/mock",
                                enabled: true,
                                mode: "backfill_live",
                                destinationVersion: 1
                            }
                        }
                    })
                })
            })
        });

        GuildConfig.updateOne = (filter, update) => {
            if (update?.$set?.["verification.webhookLog.mode"] === "live") {
                modeSwitchedToLive = true;
            }
            return Promise.resolve({ acknowledged: true });
        };

        try {
            repo.markDeliverySent(deliveryId, 1);
            assert.equal(repo.countPendingDeliveriesForJob(jobId), 0, "No pending deliveries remain");

            await manager.checkAndCompleteJobIfDone(jobId, guildId);
            const completedJob = repo.getJobById(jobId);
            assert.equal(completedJob.status, "COMPLETED", "Job transitions to COMPLETED once retry finishes");
            assert.equal(modeSwitchedToLive, true, "Guild switches to live mode only when all retries complete");
        } finally {
            GuildConfig.findOne = origFindOne;
            GuildConfig.updateOne = origUpdateOne;
        }
    });

    await t.test("32. P1/P2: postWebhookMessage aborts and throws webhook_request_timeout on request timeout", async () => {
        const origFetch = global.fetch;
        global.fetch = async (url, options) => {
            const abortErr = new Error("This operation was aborted");
            abortErr.name = "AbortError";
            throw abortErr;
        };

        try {
            await assert.rejects(
                async () => {
                    await postWebhookMessage("https://discord.com/api/webhooks/test/timeout", { content: "ping" });
                },
                (err) => {
                    assert.equal(err.code, "webhook_request_timeout");
                    assert.ok(err.message.includes("webhook_request_timeout"));
                    return true;
                },
                "postWebhookMessage must normalize AbortError into webhook_request_timeout"
            );
        } finally {
            global.fetch = origFetch;
        }
    });
});


