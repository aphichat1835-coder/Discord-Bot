"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createVoiceNotificationSystem, EVENTS } = require("../voiceWorker/notifications");
const { createVoiceSnapshot, buildVoiceEventEmbed } = require("../voiceWorker/dm");
const sessionManager = require("../sessionManager");

function makeSession(id = "session-1", ownerId = "owner-1") {
    return {
        sessionId: id,
        ownerId,
        state: "active",
        lifecycleGeneration: `generation-${id}`,
        serverId: `guild-${id}`,
        serverName: `Guild ${id}`,
        voiceId: `voice-${id}`,
        voiceName: `Voice ${id}`,
        accountId: `account-${id}`,
        accountName: `Account ${id}`,
        notificationState: { events: {} },
        recoveryState: { phase: "ready", incidentId: null, attempts: 0, lifetimeAttempts: 0 }
    };
}

function makeHarness(sessionList = [makeSession()]) {
    const sessions = new Map(sessionList.map(session => [session.sessionId, session]));
    const sent = [];
    const digests = [];
    const timers = [];
    let timestamp = 1_000_000;
    const manager = {
        getSession: id => sessions.get(id),
        getSetting: async () => "all",
        saveVoiceRuntimeState: async () => true
    };
    const dm = {
        createVoiceSnapshot,
        async sendVoiceEventDM(snapshot) { sent.push(snapshot); return { status: "sent" }; },
        async sendVoiceDigestDM(ownerId, items) { digests.push({ ownerId, items }); return { status: "sent" }; }
    };
    const options = {
        sessionManager: manager,
        dm,
        now: () => timestamp,
        randomUUID: (() => { let id = 0; return () => `incident-${++id}`; })(),
        setTimer(callback, delay) {
            const timer = { callback, delay, unref() {} };
            timers.push(timer);
            return timer;
        },
        clearTimer(timer) { timer.cleared = true; }
    };
    return {
        sessions, sent, digests, timers, options,
        advance(ms) { timestamp += ms; }
    };
}

test("500 concurrent copies of one voice event produce one DM", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeHarness();
    const system = createVoiceNotificationSystem(harness.options);
    const results = await Promise.all(Array.from({ length: 500 }, () =>
        system.emit("session-1", EVENTS.TOKEN_INVALID, { incidentId: "same-failure" })
    ));

    assert.equal(harness.sent.length, 1);
    assert.equal(results.filter(result => result.status === "sent").length, 500);
    assert.equal(system.getDiagnostics().coalesced, 499);
});

test("persisted event reservation prevents a duplicate after worker restart", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeHarness();
    const first = createVoiceNotificationSystem(harness.options);
    await first.emit("session-1", EVENTS.TOKEN_INVALID, { incidentId: "token-failure" });
    const restarted = createVoiceNotificationSystem(harness.options);
    const result = await restarted.emit("session-1", EVENTS.TOKEN_INVALID, { incidentId: "token-failure" });

    assert.equal(harness.sent.length, 1);
    assert.equal(result.reason, "duplicate");
});

test("concurrent terminal transitions notify exactly once", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeHarness();
    const system = createVoiceNotificationSystem(harness.options);
    await Promise.all(Array.from({ length: 100 }, () =>
        system.markTerminal("session-1", EVENTS.RECOVERY_EXHAUSTED)
    ));

    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].type, EVENTS.RECOVERY_EXHAUSTED);
});

test("invalid-token sessions cannot run or auto-resume", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = { state: "active", tokenInvalid: true };
    assert.equal(sessionManager.isSessionRunnable(session), false);
    assert.equal(sessionManager.shouldResumeSession(session), false);
});

test("important-only mode avoids a redundant DM when the actor already saw stop result", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeHarness();
    harness.options.sessionManager.getSetting = async () => "important_only";
    const system = createVoiceNotificationSystem(harness.options);
    const result = await system.emit("session-1", EVENTS.SESSION_STOPPED_MANUAL, {
        incidentId: "manual-stop",
        actorNotified: true
    });

    assert.equal(result.reason, "policy");
    assert.equal(harness.sent.length, 0);
});

test("owner notification budget combines excess session events into one digest", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sessions = Array.from({ length: 20 }, (_, index) => makeSession(`session-${index}`, "same-owner"));
    const harness = makeHarness(sessions);
    const system = createVoiceNotificationSystem(harness.options);
    await Promise.all(sessions.map(session => system.emit(session.sessionId, EVENTS.SESSION_READY)));

    assert.equal(harness.sent.length, 3);
    assert.equal(system.getDiagnostics().digested, 17);
    await system.flushDigest("same-owner");
    assert.equal(harness.digests.length, 1);
    assert.equal(harness.digests[0].items.length, 17);
});

test("brief disconnect recovers silently but a delayed incident sends recovery updates", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeHarness();
    const system = createVoiceNotificationSystem(harness.options);
    await system.beginIncident("session-1");
    harness.advance(30_000);
    const brief = await system.markReady("session-1", { actualChannelId: "voice-session-1" });
    assert.equal(brief.reason, "brief_recovery");
    assert.equal(harness.sent.length, 0);

    await system.beginIncident("session-1");
    const timer = harness.timers.at(-1);
    harness.advance(timer.delay);
    await timer.callback();
    await new Promise(resolve => setImmediate(resolve));
    harness.advance(10_000);
    await system.markReady("session-1", { actualChannelId: "voice-session-1" });
    assert.deepEqual(harness.sent.map(item => item.type), [EVENTS.RECOVERY_DELAYED, EVENTS.SESSION_RECOVERED]);
});

test("voice embed reports explicit verified state without exposing a token", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = { ...makeSession(), token: "secret-token-value" };
    const snapshot = createVoiceSnapshot(session, EVENTS.SESSION_RECOVERED, {
        actualChannelId: session.voiceId,
        outageDurationMs: 90_000,
        attempts: 2
    });
    const embed = buildVoiceEventEmbed(snapshot).toJSON();
    const serialized = JSON.stringify(embed);

    assert.match(serialized, /ยืนยันแล้วว่าออนไลน์ในช่องเป้าหมาย/);
    assert.match(serialized, /90|1 นาที/);
    assert.doesNotMatch(serialized, /secret-token-value/);
});

test("voice notification rejects unknown event types without mutating dynamic records", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeHarness();
    const system = createVoiceNotificationSystem(harness.options);
    const result = await system.emit("session-1", "__proto__", { incidentId: "unsafe" });

    assert.deepEqual(result, { status: "skipped", reason: "invalid_event_type" });
    assert.equal(harness.sent.length, 0);
    assert.equal(Object.hasOwn(harness.sessions.get("session-1").notificationState.events, "__proto__"), false);
});

test("voice notification normalizes persisted event records and keeps history bounded", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = makeSession();
    Object.defineProperty(session.notificationState.events, "__proto__", {
        value: { status: "malicious", at: 1 },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(session.notificationState.events, "bad\nkey", {
        value: { status: "malicious", at: 2 },
        enumerable: true,
        configurable: true
    });
    const harness = makeHarness([session]);
    harness.options.config = { eventHistoryMax: 2, ownerBudgetMax: 20 };
    const system = createVoiceNotificationSystem(harness.options);

    await system.emit("session-1", EVENTS.SESSION_READY, { incidentId: "one" });
    await system.emit("session-1", EVENTS.TOKEN_INVALID, { incidentId: "two" });
    await system.emit("session-1", EVENTS.LOGIN_FAILED, { incidentId: "three" });

    const events = session.notificationState.events;
    assert.equal(Object.getPrototypeOf(events), null);
    assert.equal(Object.hasOwn(events, "__proto__"), false);
    assert.equal(Object.hasOwn(events, "bad\nkey"), false);
    assert.equal(Object.keys(events).length, 2);
});

test("critical voice events bypass the routine owner digest budget", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sessions = Array.from({ length: 5 }, (_, index) => makeSession(`critical-${index}`, "same-owner"));
    const harness = makeHarness(sessions);
    harness.options.config = { ownerBudgetMax: 1 };
    const system = createVoiceNotificationSystem(harness.options);

    await system.emit(sessions[0].sessionId, EVENTS.SESSION_READY);
    await system.emit(sessions[1].sessionId, EVENTS.SESSION_READY);
    await system.emit(sessions[2].sessionId, EVENTS.TOKEN_INVALID);

    assert.deepEqual(harness.sent.map(item => item.type), [EVENTS.SESSION_READY, EVENTS.TOKEN_INVALID]);
    assert.equal(system.getDiagnostics().digested, 1);
});

test("failed digest delivery keeps its items for a later retry", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sessions = Array.from({ length: 3 }, (_, index) => makeSession(`digest-${index}`, "digest-owner"));
    const harness = makeHarness(sessions);
    harness.options.config = { ownerBudgetMax: 1 };
    let calls = 0;
    harness.options.dm.sendVoiceDigestDM = async (_ownerId, items) => {
        calls++;
        harness.digests.push(items.map(item => item.sessionId));
        return calls === 1 ? { status: "failed" } : { status: "sent" };
    };
    const system = createVoiceNotificationSystem(harness.options);
    for (const session of sessions) await system.emit(session.sessionId, EVENTS.SESSION_READY);

    await system.flushDigest("digest-owner");
    await system.flushDigest("digest-owner");

    assert.equal(calls, 2);
    assert.deepEqual(harness.digests[1], harness.digests[0]);
});

test("recovery notification preserves the prior online duration", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = makeSession();
    session.voiceReadyAt = 900_000;
    const harness = makeHarness([session]);
    const system = createVoiceNotificationSystem(harness.options);
    await system.beginIncident(session.sessionId);
    const timer = harness.timers.at(-1);
    harness.advance(timer.delay);
    await timer.callback();
    await new Promise(resolve => setImmediate(resolve));
    harness.advance(30_000);
    await system.markReady(session.sessionId, { actualChannelId: session.voiceId });

    const recovered = harness.sent.find(item => item.type === EVENTS.SESSION_RECOVERED);
    assert.ok(recovered.onlineDurationMs > 0);
});
