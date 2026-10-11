"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { openDatabase, closeDatabase } = require("../../database/sqlite/connection");
const VerificationStateNonceRepository = require("../../database/sqlite/repositories/temp/VerificationStateNonceRepository");
const VerificationStateNonce = require("../../discord/verification/models/VerificationStateNonce");

const TEST_DB_PATH = path.join(__dirname, `test_nonce_${Date.now()}_${process.pid}.sqlite`);
const genHash = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

describe("VerificationStateNonceRepository & Facade Tests", () => {
    let db;
    let repo;

    before(() => {
        closeDatabase();
        db = openDatabase({ path: TEST_DB_PATH });
        const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
        runMigrations(db);
        repo = new VerificationStateNonceRepository(db);
    });

    after(() => {
        closeDatabase();
        try {
            if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
            const wal = `${TEST_DB_PATH}-wal`;
            const shm = `${TEST_DB_PATH}-shm`;
            if (fs.existsSync(wal)) fs.unlinkSync(wal);
            if (fs.existsSync(shm)) fs.unlinkSync(shm);
        } catch (_) {}
    });

    test("create nonce and find by hash/id", () => {
        const hash = genHash("create");
        const nonceData = {
            nonceHash: hash,
            guildId: "111222333444",
            roleId: "999888777",
            expectedUserId: "555666777",
            panelRevision: "rev_1",
            status: "pending",
            expiresAt: Date.now() + 60000
        };

        const created = repo.create(nonceData);
        assert.ok(created);
        assert.equal(created.nonceHash, hash);
        assert.equal(created.guildId, "111222333444");
        assert.equal(created.status, "pending");

        const foundByHash = repo.findByNonceHash(hash);
        assert.ok(foundByHash);
        assert.equal(foundByHash.id, created.id);

        const exists = repo.exists({ nonceHash: hash });
        assert.equal(exists, true);

        const count = repo.countDocuments({ guildId: "111222333444" });
        assert.ok(count >= 1);
    });

    test("duplicate nonceHash throws code 11000", () => {
        const hash = genHash("dup");
        repo.create({
            nonceHash: hash,
            guildId: "111222333444",
            roleId: "999888777",
            expiresAt: Date.now() + 60000
        });

        assert.throws(() => {
            repo.create({
                nonceHash: hash, // Duplicate
                guildId: "111222333444",
                roleId: "999888777",
                expiresAt: Date.now() + 60000
            });
        }, (err) => {
            return err.code === 11000 && err.message.includes("duplicate key");
        });
    });

    test("atomic consume succeeds once and fails on replay", () => {
        const hash = genHash("consume");
        repo.create({
            nonceHash: hash,
            guildId: "111222333444",
            roleId: "999888777",
            status: "pending",
            expiresAt: Date.now() + 60000
        });

        const consumedFirst = repo.consume({
            nonceHash: hash,
            guildId: "111222333444",
            roleId: "999888777",
            now: Date.now()
        });
        assert.equal(consumedFirst, true);

        // Replay attempt must fail (atomic consume)
        const consumedSecond = repo.consume({
            nonceHash: hash,
            guildId: "111222333444",
            roleId: "999888777",
            now: Date.now()
        });
        assert.equal(consumedSecond, false);

        const current = repo.findByNonceHash(hash);
        assert.equal(current.status, "consumed");
        assert.ok(current.consumedAt);
    });

    test("expired nonce cannot be consumed", () => {
        const hash = genHash("expired");
        repo.create({
            nonceHash: hash,
            guildId: "111222333444",
            roleId: "999888777",
            status: "pending",
            expiresAt: Date.now() - 5000 // Already expired
        });

        const consumed = repo.consume({
            nonceHash: hash,
            guildId: "111222333444",
            roleId: "999888777",
            now: Date.now()
        });
        assert.equal(consumed, false);
    });

    test("cleanExpired purges expired nonces", () => {
        const hash = genHash("to_clean");
        repo.create({
            nonceHash: hash,
            guildId: "111222333444",
            roleId: "999888777",
            status: "pending",
            expiresAt: Date.now() - 1000
        });

        const deleted = repo.cleanExpired(Date.now());
        assert.ok(deleted >= 1);

        const shouldBeNull = repo.findByNonceHash(hash);
        assert.equal(shouldBeNull, null);
    });

    test("facade integration (create, exists, findOneAndUpdate)", async () => {
        const uniqueHash = genHash("facade");
        const data = {
            nonceHash: uniqueHash,
            guildId: "111222333444",
            roleId: "999888777",
            status: "pending",
            expiresAt: Date.now() + 60000
        };

        await VerificationStateNonce.create(data);

        const exists = await VerificationStateNonce.exists({ nonceHash: uniqueHash });
        assert.equal(exists, true);

        const found = await VerificationStateNonce.findOne({ nonceHash: uniqueHash }).lean();
        assert.ok(found);
        assert.equal(found.nonceHash, uniqueHash);

        const updateResult = await VerificationStateNonce.findOneAndUpdate({
            nonceHash: uniqueHash,
            guildId: "111222333444",
            roleId: "999888777"
        }, {}, {}).lean();

        assert.ok(updateResult);
        assert.equal(updateResult.status, "consumed");

        // Second consume via facade must return null
        const updateReplay = await VerificationStateNonce.findOneAndUpdate({
            nonceHash: uniqueHash,
            guildId: "111222333444",
            roleId: "999888777"
        }, {}, {}).lean();

        assert.equal(updateReplay, null);
    });
});
