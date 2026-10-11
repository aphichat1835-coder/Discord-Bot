"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const { CommandEventRepository, sanitizeDetails } = require("../../database/sqlite/repositories/history/CommandEventRepository");
const { SessionEventRepository } = require("../../database/sqlite/repositories/history/SessionEventRepository");

describe("Telemetry Buffers Suite (Command & Session Events)", () => {
    let testDb;

    before(() => {
        testDb = new Database(":memory:");
        testDb.pragma("foreign_keys = ON");
        runMigrations(testDb);
    });

    after(() => {
        if (testDb) testDb.close();
    });

    test("sanitizeDetails: recursively redacts sensitive credentials and bounds depth", () => {
        const payload = {
            username: "safe_user",
            token: "super_secret_discord_token_here",
            adminPassword: "secret_password",
            api_key: "12345-67890",
            nested: {
                pin: "1234",
                normalKey: "ok_value",
                secretToken: "secret"
            }
        };

        const cleaned = sanitizeDetails(payload);
        assert.equal(cleaned.username, "safe_user");
        assert.equal(cleaned.token, "[REDACTED]");
        assert.equal(cleaned.adminPassword, "[REDACTED]");
        assert.equal(cleaned.api_key, "[REDACTED]");
        assert.equal(cleaned.nested.pin, "[REDACTED]");
        assert.equal(cleaned.nested.secretToken, "[REDACTED]");
        assert.equal(cleaned.nested.normalKey, "ok_value");
    });

    test("CommandEventRepository: records command usage, redacts sensitive options, and flushes on threshold", () => {
        const repo = new CommandEventRepository(testDb);

        // Record 99 events
        for (let i = 0; i < 99; i++) {
            repo.record({
                commandName: "ping",
                actorId: `user_${i}`,
                guildId: "guild_123",
                status: "success",
                durationMs: 15,
                details: { token: "secret", foo: "bar" }
            });
        }

        const statsBefore = repo.getBufferStats();
        assert.equal(statsBefore.bufferedCount, 99);

        // 100th event triggers flush
        repo.record({
            commandName: "ping",
            actorId: "user_100",
            guildId: "guild_123",
            status: "success",
            durationMs: 20,
            details: { password: "admin_pass", option1: "value1" }
        });

        const statsAfter = repo.getBufferStats();
        assert.equal(statsAfter.bufferedCount, 0);

        const recent = repo.findRecent(10);
        assert.ok(recent.length > 0);
        assert.equal(recent[0].commandName, "ping");
        assert.equal(recent[0].details.password, "[REDACTED]");
        assert.equal(recent[0].details.option1, "value1");

        repo.stopFlusher();
    });

    test("SessionEventRepository: records token and lifecycle events with safe identifiers", () => {
        const repo = new SessionEventRepository(testDb);

        repo.record({
            sessionId: "session_abc_123",
            accountId: "user_789",
            eventType: "rate_limit_429",
            metadata: {
                subsystem: "voiceWorker",
                backoffSeconds: 10,
                token: "leaked_secret" // should be redacted!
            }
        });

        repo.flush();

        const recent = repo.findRecent(5);
        assert.ok(recent.length > 0);
        assert.equal(recent[0].sessionId, "session_abc_123");
        assert.equal(recent[0].eventType, "rate_limit_429");
        assert.equal(recent[0].metadata.subsystem, "voiceWorker");
        assert.equal(recent[0].metadata.token, "[REDACTED]");

        repo.stopFlusher();
    });

    test("Buffer cap protection: drops oldest events on overflow without crashing", () => {
        const repo = new CommandEventRepository(testDb);
        repo.maxQueueCap = 120;
        repo.flushSizeThreshold = 500;

        for (let i = 0; i < 130; i++) {
            repo.record({ commandName: "test", actorId: "u1" });
        }

        const stats = repo.getBufferStats();
        assert.equal(stats.isDegraded, true);
        assert.ok(stats.droppedEventsCount > 0);

        repo.stopFlusher();
    });

    test("Priority-aware drop: P0 writes immediately to SQLite, P2 is dropped before P1", () => {
        const repo = new SessionEventRepository(testDb);
        repo.stopFlusher();
        repo.maxQueueCap = 10;
        repo.flushSizeThreshold = 100;

        // 1. P0 event: should NOT enter buffer, must be written directly
        repo.record({
            sessionId: "p0_session",
            eventType: "security_alert",
            priority: "P0"
        });
        assert.equal(repo.buffer.length, 0, "P0 event must not be buffered");

        const p0Row = testDb.prepare("SELECT * FROM session_events WHERE event_type = 'security_alert'").get();
        assert.ok(p0Row, "P0 event must be immediately persisted to SQLite");
        assert.equal(p0Row.session_id, "p0_session");

        // 2. Queue 5 P1 events (high priority) and 5 P2 events (low priority)
        for (let i = 0; i < 5; i++) {
            repo.buffer.push({ priority: "P1", occurredAt: Date.now(), sessionId: `p1_${i}`, eventType: "session_quarantine" });
        }
        for (let i = 0; i < 5; i++) {
            repo.buffer.push({ priority: "P2", occurredAt: Date.now(), sessionId: `p2_${i}`, eventType: "ping_metric" });
        }
        assert.equal(repo.buffer.length, 10);

        // 3. Overflow buffer by adding one more item (dropTarget = floor(10/4) = 2)
        repo.record({
            sessionId: "new_metric",
            eventType: "verbose_ping",
            priority: "P2"
        });

        // Exactly 2 P2 items should have been evicted; all 5 P1 items must still be present!
        assert.equal(repo.droppedEventsCount, 2);
        const p1Remaining = repo.buffer.filter(item => item.priority === "P1");
        assert.equal(p1Remaining.length, 5, "All P1 items must be preserved over P2 during eviction");

        repo.stopFlusher();
    });

    test("TokenCoordinator: emits source=rest_api and records retryAfter without interrupting voice", () => {
        const { TokenCoordinator } = require("../../discord/core/tokenCoordinator");
        const coordinator = new TokenCoordinator();

        let emittedEvent = null;
        coordinator.on("token:rate_limited", (evt) => {
            emittedEvent = evt;
        });

        // Trigger REST 429 backoff
        coordinator.applyTokenBackoff("dummy_test_token_12345", 5000);

        assert.ok(emittedEvent, "token:rate_limited event must be emitted");
        assert.equal(emittedEvent.source, "rest_api", "Must tag source as rest_api");
        assert.ok(emittedEvent.backoffSeconds >= 5, "Must compute retry backoff seconds");

        // Token is in backoff, but token is NOT quarantined or destroyed
        const isQuarantined = coordinator.isQuarantined("dummy_test_token_12345");
        assert.equal(isQuarantined, false, "REST 429 must not quarantine token");
    });
});
