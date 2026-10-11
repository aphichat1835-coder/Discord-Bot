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

    t.after(() => {
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
});
