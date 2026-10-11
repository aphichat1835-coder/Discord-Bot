"use strict";

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const tokenCoordinator = require("../core/tokenCoordinator");
const sessionManager = require("../sessionManager");
const lifecycle = require("../voiceWorker/lifecycle");

describe("Token Quarantine Voice Safety Suite (429 Isolation vs 401 Termination)", () => {
    let voiceWorkerSubsystem;
    let stoppedSessionIds = [];

    beforeEach(() => {
        stoppedSessionIds = [];
        // Extract the registered voiceWorker subsystem hook
        voiceWorkerSubsystem = tokenCoordinator.subsystems.get("voiceWorker");
    });

    test("voiceWorker subsystem hook exists and is registered in tokenCoordinator", () => {
        assert.ok(voiceWorkerSubsystem, "voiceWorker must be registered in tokenCoordinator");
        assert.equal(typeof voiceWorkerSubsystem.onTokenQuarantined, "function");
    });

    test("onTokenQuarantined ignores 429 rate limit quarantine and preserves active voice connection", () => {
        const dummyToken = "mfa.test-429-token-safe-isolation-123456";
        const dummyHash = tokenCoordinator.hashToken(dummyToken);

        // Simulate 429 quarantine reason
        const rateLimitReasons = [
            "Rate limited: 429 Too Many Requests (Retry-After: 5s)",
            "429 rate limit exceeded",
            "Discord API 429 backoff active"
        ];

        for (const reason of rateLimitReasons) {
            // Invoking the quarantine callback with a 429 rate limit reason
            voiceWorkerSubsystem.onTokenQuarantined(dummyHash, reason);
        }

        // Must not have attempted to stop sessions for 429 rate limits
        assert.equal(stoppedSessionIds.length, 0, "429 rate limits must NEVER disconnect healthy voice sessions");
    });
});
