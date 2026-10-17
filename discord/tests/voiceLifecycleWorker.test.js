"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { VoiceConnectionStatus } = require("@discordjs/voice");

const {
    getVoiceGroup,
    destroyConnectionObject,
    resolveSelfMember,
    resolveVoiceChannelId,
    getSelfVoiceStateInfo,
    waitForSelfVoiceExit,
    waitForTargetVoice,
    verifyCleanupState,
    cleanupSessionVoiceConnection
} = require("../voiceWorker/lifecycleCleanup");

const {
    clearHibernateTimer,
    resolveHibernatePauseMs,
    resolveMaxHibernateCycles,
    isSessionEligibleForRecovery,
    checkRecoveryAttemptLimits,
    isSessionConnectionReady,
    isOnRecoveryCooldown,
    advanceHibernationState,
    safeRejoinConnection,
    handleWrongChannelState,
    cleanupIdleSessions
} = require("../voiceWorker/lifecycleRecovery");

test("Voice Lifecycle: lifecycleCleanup helper contracts", async (t) => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    await t.test("getVoiceGroup resolves user:guild identifier", () => {
        assert.equal(getVoiceGroup(null, null), null);
        assert.equal(getVoiceGroup({ user: { id: "u123" } }, null), null);
        assert.equal(getVoiceGroup(null, "g456", { accountId: "u123" }), "u123:g456");
        assert.equal(getVoiceGroup({ user: { id: "u123" } }, "g456"), "u123:g456");
    });

    await t.test("destroyConnectionObject destroys active and ignores destroyed connections", () => {
        assert.equal(destroyConnectionObject(null), false);

        const destroyedConn = { state: { status: VoiceConnectionStatus.Destroyed }, destroy() {} };
        assert.equal(destroyConnectionObject(destroyedConn), false);

        let destroyed = false;
        const activeConn = {
            state: { status: VoiceConnectionStatus.Ready },
            destroy() { destroyed = true; }
        };
        assert.equal(destroyConnectionObject(activeConn), true);
        assert.equal(destroyed, true);
    });

    await t.test("resolveSelfMember and resolveVoiceChannelId contracts", () => {
        assert.equal(resolveSelfMember(null, "u1"), null);
        assert.equal(resolveSelfMember({}, null), null);

        const guildWithMe = { members: { me: { id: "u1" } } };
        assert.equal(resolveSelfMember(guildWithMe, "u1").id, "u1");

        const guildWithCache = {
            members: {
                cache: new Map([["u2", { id: "u2" }]])
            }
        };
        assert.equal(resolveSelfMember(guildWithCache, "u2").id, "u2");

        assert.equal(resolveVoiceChannelId(null, null), null);
        assert.equal(resolveVoiceChannelId({ channelId: "c1" }, null), "c1");
        assert.equal(resolveVoiceChannelId({ channel: { id: "c2" } }, null), "c2");
        assert.equal(resolveVoiceChannelId(null, { channelId: "c3" }), "c3");
    });

    await t.test("getSelfVoiceStateInfo accurately reflects channel matches", () => {
        const infoEmpty = getSelfVoiceStateInfo(null, null);
        assert.equal(infoEmpty.inspectable, false);
        assert.equal(infoEmpty.inTargetChannel, false);

        const mockClient = {
            user: { id: "u1" },
            guilds: {
                cache: new Map([
                    ["g1", {
                        members: {
                            me: { voice: { channelId: "v1" } }
                        }
                    }]
                ])
            }
        };

        const infoMatching = getSelfVoiceStateInfo(mockClient, { serverId: "g1", voiceId: "v1" });
        assert.equal(infoMatching.inspectable, true);
        assert.equal(infoMatching.inTargetChannel, true);
        assert.equal(infoMatching.channelId, "v1");

        const infoMismatch = getSelfVoiceStateInfo(mockClient, { serverId: "g1", voiceId: "v2" });
        assert.equal(infoMismatch.inTargetChannel, false);
    });

    await t.test("waitForSelfVoiceExit returns quickly when exit occurs", async () => {
        const mockClient = {
            user: { id: "u1" },
            guilds: {
                cache: new Map([
                    ["g1", {
                        members: { me: { voice: { channelId: "v1" } } }
                    }]
                ])
            }
        };
        const session = { serverId: "g1", voiceId: "v1" };

        setTimeout(() => {
            const g = mockClient.guilds.cache.get("g1");
            if (g?.members?.me?.voice) g.members.me.voice.channelId = null;
        }, 30);

        const res = await waitForSelfVoiceExit(mockClient, session, 400);
        assert.equal(res.inTargetChannel, false);
    });

    await t.test("waitForTargetVoice identifies target connection", async () => {
        const mockClient = {
            user: { id: "u1" },
            guilds: {
                cache: new Map([["g1", {}]])
            }
        };
        const session = { serverId: "g1", voiceId: "v1" };
        const conn = {
            state: { status: VoiceConnectionStatus.Ready },
            joinConfig: { channelId: "v1" }
        };

        const res = await waitForTargetVoice(mockClient, session, 50, conn);
        assert.equal(res.inTargetChannel, true);
        assert.equal(res.channelSource, "connection_state");
    });

    await t.test("verifyCleanupState reports verification and errors", () => {
        const errors = [];
        const stateClean = verifyCleanupState(null, null, { inTargetChannel: false, inspectable: true }, errors, { isReady: () => true });
        assert.equal(stateClean.ok, true);
        assert.equal(stateClean.verified, true);
        assert.equal(stateClean.reason, "cleanup_verified");

        const dirtyErrors = [];
        const fakeAliveConn = { state: { status: VoiceConnectionStatus.Ready } };
        const stateDirty = verifyCleanupState(fakeAliveConn, fakeAliveConn, { inTargetChannel: true }, dirtyErrors, null);
        assert.equal(stateDirty.ok, false);
        assert.equal(stateDirty.reason, "cleanup_not_confirmed");
        assert.match(stateDirty.safeError, /voiceRegistry:still_active/);
    });

    await t.test("cleanupSessionVoiceConnection tears down session cleanly", async () => {
        let destroyed = false;
        const fakeConn = {
            state: { status: VoiceConnectionStatus.Ready },
            destroy() {
                destroyed = true;
                this.state.status = VoiceConnectionStatus.Destroyed;
            }
        };
        const session = {
            serverId: "g1",
            voiceId: "v1",
            connection: fakeConn
        };

        const result = await cleanupSessionVoiceConnection("s1", session, "hash1");
        assert.equal(destroyed, true);
        assert.equal(result.ok, true);
        assert.equal(session.connection, null);
    });
});

test("Voice Lifecycle: lifecycleRecovery helper contracts", async (t) => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    await t.test("Hibernate timer and pause durations", () => {
        clearHibernateTimer("non_existent_session");

        assert.equal(resolveHibernatePauseMs(1), 5 * 60 * 1000);
        assert.equal(resolveHibernatePauseMs(2), 10 * 60 * 1000);
        assert.equal(resolveHibernatePauseMs(3), 5 * 60 * 1000);

        assert.equal(resolveMaxHibernateCycles({ maxHibernateCycles: 4 }), 4);
        assert.equal(resolveMaxHibernateCycles({ recordRecoveryAttempt: true }), 0);
        assert.equal(resolveMaxHibernateCycles({}), Infinity);
    });

    await t.test("isSessionEligibleForRecovery evaluates runnable state and shutdown", () => {
        assert.equal(isSessionEligibleForRecovery(null, () => false, () => true), false);
        assert.equal(isSessionEligibleForRecovery({ state: "active" }, () => true, () => true), false);
        assert.equal(isSessionEligibleForRecovery({ state: "active" }, () => false, () => false), false);
        assert.equal(isSessionEligibleForRecovery({ state: "active" }, () => false, () => true), true);

        const hibernatingSession = {
            recoveryState: { phase: "hibernate", hibernateUntil: Date.now() + 100000 }
        };
        assert.equal(isSessionEligibleForRecovery(hibernatingSession, () => false, () => true), false);
    });

    await t.test("checkRecoveryAttemptLimits boundaries", async () => {
        const deps = {
            recordRecoveryAttempt: () => ({ reached: false, attempts: 2 })
        };
        const canRecover = await checkRecoveryAttemptLimits("s1", "h1", { reconnectCount: 2 }, deps, 5);
        assert.equal(canRecover, true);

        const depsOver = {
            recordRecoveryAttempt: () => ({ reached: true, attempts: 5 }),
            handleRecoveryExhaustion: async () => true
        };
        const cannotRecover = await checkRecoveryAttemptLimits("s1", "h1", { reconnectCount: 5 }, depsOver, 5);
        assert.equal(cannotRecover, false);
    });

    await t.test("isSessionConnectionReady checks VoiceConnectionStatus.Ready and client readiness", () => {
        assert.equal(isSessionConnectionReady(null, VoiceConnectionStatus.Ready), false);

        const unreadyClient = {
            client: { isReady: () => false },
            connection: { state: { status: VoiceConnectionStatus.Ready } }
        };
        assert.equal(isSessionConnectionReady(unreadyClient, VoiceConnectionStatus.Ready), false);

        const readySession = {
            client: { isReady: () => true },
            connection: { state: { status: VoiceConnectionStatus.Ready } }
        };
        assert.equal(isSessionConnectionReady(readySession, VoiceConnectionStatus.Ready), true);
    });

    await t.test("isOnRecoveryCooldown enforces cooldown window", () => {
        const mockMap = new Map([["sess_recent", Date.now()]]);
        const onCooldown = isOnRecoveryCooldown("sess_recent", Date.now(), {
            recoveryTimestamps: mockMap,
            recoveryCooldownMs: 5000
        });
        assert.equal(onCooldown, true);

        const notOnCooldown = isOnRecoveryCooldown("sess_old", Date.now(), {
            recoveryTimestamps: mockMap,
            recoveryCooldownMs: 5000
        });
        assert.equal(notOnCooldown, false);
    });

    await t.test("advanceHibernationState progresses cycle and resets phase", () => {
        assert.equal(advanceHibernationState({}, Date.now()), false);

        const hibernatingSession = {
            recoveryState: { phase: "hibernate", hibernateUntil: Date.now() + 5000 }
        };
        assert.equal(advanceHibernationState(hibernatingSession, Date.now()), true);

        const expiredSession = {
            recoveryState: { phase: "hibernate", hibernateUntil: Date.now() - 100 }
        };
        assert.equal(advanceHibernationState(expiredSession, Date.now()), false);
        assert.equal(expiredSession.recoveryState.phase, "degraded");
    });

    await t.test("safeRejoinConnection and handleWrongChannelState", () => {
        let rejoinedWith = null;
        const fakeConn = {
            rejoin(opts) { rejoinedWith = opts; }
        };
        safeRejoinConnection(fakeConn, "v999");
        assert.ok(rejoinedWith);
        assert.equal(rejoinedWith.channelId, "v999");

        const sessionWrongChannel = {
            voiceId: "target_v",
            connection: fakeConn,
            client: {}
        };
        handleWrongChannelState("s1", sessionWrongChannel, {
            getSelfVoiceStateInfo: () => ({
                inspectable: true,
                inTargetGuild: true,
                inTargetChannel: false,
                channelId: "other_v"
            })
        });
        assert.equal(rejoinedWith.channelId, "target_v");
    });

    await t.test("cleanupIdleSessions stops sessions past idle timeout", async () => {
        const stoppedSessions = [];
        const now = Date.now();
        const mockSessions = new Map([
            ["active_sess", { lastActivity: now }],
            ["idle_sess", { lastActivity: now - (10 * 3600 * 1000) }]
        ]);

        await cleanupIdleSessions({
            getAllSessions: () => mockSessions,
            getSetting: async () => "2",
            stopSession: async (id) => {
                stoppedSessions.push(id);
                return true;
            }
        });

        assert.equal(stoppedSessions.length, 1);
        assert.equal(stoppedSessions[0], "idle_sess");
    });
});
