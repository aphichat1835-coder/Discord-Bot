"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const channelLock = require("../voiceWorker/channelLock");
const { VoiceConnectionStatus } = require("@discordjs/voice");
const lifecycle = require("../voiceWorker/lifecycle");

test("channelLock ignores voice state updates for other users", () => {
    const client = { user: { id: "self-bot-1" } };
    const oldState = { channelId: "target-vc" };
    const newState = { id: "other-user", channelId: "other-vc", guild: { id: "guild-1" } };

    const result = channelLock.handleVoiceStateUpdate("session-1", client, oldState, newState);
    assert.equal(result, false);
});

test("channelLock ignores voice state updates for different guilds", () => {
    const client = { user: { id: "self-bot-1" } };
    const session = { serverId: "guild-1", voiceId: "target-vc", state: "active" };
    const oldState = { channelId: "target-vc" };
    const newState = { id: "self-bot-1", channelId: "other-vc", guild: { id: "guild-2" } };

    const result = channelLock.handleVoiceStateUpdate("session-1", client, oldState, newState, {
        getSession: () => session,
        isSessionRunnable: () => true
    });
    assert.equal(result, false);
});

test("channelLock ignores full disconnect (channelId null)", () => {
    const client = { user: { id: "self-bot-1" } };
    const session = { serverId: "guild-1", voiceId: "target-vc", state: "active" };
    const oldState = { channelId: "target-vc" };
    const newState = { id: "self-bot-1", channelId: null, guild: { id: "guild-1" } };

    const result = channelLock.handleVoiceStateUpdate("session-1", client, oldState, newState, {
        getSession: () => session,
        isSessionRunnable: () => true
    });
    assert.equal(result, false);
});

test("channelLock ignores if already in target channel", () => {
    const client = { user: { id: "self-bot-1" } };
    const session = { serverId: "guild-1", voiceId: "target-vc", state: "active" };
    const oldState = { channelId: "other-vc" };
    const newState = { id: "self-bot-1", channelId: "target-vc", guild: { id: "guild-1" } };

    const result = channelLock.handleVoiceStateUpdate("session-1", client, oldState, newState, {
        getSession: () => session,
        isSessionRunnable: () => true
    });
    assert.equal(result, false);
});

test("channelLock triggers immediate flyback and trailing debounce DM when bot is moved", async () => {
    channelLock.cancelMoveTracking("session-test-move");

    let rejoined = null;
    const mockConn = {
        state: { status: VoiceConnectionStatus.Ready },
        rejoin: config => { rejoined = config; }
    };
    const session = {
        sessionId: "session-test-move",
        ownerId: "owner-123",
        serverId: "guild-1",
        serverName: "Test Server",
        voiceId: "target-vc",
        voiceName: "Lobby",
        state: "active",
        connection: mockConn
    };
    const client = { user: { id: "self-bot-1", tag: "SelfBot#0001" } };

    const dmsSent = [];
    const deps = {
        getSession: () => session,
        isSessionRunnable: () => true,
        debounceMs: 50, // Short debounce for test
        sendDm: async payload => {
            dmsSent.push(payload);
            return { ok: true };
        }
    };

    // Move 1: Moved to afk-vc
    const res1 = channelLock.handleVoiceStateUpdate("session-test-move", client,
        { channelId: "target-vc", channel: { name: "Lobby" } },
        { id: "self-bot-1", channelId: "afk-vc", channel: { name: "AFK" }, guild: { id: "guild-1" } },
        deps
    );
    assert.equal(res1, true);
    assert.deepEqual(rejoined, { channelId: "target-vc", selfMute: true, selfDeaf: true });

    let tracking = channelLock.getMoveTracking("session-test-move");
    assert.equal(tracking.moveCount, 1);
    assert.equal(tracking.lastMovedToChannelId, "afk-vc");

    // Move 2: Moved again to gaming-vc before debounce expires
    const res2 = channelLock.handleVoiceStateUpdate("session-test-move", client,
        { channelId: "afk-vc", channel: { name: "AFK" } },
        { id: "self-bot-1", channelId: "gaming-vc", channel: { name: "Gaming" }, guild: { id: "guild-1" } },
        deps
    );
    assert.equal(res2, true);

    tracking = channelLock.getMoveTracking("session-test-move");
    assert.equal(tracking.moveCount, 2);
    assert.equal(tracking.lastMovedToChannelId, "gaming-vc");
    assert.equal(tracking.lastMovedToChannelName, "Gaming");

    // Before debounce expires, no DM should be sent yet!
    assert.equal(dmsSent.length, 0);

    // Wait for the debounce timer (50ms) to complete
    await new Promise(resolve => setTimeout(resolve, 80));

    // DM should now have been sent!
    assert.equal(dmsSent.length, 1);
    assert.equal(dmsSent[0].recipientId, "owner-123");
    assert.equal(dmsSent[0].category, "voice");

    const embed = dmsSent[0].payload.embeds[0];
    const data = embed.data || embed;
    assert.match(data.title, /ตรวจพบการย้ายห้องเสียง/);
    assert.match(data.fields.find(f => f.name.includes("จำนวนครั้ง")).value, /2/);
    assert.match(data.fields.find(f => f.name.includes("ห้องที่โดนลากไป")).value, /Gaming/);

    // Tracking should be cleared after DM is sent
    assert.equal(channelLock.getMoveTracking("session-test-move"), null);
});

test("cancelMoveTracking clears timer and pending tracking data", () => {
    channelLock.cancelMoveTracking("session-cancel-test");

    const session = {
        sessionId: "session-cancel-test",
        ownerId: "owner-456",
        serverId: "guild-1",
        voiceId: "target-vc",
        state: "active"
    };
    const client = { user: { id: "self-bot-1" } };

    channelLock.handleVoiceStateUpdate("session-cancel-test", client,
        { channelId: "target-vc" },
        { id: "self-bot-1", channelId: "other-vc", guild: { id: "guild-1" } },
        { getSession: () => session, isSessionRunnable: () => true }
    );

    assert.notEqual(channelLock.getMoveTracking("session-cancel-test"), null);
    const canceled = channelLock.cancelMoveTracking("session-cancel-test");
    assert.equal(canceled, true);
    assert.equal(channelLock.getMoveTracking("session-cancel-test"), null);
});

test("health check rejoins target channel if bot is found in wrong channel", () => {
    let rejoined = null;
    const mockConn = {
        state: { status: VoiceConnectionStatus.Ready },
        rejoin: config => { rejoined = config; }
    };
    const session = {
        sessionId: "session-health-check-wrong-channel",
        serverId: "guild-1",
        voiceId: "target-vc",
        connection: mockConn,
        client: { isReady: () => true }
    };

    const deps = {
        isSessionRunnable: () => true,
        getSessionTokenHash: () => "hash-123",
        getSessionClientFromPool: () => session.client,
        touchSession: () => {},
        getSelfVoiceStateInfo: () => ({
            inspectable: true,
            inTargetGuild: true,
            inTargetChannel: false,
            channelId: "wrong-channel"
        })
    };

    const result = lifecycle._test.processSessionHealthCheck(
        "session-health-check-wrong-channel",
        session,
        Date.now(),
        deps
    );

    assert.equal(result, false);
    assert.deepEqual(rejoined, { channelId: "target-vc", selfMute: true, selfDeaf: true });
});
