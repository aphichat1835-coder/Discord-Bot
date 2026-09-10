"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createVoiceNotificationSystem, EVENTS } = require("../voiceWorker/notifications");
const { createVoiceSnapshot, buildVoiceEventEmbed, buildVoiceTrackerEmbed } = require("../voiceWorker/dm");
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
    const trackerCalls = [];
    const trackerEdits = [];
    let timestamp = 1_000_000;
    const manager = {
        getSession: id => sessions.get(id),
        getSetting: async () => "all",
        saveVoiceRuntimeState: async () => true
    };
    const fakeMessage = {
        id: "msg-tracker-1",
        channelId: "dm-channel-1",
        async edit(payload) {
            return payload;
        }
    };
    const dm = {
        createVoiceSnapshot,
        async sendVoiceEventDM(snapshot) { sent.push(snapshot); return { status: "sent" }; },
        async sendVoiceDigestDM(ownerId, items) { digests.push({ ownerId, items }); return { status: "sent" }; },
        async sendVoiceRecoveryTrackerDM(snapshot, state) {
            trackerCalls.push({ snapshot, state });
            return { status: "sent", message: fakeMessage };
        },
        async editVoiceRecoveryTrackerDM(trackerRef, snapshot, state) {
            trackerEdits.push({ trackerRef, snapshot, state });
            return { status: "updated" };
        }
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
        sessions, sent, digests, timers, trackerCalls, trackerEdits, fakeMessage, options,
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

test("disconnect triggers immediate notification and recovery summarizes outage duration", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeHarness();
    const system = createVoiceNotificationSystem(harness.options);
    await system.beginIncident("session-1");
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].type, EVENTS.VOICE_DISCONNECTED);

    harness.advance(30_000);
    const recovered = await system.markReady("session-1", { actualChannelId: "voice-session-1" });
    assert.equal(recovered.status, "sent");
    assert.equal(harness.sent.length, 2);
    assert.equal(harness.sent[1].type, EVENTS.SESSION_RECOVERED);
    assert.equal(harness.sent[1].outageDurationMs, 30_000);

    await system.beginIncident("session-1");
    assert.equal(harness.sent[2].type, EVENTS.VOICE_DISCONNECTED);

    const timer = harness.timers.at(-1);
    harness.advance(timer.delay);
    await timer.callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.sent[3].type, EVENTS.RECOVERY_DELAYED);

    harness.advance(10_000);
    await system.markReady("session-1", { actualChannelId: "voice-session-1" });
    assert.equal(harness.sent[4].type, EVENTS.SESSION_RECOVERED);
    assert.deepEqual(harness.sent.map(item => item.type), [
        EVENTS.VOICE_DISCONNECTED,
        EVENTS.SESSION_RECOVERED,
        EVENTS.VOICE_DISCONNECTED,
        EVENTS.RECOVERY_DELAYED,
        EVENTS.SESSION_RECOVERED
    ]);
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

test("buildVoiceTrackerEmbed formats all tracker phases with appropriate tone and fields", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = makeSession("track-test");
    const snapshot = createVoiceSnapshot(session, EVENTS.VOICE_DISCONNECTED, {
        verifiedAt: 1_000_000
    });

    const startEmbed = buildVoiceTrackerEmbed(snapshot, {
        phase: "starting",
        attempts: 0,
        maxAttempts: 15,
        openedAt: 1_000_000
    }).toJSON();
    assert.match(startEmbed.title, /กำลังกู้คืนช่องเสียงแบบเรียลไทม์/);
    assert.match(JSON.stringify(startEmbed.fields), /เริ่มกระบวนการกู้คืน/);

    const attemptEmbed = buildVoiceTrackerEmbed(snapshot, {
        phase: "attempt",
        attempts: 3,
        maxAttempts: 15,
        openedAt: 950_000,
        statusText: "กำลังลองเชื่อมต่อรอบที่ 3/15..."
    }).toJSON();
    assert.match(JSON.stringify(attemptEmbed.fields), /3\/15/);
    assert.match(JSON.stringify(attemptEmbed.fields), /กำลังลองเชื่อมต่อ/);

    const hibernateEmbed = buildVoiceTrackerEmbed(snapshot, {
        phase: "hibernate",
        cycle: 1,
        attempts: 15,
        maxAttempts: 15,
        openedAt: 900_000,
        statusText: "พักรอ 5 นาที"
    }).toJSON();
    assert.match(hibernateEmbed.title, /ช่วงพักกู้คืน/);
    assert.match(JSON.stringify(hibernateEmbed.fields), /พักรอบที่ 1\/2/);

    const recoveredEmbed = buildVoiceTrackerEmbed(snapshot, {
        phase: "recovered",
        attempts: 2,
        openedAt: 900_000
    }).toJSON();
    assert.match(recoveredEmbed.title, /กู้คืนการเชื่อมต่อสำเร็จเรียบร้อย/);
    assert.match(JSON.stringify(recoveredEmbed.fields), /ออนไลน์ในช่องเป้าหมาย/);

    const exhaustedEmbed = buildVoiceTrackerEmbed(snapshot, {
        phase: "exhausted",
        attempts: 15,
        openedAt: 800_000
    }).toJSON();
    assert.match(exhaustedEmbed.title, /กู้คืนไม่สำเร็จ/);
});

test("live recovery progress tracker sends on disconnect, edits on attempt, and finalizes on recovery", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = makeSession("track-session");
    const harness = makeHarness([session]);
    const system = createVoiceNotificationSystem(harness.options);

    await system.beginIncident(session.sessionId);
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].type, EVENTS.VOICE_DISCONNECTED);
    assert.equal(harness.trackerCalls.length, 1);
    assert.equal(harness.trackerCalls[0].state.phase, "starting");
    assert.equal(system.getDiagnostics().recoveryTrackers, 1);

    await system.recordRecoveryAttempt(session.sessionId);
    assert.equal(harness.trackerEdits.length, 1);
    assert.equal(harness.trackerEdits[0].state.phase, "attempt");
    assert.equal(harness.trackerEdits[0].state.attempts, 1);

    await system.recordRecoveryAttempt(session.sessionId);
    assert.equal(harness.trackerEdits.length, 2);
    assert.equal(harness.trackerEdits[1].state.phase, "attempt");
    assert.equal(harness.trackerEdits[1].state.attempts, 2);

    await system.markReady(session.sessionId, { actualChannelId: session.voiceId });
    assert.equal(harness.trackerEdits.length, 3);
    assert.equal(harness.trackerEdits[2].state.phase, "recovered");
    assert.equal(system.getDiagnostics().recoveryTrackers, 0);

    const summaryEvent = harness.sent.find(item => item.type === EVENTS.SESSION_RECOVERED);
    assert.ok(summaryEvent);
});

test("live recovery progress tracker edits on recordHibernateCycle", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = makeSession("hibernate-session");
    const harness = makeHarness([session]);
    const system = createVoiceNotificationSystem(harness.options);

    await system.beginIncident(session.sessionId);
    assert.equal(harness.trackerCalls.length, 1);

    await system.recordHibernateCycle(session.sessionId, 1, harness.options.now() + 300_000);
    assert.equal(harness.trackerEdits.length, 1);
    assert.equal(harness.trackerEdits[0].state.phase, "hibernate");
    assert.equal(harness.trackerEdits[0].state.cycle, 1);
});

test("live recovery progress tracker edits to exhausted on terminal failure", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = makeSession("exhausted-session");
    const harness = makeHarness([session]);
    const system = createVoiceNotificationSystem(harness.options);

    await system.beginIncident(session.sessionId);
    assert.equal(harness.trackerCalls.length, 1);

    await system.markTerminal(session.sessionId, EVENTS.RECOVERY_EXHAUSTED, { attempts: 15 });
    assert.equal(harness.trackerEdits.length, 1);
    assert.equal(harness.trackerEdits[0].state.phase, "exhausted");
    assert.equal(system.getDiagnostics().recoveryTrackers, 0);

    const exhaustedSent = harness.sent.find(item => item.type === EVENTS.RECOVERY_EXHAUSTED);
    assert.ok(exhaustedSent);
});
