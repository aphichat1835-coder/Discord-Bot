"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const lifecycle = require("../voiceWorker/lifecycle");
const notifications = require("../voiceWorker/notifications");

const {
    verifyTargetVoiceChannel,
    handlePreflightFailure,
    handleHibernateTransition
} = lifecycle._test;

test("preflight: validates voice channel existence and matching target ID", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const mockChannel = { id: "voice-123", isVoice: () => true };
    const mockTextChannel = { id: "text-456", isVoice: () => false };
    const mockGuild = {
        channels: {
            cache: new Map([
                ["voice-123", mockChannel],
                ["text-456", mockTextChannel]
            ])
        }
    };
    const mockClient = {
        isReady: () => true,
        guilds: {
            cache: new Map([["guild-999", mockGuild]])
        }
    };

    // Valid voice channel
    const validSession = { serverId: "guild-999", voiceId: "voice-123" };
    const validRes = await verifyTargetVoiceChannel(mockClient, validSession);
    assert.equal(validRes.ok, true);
    assert.equal(validRes.channel.id, "voice-123");

    // Missing voice channel
    const missingSession = { serverId: "guild-999", voiceId: "voice-missing" };
    const missingRes = await verifyTargetVoiceChannel(mockClient, missingSession);
    assert.equal(missingRes.ok, false);
    assert.equal(missingRes.reason, "CHANNEL_NOT_FOUND");

    // Non-voice channel
    const textSession = { serverId: "guild-999", voiceId: "text-456" };
    const textRes = await verifyTargetVoiceChannel(mockClient, textSession);
    assert.equal(textRes.ok, false);
    assert.equal(textRes.reason, "CHANNEL_NOT_FOUND");

    // Missing guild
    const noGuildSession = { serverId: "guild-other", voiceId: "voice-123" };
    const noGuildRes = await verifyTargetVoiceChannel(mockClient, noGuildSession);
    assert.equal(noGuildRes.ok, false);
    assert.equal(noGuildRes.reason, "GUILD_NOT_FOUND");
});

test("preflight failure: destroys dead connection, stops timers, sends terminal DM notification, and deletes session", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let connectionDestroyed = false;
    const session = {
        sessionId: "session-preflight-fail",
        serverId: "guild-1",
        voiceId: "voice-1",
        connection: { destroy() { connectionDestroyed = true; } },
        reconnecting: true
    };

    const calls = [];
    await handlePreflightFailure(session.sessionId, "hash-123", session, null, "channel_not_found", {
        stopNaturalTimer: id => calls.push(["natural", id]),
        stopAutoDeafTimer: id => calls.push(["autoDeaf", id]),
        clearReconnect: id => calls.push(["clear", id]),
        recoveryTimestamps: new Map([[session.sessionId, 1]]),
        markSessionFailed: async (id, reason) => calls.push(["failed", id, reason]),
        markTerminal: async (id, eventType) => calls.push(["terminal", id, eventType]),
        cleanupSessionClientIfUnused: () => calls.push(["cleanupClient"]),
        cleanupSessionNotification: id => calls.push(["cleanupNotif", id]),
        deleteSession: async id => calls.push(["deleteSession", id])
    });

    assert.equal(connectionDestroyed, true);
    assert.equal(session.connection, null);
    assert.equal(session.reconnecting, false);
    assert.deepEqual(calls, [
        ["natural", session.sessionId],
        ["autoDeaf", session.sessionId],
        ["clear", session.sessionId],
        ["failed", session.sessionId, "channel_not_found"],
        ["terminal", session.sessionId, "CHANNEL_NOT_FOUND"],
        ["cleanupClient"],
        ["cleanupNotif", session.sessionId],
        ["deleteSession", session.sessionId]
    ]);
});

test("hibernate transition: pauses for 5 mins on cycle 1, 10 mins on cycle 2, and destroys dead connection", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let connectionDestroyed = false;
    const session = {
        sessionId: "session-hibernate",
        serverId: "guild-1",
        voiceId: "voice-1",
        connection: { destroy() { connectionDestroyed = true; } },
        reconnecting: true
    };

    const recordedCycles = [];
    const timersScheduled = [];

    // Cycle 1: transition from 0 to 1 (5 minutes = 300,000 ms)
    await handleHibernateTransition(session.sessionId, "hash-123", session, 0, {
        recordHibernateCycle: async (id, cycle, until) => {
            recordedCycles.push({ id, cycle, until });
        },
        setTimeout: (fn, delayMs) => {
            timersScheduled.push(delayMs);
            return { unref: () => {} };
        }
    });

    assert.equal(connectionDestroyed, true);
    assert.equal(session.connection, null);
    assert.equal(session.reconnecting, false);
    assert.equal(recordedCycles.length, 1);
    assert.equal(recordedCycles[0].cycle, 1);
    assert.equal(timersScheduled[0], 5 * 60 * 1000);

    // Cycle 2: transition from 1 to 2 (10 minutes = 600,000 ms)
    await handleHibernateTransition(session.sessionId, "hash-123", session, 1, {
        recordHibernateCycle: async (id, cycle, until) => {
            recordedCycles.push({ id, cycle, until });
        },
        setTimeout: (fn, delayMs) => {
            timersScheduled.push(delayMs);
            return { unref: () => {} };
        }
    });

    assert.equal(recordedCycles.length, 2);
    assert.equal(recordedCycles[1].cycle, 2);
    assert.equal(timersScheduled[1], 10 * 60 * 1000);
});

test("markReady: resets attempts, hibernateCycle, and hibernateUntil upon successful channel entry", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const fakeSession = {
        sessionId: "session-reset-test",
        ownerId: "owner-1",
        voiceReadyAt: 0,
        reconnectCount: 5,
        recoveryState: {
            phase: "degraded",
            incidentId: "inc-1",
            openedAt: Date.now() - 10000,
            attempts: 12,
            hibernateCycle: 2,
            hibernateUntil: Date.now() + 600000,
            lifetimeAttempts: 12
        }
    };

    const notifSystem = notifications.createVoiceNotificationSystem({
        sessionManager: {
            getSession: () => fakeSession,
            saveVoiceRuntimeState: async () => true
        },
        dm: {
            sendSessionStoppedDM: async () => true
        }
    });

    await notifSystem.markReady("session-reset-test", {
        actualChannelId: "voice-123"
    });

    assert.equal(fakeSession.recoveryState.phase, "ready");
    assert.equal(fakeSession.recoveryState.attempts, 0);
    assert.equal(fakeSession.recoveryState.hibernateCycle, 0);
    assert.equal(fakeSession.recoveryState.hibernateUntil, null);
    assert.equal(fakeSession.reconnecting, false);
});
