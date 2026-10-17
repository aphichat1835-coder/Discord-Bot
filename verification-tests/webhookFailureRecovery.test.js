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
    VerificationWebhookManager
} = require("../discord/verification/services/webhook/verificationWebhookManager");
const GuildConfig = require("../discord/verification/models/GuildConfig");
const VerifyLog = require("../discord/verification/models/VerifyLog");

test("Verification Webhook Failure Recovery & Reconciliation Suite", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-recov-test-"));
    const testDbPath = path.join(tempDir, "test.sqlite");

    const db = new Database(testDbPath);
    applyPragmas(db, { isNew: true });
    runStartupCheck(db, {
        dbPath: testDbPath,
        migrationsDir: path.resolve(__dirname, "../database/sqlite/migrations"),
        backupDir: path.join(tempDir, "backups"),
        assetDir: path.join(tempDir, "cache-assets")
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

    await t.test("1. VerifyLog schema persists webhookDelivery field and transitions cleanly", () => {
        const dummyDoc = new VerifyLog({
            guildId: "guild-test-111",
            userId: "user-test-111",
            result: "success",
            webhookDelivery: {
                status: "pending"
            }
        });

        assert.equal(dummyDoc.webhookDelivery.status, "pending");
        dummyDoc.webhookDelivery.status = "enqueued";
        dummyDoc.webhookDelivery.deliveryId = "del_guild-test-111_v1_123";
        assert.equal(dummyDoc.webhookDelivery.status, "enqueued");
        assert.equal(dummyDoc.webhookDelivery.deliveryId, "del_guild-test-111_v1_123");
    });

    await t.test("2. dispatchLiveEvent creates deterministic deliveryId and is idempotent on duplicate calls", async () => {
        const guildId = "999888777666555444";
        const userId = "111222333444555666";
        const logId = "60c72b2f9b1d8b0015f8e001";

        // Mock GuildConfig
        const origFindOne = GuildConfig.findOne;
        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => ({
                    lean: async () => ({
                        verification: {
                            webhookLog: {
                                enabled: true,
                                url: "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx",
                                destinationVersion: 1
                            }
                        }
                    })
                })
            })
        });

        const mockEventData = {
            _id: logId,
            guildId,
            userId,
            result: "success",
            roleAssignResult: { ok: true, roleId: "role-111" },
            verifiedAt: Date.now()
        };

        try {
            // First dispatch: should enqueue delivery
            const deliveryId1 = await manager.dispatchLiveEvent({
                guildId,
                userId,
                logId,
                eventData: mockEventData
            });

            assert.ok(deliveryId1);
            assert.equal(deliveryId1, `del_${guildId}_v1_${logId}`);

            const record1 = repo.getDeliveryById(deliveryId1);
            assert.ok(record1);
            assert.equal(record1.status, "PENDING");
            assert.equal(record1.event_id, logId);

            // Second dispatch with same event: idempotent, returns same deliveryId without error
            const deliveryId2 = await manager.dispatchLiveEvent({
                guildId,
                userId,
                logId,
                eventData: mockEventData
            });

            assert.equal(deliveryId2, deliveryId1);
            const record2 = repo.getDeliveryById(deliveryId1);
            assert.equal(record2.status, "PENDING");
        } finally {
            GuildConfig.findOne = origFindOne;
        }
    });

const mongoose = require("mongoose");

    await t.test("3. reconcilePendingVerifyLogs recovers pending logs from MongoDB and enqueues missing deliveries into SQLite", async () => {
        const guildId = "888777666555444333";
        const userId = "222333444555666777";
        const logId = "60c72b2f9b1d8b0015f8e002";

        const origReadyState = mongoose.connection.readyState;
        Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });

        const origFind = VerifyLog.find;
        const origUpdateOne = VerifyLog.updateOne;
        const origFindOne = GuildConfig.findOne;

        const updatedStatuses = [];

        // Mock VerifyLog.find returning a pending log that was never enqueued
        VerifyLog.find = () => ({
            sort: () => ({
                limit: () => ({
                    lean: async () => [{
                        _id: logId,
                        guildId,
                        userId,
                        result: "success",
                        roleAssignResult: { ok: true, roleId: "role-222" },
                        verifiedAt: Date.now() - 60000,
                        webhookDelivery: { status: "pending" }
                    }]
                })
            })
        });

        VerifyLog.updateOne = async (filter, update) => {
            updatedStatuses.push({ filter, update });
            return { acknowledged: true, modifiedCount: 1 };
        };

        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => ({
                    lean: async () => ({
                        verification: {
                            webhookLog: {
                                enabled: true,
                                url: "https://discord.com/api/webhooks/888777666555444333/abcdefghijklmnopqrstuvwx",
                                destinationVersion: 1
                            }
                        }
                    })
                })
            })
        });

        const origTrigger = manager.triggerWorker;
        manager.triggerWorker = () => {};

        try {
            // Prior to recovery, SQLite does NOT have this delivery
            const expectedDeliveryId = `del_${guildId}_v1_${logId}`;
            assert.equal(repo.getDeliveryById(expectedDeliveryId), null);

            // Run reconciliation
            const count = await manager.reconcilePendingVerifyLogs();
            assert.equal(count, 1);

            // SQLite now has the delivery enqueued!
            const enqueuedRecord = repo.getDeliveryById(expectedDeliveryId);
            assert.ok(enqueuedRecord);
            assert.equal(enqueuedRecord.status, "PENDING");
            assert.equal(enqueuedRecord.event_id, logId);

            // VerifyLog was updated to 'enqueued'
            const statusUpdate = updatedStatuses.find(u => u.update?.$set?.["webhookDelivery.status"] === "enqueued");
            assert.ok(statusUpdate, "VerifyLog should be transitioned to enqueued in MongoDB");
            assert.equal(statusUpdate.update.$set["webhookDelivery.deliveryId"], expectedDeliveryId);
        } finally {
            manager.triggerWorker = origTrigger;
            Object.defineProperty(mongoose.connection, "readyState", { value: origReadyState, configurable: true, writable: true });
            VerifyLog.find = origFind;
            VerifyLog.updateOne = origUpdateOne;
            GuildConfig.findOne = origFindOne;
        }
    });

    await t.test("4. reconcilePendingVerifyLogs marks delivered if SQLite already completed delivery", async () => {
        const guildId = "777666555444333222";
        const userId = "333444555666777888";
        const logId = "60c72b2f9b1d8b0015f8e003";
        const deliveryId = `del_${guildId}_v1_${logId}`;

        const origReadyState = mongoose.connection.readyState;
        Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true, writable: true });

        // Enqueue and mark SENT in SQLite beforehand
        repo.enqueueDelivery({
            deliveryId,
            guildId,
            destinationVersion: 1,
            eventId: logId,
            userId
        });
        repo.claimNextDeliveries(guildId, 1);
        repo.markDeliverySent(deliveryId, 1);

        const origFind = VerifyLog.find;
        const origUpdateOne = VerifyLog.updateOne;
        const origFindOne = GuildConfig.findOne;

        const updatedStatuses = [];

        VerifyLog.find = () => ({
            sort: () => ({
                limit: () => ({
                    lean: async () => [{
                        _id: logId,
                        guildId,
                        userId,
                        result: "success",
                        roleAssignResult: { ok: true },
                        verifiedAt: Date.now() - 30000,
                        webhookDelivery: { status: "pending" }
                    }]
                })
            })
        });

        VerifyLog.updateOne = async (filter, update) => {
            updatedStatuses.push({ filter, update });
            return { acknowledged: true, modifiedCount: 1 };
        };

        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => ({
                    lean: async () => ({
                        verification: {
                            webhookLog: {
                                enabled: true,
                                url: "https://discord.com/api/webhooks/777666555444333222/abcdefghijklmnopqrstuvwx",
                                destinationVersion: 1
                            }
                        }
                    })
                })
            })
        });

        try {
            await manager.reconcilePendingVerifyLogs();

            // Should detect delivery was already DELIVERED in SQLite and mark MongoDB as delivered
            const statusUpdate = updatedStatuses.find(u => u.update?.$set?.["webhookDelivery.status"] === "delivered");
            assert.ok(statusUpdate, "VerifyLog should be transitioned to delivered");
            assert.equal(statusUpdate.update.$set["webhookDelivery.deliveryId"], deliveryId);
        } finally {
            Object.defineProperty(mongoose.connection, "readyState", { value: origReadyState, configurable: true, writable: true });
            VerifyLog.find = origFind;
            VerifyLog.updateOne = origUpdateOne;
            GuildConfig.findOne = origFindOne;
        }
    });
});
