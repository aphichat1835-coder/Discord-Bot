const assert = require("node:assert/strict");
const test = require("node:test");
const { VoiceConnectionStatus } = require("@discordjs/voice");

function manager(entries = []) {
    return { cache: new Map(entries) };
}

function channel(id, messageCount = 0) {
    return {
        id,
        messages: manager(Array.from({ length: messageCount }, (_, idx) => [`m${id}_${idx}`, { id: `m${id}_${idx}` }]))
    };
}

function guild(id, targetChannelId, selfUserId) {
    return {
        id,
        channels: manager([
            [targetChannelId, channel(targetChannelId, 2)],
            [`${id}_other_channel`, channel(`${id}_other_channel`, 2)]
        ]),
        members: manager([
            [selfUserId, { id: selfUserId }],
            [`${id}_member`, { id: `${id}_member` }]
        ]),
        voiceStates: manager([
            [selfUserId, { id: selfUserId, channelId: targetChannelId }],
            [`${id}_voice`, { id: `${id}_voice` }]
        ]),
        roles: manager([[`${id}_role`, {}]]),
        emojis: manager([[`${id}_emoji`, {}]]),
        presences: manager([[`${id}_presence`, {}]])
    };
}

test("voice lean cleanup keeps only target guild/channel and self identity", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const voiceWorker = require("../voiceWorker");
    const selfUserId = "self-user";
    const targetGuildId = "guild-target";
    const targetChannelId = "voice-target";
    const otherGuildId = "guild-other";
    const targetGuild = guild(targetGuildId, targetChannelId, selfUserId);
    const otherGuild = guild(otherGuildId, "other-voice", selfUserId);
    const targetChannel = targetGuild.channels.cache.get(targetChannelId);
    const otherChannel = otherGuild.channels.cache.get("other-voice");

    const client = {
        user: { id: selfUserId },
        guilds: manager([
            [targetGuildId, targetGuild],
            [otherGuildId, otherGuild]
        ]),
        channels: manager([
            [targetChannelId, targetChannel],
            ["other-voice", otherChannel],
            ["text-other", channel("text-other", 3)]
        ]),
        users: manager([
            [selfUserId, { id: selfUserId }],
            ["other-user", { id: "other-user" }]
        ])
    };

    const session = {
        sessionId: "vc_test_lean",
        serverId: targetGuildId,
        voiceId: targetChannelId,
        accountId: selfUserId
    };

    const summary = voiceWorker._test.cleanupLeanClientCache(client, session, "test");

    assert.equal(summary.before.guilds, 2);
    assert.equal(summary.after.guilds, 1);
    assert.equal(client.guilds.cache.has(targetGuildId), true);
    assert.equal(client.guilds.cache.has(otherGuildId), false);
    assert.deepEqual([...client.channels.cache.keys()], [targetChannelId]);
    assert.deepEqual([...targetGuild.channels.cache.keys()], [targetChannelId]);
    assert.deepEqual([...targetGuild.members.cache.keys()], [selfUserId]);
    assert.deepEqual([...targetGuild.voiceStates.cache.keys()], [selfUserId]);
    assert.equal(targetGuild.roles.cache.size, 0);
    assert.equal(targetGuild.emojis.cache.size, 0);
    assert.equal(targetGuild.presences.cache.size, 0);
    assert.equal(targetChannel.messages.cache.size, 0);
    assert.deepEqual([...client.users.cache.keys()], [selfUserId]);
});

test("ensureVoiceSession replaces an existing ready target session with the latest request", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const lifecycle = require("../voiceWorker/lifecycle");
    const token = "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.ccccccccccccccccccccccccccc";
    const guildId = "111111111111111111";
    const channelId = "222222222222222222";
    const oldSessionId = "vc_existing_target";
    const newSessionId = "vc_latest_target";
    const calls = [];
    const sessions = new Map([
        [newSessionId, { sessionId: newSessionId, lifecycleGeneration: "generation-latest" }]
    ]);

    const result = await lifecycle._test.ensureVoiceSessionInternal({
        token,
        guildId,
        channelId,
        ownerId: "owner",
        ownerTag: "Owner",
        reason: "test"
    }, {
        repairFailedStopSessionForTokenGuild: async () => ({ repaired: 0, blocked: 0 }),
        findActiveVoiceSessionByTokenGuild: () => ({
            id: oldSessionId,
            session: { sessionId: oldSessionId, serverId: guildId, voiceId: channelId }
        }),
        stopSession: async (sessionId, options) => {
            calls.push(["stop", sessionId, options.stoppedBy]);
            return true;
        },
        createSession: async (_token, serverId, voiceId, _guildName, ownerId) => {
            calls.push(["create", serverId, voiceId, ownerId]);
            return newSessionId;
        },
        getSession: sessionId => sessions.get(sessionId) || null,
        startSession: async (sessionId, suppliedToken) => {
            calls.push(["start", sessionId, suppliedToken]);
        },
        cleanupFailedEnsureSession: async () => {
            throw new Error("cleanup should not run for a successful replacement");
        }
    });

    assert.equal(result.ok, true);
    assert.equal(result.reused, false);
    assert.equal(result.replaced, true);
    assert.equal(result.replacedSessionId, oldSessionId);
    assert.equal(result.action, "replaced_by_latest_request");
    assert.equal(result.sessionId, newSessionId);
    assert.deepEqual(calls, [
        ["stop", oldSessionId, "owner"],
        ["create", guildId, channelId, "owner"],
        ["start", newSessionId, token]
    ]);
});

test("ensureVoiceSession resolves a duplicate create race by replacing the raced session", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const lifecycle = require("../voiceWorker/lifecycle");
    const token = "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.ccccccccccccccccccccccccccc";
    const guildId = "111111111111111111";
    const channelId = "222222222222222222";
    const racedSessionId = "vc_raced_target";
    const newSessionId = "vc_after_race";
    let lookupCount = 0;
    let createCount = 0;
    const stopped = [];
    const sessions = new Map([
        [newSessionId, { sessionId: newSessionId, lifecycleGeneration: "generation-after-race" }]
    ]);

    const result = await lifecycle._test.ensureVoiceSessionInternal({
        token,
        guildId,
        channelId,
        ownerId: "owner",
        ownerTag: "Owner",
        reason: "test_race"
    }, {
        repairFailedStopSessionForTokenGuild: async () => ({ repaired: 0, blocked: 0 }),
        findActiveVoiceSessionByTokenGuild: () => {
            lookupCount++;
            if (lookupCount === 1) return null;
            return {
                id: racedSessionId,
                session: { sessionId: racedSessionId, serverId: guildId, voiceId: channelId }
            };
        },
        stopSession: async sessionId => {
            stopped.push(sessionId);
            return true;
        },
        createSession: async () => {
            createCount++;
            if (createCount === 1) {
                const error = new Error("ALREADY_ACTIVE_IN_GUILD");
                error.code = "ALREADY_ACTIVE_IN_GUILD";
                throw error;
            }
            return newSessionId;
        },
        getSession: sessionId => sessions.get(sessionId) || null,
        startSession: async () => {},
        cleanupFailedEnsureSession: async () => {
            throw new Error("cleanup should not run after duplicate-race recovery");
        }
    });

    assert.equal(result.ok, true);
    assert.equal(result.replaced, true);
    assert.equal(result.replacedSessionId, racedSessionId);
    assert.equal(result.action, "replaced_by_latest_request");
    assert.equal(result.sessionId, newSessionId);
    assert.equal(createCount, 2);
    assert.deepEqual(stopped, [racedSessionId]);
});

test("ensureVoiceSession cleans up only the created generation when startup fails", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const lifecycle = require("../voiceWorker/lifecycle");
    const token = "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.ccccccccccccccccccccccccccc";
    const sessionId = "vc_failed_start";
    const cleaned = [];

    await assert.rejects(() => lifecycle._test.ensureVoiceSessionInternal({
        token,
        guildId: "111111111111111111",
        channelId: "222222222222222222",
        ownerId: "owner",
        reason: "startup_failure_test"
    }, {
        repairFailedStopSessionForTokenGuild: async () => ({ repaired: 0, blocked: 0 }),
        findActiveVoiceSessionByTokenGuild: () => null,
        createSession: async () => sessionId,
        getSession: id => id === sessionId
            ? { sessionId, lifecycleGeneration: "generation-created" }
            : null,
        startSession: async () => {
            throw new Error("START_FAILED");
        },
        cleanupFailedEnsureSession: async (...args) => cleaned.push(args)
    }), /START_FAILED/);

    assert.deepEqual(cleaned, [[
        sessionId,
        "owner",
        "startup_failure_test",
        "generation-created"
    ]]);
});
