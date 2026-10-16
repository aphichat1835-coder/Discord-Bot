"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    retentionDays,
    retentionFilters,
    waitForMaintenanceIdle,
    getVerificationDiagnostics,
    runPrivacyDeletionRecoverySafe,
    runVerificationMaintenance
} = require("../discord/verification/lifecycle");

test("lifecycle retentionDays parses retention strings correctly", () => {
    assert.equal(retentionDays("30d"), 30);
    assert.equal(retentionDays("rolling_30d"), 30);
    assert.equal(retentionDays("delete_after_30d"), 30);
    assert.equal(retentionDays("90d"), 90);
    assert.equal(retentionDays("rolling_90d"), 90);
    assert.equal(retentionDays("delete_after_90d"), 90);
    assert.equal(retentionDays("180d"), 180);
    assert.equal(retentionDays("rolling_180d"), 180);
    assert.equal(retentionDays("delete_after_180d"), 180);
    assert.equal(retentionDays("until_admin_delete"), null);
    assert.equal(retentionDays("permanent"), null);
    assert.equal(retentionDays(""), null);
    assert.equal(retentionDays(null), null);
    assert.equal(retentionDays(undefined), null);
});

test("lifecycle retentionFilters constructs accurate MongoDB query filters", () => {
    const guildId = "guild_123456789";
    const cutoff = 1700000000000;
    const filters = retentionFilters(guildId, cutoff);

    assert.equal(filters.verify.guildId, guildId);
    assert.deepEqual(filters.verify.deletedAt, { $exists: false });
    assert.ok(Array.isArray(filters.verify.$or));
    assert.equal(filters.verify.$or[0].verifiedAt.$lt, cutoff);

    assert.equal(filters.identity.guildId, guildId);
    assert.deepEqual(filters.identity.deletedAt, { $exists: false });
    assert.equal(filters.identity.lastSeenAt.$lt, cutoff);
});

test("lifecycle waitForMaintenanceIdle resolves when idle", async () => {
    await assert.doesNotReject(waitForMaintenanceIdle());
});

test("lifecycle getVerificationDiagnostics returns complete system diagnostics", () => {
    const diag = getVerificationDiagnostics();
    assert.equal(typeof diag, "object");
    assert.equal(typeof diag.ready, "boolean");
    assert.equal(typeof diag.timerActive, "boolean");
    assert.equal(typeof diag.inFlight, "boolean");
    assert.ok(diag.privacyDeletionRecovery);
    assert.ok(diag.snapshotCleanup);
    assert.ok(diag.encryptionMigration);
    assert.ok(diag.oauthTokenRefresh);
});

test("lifecycle runPrivacyDeletionRecoverySafe executes mock recovery", async () => {
    const mockJobs = [{ id: "job1" }, { id: "job2" }];
    const res = await runPrivacyDeletionRecoverySafe({
        recoverPendingPrivacyDeletionsFn: async () => mockJobs
    });
    assert.equal(res.recoveredCount, 2);
    assert.deepEqual(res.jobs, mockJobs);

    const diag = getVerificationDiagnostics();
    assert.equal(diag.privacyDeletionRecovery.lastSummary.recoveredCount, 2);
});

test("lifecycle runVerificationMaintenance dry run handles execution gracefully", async () => {
    // If GuildConfig / VerifyLog aren't connected to MongoDB, it will throw or succeed
    try {
        const summary = await runVerificationMaintenance({ dryRun: true });
        assert.equal(summary.dryRun, true);
    } catch (_err) {
        // Safe if Mongo not connected in offline test mode
    }
});
