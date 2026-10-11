'use strict';

const { VoiceConnectionStatus } = require("@discordjs/voice");
const sessionManager = require("../sessionManager");
const notifications = require("./notifications");
const { EVENTS } = notifications;
const {
    CONFIG,
    config,
    RECOVERY_COOLDOWN_MS,
    randomInt,
    delay
} = require("./config");
const {
    st,
    recoveryTimestamps,
    hibernateTimers
} = require("./state");
const {
    startNaturalTimer,
    stopNaturalTimer
} = require("./natural");
const {
    startAutoDeafTimer,
    stopAutoDeafTimer
} = require("./autoDeaf");
const { recoveryQueue } = require("./queue");
const tokenCoordinator = require("../core/tokenCoordinator");
const { sanitizeLogText } = require("../core/safeLogger");
const {
    sanitizeLifecycleError,
    isSessionRunnable,
    lockSession,
    unlockSession,
    isSessionLocked,
    getSessionToken,
    getSessionTokenHash,
    getSessionClientFromPool,
    cleanupSessionClientIfUnused,
    clearReconnect
} = require("./session");
const { getSelfVoiceStateInfo } = require("./lifecycleCleanup");

function clearHibernateTimer(sessionId) {
    const timer = hibernateTimers.get(sessionId);
    if (timer) {
        clearTimeout(timer);
        hibernateTimers.delete(sessionId);
    }
}

function resolveHibernatePauseMs(cycle) {
    if (cycle === 2) {
        return 10 * 60 * 1000;
    }
    return 5 * 60 * 1000;
}

async function handleHibernateTransition(sessionId, tokenHash, session, currentCycle, deps = {}) {
    const nextCycle = currentCycle + 1;
    const pauseMs = resolveHibernatePauseMs(nextCycle);
    const hibernateUntil = Date.now() + pauseMs;
    const recordHibernate = deps.recordHibernateCycle || notifications.recordHibernateCycle;

    console.log(`[WORKER] 💤 Max burst attempts reached for ${sanitizeLogText(sessionId)}. Entering Hibernate Cycle ${nextCycle}: pausing for ${pauseMs / 60000} minutes.`);

    if (session?.connection) {
        try { session.connection.destroy(); } catch {}
        session.connection = null;
    }
    if (session) {
        session.reconnecting = false;
    }

    if (recordHibernate) {
        await recordHibernate(sessionId, nextCycle, hibernateUntil).catch(() => {});
    }

    clearHibernateTimer(sessionId);

    const setTimer = deps.setTimeout || setTimeout;
    const wakeTimer = setTimer(() => {
        hibernateTimers.delete(sessionId);
        const currentSession = sessionManager.getSession(sessionId);
        if (!currentSession || st.isShuttingDown) return;
        console.log(`[WORKER] ⏰ Hibernate pause ended for ${sanitizeLogText(sessionId)}. Resuming recovery queue...`);
        if (currentSession.recoveryState) {
            currentSession.recoveryState.phase = "degraded";
            currentSession.recoveryState.attempts = 0;
            currentSession.recoveryState.hibernateUntil = null;
        }
        if (typeof deps.healthCheck === "function") {
            deps.healthCheck().catch(() => {});
        }
    }, pauseMs);
    wakeTimer.unref?.();
    hibernateTimers.set(sessionId, wakeTimer);
}

function resolveRecoveryExhaustionDeps(deps = {}) {
    return {
        stopNatural: deps.stopNaturalTimer || stopNaturalTimer,
        stopAutoDeaf: deps.stopAutoDeafTimer || stopAutoDeafTimer,
        clearRecovery: deps.clearReconnect || clearReconnect,
        recoveryMap: deps.recoveryTimestamps || recoveryTimestamps,
        markTerminal: deps.markTerminal || notifications.markTerminal,
        markFailed: deps.markSessionFailed || sessionManager.markSessionFailed?.bind(sessionManager),
        getPooledClient: deps.getSessionClientFromPool || getSessionClientFromPool,
        cleanupClient: deps.cleanupSessionClientIfUnused || cleanupSessionClientIfUnused,
        deleteSession: deps.deleteSession || sessionManager.deleteSession?.bind(sessionManager),
        cleanupSessionNotif: deps.cleanupSessionNotification || notifications.cleanupSession
    };
}

async function handleRecoveryExhaustion(sessionId, tokenHash, session, recovery, deps = {}) {
    const d = resolveRecoveryExhaustionDeps(deps);

    d.stopNatural(sessionId);
    d.stopAutoDeaf(sessionId);
    d.clearRecovery(sessionId);
    d.recoveryMap.delete(sessionId);
    if (session.connection) {
        try {
            session.connection.destroy();
        } catch (error) {
            console.warn(`[HEARTBEAT] ⚠️ Failed to destroy exhausted connection. session=${sanitizeLogText(sessionId)} code=${sanitizeLifecycleError(error?.code || error?.name)}`);
        }
        session.connection = null;
    }
    await d.markTerminal(sessionId, EVENTS.RECOVERY_EXHAUSTED, {
        attempts: recovery.attempts,
        reason: "ระบบลองกู้คืนครบจำนวนที่กำหนดแล้ว แต่ยังยืนยันการเชื่อมต่อไม่ได้"
    });
    await d.markFailed?.(sessionId, "max_reconnect_attempts", null, "health recovery exhausted");
    const clientRef = session.client || d.getPooledClient(sessionId, session, tokenHash);
    d.cleanupClient(tokenHash, clientRef, sessionId, session, "health-recovery-exhausted");
    d.cleanupSessionNotif?.(sessionId);
    if (d.deleteSession) {
        await d.deleteSession(sessionId).catch(() => false);
    }
}

async function resolveRecoveryClient(sessionId, session, tokenHash, deps = {}) {
    const getPooledClient = deps.getSessionClientFromPool || getSessionClientFromPool;
    const resolveToken = deps.getSessionToken || getSessionToken;
    const login = deps.resolveOrLoginSessionClient;
    const markFailed = deps.markSessionFailed || sessionManager.markSessionFailed?.bind(sessionManager);

    if (!session.client) session.client = getPooledClient(sessionId, session, tokenHash);
    if (session.client?.isReady?.()) return true;

    const token = resolveToken(sessionId);
    if (!token) {
        if (markFailed) {
            await markFailed(
                sessionId,
                "token_unavailable",
                null,
                "health recovery could not decrypt the stored token"
            ).catch(() => false);
        }
        return false;
    }

    if (login) {
        await login(sessionId, session, tokenHash, token);
    }
    return session.client?.isReady?.() === true;
}

async function restoreRecoveryVoiceConnection(sessionId, tokenHash, session, deps = {}) {
    const connect = deps.connectToVoice;
    const markReady = deps.markReady || notifications.markReady;
    const inspectVoice = deps.getSelfVoiceStateInfo || getSelfVoiceStateInfo;
    const startNatural = deps.startNaturalTimer || startNaturalTimer;
    const startAutoDeaf = deps.startAutoDeafTimer || startAutoDeafTimer;
    const conn = await connect(session.client, session.serverId, session.voiceId, tokenHash, sessionId, deps);
    if (conn) session.connection = conn;

    console.log(`[HEARTBEAT] 💖 Restored connection for ${sanitizeLogText(sessionId)}.`);
    const voiceInfo = inspectVoice(session.client, session);
    await markReady(sessionId, {
        actualChannelId: voiceInfo.channelId || conn.joinConfig?.channelId,
        actualChannelSource: voiceInfo.channelSource || "connection_state",
        verifiedAt: Date.now(),
        reason: "ระบบกู้คืนสำเร็จและยืนยันตำแหน่งในช่องเสียงแล้ว"
    });

    startNatural(sessionId);
    startAutoDeaf(sessionId);
}

function releaseRecoveryOwnership(sessionId, deps = {}) {
    const getSession = deps.getSession || sessionManager.getSession.bind(sessionManager);
    const unlock = deps.unlockSession || unlockSession;
    const latest = getSession(sessionId);
    if (latest) latest.reconnecting = false;
    unlock(sessionId);
}

function resolveMaxHibernateCycles(deps) {
    if (deps.maxHibernateCycles !== undefined) {
        return deps.maxHibernateCycles;
    }
    if (deps.recordRecoveryAttempt) {
        return 0;
    }
    return Infinity;
}

function isSessionEligibleForRecovery(session, shuttingDown, runnable) {
    if (!session || shuttingDown() || !runnable(session)) {
        return false;
    }
    const nowMs = Date.now();
    if (session.recoveryState?.phase === "hibernate" && nowMs < (session.recoveryState.hibernateUntil || 0)) {
        return false;
    }
    return true;
}

async function performRecoveryPreflight(sessionId, tokenHash, session, deps) {
    if (!session.client?.isReady?.()) return true;
    const preflightCheck = deps.verifyTargetVoiceChannel;
    if (typeof preflightCheck !== "function") return true;

    const preflight = await preflightCheck(session.client, session);
    if (!preflight.ok && preflight.reason !== "CLIENT_NOT_READY") {
        console.warn(`[HEARTBEAT] 🛑 Pre-flight failed in recovery for ${sanitizeLogText(sessionId)}: ${preflight.reason}`);
        const preflightHandler = deps.handlePreflightFailure;
        if (typeof preflightHandler === "function") {
            await preflightHandler(sessionId, tokenHash, session, session.client, "channel_not_found", deps);
        }
        return false;
    }
    return true;
}

async function checkRecoveryAttemptLimits(sessionId, tokenHash, session, deps, maxAttempts) {
    const recordAttempt = deps.recordRecoveryAttempt || notifications.recordRecoveryAttempt;
    const recovery = await recordAttempt(sessionId, { cause: "health_check" });
    if (Number(recovery?.attempts || 0) < maxAttempts) {
        return true;
    }
    const hibernateCycle = Number(session.recoveryState?.hibernateCycle || 0);
    const maxHibernateCycles = resolveMaxHibernateCycles(deps);
    if (maxHibernateCycles > 0 && hibernateCycle < maxHibernateCycles) {
        const hibernateHandler = deps.handleHibernateTransition || handleHibernateTransition;
        await hibernateHandler(sessionId, tokenHash, session, hibernateCycle, deps);
        return false;
    }
    await handleRecoveryExhaustion(sessionId, tokenHash, session, recovery, deps);
    return false;
}

function resolveRecoveryDeps(deps = {}) {
    return {
        getSession: deps.getSession || sessionManager.getSession.bind(sessionManager),
        shuttingDown: deps.isShuttingDown || (() => st.isShuttingDown),
        runnable: deps.isSessionRunnable || isSessionRunnable,
        maxAttempts: deps.maxReconnectAttempts || CONFIG.MAX_RECONNECT_ATTEMPTS,
        wait: deps.delay || delay,
        jitter: deps.randomInt || randomInt
    };
}

function isPostJitterSessionValid(session, shuttingDown, runnable) {
    if (!session || shuttingDown()) return false;
    return Boolean(runnable(session));
}

async function recoverSessionConnection(sessionId, tokenHash, deps = {}) {
    const { getSession, shuttingDown, runnable, maxAttempts, wait, jitter } = resolveRecoveryDeps(deps);
    try {
        const session = getSession(sessionId);
        if (!isSessionEligibleForRecovery(session, shuttingDown, runnable)) return;

        if (!await performRecoveryPreflight(sessionId, tokenHash, session, deps)) return;

        if (!await checkRecoveryAttemptLimits(sessionId, tokenHash, session, deps, maxAttempts)) return;

        await wait(jitter(1000, 3000));

        if (shuttingDown()) return;

        const latest = getSession(sessionId);
        if (!isPostJitterSessionValid(latest, shuttingDown, runnable)) return;

        if (!await resolveRecoveryClient(sessionId, latest, tokenHash, deps)) return;
        await restoreRecoveryVoiceConnection(sessionId, tokenHash, latest, deps);

    } catch (e) {
        console.error(`[HEARTBEAT] 💔 Recovery failed for ${sanitizeLogText(sessionId)}: ${e.message}`);
    } finally {
        releaseRecoveryOwnership(sessionId, deps);
    }
}

function scheduleHealthRecovery(sessionId, session, tokenHash, now, deps = {}) {
    const lock = deps.lockSession || lockSession;
    if (!lock(sessionId)) return false;

    session.reconnecting = true;
    const recoveryMap = deps.recoveryTimestamps || recoveryTimestamps;
    recoveryMap.set(sessionId, now);
    notifications.beginIncident(sessionId, { cause: "health_check" }).catch(() => {});

    console.log(`[HEARTBEAT] 🩺 Queueing dead connection recovery for ${sanitizeLogText(sessionId)}...`);

    const queue = deps.recoveryQueue || recoveryQueue;
    queue.add(() => (deps.recoverSessionConnection || recoverSessionConnection)(sessionId, tokenHash, deps)).catch((e) => {
        console.error(`[HEARTBEAT] 💔 Recovery queue failed for ${sanitizeLogText(sessionId)}: ${e.message}`);
        const latest = (deps.getSession || sessionManager.getSession.bind(sessionManager))(sessionId);
        if (latest) latest.reconnecting = false;
        (deps.unlockSession || unlockSession)(sessionId);
    });

    return true;
}

function advanceHibernationState(session, now) {
    if (session.recoveryState?.phase !== "hibernate") return false;
    if (now < (session.recoveryState.hibernateUntil || 0)) {
        return true;
    }
    session.recoveryState.phase = "degraded";
    session.recoveryState.hibernateUntil = null;
    return false;
}

function safeRejoinConnection(connection, channelId) {
    if (!connection || typeof connection.rejoin !== "function") return;
    try {
        connection.rejoin({
            channelId,
            selfMute: true,
            selfDeaf: true
        });
    } catch {}
}

function handleWrongChannelState(sessionId, session, deps = {}) {
    const inspectVoice = deps.getSelfVoiceStateInfo || getSelfVoiceStateInfo;
    const voiceInfo = inspectVoice(session.client, session);
    if (voiceInfo?.inspectable && voiceInfo.inTargetGuild && !voiceInfo.inTargetChannel) {
        console.log(`[HEARTBEAT] 🧲 Bot in wrong channel (${voiceInfo.channelId}) — returning to target channel ${session.voiceId} (${sanitizeLogText(sessionId)})`);
        safeRejoinConnection(session.connection, session.voiceId);
    }
}

function isSessionConnectionReady(session, readyStatus, deps = {}) {
    const clientReady = session?.client?.isReady?.() === true;
    const connStatus = session?.connection?.state?.status;
    if (!clientReady || connStatus !== readyStatus) return false;

    const inspectVoice = deps.getSelfVoiceStateInfo || getSelfVoiceStateInfo;
    const voiceInfo = inspectVoice(session.client, session);
    if (voiceInfo?.inspectable && !voiceInfo.inTargetGuild) {
        const coordinator = deps.tokenCoordinator || tokenCoordinator;
        const tokenHash = deps.getSessionTokenHash?.(session) || session?.tokenHash;
        if (coordinator?.shouldDebounceVoiceHealthCheck?.(tokenHash)) {
            const now = Date.now();
            if (!session._lastVoiceFlickerAt) {
                session._lastVoiceFlickerAt = now;
                console.log(`[WORKER] ⏳ Quest active for ${sanitizeLogText(session?.id || '')}: applying voice debounce grace`);
                return true;
            }
            if (now - session._lastVoiceFlickerAt < 10000) {
                return true;
            }
        }
        return false;
    }
    if (session) session._lastVoiceFlickerAt = 0;
    return true;
}

function isOnRecoveryCooldown(sessionId, now, deps = {}) {
    const recoveryMap = deps.recoveryTimestamps || recoveryTimestamps;
    const lastRecovered = recoveryMap.get(sessionId) || 0;
    return (now - lastRecovered) < (deps.recoveryCooldownMs || RECOVERY_COOLDOWN_MS);
}

function syncSessionClientFromPool(sessionId, session, tokenHash, deps = {}) {
    const getPooledClient = deps.getSessionClientFromPool || getSessionClientFromPool;
    const pooledClient = getPooledClient(sessionId, session, tokenHash);
    if (!session.client && pooledClient) session.client = pooledClient;
}

function processSessionHealthCheck(sessionId, session, now, deps = {}) {
    const runnable = deps.isSessionRunnable || isSessionRunnable;
    if (!runnable(session) || advanceHibernationState(session, now)) return false;

    const resolveTokenHash = deps.getSessionTokenHash || getSessionTokenHash;
    const tokenHash = resolveTokenHash(sessionId, session);
    if (!tokenHash) return false;

    syncSessionClientFromPool(sessionId, session, tokenHash, deps);

    const readyStatus = deps.readyStatus || VoiceConnectionStatus.Ready;
    const needsRecovery = !isSessionConnectionReady(session, readyStatus, deps);
    const isUrgent = Boolean(session.urgentRecovery);
    session.urgentRecovery = false;

    if (!needsRecovery) {
        handleWrongChannelState(sessionId, session, deps);
        (deps.touchSession || sessionManager.touchSession)(sessionId);
        return false;
    }

    const onCooldown = isOnRecoveryCooldown(sessionId, now, deps);
    const locked = (deps.isSessionLocked || isSessionLocked)(sessionId);
    if ((isUrgent || !onCooldown) && !session.reconnecting && !locked) {
        return (deps.scheduleHealthRecovery || scheduleHealthRecovery)(sessionId, session, tokenHash, now, deps);
    }
    return false;
}

async function forceReconnectSession(sessionId, deps = {}) {
    const getSession = deps.getSession || sessionManager.getSession.bind(sessionManager);
    const session = getSession(sessionId);
    if (!session) {
        return { ok: false, error: "ไม่พบ Session ในระบบ" };
    }
    if (st.isShuttingDown) {
        return { ok: false, error: "ระบบกำลังปิดการทำงาน" };
    }

    const resolveTokenHash = deps.getSessionTokenHash || getSessionTokenHash;
    const tokenHash = resolveTokenHash(sessionId, session);
    if (!tokenHash) {
        return { ok: false, error: "ไม่พบ Token สำหรับ Session นี้" };
    }

    clearHibernateTimer(sessionId);
    recoveryTimestamps.delete(sessionId);
    clearReconnect(sessionId);
    unlockSession(sessionId);

    session.state = "active";
    delete session.failedReason;
    delete session.tokenInvalid;

    if (session.recoveryState) {
        session.recoveryState.phase = "recovering";
        session.recoveryState.attempts = 0;
        session.recoveryState.hibernateUntil = null;
        session.recoveryState.lastAttemptAt = Date.now();
    }
    session.reconnecting = true;
    session.lastActivity = Date.now();

    if (session.connection) {
        try { session.connection.destroy(); } catch {}
        session.connection = null;
    }

    console.log(`[WORKER] 🚀 Force reconnect triggered for ${sanitizeLogText(sessionId)}`);

    try {
        const recover = deps.recoverSessionConnection || recoverSessionConnection;
        await recover(sessionId, tokenHash, deps);
        const updated = getSession(sessionId);
        const readyStatus = deps.readyStatus || VoiceConnectionStatus.Ready;
        const isReady = updated?.client?.isReady?.() && updated?.connection?.state?.status === readyStatus;
        return { ok: true, ready: isReady };
    } catch (err) {
        console.error(`[WORKER] ❌ Force reconnect failed for ${sanitizeLogText(sessionId)}: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

async function cleanupIdleSessions(deps = {}) {
    const shuttingDown = deps.isShuttingDown ? deps.isShuttingDown() : st.isShuttingDown;
    if (shuttingDown) return;

    const now = Date.now();
    const getSetting = deps.getSetting || sessionManager.getSetting.bind(sessionManager);
    const savedHrs = await getSetting("idleTimeoutHrs", null).catch(() => null);
    const parsedHrs = Number.parseInt(savedHrs, 10);
    const maxIdle = (savedHrs && parsedHrs > 0)
        ? parsedHrs * 3600000
        : config.limits.idleTimeoutMs;
    const getAllSessions = deps.getAllSessions || sessionManager.getAllSessions.bind(sessionManager);
    const sessions = getAllSessions();

    const stop = deps.stopSession;

    for (const [id, session] of sessions) {
        const lastSeen = session.lastActivity ?? session.startedAt;

        if (now - lastSeen > maxIdle) {
            console.log(`[CLEANUP] 🧹 Session ${id} idle for ${Math.round((now - lastSeen) / 3600000)}h — shutting down.`);
            if (stop) {
                const stopped = await stop(id, { notifyReason: "idle" });
                if (!stopped) {
                    console.warn(`[CLEANUP] ⚠️ Idle cleanup could not stop ${id}; session remains visible for review.`);
                }
            }
        }
    }
}

module.exports = {
    clearHibernateTimer,
    resolveHibernatePauseMs,
    handleHibernateTransition,
    resolveRecoveryExhaustionDeps,
    handleRecoveryExhaustion,
    resolveRecoveryClient,
    restoreRecoveryVoiceConnection,
    releaseRecoveryOwnership,
    resolveMaxHibernateCycles,
    isSessionEligibleForRecovery,
    performRecoveryPreflight,
    checkRecoveryAttemptLimits,
    resolveRecoveryDeps,
    isPostJitterSessionValid,
    recoverSessionConnection,
    scheduleHealthRecovery,
    advanceHibernationState,
    safeRejoinConnection,
    handleWrongChannelState,
    isSessionConnectionReady,
    isOnRecoveryCooldown,
    syncSessionClientFromPool,
    processSessionHealthCheck,
    forceReconnectSession,
    cleanupIdleSessions
};
