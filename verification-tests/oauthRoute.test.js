"use strict";

process.env.VERIFY_STATE_SECRET = "state-test-secret-value-1234567890";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const oauthRoute = require("../discord/verification/routes/oauth");
const {
    REDIRECT_URI,
    makeRequestId,
    jsonFail,
    sanitizeSideEffectError,
    validateCallbackStateNonce,
    buildPolicySnapshot,
    checkAccountEligibilityRequirements,
    checkAccountEligibility
} = oauthRoute._test;
const { encodeSignedState } = require("../discord/verification/utils/state");
const { registerVerificationState } = require("../discord/verification/services/verificationStateNonce");
const verificationOrchestrator = require("../discord/verification/services/verificationOrchestrator");
const discord = require("../discord/verification/utils/discordAPI");

function encodeState(obj) {
    return encodeSignedState({
        type: "verify-callback",
        guildId: obj.guildId,
        roleId: obj.roleId,
        expectedUserId: obj.userId || obj.expectedUserId,
        nonce: obj.nonce,
        ts: obj.ts || Date.now()
    });
}

function mockResponse() {
    const res = {
        statusCode: 200,
        sentJson: null,
        sentFile: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.sentJson = data;
            return this;
        },
        sendFile(filePath) {
            this.sentFile = filePath;
            return this;
        }
    };
    return res;
}

test("makeRequestId generates expected prefixes", () => {
    const req1 = makeRequestId();
    assert.match(req1, /^req_\d+_[a-f0-9]{8}$/);

    const req2 = makeRequestId("verify");
    assert.match(req2, /^verify_\d+_[a-f0-9]{8}$/);
});

test("jsonFail formats standard JSON failure response", () => {
    const res = mockResponse();
    const result = jsonFail(res, "ข้อผิดพลาด", "test_code", 400, "req_123");
    assert.equal(result, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.sentJson, {
        success: false,
        userMessage: "ข้อผิดพลาด",
        message: "ข้อผิดพลาด",
        code: "test_code",
        requestId: "req_123"
    });
});

test("sanitizeSideEffectError returns safe details or null", () => {
    assert.equal(sanitizeSideEffectError(null), null);
    assert.equal(sanitizeSideEffectError(undefined), null);

    const err = new Error("Something broke");
    err.code = "ERR_TEST";
    err.status = 500;
    const sanitized = sanitizeSideEffectError(err);
    assert.equal(sanitized.message, "Something broke");
    assert.equal(sanitized.code, "ERR_TEST");
    assert.equal(sanitized.status, 500);

    const strErr = sanitizeSideEffectError("raw string error");
    assert.equal(strErr.message, "raw string error");
});

test("validateCallbackStateNonce handles missing code, invalid state, and nonce replay", async () => {
    const res1 = mockResponse();
    const r1 = await validateCallbackStateNonce({}, res1, "req_1");
    assert.equal(r1.ok, false);
    assert.equal(res1.sentJson.code, "missing_oauth_code");

    const res2 = mockResponse();
    const r2 = await validateCallbackStateNonce({ code: "abc", state: "invalid-state" }, res2, "req_2");
    assert.equal(r2.ok, false);
    assert.equal(res2.sentJson.code, "invalid_callback_state");

    const stateObj = {
        guildId: "123456789012345678",
        roleId: "234567890123456789",
        userId: "345678901234567890",
        nonce: "unique-nonce-" + Date.now() + "-" + Math.random(),
        ts: Date.now() + 600000
    };
    await registerVerificationState(stateObj);

    const encodedState = encodeState(stateObj);

    // First consumption: ok
    const res3 = mockResponse();
    const r3 = await validateCallbackStateNonce({ code: "valid-code", state: encodedState }, res3, "req_3");
    assert.equal(r3.ok, true);
    assert.equal(r3.code, "valid-code");
    assert.equal(r3.stateObj.guildId, stateObj.guildId);

    // Second consumption: replayed
    const res4 = mockResponse();
    const r4 = await validateCallbackStateNonce({ code: "valid-code", state: encodedState }, res4, "req_4");
    assert.equal(r4.ok, false);
    assert.equal(res4.sentJson.code, "callback_state_replayed");
});

test("buildPolicySnapshot builds normalized snapshot with defaults and overrides", () => {
    const defaultSnap = buildPolicySnapshot();
    assert.equal(defaultSnap.enabled, true);
    assert.equal(defaultSnap.blockVPN, true);
    assert.equal(defaultSnap.blockHosting, false);
    assert.equal(defaultSnap.minConnections, 0);

    const customSnap = buildPolicySnapshot({
        enabled: false,
        blockVPN: false,
        blockHosting: true,
        minAccountAgeDays: 7,
        requireEmail: true,
        requireEmailVerified: true,
        requireConnections: true,
        minConnections: 3
    });
    assert.equal(customSnap.enabled, false);
    assert.equal(customSnap.blockVPN, false);
    assert.equal(customSnap.blockHosting, true);
    assert.equal(customSnap.minAccountAgeDays, 7);
    assert.equal(customSnap.requireEmail, true);
    assert.equal(customSnap.requireEmailVerified, true);
    assert.equal(customSnap.requireConnections, true);
    assert.equal(customSnap.minConnections, 3);
});

test("checkAccountEligibility evaluates account age, email, and connections", () => {
    // 1. Account age failure
    // Snowflake for 2026 is large, snowflake for 2020:
    const oldSnowflake = "700000000000000000";
    const newSnowflake = String((BigInt(Date.now() - 86400000) - 1420070400000n) << 22n); // ~1 day old

    const blockedAge = checkAccountEligibility({
        profile: { id: newSnowflake, email: "test@example.com", verified: true },
        policySnapshot: { minAccountAgeDays: 10, requireEmail: false },
        connections: []
    });
    assert.ok(blockedAge);
    assert.match(blockedAge.reason, /^new_account:/);

    // 2. Email requirement failure
    const blockedEmail = checkAccountEligibility({
        profile: { id: oldSnowflake, email: null, verified: false },
        policySnapshot: { minAccountAgeDays: 0, requireEmail: true },
        connections: []
    });
    assert.ok(blockedEmail);
    assert.equal(blockedEmail.reason, "email_requirement_failed");

    // 3. Email verified requirement failure
    const blockedEmailVerified = checkAccountEligibility({
        profile: { id: oldSnowflake, email: "test@example.com", verified: false },
        policySnapshot: { minAccountAgeDays: 0, requireEmailVerified: true },
        connections: []
    });
    assert.ok(blockedEmailVerified);
    assert.equal(blockedEmailVerified.reason, "email_requirement_failed");

    // 4. Connections requirement failure
    const blockedConnections = checkAccountEligibility({
        profile: { id: oldSnowflake, email: "test@example.com", verified: true },
        policySnapshot: { requireConnections: true, minConnections: 2 },
        connections: [{ type: "github" }]
    });
    assert.ok(blockedConnections);
    assert.equal(blockedConnections.reason, "connection_requirement_failed:1");

    // 5. Eligible passes
    const eligible = checkAccountEligibility({
        profile: { id: oldSnowflake, email: "test@example.com", verified: true },
        policySnapshot: { requireEmail: true, requireEmailVerified: true, requireConnections: true, minConnections: 1 },
        connections: [{ type: "github" }]
    });
    assert.equal(eligible, null);
});

test("GET /auth/callback serves callback.html", () => {
    const req = { method: "GET", url: "/auth/callback" };
    const res = mockResponse();

    // Find the get handler in router stack
    const layer = oauthRoute.stack.find(s => s.route?.path === "/auth/callback" && s.route.methods.get);
    assert.ok(layer, "GET /auth/callback route must exist");
    layer.handle(req, res);

    assert.ok(res.sentFile);
    assert.ok(res.sentFile.endsWith(path.join("views", "callback.html")));
});

test("POST /auth/callback handles validation failure, execution success, invalid grant, and generic errors", async () => {
    const layer = oauthRoute.stack.find(s => s.route?.path === "/auth/callback" && s.route.methods.post);
    assert.ok(layer, "POST /auth/callback route must exist");
    const handler = layer.route.stack[0].handle;

    // 1. Missing code
    const res1 = mockResponse();
    await handler({ method: "POST", body: {} }, res1);
    assert.equal(res1.sentJson.code, "missing_oauth_code");

    // 2. Successful orchestrator execution
    const origExecute = verificationOrchestrator.executeVerification;
    try {
        verificationOrchestrator.executeVerification = async () => ({
            statusCode: 200,
            body: { success: true, message: "ยืนยันตัวตนสำเร็จ" }
        });

        const stateObj = {
            guildId: "123456789012345678",
            roleId: "234567890123456789",
            userId: "345678901234567890",
            nonce: "nonce-success-" + Date.now(),
            ts: Date.now() + 600000
        };
        await registerVerificationState(stateObj);

        const res2 = mockResponse();
        await handler({
            method: "POST",
            body: { code: "valid-code", state: encodeState(stateObj) }
        }, res2);

        assert.equal(res2.statusCode, 200);
        assert.equal(res2.sentJson.success, true);

        // 3. Invalid grant error
        verificationOrchestrator.executeVerification = async () => {
            const err = new Error("invalid_grant");
            err.providerCode = "invalid_grant";
            throw err;
        };

        const stateObj2 = {
            guildId: "123456789012345678",
            roleId: "234567890123456789",
            userId: "345678901234567890",
            nonce: "nonce-grant-" + Date.now(),
            ts: Date.now() + 600000
        };
        await registerVerificationState(stateObj2);

        const res3 = mockResponse();
        await handler({
            method: "POST",
            body: { code: "expired-code", state: encodeState(stateObj2) }
        }, res3);
        assert.equal(res3.sentJson.code, "oauth_code_expired_or_used");

        // 4. Generic error
        verificationOrchestrator.executeVerification = async () => {
            throw new Error("Database timeout");
        };

        const stateObj3 = {
            guildId: "123456789012345678",
            roleId: "234567890123456789",
            userId: "345678901234567890",
            nonce: "nonce-generic-" + Date.now(),
            ts: Date.now() + 600000
        };
        await registerVerificationState(stateObj3);

        const res4 = mockResponse();
        await handler({
            method: "POST",
            body: { code: "generic-code", state: encodeState(stateObj3) }
        }, res4);
        assert.equal(res4.sentJson.code, "Database timeout");

    } finally {
        verificationOrchestrator.executeVerification = origExecute;
    }
});
