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
});
