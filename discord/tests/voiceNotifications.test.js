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
