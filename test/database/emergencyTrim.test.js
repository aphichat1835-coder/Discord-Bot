"use strict";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const { executeEmergencyTrim } = require("../../database/sqlite/maintenance/emergencyTrim");
const {
    evaluateEmergencyThresholds,
    canSendAlert,
    recordAlertSent,
    resetAlertThrottle
} = require("../../database/sqlite/maintenance/quota");
const { AssetCacheManager } = require("../../database/sqlite/cache/assetCacheManager");

describe("Emergency Auto-Trim & Resilience Suite", () => {
    let db;
    let testAssetDir;

    before(() => {
        testAssetDir = path.join(__dirname, "test-emergency-assets");
        if (fs.existsSync(testAssetDir)) {
            fs.rmSync(testAssetDir, { recursive: true, force: true });
        }
        fs.mkdirSync(testAssetDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(testAssetDir)) {
            fs.rmSync(testAssetDir, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        runMigrations(db);
        resetAlertThrottle();
    });

    test("executeEmergencyTrim purges expired data while strictly protecting core operational records", async () => {
        const now = Date.now();
        const pastCutoff = now - (35 * 24 * 60 * 60 * 1000); // 35 days ago (past retention)
        const recent = now - (5 * 24 * 60 * 60 * 1000);     // 5 days ago (valid)

        // 1. Core Data: Scheduled Runners & Voice Session Runtime (INVIOLABLE)
        db.prepare(`
            INSERT INTO scheduled_runners (owner_id, guild_id, channel_id, account_id, token_ciphertext, token_iv, token_tag, token_salt, enabled, next_check_at, created_at, updated_at)
            VALUES ('owner_1', 'guild_1', 'chan_1', 'acc_1', 'enc', 'iv', 'tag', 'salt', 1, ?, ?, ?)
        `).run(now + 3600000, now, now);

        db.prepare(`
            INSERT INTO voice_session_runtime (session_id, server_id, owner_id, state, last_heartbeat, last_activity, reconnect_count, status_label, updated_at)
            VALUES ('session_core_01', 'guild_1', 'owner_1', 'active', ?, ?, 0, 'ready', ?)
        `).run(now, now, now);

        // 2. Cache Entries: 1 Expired, 1 Valid
        db.prepare(`
            INSERT INTO cache_entries (namespace, cache_key, payload_json, expires_at, created_at, updated_at, last_accessed_at)
            VALUES ('test', 'expired_key', '{"data":"old"}', ?, ?, ?, ?)
        `).run(now - 10000, now - 20000, now - 20000, now - 20000);

        db.prepare(`
            INSERT INTO cache_entries (namespace, cache_key, payload_json, expires_at, created_at, updated_at, last_accessed_at)
            VALUES ('test', 'valid_key', '{"data":"fresh"}', ?, ?, ?, ?)
        `).run(now + 600000, now, now, now);

        // 3. Verification Nonce: 1 Expired, 1 Valid
        db.prepare(`
            INSERT INTO verification_state_nonce (nonce_hash, guild_id, role_id, expires_at, created_at)
            VALUES ('nonce_expired', 'guild_1', 'role_1', ?, ?)
        `).run(now - 5000, now - 10000);

        db.prepare(`
            INSERT INTO verification_state_nonce (nonce_hash, guild_id, role_id, expires_at, created_at)
            VALUES ('nonce_valid', 'guild_1', 'role_1', ?, ?)
        `).run(now + 300000, now);

        // 4. History Events: Past Retention vs Recent
        db.prepare(`
            INSERT INTO command_events (command_name, actor_id, guild_id, status, duration_ms, occurred_at)
            VALUES ('help', 'u1', 'g1', 'success', 25, ?)
        `).run(pastCutoff);

        db.prepare(`
            INSERT INTO command_events (command_name, actor_id, guild_id, status, duration_ms, occurred_at)
            VALUES ('status', 'u1', 'g1', 'success', 15, ?)
        `).run(recent);

        // 5. Asset Cache: Expired vs Valid
        const assetMgr = new AssetCacheManager(db, { assetDir: testAssetDir });
        const buf = Buffer.from("dummy-image-bytes");
        assetMgr.setAsset("avatar_expired", buf, {
            assetType: "avatar",
            mimeType: "image/png",
            ttlMs: -5000 // already expired
        });

        assetMgr.setAsset("avatar_fresh", buf, {
            assetType: "avatar",
            mimeType: "image/png",
            ttlMs: 86400000 // 1 day valid
        });

        // Verify initial counts before trim
        assert.equal(db.prepare("SELECT count(*) as c FROM cache_entries").get().c, 2);
        assert.equal(db.prepare("SELECT count(*) as c FROM verification_state_nonce").get().c, 2);
        assert.equal(db.prepare("SELECT count(*) as c FROM command_events").get().c, 2);

        // Execute Emergency Auto-Trim
        const trimResult = await executeEmergencyTrim(db, {
            actor: "test_suite_operator",
            reason: "Simulated emergency storage alert"
        });

        assert.equal(trimResult.ok, true);
        assert.equal(trimResult.actor, "test_suite_operator");
        assert.equal(typeof trimResult.freedMb, "number");
        assert.equal(typeof trimResult.durationMs, "number");

        // Verify: Expired cache, nonce, history are purged
        const remainingCache = db.prepare("SELECT cache_key FROM cache_entries").all();
        assert.equal(remainingCache.length, 1);
        assert.equal(remainingCache[0].cache_key, "valid_key");

        const remainingNonces = db.prepare("SELECT nonce_hash FROM verification_state_nonce").all();
        assert.equal(remainingNonces.length, 1);
        assert.equal(remainingNonces[0].nonce_hash, "nonce_valid");

        const remainingCommands = db.prepare("SELECT command_name FROM command_events").all();
        assert.equal(remainingCommands.length, 1);
        assert.equal(remainingCommands[0].command_name, "status");

        // Verify: Core Data is strictly untouched
        const runners = db.prepare("SELECT id FROM scheduled_runners").all();
        assert.equal(runners.length, 1);
        assert.equal(runners[0].id, 1);

        const voiceRuntimes = db.prepare("SELECT session_id FROM voice_session_runtime").all();
        assert.equal(voiceRuntimes.length, 1);
        assert.equal(voiceRuntimes[0].session_id, "session_core_01");

        // Verify: maintenance_runs audit log recorded
        const auditLog = db.prepare("SELECT * FROM maintenance_runs WHERE run_type = 'emergency_trim'").get();
        assert.ok(auditLog, "Audit log for emergency_trim must exist");
        assert.equal(auditLog.run_type, "emergency_trim");
        const details = JSON.parse(auditLog.details_json);
        assert.equal(details.actor, "test_suite_operator");
        assert.equal(typeof details.durationMs, "number");
    });

    test("evaluateEmergencyThresholds correctly flags buffer overflow and WAL swelling", () => {
        // Normal state
        const normalEval = evaluateEmergencyThresholds(":memory:", { writeBufferCount: 50 });
        assert.equal(normalEval.isEmergency, false);
        assert.equal(normalEval.severity, "OK");

        // Buffer overflow >= 2000
        const bufferCrit = evaluateEmergencyThresholds(":memory:", { writeBufferCount: 2050 });
        assert.equal(bufferCrit.isEmergency, true);
        assert.ok(bufferCrit.reasons.some(r => r.includes("buffer queue overflow")));
    });

    test("canSendAlert respects 15-minute cooldown throttle per event category", () => {
        const eventKey = "storage_critical_alert";
        const t0 = 1000000;

        assert.equal(canSendAlert(eventKey, 15 * 60 * 1000, t0), true);
        recordAlertSent(eventKey, t0);

        // Immediate next check must be throttled
        assert.equal(canSendAlert(eventKey, 15 * 60 * 1000, t0 + 1000), false);
        assert.equal(canSendAlert(eventKey, 15 * 60 * 1000, t0 + (10 * 60 * 1000)), false);

        // After 15 minutes + 1ms, alert is allowed again
        assert.equal(canSendAlert(eventKey, 15 * 60 * 1000, t0 + (15 * 60 * 1000) + 1), true);
    });
});
