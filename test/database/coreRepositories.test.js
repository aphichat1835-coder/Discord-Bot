"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Database = require("better-sqlite3");

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const DmNotificationRepository = require("../../database/sqlite/repositories/core/DmNotificationRepository");
const VerificationRecoveryRepository = require("../../database/sqlite/repositories/core/VerificationRecoveryRepository");

describe("Core SQLite Repositories Suite", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let db;
    let dmRepo;
    let recoveryRepo;

    before(() => {
        db = new Database(":memory:");
        const migrationsDir = path.resolve(__dirname, "../../database/sqlite/migrations");
        runMigrations(db, { migrationsDir });

        dmRepo = new DmNotificationRepository(db);
        recoveryRepo = new VerificationRecoveryRepository(db);
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
});
