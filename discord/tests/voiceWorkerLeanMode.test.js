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

test("voice lean cleanup keeps only target guild/channel and self identity", () => {
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

test("ensureVoiceSession reuses an existing ready target session", async () => {
    const voiceWorker = require("../voiceWorker");
    const sessionManager = require("../sessionManager");
    const token = "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.ccccccccccccccccccccccccccc";
    const guildId = "111111111111111111";
    const channelId = "222222222222222222";
    const sessionId = "vc_existing_target";
    const old = {
        hashToken: sessionManager.hashToken,
        findActiveVoiceSessionByTokenGuild: sessionManager.findActiveVoiceSessionByTokenGuild,
        getSession: sessionManager.getSession,
        touchSession: sessionManager.touchSession,
        createSession: sessionManager.createSession
    };
    const session = {
        sessionId,
        serverId: guildId,
        voiceId: channelId,
        accountId: "self-user",
        ownerId: "owner",
        state: "active",
        client: {
            user: { id: "self-user" },
            guilds: manager(),
            channels: manager([[channelId, channel(channelId, 1)]]),
            users: manager([["self-user", { id: "self-user" }]])
        },
        connection: {
            state: { status: VoiceConnectionStatus.Ready },
            joinConfig: { channelId }
        }
    };
    const targetChannel = { id: channelId, name: "Voice", isVoice: () => true };
    const targetGuild = {
        id: guildId,
        name: "Target Guild",
        channels: {
            cache: new Map([[channelId, targetChannel]]),
            fetch: async () => targetChannel
        }
    };
    const client = {
        guilds: {
            cache: new Map([[guildId, targetGuild]]),
            fetch: async () => targetGuild
        }
    };

    try {
        voiceWorker.setMainClient(client);
        sessionManager.hashToken = () => "token-hash";
        sessionManager.findActiveVoiceSessionByTokenGuild = () => ({ id: sessionId, session });
        sessionManager.getSession = () => session;
        sessionManager.touchSession = id => {
            assert.equal(id, sessionId);
            session.touched = true;
            return session;
        };
        sessionManager.createSession = async () => {
            throw new Error("createSession should not be called for an existing ready session");
        };

        const result = await voiceWorker.ensureVoiceSession({
            token,
            guildId,
            channelId,
            ownerId: "owner",
            ownerTag: "Owner",
            reason: "test"
        });

        assert.equal(result.ok, true);
        assert.equal(result.reused, true);
        assert.equal(result.action, "already_active");
        assert.equal(result.sessionId, sessionId);
        assert.equal(session.touched, true);
    } finally {
        Object.assign(sessionManager, old);
        voiceWorker.setMainClient(null);
    }
});

test("ensureVoiceSession treats duplicate create race as existing session reuse", async () => {
    const voiceWorker = require("../voiceWorker");
    const sessionManager = require("../sessionManager");
    const token = "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.ccccccccccccccccccccccccccc";
    const guildId = "111111111111111111";
    const channelId = "222222222222222222";
    const sessionId = "vc_raced_target";
    const old = {
        hashToken: sessionManager.hashToken,
        findActiveVoiceSessionByTokenGuild: sessionManager.findActiveVoiceSessionByTokenGuild,
        getSession: sessionManager.getSession,
        touchSession: sessionManager.touchSession,
        createSession: sessionManager.createSession
    };
    const session = {
        sessionId,
        serverId: guildId,
        voiceId: channelId,
        accountId: "self-user",
        ownerId: "owner",
        state: "active",
        client: {
            user: { id: "self-user" },
            guilds: manager(),
            channels: manager(),
            users: manager([["self-user", { id: "self-user" }]])
        },
        connection: {
            state: { status: VoiceConnectionStatus.Ready },
            joinConfig: { channelId }
        }
    };
    const targetChannel = { id: channelId, name: "Voice", isVoice: () => true };
    const targetGuild = {
        id: guildId,
        name: "Target Guild",
        channels: {
            cache: new Map([[channelId, targetChannel]]),
            fetch: async () => targetChannel
        }
    };
    const client = {
        guilds: {
            cache: new Map([[guildId, targetGuild]]),
            fetch: async () => targetGuild
        }
    };
    let lookupCount = 0;

    try {
        voiceWorker.setMainClient(client);
        sessionManager.hashToken = () => "token-hash";
        sessionManager.findActiveVoiceSessionByTokenGuild = () => {
            lookupCount++;
            return lookupCount === 1 ? null : { id: sessionId, session };
        };
        sessionManager.getSession = () => session;
        sessionManager.touchSession = () => session;
        sessionManager.createSession = async () => {
            throw new Error("ALREADY_ACTIVE_IN_GUILD");
        };

        const result = await voiceWorker.ensureVoiceSession({
            token,
            guildId,
            channelId,
            ownerId: "owner",
            ownerTag: "Owner",
            reason: "test_race"
        });

        assert.equal(result.ok, true);
        assert.equal(result.reused, true);
        assert.equal(result.raced, true);
        assert.equal(result.action, "already_active");
        assert.equal(result.sessionId, sessionId);
    } finally {
        Object.assign(sessionManager, old);
        voiceWorker.setMainClient(null);
    }
});
