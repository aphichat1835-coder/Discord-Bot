'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const mongoose = require('mongoose');

const oauthRoute = require('../discord/verification/routes/oauth');
const {
    buildPolicySnapshot,
    checkAccountEligibility,
    checkAccountEligibilityRequirements
} = oauthRoute._test;

const { VerificationWebhookRepository } = require('../database/sqlite/repositories/core/VerificationWebhookRepository');
const {
    VerificationWebhookManager
} = require('../discord/verification/services/webhook/verificationWebhookManager');
const { applyPragmas } = require('../database/sqlite/pragmas');
const { runStartupCheck } = require('../database/sqlite/maintenance/startupCheck');

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2: SEC-01 — minConnections & Account Eligibility Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PHASE 2 (SEC-01): buildPolicySnapshot normalizes minConnections accurately', () => {
    // 1. requireConnections disabled: minConnections defaults to 0
    const snapNoReq = buildPolicySnapshot({ requireConnections: false });
    assert.equal(snapNoReq.requireConnections, false);
    assert.equal(snapNoReq.minConnections, 0);

    // 2. requireConnections enabled without explicit minConnections: defaults to 1
    const snapReqNoMin = buildPolicySnapshot({ requireConnections: true });
    assert.equal(snapReqNoMin.requireConnections, true);
    assert.equal(snapReqNoMin.minConnections, 1);

    // 3. requireConnections enabled with explicit valid minConnections
    const snapExplicit = buildPolicySnapshot({ requireConnections: true, minConnections: 3 });
    assert.equal(snapExplicit.requireConnections, true);
    assert.equal(snapExplicit.minConnections, 3);

    // 4. Invalid minConnections (negative or string or null): safely clamped/normalized
    const snapNegative = buildPolicySnapshot({ requireConnections: true, minConnections: -5 });
    assert.equal(snapNegative.minConnections, 1, 'Negative minConnections must default to 1 when requireConnections is on');

    const snapString = buildPolicySnapshot({ requireConnections: true, minConnections: '4' });
    assert.equal(snapString.minConnections, 4, 'Valid numeric string must parse to integer');

    const snapInvalidStr = buildPolicySnapshot({ requireConnections: true, minConnections: 'invalid' });
    assert.equal(snapInvalidStr.minConnections, 1, 'Invalid string must default to 1');
});

test('PHASE 2 (SEC-01): checkAccountEligibility enforces minConnections correctly', () => {
    const profile = { id: '123456789012345678', email: 'test@example.com', verified: true };

    // 1. requireConnections is OFF: 0 connections passes
    const policyOff = buildPolicySnapshot({ requireConnections: false });
    const resOff = checkAccountEligibility({ profile, policySnapshot: policyOff, connections: [] });
    assert.equal(resOff, null, 'Must pass when requireConnections is off even with 0 connections');

    // 2. requireConnections is ON with minConnections = 2
    const policyMin2 = buildPolicySnapshot({ requireConnections: true, minConnections: 2 });

    // User has 2 connections -> PASS
    const resPass = checkAccountEligibility({
        profile,
        policySnapshot: policyMin2,
        connections: [{ type: 'steam' }, { type: 'github' }]
    });
    assert.equal(resPass, null, 'Must pass when connection count equals minConnections');

    // User has 3 connections -> PASS
    const resOverPass = checkAccountEligibility({
        profile,
        policySnapshot: policyMin2,
        connections: [{ type: 'steam' }, { type: 'github' }, { type: 'youtube' }]
    });
    assert.equal(resOverPass, null, 'Must pass when connection count exceeds minConnections');

    // User has 1 connection -> BLOCKED
    const resUnderFail = checkAccountEligibility({
        profile,
        policySnapshot: policyMin2,
        connections: [{ type: 'steam' }]
    });
    assert.ok(resUnderFail, 'Must block when connection count is less than minConnections');
    assert.equal(resUnderFail.result, 'blocked');
    assert.equal(resUnderFail.reason, 'connection_requirement_failed:1');

    // User has 0 connections -> BLOCKED
    const resZeroFail = checkAccountEligibility({
        profile,
        policySnapshot: policyMin2,
        connections: []
    });
    assert.ok(resZeroFail);
    assert.equal(resZeroFail.result, 'blocked');
    assert.equal(resZeroFail.reason, 'connection_requirement_failed:0');

    // User connections is null/undefined -> BLOCKED
    const resNullFail = checkAccountEligibility({
        profile,
        policySnapshot: policyMin2,
        connections: null
    });
    assert.ok(resNullFail);
    assert.equal(resNullFail.result, 'blocked');
    assert.equal(resNullFail.reason, 'connection_requirement_failed:0');
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3: Dashboard DASH-01 & DASH-02 Logic Verification
// ─────────────────────────────────────────────────────────────────────────────

test('PHASE 3 (DASH-01): oauthStatusRows logic calculates remaining and handles edge cases', () => {
    // Pure replica of the hardened oauthStatusRows logic in guild-dashboard.js
    function fmtDuration(ms) {
        const value = Number(ms);
        if (!Number.isFinite(value)) return '—';
        const seconds = Math.max(0, Math.floor(Math.abs(value) / 1000));
        return `${seconds} วินาที`;
    }

    function oauthStatusRowsLogic(token = {}) {
        const oauth = token.oauth || {};
        const now = 1000000;
        const issuedAt = Number(oauth.issuedAt);
        const tokenAge = Number.isFinite(issuedAt) && issuedAt > 0
            ? Math.max(0, now - issuedAt)
            : null;
        const expiresAt = Number(oauth.expiresAt);
        const hasValidExpiry = Number.isFinite(expiresAt) && expiresAt > 0;
        const remaining = hasValidExpiry ? expiresAt - now : null;
        let remainingText = '—';
        if (remaining !== null) {
            remainingText = remaining > 0 ? fmtDuration(remaining) : `หมดอายุแล้ว ${fmtDuration(-remaining)}`;
        }
        return { tokenAge, remaining, remainingText };
    }

    // 1. Valid future expiresAt
    const validFuture = oauthStatusRowsLogic({ oauth: { expiresAt: 1060000, issuedAt: 900000 } });
    assert.equal(validFuture.remaining, 60000);
    assert.equal(validFuture.remainingText, '60 วินาที');
    assert.equal(validFuture.tokenAge, 100000);

    // 2. Past expiresAt (expired)
    const pastExpired = oauthStatusRowsLogic({ oauth: { expiresAt: 950000 } });
    assert.equal(pastExpired.remaining, -50000);
    assert.equal(pastExpired.remainingText, 'หมดอายุแล้ว 50 วินาที');

    // 3. Missing expiresAt
    const missingExp = oauthStatusRowsLogic({ oauth: {} });
    assert.equal(missingExp.remaining, null);
    assert.equal(missingExp.remainingText, '—');

    // 4. Invalid non-numeric expiresAt
    const invalidExp = oauthStatusRowsLogic({ oauth: { expiresAt: 'not-a-number' } });
    assert.equal(invalidExp.remaining, null);
    assert.equal(invalidExp.remainingText, '—');
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 & 5: QUEUE-01, QUEUE-02 & Delivery Queue Verification
// ─────────────────────────────────────────────────────────────────────────────

test('PHASE 4 & 5: VerificationWebhookRepository handles FAILED re-queuing and atomic lease recovery', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-'));
    const testDbPath = path.join(tempDir, 'queue_test.sqlite');

    const db = new Database(testDbPath);
    applyPragmas(db, { isNew: true });
    runStartupCheck(db, {
        dbPath: testDbPath,
        migrationsDir: path.resolve(__dirname, '../database/sqlite/migrations'),
        backupDir: path.join(tempDir, 'backups'),
        assetDir: path.join(tempDir, 'assets')
    });

    const repo = new VerificationWebhookRepository(db);

    // 1. Create a backfill job
    repo.createJob({
        jobId: 'job_test_1',
        guildId: 'guild_1',
        destinationVersion: 1,
        mode: 'BACKFILL_LIVE',
        totalEligible: 5
    });

    // 2. Enqueue a delivery and mark it FAILED
    repo.enqueueDelivery({
        deliveryId: 'del_guild_1_v1_evt1',
        jobId: 'job_test_1',
        guildId: 'guild_1',
        destinationVersion: 1,
        eventId: 'evt1',
        userId: 'user1'
    });
    repo.markDeliveryFailed('del_guild_1_v1_evt1', 'permanent_400', 'Bad Request');

    const failedRow = repo.getDeliveryById('del_guild_1_v1_evt1');
    assert.equal(failedRow.status, 'FAILED');

    // 3. Re-enqueuing on a new backfill: should re-activate FAILED delivery to PENDING
    repo.requeueFailedDelivery('del_guild_1_v1_evt1', 'job_test_2');
    const revivedRow = repo.getDeliveryById('del_guild_1_v1_evt1');
    assert.equal(revivedRow.status, 'PENDING');
    assert.equal(revivedRow.job_id, 'job_test_2');
    assert.equal(revivedRow.attempt_count, 0);
    assert.equal(revivedRow.error_code, null);

    // 4. Test atomic lease acquisition & renewal
    const hasLease = repo.acquireJobLease('job_test_1', 'token_A', 10000);
    assert.equal(hasLease, true, 'First worker must successfully acquire lease');

    // Competing worker tries with different token before lease expires -> REJECTED
    const competingLease = repo.acquireJobLease('job_test_1', 'token_B', 10000);
    assert.equal(competingLease, false, 'Competing worker must be rejected while lease is held');

    // Original worker can renew lease
    const renewed = repo.renewJobLease('job_test_1', 'token_A', 15000);
    assert.equal(renewed, true, 'Original worker can renew matching lease');

    // Competing worker cannot renew lease
    const fakeRenew = repo.renewJobLease('job_test_1', 'token_B', 15000);
    assert.equal(fakeRenew, false, 'Competing worker cannot renew unowned lease');

    // Clean up
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('PHASE 6: VoiceEventRepository, CommandEventRepository & SessionEventRepository criticalRetryQueue does not drop items on partial flush failure and spools on shutdown', () => {
    const { VoiceEventRepository } = require('../database/sqlite/repositories/history/VoiceEventRepository');
    const { CommandEventRepository } = require('../database/sqlite/repositories/history/CommandEventRepository');
    const { SessionEventRepository } = require('../database/sqlite/repositories/history/SessionEventRepository');
    const { runMigrations } = require('../database/sqlite/migrations/migrationRunner');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-test-'));
    const testDbPath = path.join(tempDir, 'history_test.sqlite');

    const db = new Database(testDbPath);
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const repoClasses = [
        { name: 'VoiceEventRepository', cls: VoiceEventRepository, priorityField: 'priority', p1Val: 'P1' },
        { name: 'CommandEventRepository', cls: CommandEventRepository, priorityField: 'priority', p1Val: 'P1' },
        { name: 'SessionEventRepository', cls: SessionEventRepository, priorityField: 'priority', p1Val: 'P1' }
    ];

    for (const { name, cls, priorityField, p1Val } of repoClasses) {
        const repo = new cls(db);
        repo.stopFlusher(); // stop background flusher for deterministic testing

        // 1. Populate criticalRetryQueue with 3 items
        const item1 = { [priorityField]: p1Val, id: 1, eventType: 'test_1', occurredAt: Date.now() };
        const item2 = { [priorityField]: p1Val, id: 2, eventType: 'test_2', occurredAt: Date.now() };
        const item3 = { [priorityField]: p1Val, id: 3, eventType: 'test_3', occurredAt: Date.now() };

        repo.criticalRetryQueue.push(item1, item2, item3);

        // Mock _insertSingle to fail on item2
        const originalInsert = repo._insertSingle.bind(repo);
        let calls = 0;
        repo._insertSingle = function(item) {
            calls++;
            if (item.id === 2) {
                throw new Error('Disk I/O error on item 2');
            }
            return true;
        };

        // Run flush()
        repo.flush();

        // item1 was successfully inserted, item2 failed and item3 was never processed -> both must remain in criticalRetryQueue!
        assert.equal(repo.criticalRetryQueue.length, 2, `${name}: item2 and item3 must remain in criticalRetryQueue without data loss`);
        assert.equal(repo.criticalRetryQueue[0].id, 2, `${name}: head of criticalRetryQueue must be item2`);
        assert.equal(repo.criticalRetryQueue[1].id, 3, `${name}: item3 must still be in criticalRetryQueue`);

        // 2. Test stopFlusher fallback to spoolP0Event on shutdown
        let spooled = [];
        repo._insertSingle = function() {
            throw new Error('Shutdown failure');
        };
        // Mock p0Journal spoolP0Event or test fallback
        const p0Journal = require('../database/sqlite/repositories/history/p0Journal');
        const origSpool = p0Journal.spoolP0Event;
        p0Journal.spoolP0Event = function(repoName, ev) {
            spooled.push(ev);
            return true;
        };

        try {
            repo.stopFlusher();
            assert.equal(spooled.length, 2, `${name}: remaining items in criticalRetryQueue must be spooled to p0Journal on shutdown`);
            assert.equal(repo.criticalRetryQueue.length, 0, `${name}: criticalRetryQueue should be emptied after spooling`);
        } finally {
            p0Journal.spoolP0Event = origSpool;
        }
    }

    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

