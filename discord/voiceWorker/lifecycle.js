/* eslint-disable complexity -- Voice/session lifecycle is behavior-sensitive; refactor separately. */
/**
 * Voice Session Lifecycle Management
 * - Self-client authentication, voice channel connections, and gateway heartbeats.
 * - Reconnect backoff scheduling and Token Coordinator quarantine integration.
 */
const crypto = require("node:crypto");
const { Client: SelfClient } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } = require("@discordjs/voice");
const sessionManager = require("../sessionManager");
const { sendWebhookEvent, getDiscordGuildIconUrl } = require("../core/webhooks");
const { sanitizeLogText } = require("../core/safeLogger");
const { registerGatewayDiagnostics } = require("../core/gatewayDiagnostics");
const tokenCoordinator = require("../core/tokenCoordinator");
const {
    st,
    naturalRunning,
    autoDeafRunning,
    recoveryTimestamps,
    hibernateTimers,
} = require("./state");
const {
    CONFIG,
    RECOVERY_COOLDOWN_MS,
    config,
    randomInt,
    delay,
    withTimeoutReject,
} = require("./config");
const {
    validateToken,
    sanitizeLifecycleError,
    isSessionRunnable,
    shouldResumeSession,
    sha256,
    getSessionToken,
    getSessionTokenHash,
    lockSession,
    unlockSession,
    isSessionLocked,
    addReconnect,
    clearReconnect,
    getSessionShortId,
    getSessionClientFromPool,
    setSessionClientInPool,
    destroySessionClient,
    countOtherActiveSessionsForClient,
    cleanupSessionClientIfUnused,
    countActiveSessionsForAccountId,
    waitForTokenLoginCooldown,
    debugVoiceSession,
    disposeSelfClient,
} = require("./session");
const {
    buildSelfClientOptions,
    cleanupLeanSessionClient,
    destroyAllPooledClients,
} = require("./cacheUtils");
const {
    refreshSessionMetadata,
    refreshSessionMetadataFast,
    normalizeVoiceTarget,
    isVoiceConnectionUsable,
    getGuildLabel,
    getVoiceLabel,
} = require("./display");
const notifications = require("./notifications");
const { EVENTS } = notifications;
const { startNaturalTimer, stopNaturalTimer, stopAllNaturalTimers } = require("./natural");
const { startAutoDeafTimer, stopAutoDeafTimer, stopAllAutoDeafTimers } = require("./autoDeaf");
const { loginQueue, recoveryQueue } = require("./queue");
const { cleanToken } = require("../sessions/tokenUtils");
const channelLock = require("./channelLock");

const ensureSessionFlights = new Map();

tokenCoordinator.registerSubsystem({
    name: "voiceWorker",
    onTokenQuarantined: (tokenHash, reason) => {
        try {
            const reasonStr = String(reason || "").toLowerCase();
            const isRateLimit = reasonStr.includes("429") || reasonStr.includes("rate limit") || reasonStr.includes("backoff");
            if (isRateLimit) {
                // Policy: 429 rate limit must NOT terminate or disconnect healthy Voice sessions
                console.warn(`[WORKER] ℹ️ Token ${tokenHash ? tokenHash.slice(0, 8) : "unknown"} quarantined for rate limit (${reason}); keeping healthy active voice connection intact.`);
                return;
            }

            const allSessions = sessionManager.getAllSessions();
            if (allSessions && typeof allSessions.entries === "function") {
                for (const [id, s] of allSessions.entries()) {
                    const h = getSessionTokenHash(id, s);
                    if (h === tokenHash) {
                        console.warn(`[WORKER] 🚨 Stopping voice session ${sanitizeLogText(id)} due to fatal token quarantine: ${reason}`);
                        stopSession(id, { reason: `Token Quarantined: ${reason}` }).catch((err) => {
                            console.error(`[WORKER] Failed to stop quarantined session ${id}:`, err?.message || err);
                        });
                    }
                }
            }
        } catch {
            // safe swallow
        }
    }
});


const {
    getVoiceGroup,
    destroyConnectionObject,
    resolveSelfMember,
    resolveVoiceChannelId,
    getSelfVoiceStateInfo,
    waitForSelfVoiceExit,
    waitForTargetVoice,
    attemptSelfVoiceDisconnect,
    verifyCleanupState,
    cleanupSessionVoiceConnection
} = require("./lifecycleCleanup");

// ════════════════════════════════════════════════════════════════════════════
//  🔧  ensureVoiceSession helpers
// ════════════════════════════════════════════════════════════════════════════
async function startExistingSession({ sessionId, token, channelId, reason }) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    if (isVoiceConnectionUsable(session.connection, channelId)) {
        sessionManager.touchSession(sessionId);
        cleanupLeanSessionClient(sessionId, `ensure-${reason || "already-active"}`);
        return { action: "already_active", sessionId, session };
    }

    await startSession(sessionId, token);
    return {
        action: session.connection ? "resumed" : "started",
        sessionId,
        session: sessionManager.getSession(sessionId)
    };
}

async function cleanupFailedEnsureSession(sessionId, ownerId, reason, expectedGeneration = null) {
    if (!sessionId) return;

    const removed = await sessionManager.deleteSession(sessionId, { expectedGeneration }).catch(() => false);
    if (removed) return;

    await sessionManager.markSessionFailed?.(
        sessionId,
        "start_cleanup_failed",
        ownerId || null,
        `ensure voice session failed during ${reason || "unknown"}`
    ).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════
//  🎧  REGION 6: START SESSION
// ════════════════════════════════════════════════════════════════════════════
async function markTokenInvalid(sessionId, source) {
    const session = sessionManager.getSession(sessionId);
    if (!session || session.tokenInvalid === true) return false;
    const tokenHash = getSessionTokenHash(sessionId, session);
    const clientRef = session.client || getSessionClientFromPool(sessionId, session, tokenHash);
    session.tokenInvalid = true;
    session.reconnecting = false;
    stopNaturalTimer(sessionId);
    stopAutoDeafTimer(sessionId);
    clearReconnect(sessionId);
    recoveryTimestamps.delete(sessionId);
    if (session.connection) {
        try {
            session.connection.destroy();
        } catch (error) {
            console.warn(`[WORKER] ⚠️ Token-invalid connection cleanup failed. session=${sanitizeLogText(sessionId)} code=${sanitizeLifecycleError(error?.code || error?.name)}`);
        }
        session.connection = null;
    }
    await sessionManager.saveVoiceRuntimeState?.(sessionId).catch(() => false);
    await sessionManager.markSessionFailed?.(sessionId, "token_invalid", null, source).catch(() => false);
    if (tokenHash && clientRef) {
        cleanupSessionClientIfUnused(tokenHash, clientRef, sessionId, session, "token-invalid");
    }
    await notifications.markTerminal(sessionId, EVENTS.TOKEN_INVALID, {
        reason: "Discord ปฏิเสธ Token หรือบัญชีถูกยกเลิกการเข้าสู่ระบบ",
        action: "เปลี่ยน Token หรือใช้บัญชีอื่น แล้วเริ่ม Session ใหม่"
    });
    notifications.cleanupSession(sessionId);
    await sessionManager.deleteSession(sessionId).catch(() => false);
    return true;
}

async function notifyStartFailure(sessionId, error) {
    const message = String(error?.message || "UNKNOWN");
    if (message.includes("TOKEN_INVALID")) return;
    if (/SYSTEM_SHUTTING_DOWN|SESSION_LOCKED|VOICE_QUEUE_BUSY|OPERATION_QUEUE_FULL/.test(message)) return;
    let type = EVENTS.LOGIN_FAILED;
    if (message.includes("GUILD_NOT_FOUND")) type = EVENTS.GUILD_NOT_FOUND;
    else if (message.includes("CHANNEL_NOT_FOUND")) type = EVENTS.CHANNEL_NOT_FOUND;
    else if (/Missing Permissions|VOICE_PERMISSION|403/i.test(message)) type = EVENTS.VOICE_PERMISSION_DENIED;
    else if (/VOICE_TARGET_NOT_CONFIRMED|VOICE_CONNECTION|AbortError|aborted/i.test(message)) type = EVENTS.VOICE_CONNECTION_FAILED;
    await notifications.markTerminal(sessionId, type, {
        action: type === EVENTS.LOGIN_FAILED
            ? "รอสักครู่แล้วลองเริ่มใหม่ หากยังไม่สำเร็จให้ตรวจสอบบัญชีและ Token"
            : "ตรวจสอบว่าเซิร์ฟเวอร์ ช่องเสียง และสิทธิ์ของบัญชียังถูกต้อง"
    }).catch(() => {});
}

function setupClientEventHandlers(newClient, sessionId) {
    registerGatewayDiagnostics(newClient, {
        clientName: "voice-self-client",
        context: `session-${getSessionShortId(sessionId)}`
    });
    newClient.on("ready", () => {
        console.log(`[WORKER] 🟢 Self-bot connected: ${newClient.user.tag}`);
        try { newClient.user.setStatus("idle"); } catch {}
    });
    newClient.once("invalidated", async () => {
        console.error(`[WORKER] 🚫 Token invalidated (WS) for session: ${sanitizeLogText(sessionId)}`);
        await markTokenInvalid(sessionId, "gateway_invalidated").catch(() => {});
    });
    newClient.on("voiceStateUpdate", (oldState, newState) => {
        channelLock.handleVoiceStateUpdate(sessionId, newClient, oldState, newState);
    });
}

function isLoginGenerationActive(current, session, loginGeneration, isShuttingDown) {
    if (isShuttingDown()) return false;
    if (!current || current !== session) return false;
    return current.loginGeneration === loginGeneration;
}

async function handleLoginFailure(err, { newClient, sessionId, session, tokenHash, loginGeneration, markInvalid, disposeClient }) {
    if (session.loginGeneration === loginGeneration) session.loginGeneration = null;
    const errorDetail = sanitizeLifecycleError(err?.message || err?.code || "UNKNOWN");
    console.error(`[WORKER] ❌ Login failed for ${sanitizeLogText(sessionId)}: ${errorDetail}. Destroying ghost client.`);
    try { disposeClient(newClient, "login-failure"); } catch {}
    if (err.code === "OPERATION_QUEUE_FULL") throw new Error("VOICE_QUEUE_BUSY");
    if (isInvalidTokenError(err)) {
        if (tokenHash) {
            tokenCoordinator.quarantineToken(tokenHash, `Voice login rejected: ${errorDetail}`);
        }
        await markInvalid(sessionId, "login_rejected");
        throw new Error("TOKEN_INVALID");
    }
    throw err;
}

async function performClientLogin(newClient, sessionId, session, tokenHash, tokenString, deps = {}) {
    const loginGeneration = crypto.randomUUID();
    const getSession = deps.getSession || (id => sessionManager.getSession(id));
    const waitForCooldown = deps.waitForTokenLoginCooldown || waitForTokenLoginCooldown;
    const queue = deps.loginQueue || loginQueue;
    const waitWithTimeout = deps.withTimeoutReject || withTimeoutReject;
    const disposeClient = deps.disposeSelfClient || disposeSelfClient;
    const putClientInPool = deps.setSessionClientInPool || setSessionClientInPool;
    const markInvalid = deps.markTokenInvalid || markTokenInvalid;
    const isShuttingDown = deps.isShuttingDown || (() => st.isShuttingDown);
    session.loginGeneration = loginGeneration;
    let loginPromise = null;

    const disposeLateLogin = () => {
        Promise.resolve(loginPromise).then(() => {
            const current = getSession(sessionId);
            if (!isLoginGenerationActive(current, session, loginGeneration, isShuttingDown)) {
                try { disposeClient(newClient, "late-login-completion"); } catch {}
            }
        }).catch(() => {});
    };

    try {
        await waitForCooldown(tokenHash);
        await queue.add(async () => {
            loginPromise = Promise.resolve().then(() => newClient.login(tokenString));
            loginPromise.catch(() => {});
            try {
                await waitWithTimeout(loginPromise, CONFIG.LOGIN_TIMEOUT, "LOGIN_TIMEOUT");
            } catch (error) {
                if (session.loginGeneration === loginGeneration) session.loginGeneration = null;
                disposeLateLogin();
                throw error;
            }
        });

        const current = getSession(sessionId);
        if (!isLoginGenerationActive(current, session, loginGeneration, isShuttingDown)) {
            try { disposeClient(newClient, "cancelled-login-generation"); } catch {}
            throw new Error("LOGIN_GENERATION_CANCELLED");
        }

        session.loginGeneration = null;
        putClientInPool(sessionId, session, tokenHash, newClient);
    } catch (err) {
        await handleLoginFailure(err, { newClient, sessionId, session, tokenHash, loginGeneration, markInvalid, disposeClient });
    }
}

function isInvalidTokenError(error) {
    const code = String(error?.code ?? error?.status ?? "").trim();
    const message = String(error?.message || error || "");
    return code === "4004" ||
        code === "401" ||
        /TOKEN_INVALID|invalid token|incorrect login|authentication failed/i.test(message);
}

async function resolveOrLoginSessionClient(sessionId, session, tokenHash, tokenString) {
    const pooledClient = getSessionClientFromPool(sessionId, session, tokenHash);

    if (pooledClient?.isReady?.()) {
        session.client = pooledClient;
        console.log(`[WORKER] ♻️ Reused session-owned client. session=${sanitizeLogText(sessionId)}`);
    } else if (pooledClient) {
        destroySessionClient(sessionId, session, tokenHash, "stale-pooled-client", pooledClient);
        console.log(`[WORKER] 🔄 Stale session-owned client — will re-login. session=${sanitizeLogText(sessionId)}`);
    }

    if (session.client && !session.client.isReady?.()) {
        destroySessionClient(sessionId, session, tokenHash, "stale-start-client", session.client);
    }

    if (session.client && !getSessionClientFromPool(sessionId, session, tokenHash)) {
        setSessionClientInPool(sessionId, session, tokenHash, session.client);
    }

    if (session.client) return;

    const newClient = new SelfClient(buildSelfClientOptions());
    setupClientEventHandlers(newClient, sessionId);
    await performClientLogin(newClient, sessionId, session, tokenHash, tokenString);
}


function startupGuardError(code, stage) {
    const error = new Error(code);
    error.code = code;
    error.stage = stage;
    return error;
}

function assertVoiceStartupAllowed(sessionId, session, stage, deps = {}) {
    const isShuttingDown = deps.isShuttingDown || (() => st.isShuttingDown);
    const getSession = deps.getSession || (id => sessionManager.getSession(id));
    if (isShuttingDown()) throw startupGuardError("SYSTEM_SHUTTING_DOWN", stage);
    const current = getSession(sessionId);
    if (!current || current !== session) throw startupGuardError("SESSION_SUPERSEDED", stage);
    return current;
}

function assertSessionCanStart(sessionId, tokenString) {
    if (st.isShuttingDown) throw new Error("SYSTEM_SHUTTING_DOWN");
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");
    validateToken(tokenString);

    if (!lockSession(sessionId)) {
        console.warn(`[WORKER] ⚠️ Session ${sanitizeLogText(sessionId)} is locked. Skipping.`);
        throw new Error("SESSION_LOCKED");
    }
    return session;
}

function buildStartReadyPayload(options, conn, voiceInfo) {
    return {
        notifyInitial: options.notifyInitial !== false,
        source: options.source || "manual_start",
        actualChannelId: voiceInfo.channelId || conn.joinConfig?.channelId,
        actualChannelSource: voiceInfo.channelSource || "connection_state",
        verifiedAt: Date.now(),
        reason: "ระบบยืนยันแล้วว่าบัญชีอยู่ในช่องเสียงเป้าหมาย"
    };
}

async function startSession(sessionId, tokenString, options = {}) {
    if (st.isShuttingDown) throw new Error("SYSTEM_SHUTTING_DOWN");

    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    validateToken(tokenString);

    if (!lockSession(sessionId)) {
        console.warn(`[WORKER] ⚠️ Session ${sanitizeLogText(sessionId)} is locked. Skipping.`);
        throw new Error("SESSION_LOCKED");
    }

    let tokenHash = null;
    const startupDeps = options.startupDeps || {};

    try {
        assertVoiceStartupAllowed(sessionId, session, "pre_login", startupDeps);
        tokenHash = getSessionTokenHash(sessionId, session);
        if (!tokenHash) throw new Error("TOKEN_DECRYPTION_FAILED");
        if (tokenCoordinator.isQuarantined(tokenHash)) {
            const q = tokenCoordinator.getQuarantineDetails(tokenHash);
            throw new Error(`TOKEN_QUARANTINED: Cannot start voice session, token is quarantined (${q?.reason || 'Invalid'})`);
        }

        /*
         * Client ownership is token+guild scoped. Same token in different guilds
         * gets separate SelfClient instances to avoid shared gateway voice-state fights.
         */
        await resolveOrLoginSessionClient(sessionId, session, tokenHash, tokenString);
        assertVoiceStartupAllowed(sessionId, session, "post_login", startupDeps);

        const jitterDelay = randomInt(1500, 3500);
        await delay(jitterDelay);
        assertVoiceStartupAllowed(sessionId, session, "post_jitter", startupDeps);
        assertVoiceStartupAllowed(sessionId, session, "pre_connect", startupDeps);

        const conn = await connectToVoice(session.client, session.serverId, session.voiceId, tokenHash, sessionId);
        session.connection = conn;
        assertVoiceStartupAllowed(sessionId, session, "post_connect", startupDeps);

        console.log(`[WORKER] 🎧 Voice connected for Session: ${sanitizeLogText(sessionId)} Guild: ${session.serverId}`);

        await refreshSessionMetadataFast(sessionId, 1800).catch(() => {});
        cleanupLeanSessionClient(sessionId, "post-connect");

        assertVoiceStartupAllowed(sessionId, session, "pre_timers", startupDeps);
        startNaturalTimer(sessionId);
        startAutoDeafTimer(sessionId);
        assertVoiceStartupAllowed(sessionId, session, "pre_ready", startupDeps);

        const voiceInfo = getSelfVoiceStateInfo(session.client, session);
        await notifications.markReady(sessionId, buildStartReadyPayload(options, conn, voiceInfo));

        return true;

    } catch (err) {
        stopNaturalTimer(sessionId);
        stopAutoDeafTimer(sessionId);

        if (session.connection) {
            try { session.connection.destroy(); } catch {}
            session.connection = null;
        }

        if (tokenHash && session.client) {
            cleanupSessionClientIfUnused(tokenHash, session.client, sessionId, session, "start-failure");
        }

        await notifyStartFailure(sessionId, err);

        throw err;
    } finally {
        unlockSession(sessionId);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔊  REGION 7: VOICE CONNECTION & PREFLIGHT
// ════════════════════════════════════════════════════════════════════════════
async function verifyTargetVoiceChannel(client, session) {
    if (!session || !client?.isReady?.()) {
        return { ok: false, reason: "CLIENT_NOT_READY" };
    }
    if (!client.guilds || typeof client.guilds !== "object") {
        return { ok: true, skipped: true };
    }
    const targetGuildId = session.serverId;
    const targetChannelId = session.voiceId;
    if (!targetGuildId || !targetChannelId) {
        return { ok: false, reason: "INVALID_TARGET" };
    }
    const guild = client.guilds?.cache?.get?.(targetGuildId) ||
        await client.guilds?.fetch?.(targetGuildId).catch(() => null);
    if (!guild) {
        return { ok: false, reason: "GUILD_NOT_FOUND" };
    }
    const channel = guild.channels?.cache?.get?.(targetChannelId) ||
        await guild.channels?.fetch?.(targetChannelId).catch(() => null);
    if (!channel || (typeof channel.isVoice === "function" && !channel.isVoice())) {
        return { ok: false, reason: "CHANNEL_NOT_FOUND" };
    }
    if (String(channel.id) !== String(targetChannelId)) {
        return { ok: false, reason: "CHANNEL_MISMATCH" };
    }
    return { ok: true, guild, channel };
}

async function handlePreflightFailure(sessionId, tokenHash, session, clientRef, reason = "channel_not_found", deps = {}) {
    const stopNatural = deps.stopNaturalTimer || stopNaturalTimer;
    const stopAutoDeaf = deps.stopAutoDeafTimer || stopAutoDeafTimer;
    const clearRecovery = deps.clearReconnect || clearReconnect;
    const recoveryMap = deps.recoveryTimestamps || recoveryTimestamps;
    const markTerminal = deps.markTerminal || notifications.markTerminal;
    const markFailed = deps.markSessionFailed || sessionManager.markSessionFailed?.bind(sessionManager);
    const cleanupClient = deps.cleanupSessionClientIfUnused || cleanupSessionClientIfUnused;
    const deleteSession = deps.deleteSession || sessionManager.deleteSession?.bind(sessionManager);
    const cleanupSessionNotif = deps.cleanupSessionNotification || notifications.cleanupSession;

    stopNatural(sessionId);
    stopAutoDeaf(sessionId);
    clearRecovery(sessionId);
    recoveryMap.delete(sessionId);

    if (session?.connection) {
        try {
            session.connection.destroy();
        } catch {}
        session.connection = null;
    }
    if (session) {
        session.reconnecting = false;
    }

    await markFailed?.(
        sessionId,
        reason,
        null,
        "target voice channel missing or mismatched during preflight check"
    ).catch(() => false);

    await markTerminal(sessionId, EVENTS.CHANNEL_NOT_FOUND, {
        reason: "ไม่พบช่องเสียงเป้าหมาย หรือช่องถูกลบแล้ว",
        action: "เลือกช่องเสียงใหม่แล้วเริ่ม Session อีกครั้ง"
    }).catch(() => {});

    cleanupClient(tokenHash, clientRef, sessionId, session, "preflight-channel-missing");
    cleanupSessionNotif?.(sessionId);
    if (deleteSession) {
        await deleteSession(sessionId).catch(() => false);
    }
}

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
        healthCheck().catch(() => {});
    }, pauseMs);
    wakeTimer.unref?.();
    hibernateTimers.set(sessionId, wakeTimer);
}

function cleanupStaleConnectionIfPresent(session, guildId, channelId, sessionId, deps = {}) {
    const existingConn = session.connection;
    if (!existingConn || existingConn.state?.status === VoiceConnectionStatus.Destroyed) {
        return false;
    }
    const sameGuild = String(existingConn.joinConfig?.guildId) === String(guildId);
    const sameChannel = String(existingConn.joinConfig?.channelId) === String(channelId);

    const inspectVoice = deps.getSelfVoiceStateInfo || getSelfVoiceStateInfo;
    const voiceInfo = inspectVoice(session?.client, session);
    const ghostSuspected = Boolean(voiceInfo?.inspectable && !voiceInfo.inTargetGuild);

    if (sameGuild && sameChannel && existingConn.state.status === VoiceConnectionStatus.Ready && !ghostSuspected) {
        console.log(`[WORKER] ♻️ Reusing own ready connection for ${sanitizeLogText(sessionId)}`);
        return true;
    }

    // Fix #4: destroy ทุก state ที่ไม่ใช่ Ready (Connecting, Signalling, ฯลฯ)
    // และ clear session.connection ทันทีเพื่อป้องกัน stale listener ยิงซ้ำ
    try {
        console.log(`[WORKER] 🧹 Destroying own stale ${existingConn.state?.status || "unknown"} connection for ${sanitizeLogText(sessionId)}`);
        existingConn.destroy();
    } catch {}
    session.connection = null;
    return false;
}

async function handleMaxReconnectReached({ sessionId, tokenHash, connection, guild, guildId }) {
    console.error(`[WORKER] 💀 Max reconnect attempts (${CONFIG.MAX_RECONNECT_ATTEMPTS}) reached for ${sanitizeLogText(sessionId)}. Aborting.`);

    if (connection.state?.status !== VoiceConnectionStatus.Destroyed) {
        try { connection.destroy(); } catch {}
    }

    const failedSession = sessionManager.getSession(sessionId);
    if (failedSession) {
        const failedTokenHash = getSessionTokenHash(sessionId, failedSession) || tokenHash;
        const failedClientRef = failedSession.client || getSessionClientFromPool(sessionId, failedSession, failedTokenHash);
        failedSession.connection = null;
        failedSession.reconnecting = false;
        stopNaturalTimer(sessionId);
        stopAutoDeafTimer(sessionId);
        clearReconnect(sessionId);
        recoveryTimestamps.delete(sessionId);
        const markResult = await sessionManager.markSessionFailed?.(
            sessionId,
            "max_reconnect_attempts",
            null,
            `max reconnect attempts reached (${CONFIG.MAX_RECONNECT_ATTEMPTS})`
        );
        if (!(markResult?.ok ?? markResult)) {
            console.warn(`[WORKER] ⚠️ Max reconnect failed state was not persisted for ${sanitizeLogText(sessionId)}: ${markResult?.safeError || "UNKNOWN"}`);
            sendWebhookEvent({
                severity: "ERROR",
                category: "DATA",
                code: "voice.session.failure_state_persistence_failed",
                state: "OPEN",
                title: "บันทึกสถานะ Voice Session ที่หยุดทำงานไม่ได้",
                description: "Session หยุดหลังเชื่อมต่อใหม่ไม่สำเร็จ แต่ฐานข้อมูลไม่ยืนยันการเปลี่ยนสถานะ",
                impact: "Dashboard อาจยังแสดงสถานะ Session ไม่ตรงกับการทำงานจริง",
                action: "ตรวจ MongoDB และสถานะ Session แล้วนำรายการค้างออกหากจำเป็น",
                context: {
                    "Session": getSessionShortId(sessionId),
                    "Guild ID": failedSession.serverId || guildId,
                    "รหัสข้อผิดพลาด": markResult?.safeError || "persistence_unacknowledged"
                },
                sourceIconUrl: getDiscordGuildIconUrl(guild),
                thumbnailUrl: failedSession.accountAvatar,
                dedupeKey: `voice-state-persistence:${getSessionShortId(sessionId)}`,
                dedupeMs: 30 * 60 * 1000
            }).catch(() => {});
        }
        cleanupSessionClientIfUnused(failedTokenHash, failedClientRef, sessionId, failedSession, "max-reconnect");
    }

    await notifications.markTerminal(sessionId, EVENTS.RECOVERY_EXHAUSTED, {
        attempts: CONFIG.MAX_RECONNECT_ATTEMPTS,
        reason: "ลองเชื่อมต่อใหม่ครบจำนวนที่กำหนดแล้ว แต่ยังยืนยันการเข้า channel ไม่ได้",
        action: "ตรวจสอบสิทธิ์และช่องเสียง แล้วสั่งเริ่ม Session ใหม่"
    });

    notifications.cleanupSession(sessionId);
    await sessionManager.deleteSession(sessionId).catch(() => false);
}

async function executePassiveReconnect({ connection, sessionId, client, session, reconnectAttempts }) {
    const backoffMs = Math.min(1500 + (reconnectAttempts - 1) * 500, 3000);

    try {
        // Fix #1: ใช้ entersState() แทน connection.once() เพื่อป้องกัน race condition
        // entersState() เช็ค current state ก่อน register listener ทำให้ไม่ miss event
        await withTimeoutReject(
            entersState(connection, VoiceConnectionStatus.Ready, backoffMs),
            backoffMs,
            "TIMEOUT"
        );

        clearReconnect(sessionId);
        console.log(`[WORKER] ✅ Passive reconnect OK for ${sanitizeLogText(sessionId)}.`);

        const voiceInfo = await waitForTargetVoice(client, session, 3000, connection);
        if (!voiceInfo.inTargetChannel) throw new Error("VOICE_TARGET_NOT_CONFIRMED");

        // Fix #5: ตรวจ session ยังอยู่ก่อน markReady ป้องกัน notification ค้างหลัง delete
        const currentSession = sessionManager.getSession(sessionId);
        if (!currentSession) {
            console.log(`[WORKER] ℹ️ Session ${sanitizeLogText(sessionId)} deleted during passive reconnect — skipping markReady.`);
            return;
        }

        await notifications.markReady(sessionId, {
            actualChannelId: voiceInfo.channelId || connection.joinConfig?.channelId,
            actualChannelSource: voiceInfo.channelSource || "connection_state",
            verifiedAt: Date.now(),
            reason: "การเชื่อมต่อกลับมาปกติและตรวจพบในช่องเป้าหมายแล้ว"
        });
    } catch {
        console.warn(`[WORKER] ⚡ Passive reconnect timed out for ${sanitizeLogText(sessionId)} — triggering urgent recovery.`);
        if (connection.state?.status !== VoiceConnectionStatus.Destroyed) {
            try { connection.destroy(); } catch {}
        }
        const sess = sessionManager.getSession(sessionId) || session;
        if (sess) {
            sess.connection = null;
            sess.urgentRecovery = true;
        }
        const recoveryTimer = setTimeout(() => healthCheck().catch(() => {}), 1000);
        recoveryTimer.unref?.();
    }
}

async function handleVoiceDisconnectionEvent({
    sessionId,
    tokenHash,
    session,
    client,
    connection,
    guild,
    guildId
}) {
    if (st.isShuttingDown) {
        console.log(`[WORKER] ⏸️ Shutdown in progress — skipping reconnect for ${sanitizeLogText(sessionId)}`);
        return;
    }

    const currentSession = sessionManager.getSession(sessionId) || session;
    const preflight = await verifyTargetVoiceChannel(client, currentSession);
    if (!preflight.ok && preflight.reason !== "CLIENT_NOT_READY") {
        console.warn(`[WORKER] 🛑 Pre-flight failed on disconnect for ${sanitizeLogText(sessionId)}: ${preflight.reason}`);
        await handlePreflightFailure(sessionId, tokenHash, currentSession, client, "channel_not_found");
        return;
    }

    const recovery = await notifications.recordRecoveryAttempt(sessionId, { cause: "voice_disconnected" });
    const reconnectAttempts = Number(recovery?.attempts || 0);
    const hibernateCycle = Number(recovery?.hibernateCycle || 0);
    addReconnect(sessionId);

    console.log(`[WORKER] ⚠️ Voice dropped for ${sanitizeLogText(sessionId)}. Attempt ${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS} (Hibernate cycle ${hibernateCycle}/2)`);

    if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
        if (hibernateCycle < 2) {
            await handleHibernateTransition(sessionId, tokenHash, currentSession, hibernateCycle);
            return;
        }
        await handleMaxReconnectReached({ sessionId, tokenHash, connection, guild, guildId });
        return;
    }

    await executePassiveReconnect({ connection, sessionId, client, session: currentSession, reconnectAttempts });
}

function setupVoiceConnectionListeners({ connection, client, guild, guildId, tokenHash, sessionId, session }) {
    let lastVoiceReadyAt = 0;
    const VOICE_READY_THROTTLE_MS = 10000;

    connection.on("error", (error) => {
        console.warn(`[WORKER] ⚠️ VoiceConnection socket error for ${sanitizeLogText(sessionId)}: ${error?.message || error}`);
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
        sessionManager.touchSession(sessionId);
        const now = Date.now();
        if (now - lastVoiceReadyAt < VOICE_READY_THROTTLE_MS) {
            return;
        }
        lastVoiceReadyAt = now;
        tokenCoordinator.registerVoiceActivity(tokenHash, {
            guildId,
            channelId: session?.voiceId || connection?.joinConfig?.channelId,
            sessionId
        });
        refreshSessionMetadataFast(sessionId, 1200)
            .finally(() => cleanupLeanSessionClient(sessionId, "voice-ready"))
            .catch(() => {});
        console.log(`[WORKER] 💚 Voice Ready for ${sanitizeLogText(sessionId)}`);
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
        tokenCoordinator.unregisterVoiceActivity(tokenHash);
    });

    let disconnectHandling = false;
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (disconnectHandling) return;
        disconnectHandling = true;
        try {
            await handleVoiceDisconnectionEvent({
                sessionId,
                tokenHash,
                session,
                client,
                connection,
                guild,
                guildId
            });
        } finally {
            disconnectHandling = false;
        }
    });
}

async function confirmVoiceConnectionReady(connection, client, session, sessionId) {
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, CONFIG.CONNECTION_TIMEOUT);
        const voiceInfo = await waitForTargetVoice(client, session, Math.min(CONFIG.CONNECTION_TIMEOUT, 5000), connection);
        if (!voiceInfo.inTargetChannel) throw new Error("VOICE_TARGET_NOT_CONFIRMED");
    } catch (error) {
        try {
            connection.destroy();
        } catch (destroyError) {
            console.warn(`[WORKER] ⚠️ Failed to destroy unready voice connection. session=${sanitizeLogText(sessionId)} code=${sanitizeLifecycleError(destroyError?.code || destroyError?.name)}`);
        }
        throw error;
    }
}

function debugVoiceJoinState(phase, sessionId, session, client, guild, connection = null) {
    const accountId = client.user?.id || session.accountId || null;
    debugVoiceSession(phase, sessionId, session, {
        accountId,
        group: client.user?.id ? `${client.user.id}:${guild.id}` : null,
        connectionStatus: connection?.state?.status || null,
        selfVoice: getSelfVoiceStateInfo(client, session).channelId || null,
        sameAccountSessions: countActiveSessionsForAccountId(accountId)
    });
}

async function connectToVoice(client, guildId, channelId, tokenHash, sessionId, deps = {}) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new Error("GUILD_NOT_FOUND");

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isVoice()) throw new Error("CHANNEL_NOT_FOUND");

    await refreshSessionMetadata(sessionId, client, guild, channel).catch(() => {});
    debugVoiceJoinState("beforeJoin", sessionId, session, client, guild);

    if (cleanupStaleConnectionIfPresent(session, guildId, channelId, sessionId, deps)) {
        return session.connection;
    }

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: true,
        group: `${client.user.id}:${guild.id}`
    });

    connection.setMaxListeners(20);
    debugVoiceJoinState("afterJoinRequested", sessionId, session, client, guild, connection);

    setupVoiceConnectionListeners({ connection, client, guild, guildId, tokenHash, sessionId, session });

    await confirmVoiceConnectionReady(connection, client, session, sessionId);

    return connection;
}

// ════════════════════════════════════════════════════════════════════════════
//  🔒  ensureVoiceSession (entry point for external callers)
// ════════════════════════════════════════════════════════════════════════════
async function replaceExistingVoiceSession(existing, input, deps = {}) {
    if (!existing?.session) return { replaced: false, replacedSessionId: null };

    const replacedSessionId = existing.id || existing.session.sessionId;
    const stop = deps.stopSession || stopSession;
    const stopped = await stop(replacedSessionId, {
        stoppedBy: input.ownerId || "latest_request",
        notifyReason: null,
        actorNotified: false
    });
    if (!stopped) {
        const error = new Error("SESSION_REPLACEMENT_FAILED");
        error.code = "SESSION_REPLACEMENT_FAILED";
        error.sessionId = replacedSessionId;
        throw error;
    }
    return { replaced: true, replacedSessionId };
}

function mergeVoiceSessionReplacement(current, next) {
    return {
        replaced: current.replaced || next.replaced,
        replacedSessionId: next.replacedSessionId || current.replacedSessionId
    };
}

function isDuplicateVoiceSessionError(error) {
    return error?.code === "ALREADY_ACTIVE_IN_GUILD" || error?.message === "ALREADY_ACTIVE_IN_GUILD";
}

async function createVoiceSessionWithDuplicateRecovery({
    input,
    token,
    tokenHash,
    guildId,
    channelId,
    guildName
}, deps = {}) {
    const findActive = deps.findActiveVoiceSessionByTokenGuild || sessionManager.findActiveVoiceSessionByTokenGuild?.bind(sessionManager);
    const createSession = deps.createSession || sessionManager.createSession.bind(sessionManager);
    const replacementInput = { ...input, guildId, channelId };
    let replacement = await replaceExistingVoiceSession(findActive?.(tokenHash, guildId), replacementInput, deps);
    let duplicateRetried = false;

    while (true) {
        try {
            const sessionId = await createSession(
                token,
                guildId,
                channelId,
                guildName,
                input.ownerId || null,
                input.ownerAvatar || null,
                input.ownerTag || null
            );
            return { sessionId, replacement };
        } catch (error) {
            if (!isDuplicateVoiceSessionError(error) || duplicateRetried) throw error;

            duplicateRetried = true;
            const racedExisting = findActive?.(tokenHash, guildId);
            if (!racedExisting?.session) throw error;
            const racedReplacement = await replaceExistingVoiceSession(racedExisting, replacementInput, deps);
            replacement = mergeVoiceSessionReplacement(replacement, racedReplacement);
        }
    }
}

async function startCreatedVoiceSession(sessionId, token, getSession, start) {
    const creationGeneration = getSession(sessionId)?.lifecycleGeneration || null;
    try {
        await start(sessionId, token);
    } catch (error) {
        error.creationGeneration = creationGeneration;
        throw error;
    }
}

async function ensureVoiceSessionInternal(input = {}, deps = {}) {
    if (st.isShuttingDown) throw new Error("SYSTEM_SHUTTING_DOWN");

    const token = cleanToken(input.token);
    validateToken(token);

    const { guildId, channelId } = normalizeVoiceTarget(input);
    const guildName = input.guildName || "เซิร์ฟเวอร์ไม่ทราบชื่อ";
    const reason = input.reason || "ensure";
    const tokenHash = sessionManager.hashToken
        ? sessionManager.hashToken(token)
        : sha256(token);

    const repairFailedStop = deps.repairFailedStopSessionForTokenGuild || repairFailedStopSessionForTokenGuild;
    const getSession = deps.getSession || sessionManager.getSession.bind(sessionManager);
    const start = deps.startSession || startSession;
    const cleanupFailed = deps.cleanupFailedEnsureSession || cleanupFailedEnsureSession;

    await repairFailedStop(token, guildId);

    let sessionId = null;
    try {
        const creation = await createVoiceSessionWithDuplicateRecovery({
            input,
            token,
            tokenHash,
            guildId,
            channelId,
            guildName
        }, deps);
        sessionId = creation.sessionId;
        await startCreatedVoiceSession(sessionId, token, getSession, start);

        return {
            ok: true,
            reused: false,
            replaced: creation.replacement.replaced,
            replacedSessionId: creation.replacement.replacedSessionId,
            action: creation.replacement.replaced ? "replaced_by_latest_request" : "created",
            sessionId,
            session: getSession(sessionId),
            reason
        };
    } catch (err) {
        if (sessionId) {
            await cleanupFailed(
                sessionId,
                input.ownerId,
                reason,
                err.creationGeneration || getSession(sessionId)?.lifecycleGeneration || null
            );
        }
        throw err;
    }
}

function supersededVoiceResult(generation) {
    return {
        ok: false,
        superseded: true,
        generation,
        action: "superseded_by_newer_request"
    };
}

async function ensureVoiceSession(input = {}, deps = {}) {
    const shuttingDown = deps.isShuttingDown || (() => st.isShuttingDown);
    if (shuttingDown()) throw new Error("SYSTEM_SHUTTING_DOWN");

    const token = cleanToken(input.token);
    (deps.validateToken || validateToken)(token);

    const { guildId } = (deps.normalizeVoiceTarget || normalizeVoiceTarget)(input);
    const hashToken = deps.hashToken || sessionManager.hashToken || sha256;
    const tokenHash = hashToken(token);
    const flightKey = `${tokenHash}:${guildId}`;
    const previousEntry = ensureSessionFlights.get(flightKey) || null;
    const generation = Number(previousEntry?.generation || 0) + 1;
    const previousPromise = previousEntry?.promise || Promise.resolve();
    const runInternal = deps.ensureVoiceSessionInternal || ensureVoiceSessionInternal;

    let promise;
    promise = previousPromise.catch(() => null).then(async () => {
        const latestBeforeStart = ensureSessionFlights.get(flightKey);
        if (latestBeforeStart?.generation !== generation) {
            return supersededVoiceResult(generation);
        }

        const result = await runInternal({ ...input, token, guildId, requestGeneration: generation }, deps);
        const latestAfterStart = ensureSessionFlights.get(flightKey);
        if (latestAfterStart?.generation !== generation) {
            return supersededVoiceResult(generation);
        }
        return result;
    });

    ensureSessionFlights.set(flightKey, { generation, promise });

    try {
        return await promise;
    } finally {
        const current = ensureSessionFlights.get(flightKey);
        if (current?.generation === generation && current?.promise === promise) {
            ensureSessionFlights.delete(flightKey);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🛑  REGION 9: STOP / PAUSE / CLEANUP
// ════════════════════════════════════════════════════════════════════════════
function isSessionEligibleForFailedStopRepair(session, serverId, tokenHash) {
    if (!session || String(session.serverId) !== String(serverId)) return false;
    if (!["stop_cleanup_failed", "session_delete_failed"].includes(session.stoppedReason)) return false;
    return getSessionTokenHash(session.sessionId, session) === tokenHash;
}

async function repairSingleFailedStopSession({ sessionId, session, tokenHash }) {
    const cleanup = await cleanupSessionVoiceConnection(sessionId, session, tokenHash);
    clearReconnect(sessionId);
    recoveryTimestamps.delete(sessionId);

    if (!cleanup.ok || !cleanup.shouldDeleteRecord) {
        await sessionManager.markSessionFailed?.(
            sessionId,
            "stop_cleanup_failed",
            session.stoppedBy || null,
            cleanup.safeError || cleanup.reason || "repair cleanup not verified"
        );
        return false;
    }

    const deleted = await sessionManager.deleteSession(sessionId);
    if (deleted) {
        cleanupSessionClientIfUnused(tokenHash, cleanup.clientRef || session.client, sessionId, session, "failed-stop-repair");
        return true;
    }

    await sessionManager.markSessionFailed?.(
        sessionId,
        "stop_cleanup_failed",
        session.stoppedBy || null,
        "repair delete failed after verified cleanup"
    );
    return false;
}

async function repairFailedStopSessionForTokenGuild(tokenString, serverId) {
    const tokenHash = sessionManager.hashToken
        ? sessionManager.hashToken(tokenString)
        : sha256(tokenString);
    let repaired = 0;
    let blocked = 0;

    for (const [sessionId, session] of sessionManager.getAllSessions()) {
        if (!isSessionEligibleForFailedStopRepair(session, serverId, tokenHash)) continue;

        const ok = await repairSingleFailedStopSession({ sessionId, session, tokenHash });
        if (ok) repaired++;
        else blocked++;
    }

    if (repaired > 0) {
        console.log(`[WORKER] 🧹 Repaired ${repaired} failed voice session record(s) before restart attempt.`);
    }

    return { repaired, blocked };
}

async function persistStopFailure(sessionId, options, cleanup) {
    const markResult = await sessionManager.markSessionFailed?.(
        sessionId,
        "stop_cleanup_failed",
        options.stoppedBy || null,
        cleanup.safeError || cleanup.reason
    );
    const markOk = markResult?.ok ?? markResult;
    if (markOk) {
        console.warn(`[WORKER] ⚠️ Stop cleanup failed for ${sanitizeLogText(sessionId)}: ${cleanup.safeError || cleanup.reason}`);
    } else {
        console.warn(`[WORKER] ⚠️ Stop cleanup failed and failed state was not persisted for ${sanitizeLogText(sessionId)}: ${sanitizeLogText(markResult?.safeError || "UNKNOWN")}`);
    }
    await notifications.markTerminal(sessionId, EVENTS.STOP_FAILED, {
        reason: "ระบบสั่งหยุดแล้ว แต่ยังตรวจพบว่าการเชื่อมต่ออาจค้างอยู่",
        action: "ตรวจสอบบัญชีในช่องเสียง และลองสั่งหยุดอีกครั้ง"
    }).catch(() => {});
}

async function notifySessionStopped(sessionId, options) {
    if (!options.notifyReason) return;

    const idleStop = options.notifyReason === "idle";
    await notifications.markTerminal(
        sessionId,
        idleStop ? EVENTS.SESSION_STOPPED_IDLE : EVENTS.SESSION_STOPPED_MANUAL,
        {
            actorNotified: options.actorNotified === true,
            reason: idleStop
                ? "Session ไม่มี activity เกินเวลาที่ตั้งไว้ ระบบจึงหยุดให้โดยอัตโนมัติ"
                : "มีการสั่งหยุด Session ด้วยตนเอง",
            action: "หากต้องการออนอีกครั้ง ให้เริ่ม Session ใหม่จากแผงควบคุม"
        }
    ).catch(() => {});
}

async function persistSessionDeleteFailure(sessionId, options) {
    const markResult = await sessionManager.markSessionFailed?.(
        sessionId,
        "session_delete_failed",
        options.stoppedBy || null,
        "session delete failed after voice cleanup"
    );
    if (!(markResult?.ok ?? markResult)) {
        console.warn(`[WORKER] ⚠️ Session delete failed and failed state was not persisted for ${sanitizeLogText(sessionId)}: ${sanitizeLogText(markResult?.safeError || "UNKNOWN")}`);
    }
    await notifications.markTerminal(sessionId, EVENTS.STOP_FAILED, {
        reason: "บัญชีออกจากช่องเสียงแล้ว แต่ระบบลบข้อมูลการออนรายการนี้ไม่สำเร็จ",
        action: "ลองกดหยุดอีกครั้ง หากรายการยังค้างอยู่ให้ตรวจสอบฐานข้อมูล"
    }).catch(() => {});
}

function canSessionStop(sessionId) {
    if (st._isProtected?.(sessionId)) {
        console.warn(`[WORKER] 🛡️ Session ${sanitizeLogText(sessionId)} is PROTECTED — stop rejected by Shadow Protocol`);
        return { allowed: false, returnVal: false };
    }
    const session = sessionManager.getSession(sessionId);
    if (!session) {
        console.warn(`[WORKER] ⚠️ Attempted to stop non-existent session: ${sanitizeLogText(sessionId)}`);
        return { allowed: false, returnVal: true };
    }
    if (!lockSession(sessionId)) {
        console.warn(`[WORKER] ⚠️ Session ${sanitizeLogText(sessionId)} is locked during stop — skipping`);
        return { allowed: false, returnVal: false };
    }
    return { allowed: true, session };
}

function stopSessionTimersAndTracking(sessionId) {
    stopNaturalTimer(sessionId);
    stopAutoDeafTimer(sessionId);
    clearHibernateTimer(sessionId);
    channelLock.cancelMoveTracking(sessionId);
}

async function handleUncleanVoiceStop(sessionId, session, tokenHash, clientRef, cleanup, options) {
    if (session.state === "failed" || session.tokenInvalid === true) {
        console.log(`[WORKER] 🧹 Forcing cleanup of already failed session: ${sanitizeLogText(sessionId)}`);
        if (tokenHash && clientRef) {
            cleanupSessionClientIfUnused(tokenHash, clientRef, sessionId, session, "failed-session-stop");
        }
        notifications.cleanupSession(sessionId);
        const deleted = await sessionManager.deleteSession(sessionId).catch(() => false);
        return !!deleted;
    }
    await persistStopFailure(sessionId, options, cleanup);
    return false;
}

async function stopSession(sessionId, options = {}) {
    const check = canSessionStop(sessionId);
    if (!check.allowed) return check.returnVal;
    const session = check.session;

    try {
        const tokenHash = getSessionTokenHash(sessionId, session);
        const clientRef = session.client || getSessionClientFromPool(sessionId, session, tokenHash);

        await refreshSessionMetadataFast(sessionId, 1000).catch(() => {});
        stopSessionTimersAndTracking(sessionId);

        const cleanup = await cleanupSessionVoiceConnection(sessionId, session, tokenHash);
        recoveryTimestamps.delete(sessionId);
        clearReconnect(sessionId);

        if (!cleanup.ok || !cleanup.shouldDeleteRecord) {
            return await handleUncleanVoiceStop(sessionId, session, tokenHash, clientRef, cleanup, options);
        }

        await notifySessionStopped(sessionId, options);

        if (tokenHash && clientRef) {
            cleanupSessionClientIfUnused(tokenHash, clientRef, sessionId, session, "manual-stop");
        }

        const deleted = await sessionManager.deleteSession(sessionId);
        if (!deleted) {
            await persistSessionDeleteFailure(sessionId, options);
            return false;
        }

        console.log(`[WORKER] 🛑 Stopped session: ${sanitizeLogText(sessionId)}`);
        notifications.cleanupSession(sessionId);

        return true;
    } finally {
        unlockSession(sessionId);
    }
}

async function stopAll() {
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] 🛑 Global Stop: ${sessions.size} sessions...`);

    let stopped = 0;
    let failed = 0;
    for (const id of sessions.keys()) {
        const ok = await stopSession(id);
        if (ok) stopped++;
        else failed++;
    }

    if (failed === 0) {
        destroyAllPooledClients("stopAll");
    }
    naturalRunning.clear();
    autoDeafRunning.clear();
    channelLock.clearAllMoveTrackers();

    console.log(`[WORKER] ✅ Global Stop Complete. stopped=${stopped} failed=${failed}`);
}

async function pauseAll() {
    st.isShuttingDown = true;

    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] ⏸️ Global Pause: ${sessions.size} sessions...`);

    stopAllNaturalTimers();
    stopAllAutoDeafTimers();
    channelLock.clearAllMoveTrackers();

    for (const [id, session] of sessions) {
        try {
            if (session.connection) {
                session.connection.destroy();
                session.connection = null;
            }
            session.reconnecting = false;
            unlockSession(id);

            if (typeof sessionManager.pauseSession === "function") {
                await sessionManager.pauseSession(id);
            }
        } catch (err) {
            console.warn(`[WORKER] ⚠️ pauseAll failed for session=${id}: ${err.message}`);
        }
    }

    naturalRunning.clear();
    autoDeafRunning.clear();
    destroyAllPooledClients("pauseAll");
}

// ════════════════════════════════════════════════════════════════════════════
//  🔄  REGION 10: AUTO RESUME & HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════
async function autoResume() {
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] 🔄 Auto-resume scan: ${sessions.size} stored sessions...`);

    let activeToResume = 0;
    let resumed = 0;
    let failed = 0;
    let skipped = 0;

    for (const [id] of sessions) {
        if (st.isShuttingDown) break;

        try {
            const session = sessionManager.getSession(id);
            if (!shouldResumeSession(session)) {
                skipped++;
                continue;
            }

            activeToResume++;

            const token = getSessionToken(id);
            if (token) {
                await startSession(id, token, { notifyInitial: false, source: "auto_resume" });
                resumed++;

                const warmUpJitter = randomInt(2000, 3500);
                await delay(warmUpJitter);
            } else {
                skipped++;
                await sessionManager.markSessionFailed?.(
                    id,
                    "token_unavailable",
                    null,
                    "stored token could not be decrypted or was missing"
                ).catch(() => false);
                await notifications.markTerminal(id, EVENTS.LOGIN_FAILED, {
                    source: "auto_resume",
                    reason: "ไม่พบ Token ที่อ่านได้สำหรับเริ่มการออนเดิมหลังระบบเปิดใหม่",
                    action: "เปิดรายละเอียดบัญชีแล้วใส่ Token ใหม่ จากนั้นเริ่มออนอีกครั้ง"
                }).catch(() => {});
            }
        } catch (err) {
            failed++;
            console.error(`[WORKER] ❌ Failed to auto-resume ${id}: ${err.message}`);
        }
    }

    console.log(`[WORKER] ✅ Auto-resume complete: active=${activeToResume} resumed=${resumed} failed=${failed} skipped=${skipped} total=${sessions.size}`);
}

const {
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
    cleanupIdleSessions: recoveryCleanupIdleSessions
} = require("./lifecycleRecovery");

async function healthCheck() {
    if (st.isShuttingDown) return;
    if (st.healthCheckRunning) {
        console.warn("[HEARTBEAT] ⚠️ Previous healthCheck scan still running — skipped.");
        return;
    }

    st.healthCheckRunning = true;

    try {
        const sessions = sessionManager.getAllSessions();
        const now = Date.now();

        for (const [sessionId, session] of sessions) {
            if (st.isShuttingDown) break;
            processSessionHealthCheck(sessionId, session, now);
        }
    } finally {
        st.healthCheckRunning = false;
    }
}

async function cleanupIdleSessions() {
    return recoveryCleanupIdleSessions({ stopSession });
}

module.exports = {
    getSelfVoiceStateInfo,
    waitForSelfVoiceExit,
    attemptSelfVoiceDisconnect,
    getVoiceGroup,
    destroyConnectionObject,
    cleanupSessionVoiceConnection,
    repairFailedStopSessionForTokenGuild,
    startExistingSession,
    cleanupFailedEnsureSession,
    startSession,
    connectToVoice,
    ensureVoiceSession,
    stopSession,
    stopAll,
    pauseAll,
    autoResume,
    recoverSessionConnection,
    forceReconnectSession,
    scheduleHealthRecovery,
    healthCheck,
    cleanupIdleSessions,
    clearHibernateTimer,
    isInvalidTokenError,
    channelLock,
    _test: {
        ensureSessionFlights,
        ensureVoiceSessionInternal,
        replaceExistingVoiceSession,
        createVoiceSessionWithDuplicateRecovery,
        startCreatedVoiceSession,
        handleRecoveryExhaustion,
        resolveRecoveryClient,
        restoreRecoveryVoiceConnection,
        releaseRecoveryOwnership,
        supersededVoiceResult,
        assertVoiceStartupAllowed,
        performClientLogin,
        processSessionHealthCheck,
        advanceHibernationState,
        handleWrongChannelState,
        isSessionConnectionReady,
        safeRejoinConnection,
        verifyTargetVoiceChannel,
        handlePreflightFailure,
        handleHibernateTransition,
        resolveHibernatePauseMs,
        cleanupStaleConnectionIfPresent,
        executePassiveReconnect,
        setupVoiceConnectionListeners
    }
};
