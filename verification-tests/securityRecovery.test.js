const assert = require("node:assert/strict");
const test = require("node:test");

const stateNonceModel = require("../discord/verification/models/VerificationStateNonce");
const stateNonce = require("../discord/verification/services/verificationStateNonce");
const auditStorage = require("../discord/logging/auditStorage");
const sensitiveAccess = require("../discord/verification/services/sensitiveAccessService");
const {
    evaluateCriticalPersistence,
    coordinatePersistenceFailure
} = require("../discord/verification/services/verificationPersistence");

const ACTOR_ID = "111111111111111111";
const GUILD_ID = "222222222222222222";
const USER_ID = "333333333333333333";
const ROLE_ID = "444444444444444444";

test("verification state nonce registration hashes the nonce and consumption is atomic", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const originalCreate = stateNonceModel.create;
    const originalFind = stateNonceModel.findOneAndUpdate;
    let created;
    let consumed = false;
    try {
        stateNonceModel.create = async record => {
            created = record;
            return record;
        };
        stateNonceModel.findOneAndUpdate = () => ({
            async lean() {
                if (consumed) return null;
                consumed = true;
                return { status: "consumed" };
            }
        });
        const state = {
            nonce: "single-use-secret",
            guildId: GUILD_ID,
            roleId: ROLE_ID,
            expectedUserId: USER_ID,
            panelRevision: "revision-1",
            ts: Date.now() + 60_000
        };
        assert.equal(await stateNonce.registerVerificationState(state), true);
        assert.notEqual(created.nonceHash, state.nonce);
        assert.equal(created.guildId, GUILD_ID);
        assert.equal(await stateNonce.consumeVerificationState(state), true);
        assert.equal(await stateNonce.consumeVerificationState(state), false);
    } finally {
        stateNonceModel.create = originalCreate;
        stateNonceModel.findOneAndUpdate = originalFind;
    }
});

test("Token/IP reveal requires audit but does not require owner-entered reason", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const originalSave = auditStorage.saveAuditRecord;
    const records = [];
    try {
        auditStorage.saveAuditRecord = async (_manager, record) => {
            records.push(record);
            return { eventId: `event-${records.length}` };
        };
        const revealed = await sensitiveAccess.revealSensitiveValue({
            actorId: ACTOR_ID,
            guildId: GUILD_ID,
            userId: USER_ID,
            valueType: "oauth_tokens",
            loader: async () => ({ accessToken: "decrypted-test-token" }),
            requestId: "sensitive-test"
        });
        assert.equal(revealed.accessToken, "decrypted-test-token");
        assert.equal(revealed.audit.status, "recorded");
        assert.deepEqual(records.map(record => record.metadata.phase), ["intent", "result"]);
        assert.equal(records[0].reason, "owner_dashboard_reveal:oauth_tokens");
    } finally {
        auditStorage.saveAuditRecord = originalSave;
    }
});

test("critical verification persistence failure rolls back a newly applied role and records recovery", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const evaluated = evaluateCriticalPersistence({
        oauthSaved: true,
        verifyLogSaved: false,
        trackingRequired: true,
        trackingSaved: true
    });
    assert.equal(evaluated.ok, false);

    const saved = [];
    let rollbackCalls = 0;
    const result = await coordinatePersistenceFailure({
        requestId: "verify-request",
        guildId: GUILD_ID,
        userId: USER_ID,
        roleId: ROLE_ID,
        result: "success",
        roleAssignResult: { ok: true, alreadyHadRole: false },
        persistence: evaluated.persistence,
        removeRole: async () => {
            rollbackCalls++;
            return { ok: true };
        },
        saveRecovery: async recovery => {
            saved.push(recovery);
            return true;
        },
        now: () => 123456
    });

    assert.equal(rollbackCalls, 1);
    assert.equal(result.rollbackSucceeded, true);
    assert.equal(result.manualReviewRequired, false);
    assert.equal(result.response.success, false);
    assert.equal(result.response.code, "verification_persistence_failed");
    assert.equal(saved[0].status, "role_rolled_back");
    assert.equal(saved[0].updatedAt, 123456);
});

test("failed rollback remains fail-closed and requires manual review", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = await coordinatePersistenceFailure({
        requestId: "verify-request-2",
        guildId: GUILD_ID,
        userId: USER_ID,
        roleId: ROLE_ID,
        result: "success",
        roleAssignResult: { ok: true, alreadyHadRole: false },
        persistence: { oauthUser: false, verifyLog: false, ipTracking: false },
        removeRole: async () => ({ ok: false }),
        saveRecovery: async () => true
    });
    assert.equal(result.rollbackSucceeded, false);
    assert.equal(result.manualReviewRequired, true);
    assert.equal(result.response.manualReviewRequired, true);
});
