/* eslint-disable complexity -- Voice/session lifecycle is behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT MODIFY: MAX_RECONNECT_ATTEMPTS, CONNECTION_TIMEOUT, LOGIN_TIMEOUT.
DO NOT REMOVE: isShuttingDown flag — critical for SIGTERM safety (เฟส 8+18).
DO NOT SIMPLIFY: OperationQueue concurrency — prevents IP ban from Discord.
================================================================================
*/
const { Client: SelfClient } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");
const sessionManager = require("../sessionManager");
const { sendAlertWebhook } = require("../core/webhooks");
const { sanitizeLogText } = require("../core/safeLogger");
const {
    st,
    naturalRunning,
    autoDeafRunning,
    lastDMSent,
    lastOnlineDMSent,
    recoveryTimestamps,
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
const { sendSessionStoppedDM, sendTokenInvalidDM, sendSessionOnlineDM } = require("./dm");
const { startNaturalTimer, stopNaturalTimer, stopAllNaturalTimers } = require("./natural");
const { startAutoDeafTimer, stopAutoDeafTimer, stopAllAutoDeafTimers } = require("./autoDeaf");
const { loginQueue, recoveryQueue } = require("./queue");


// ════════════════════════════════════════════════════════════════════════════
//  🛑  REGION 9 (helpers): Connection cleanup utilities
// ════════════════════════════════════════════════════════════════════════════
function getVoiceGroup(client, guildId, session = null) {
    const userId = client?.user?.id || session?.accountId;
    if (!userId || !guildId) return null;
    return `${userId}:${guildId}`;
}

function destroyConnectionObject(connection) {
    if (!connection || connection.state?.status === VoiceConnectionStatus.Destroyed) return false;
    connection.destroy();
    return true;
}

function getSelfVoiceStateInfo(client, session) {
    const guild = client?.guilds?.cache?.get?.(session.serverId) || null;
    const userId = client?.user?.id || null;
    const member = guild && userId
        ? (guild.members?.me || guild.me || guild.members?.cache?.get?.(userId) || null)
        : null;
    const memberVoice = member?.voice || null;
    const cachedState = guild && userId ? guild.voiceStates?.cache?.get?.(userId) : null;
    const voiceState = memberVoice || cachedState || null;
    const channelId =
        memberVoice?.channelId ||
        memberVoice?.channel?.id ||
        cachedState?.channelId ||
        cachedState?.channel?.id ||
        null;

    return {
        inspectable: !!guild && (!!memberVoice || !!cachedState),
        inTargetGuild: !!channelId,
        inTargetChannel: !!channelId && String(channelId) === String(session.voiceId),
        channelId,
        voiceState,
        memberVoice
    };
}

async function waitForSelfVoiceExit(clientRef, session, timeoutMs = 1200) {
    const started = Date.now();
    let lastInfo = getSelfVoiceStateInfo(clientRef, session);

    while (Date.now() - started < timeoutMs) {
        if (!lastInfo.inTargetChannel) return lastInfo;
        await delay(150);
        lastInfo = getSelfVoiceStateInfo(clientRef, session);
    }

    return lastInfo;
}

async function attemptSelfVoiceDisconnect(clientRef, session, sessionId, tokenHash, errors) {
    let info = getSelfVoiceStateInfo(clientRef, session);
    if (!info.inTargetChannel) return info;

    const started = Date.now();
    const budgetMs = 1500;
    const disconnectors = [
        { target: info.memberVoice, method: "disconnect", args: ["Voice session stopped"] },
        { target: info.voiceState, method: "disconnect", args: ["Voice session stopped"] },
        { target: info.memberVoice, method: "setChannel", args: [null, "Voice session stopped"] },
        { target: info.voiceState, method: "setChannel", args: [null, "Voice session stopped"] }
    ].filter(item => item.target && typeof item.target[item.method] === "function");

    for (const item of disconnectors) {
        info = getSelfVoiceStateInfo(clientRef, session);
        if (!info.inTargetChannel) return info;
        if (Date.now() - started >= budgetMs) break;

        try {
            await item.target[item.method](...item.args);
            const remainingMs = Math.max(150, budgetMs - (Date.now() - started));
            const after = await waitForSelfVoiceExit(clientRef, session, Math.min(remainingMs, 750));
            if (!after.inTargetChannel) return after;
        } catch (err) {
            errors.push(`selfVoiceDisconnect:${sanitizeLifecycleError(err.message)}`);
        }
    }

    info = getSelfVoiceStateInfo(clientRef, session);
    if (!info.inTargetChannel) return info;

    const otherActive = countOtherActiveSessionsForClient(tokenHash, sessionId, session);
    if (otherActive <= 0) {
        cleanupSessionClientIfUnused(tokenHash, clientRef, sessionId, session, "self-voice-fallback");
        const afterDestroy = await waitForSelfVoiceExit(clientRef, session, 500);
        return afterDestroy.inTargetChannel
            ? afterDestroy
            : { inspectable: true, inTargetGuild: false, inTargetChannel: false, channelId: null };
    }

    errors.push(`selfVoiceStillConnected:activeSessions=${otherActive}`);
    return getSelfVoiceStateInfo(clientRef, session);
}

function verifyCleanupState(registryAfter, ownConnection, selfVoiceInfo, errors, clientRef) {
    const registryAlive = !!registryAfter && registryAfter.state?.status !== VoiceConnectionStatus.Destroyed;
    const ownConnectionAlive = !!ownConnection && ownConnection.state?.status !== VoiceConnectionStatus.Destroyed;
    const selfStillInTargetVoice = !!selfVoiceInfo.inTargetChannel;

    if (registryAlive) errors.push("voiceRegistry:still_active");
    if (ownConnectionAlive) errors.push("session.connection:still_active");
    if (selfStillInTargetVoice) {
        errors.push("selfVoiceStillConnected:target_channel");
    }

    const ok = errors.length === 0 && !registryAlive && !ownConnectionAlive && !selfStillInTargetVoice;

    return {
        ok,
        verified: ok && (selfVoiceInfo.inspectable || !clientRef?.isReady?.()),
        reason: ok ? "cleanup_verified" : "cleanup_not_confirmed",
        safeError: errors.join("; ") || null
    };
}

async function cleanupSessionVoiceConnection(sessionId, session, tokenHash) {
    const errors = [];
    const clientRef = session.client || getSessionClientFromPool(sessionId, session, tokenHash);
    const group = getVoiceGroup(clientRef, session.serverId, session);

    const ownConnection = session.connection;

    try {
        if (ownConnection) destroyConnectionObject(ownConnection);
    } catch (err) {
        errors.push(`session.connection:${sanitizeLifecycleError(err.message)}`);
    }

    try {
        const registryConnection = group ? getVoiceConnection(session.serverId, group) : null;
        if (registryConnection) destroyConnectionObject(registryConnection);
    } catch (err) {
        errors.push(`voiceRegistry:${sanitizeLifecycleError(err.message)}`);
    }

    let selfVoiceInfo = { inspectable: false, inTargetGuild: false, inTargetChannel: false, channelId: null };
    if (clientRef) {
        selfVoiceInfo = await attemptSelfVoiceDisconnect(clientRef, session, sessionId, tokenHash, errors);
    }

    const registryAfter = group ? getVoiceConnection(session.serverId, group) : null;
    const ownConnectionAlive = !!ownConnection && ownConnection.state?.status !== VoiceConnectionStatus.Destroyed;
    session.connection = ownConnectionAlive ? ownConnection : null;

    const verification = verifyCleanupState(registryAfter, ownConnection, selfVoiceInfo, errors, clientRef);

    return {
        ...verification,
        shouldDeleteRecord: verification.ok,
        clientRef
    };
}

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

async function cleanupFailedEnsureSession(sessionId, ownerId, reason) {
    if (!sessionId) return;

    const removed = await sessionManager.deleteSession(sessionId).catch(() => false);
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
function setupClientEventHandlers(newClient, sessionId) {
    newClient.on("ready", () => {
        console.log(`[WORKER] 🟢 Self-bot connected: ${newClient.user.tag}`);
        try { newClient.user.setStatus("idle"); } catch {}
    });
    newClient.on("invalidated", async () => {
        console.error(`[WORKER] 🚫 Token invalidated (WS) for session: ${sanitizeLogText(sessionId)}`);
        const sess = sessionManager.getSession(sessionId);
        if (sess) sess.tokenInvalid = true;
        stopNaturalTimer(sessionId);
        stopAutoDeafTimer(sessionId);
        await sendTokenInvalidDM(sessionId).catch(() => {});
    });
}

async function performClientLogin(newClient, sessionId, session, tokenHash, tokenString) {
    try {
        await waitForTokenLoginCooldown(tokenHash);
        await loginQueue.add(async () => {
            await withTimeoutReject(newClient.login(tokenString), CONFIG.LOGIN_TIMEOUT, "LOGIN_TIMEOUT");
        });
        setSessionClientInPool(sessionId, session, tokenHash, newClient);
    } catch (err) {
        console.error(`[WORKER] ❌ Login failed for ${sanitizeLogText(sessionId)}. Destroying ghost client.`);
        try { disposeSelfClient(newClient, "login-failure"); } catch {}
        if (err.code === "OPERATION_QUEUE_FULL") throw new Error("VOICE_QUEUE_BUSY");
        const isTokenErr =
            err.message.includes("TOKEN_INVALID") ||
            err.message.includes("Incorrect login") ||
            err.message.includes("401");
        if (isTokenErr) {
            const sess = sessionManager.getSession(sessionId);
            if (sess) sess.tokenInvalid = true;
            sendTokenInvalidDM(sessionId).catch(() => {});
            throw new Error("TOKEN_INVALID");
        }
        throw err;
    }
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

async function startSession(sessionId, tokenString) {
    if (st.isShuttingDown) throw new Error("SYSTEM_SHUTTING_DOWN");

    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    validateToken(tokenString);

    if (!lockSession(sessionId)) {
        console.warn(`[WORKER] ⚠️ Session ${sanitizeLogText(sessionId)} is locked. Skipping.`);
        throw new Error("SESSION_LOCKED");
    }

    let tokenHash = null;

    try {
        tokenHash = getSessionTokenHash(sessionId, session);
        if (!tokenHash) throw new Error("TOKEN_DECRYPTION_FAILED");

        /*
         * Client ownership is token+guild scoped. Same token in different guilds
         * gets separate SelfClient instances to avoid shared gateway voice-state fights.
         */
        await resolveOrLoginSessionClient(sessionId, session, tokenHash, tokenString);

        const jitterDelay = randomInt(1500, 3500);
        await delay(jitterDelay);

        const conn = await connectToVoice(session.client, session.serverId, session.voiceId, tokenHash, sessionId);
        session.connection = conn;

        console.log(`[WORKER] 🎧 Voice connected for Session: ${sanitizeLogText(sessionId)} Guild: ${session.serverId}`);

        await refreshSessionMetadataFast(sessionId, 1800).catch(() => {});
        cleanupLeanSessionClient(sessionId, "post-connect");

        startNaturalTimer(sessionId);
        startAutoDeafTimer(sessionId);

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

        throw err;
    } finally {
        unlockSession(sessionId);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔊  REGION 7: VOICE CONNECTION
// ════════════════════════════════════════════════════════════════════════════
async function connectToVoice(client, guildId, channelId, tokenHash, sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    const guild =
        client.guilds.cache.get(guildId) ||
        await client.guilds.fetch(guildId).catch(() => null);

    if (!guild) throw new Error("GUILD_NOT_FOUND");

    const channel =
        guild.channels.cache.get(channelId) ||
        await guild.channels.fetch(channelId).catch(() => null);

    if (!channel?.isVoice()) throw new Error("CHANNEL_NOT_FOUND");

    await refreshSessionMetadata(sessionId, client, guild, channel).catch(() => {});
    debugVoiceSession("beforeJoin", sessionId, session, {
        accountId: client.user?.id || session.accountId || null,
        group: client.user?.id ? `${client.user.id}:${guild.id}` : null,
        selfVoice: getSelfVoiceStateInfo(client, session).channelId || null,
        sameAccountSessions: countActiveSessionsForAccountId(client.user?.id || session.accountId)
    });

    /*
     * Important:
     * Do NOT use getVoiceConnection(guildId) here.
     * It is guild-wide and can point to another token/session in the same guild.
     * Destroying it causes cross-token collision.
     *
     * Correct behavior:
     * - Same token + same guild is blocked before this point.
     * - Same token + different guild uses a separate session-owned SelfClient.
     * - Different tokens in same guild/channel must not affect each other.
     */
    const existingConn = session.connection;

    if (existingConn && existingConn.state?.status !== VoiceConnectionStatus.Destroyed) {
        const sameGuild = String(existingConn.joinConfig?.guildId) === String(guildId);
        const sameChannel = String(existingConn.joinConfig?.channelId) === String(channelId);

        if (sameGuild && sameChannel && existingConn.state.status === VoiceConnectionStatus.Ready) {
            console.log(`[WORKER] ♻️ Reusing own ready connection for ${sanitizeLogText(sessionId)}`);
            return existingConn;
        }

        try {
            console.log(`[WORKER] 🧹 Destroying own stale connection for ${sanitizeLogText(sessionId)}`);
            existingConn.destroy();
        } catch {}
    }

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: true,

        /*
         * group separated by account + guild prevents voice registry collision
         * when multiple tokens join the same guild or same channel.
         */
        group: `${client.user.id}:${guild.id}`
    });

    connection.setMaxListeners(20);
    debugVoiceSession("afterJoinRequested", sessionId, session, {
        accountId: client.user?.id || session.accountId || null,
        group: `${client.user.id}:${guild.id}`,
        connectionStatus: connection.state?.status || null,
        selfVoice: getSelfVoiceStateInfo(client, session).channelId || null,
        sameAccountSessions: countActiveSessionsForAccountId(client.user?.id || session.accountId)
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
        sessionManager.touchSession(sessionId);
        refreshSessionMetadataFast(sessionId, 1200)
            .finally(() => cleanupLeanSessionClient(sessionId, "voice-ready"))
            .catch(() => {});
        console.log(`[WORKER] 💚 Voice Ready for ${sanitizeLogText(sessionId)}`);
    });

    let reconnectAttempts = 0;

    async function onVoiceDisconnected() {
        if (st.isShuttingDown) {
            console.log(`[WORKER] ⏸️ Shutdown in progress — skipping reconnect for ${sanitizeLogText(sessionId)}`);
            return;
        }

        reconnectAttempts++;
        addReconnect(sessionId);

        const currentSession = sessionManager.getSession(sessionId);
        if (currentSession) currentSession.reconnectCount = (currentSession.reconnectCount || 0) + 1;

        console.log(`[WORKER] ⚠️ Voice dropped for ${sanitizeLogText(sessionId)}. Attempt ${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}`);

        if (reconnectAttempts === 3) {
            const sess = sessionManager.getSession(sessionId);
            sendAlertWebhook({
                content: [ // nosemgrep
                    `${config.emojis.warning} **[SESSION WARNING]** session หลุดบ่อยผิดปกติ`,
                    `${config.emojis.robot} Session: \`${getSessionShortId(sessionId)}\``,
                    `${config.emojis.signal} เซิร์ฟเวอร์: **${sanitizeLogText(sess?.serverName || guildId)}**`,
                    `${config.emojis.halt} ห้องเสียง: **${sanitizeLogText(sess?.voiceName || channel.name || channelId)}**`,
                    `${config.emojis.alert} หลุดแล้ว: **${reconnectAttempts}** ครั้ง (สูงสุด ${CONFIG.MAX_RECONNECT_ATTEMPTS})`,
                    `⏰ <t:${Math.floor(Date.now() / 1000)}:F>`
                ].join("\n")
            }).catch(() => {});
        }

        if (reconnectAttempts > CONFIG.MAX_RECONNECT_ATTEMPTS) {
            await handleMaxReconnectReached();
            return;
        }

        await handlePassiveReconnect();
    }

    async function handleMaxReconnectReached() {
        console.error(`[WORKER] 💀 Max reconnect attempts (${CONFIG.MAX_RECONNECT_ATTEMPTS}) reached for ${sanitizeLogText(sessionId)}. Aborting.`);

        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
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
            }
            cleanupSessionClientIfUnused(failedTokenHash, failedClientRef, sessionId, failedSession, "max-reconnect");
        }

        await sendSessionStoppedDM(sessionId, "maxRetries");

        const sess = sessionManager.getSession(sessionId);
        sendAlertWebhook({
            content: [ // nosemgrep
                `${config.emojis.error} **[SESSION DEAD]** session หลุดเกินกำหนด ระบบหยุดแล้ว`,
                `${config.emojis.robot} Session: \`${getSessionShortId(sessionId)}\``,
                `${config.emojis.signal} เซิร์ฟเวอร์: **${sanitizeLogText(sess?.serverName || guildId)}**`,
                `${config.emojis.stop} ห้องเสียง: **${sanitizeLogText(sess?.voiceName || channel.name || channelId)}**`,
                `${config.emojis.no_entry} พยายามต่อใหม่: **${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}** ครั้ง — ยกเลิกแล้ว`,
                `⏰ <t:${Math.floor(Date.now() / 1000)}:F>`
            ].join("\n")
        }).catch(() => {});
    }

    async function handlePassiveReconnect() {
        const backoffMs = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);

        let onPassiveReady;
        let passiveResolved = false;

        try {
            const passivePromise = new Promise(resolve => {
                onPassiveReady = () => {
                    if (!passiveResolved) { passiveResolved = true; resolve(); }
                };
                connection.once(VoiceConnectionStatus.Ready, onPassiveReady);
            });

            await withTimeoutReject(passivePromise, backoffMs, "TIMEOUT");

            if (onPassiveReady) connection.off(VoiceConnectionStatus.Ready, onPassiveReady);

            const prevAttempts = reconnectAttempts;
            reconnectAttempts = 0;
            clearReconnect(sessionId);

            console.log(`[WORKER] ✅ Passive reconnect OK for ${sanitizeLogText(sessionId)}.`);

            if (prevAttempts > 1) sendSessionOnlineDM(sessionId).catch(() => {});

        } catch {
            if (onPassiveReady) connection.off(VoiceConnectionStatus.Ready, onPassiveReady);

            console.warn(`[WORKER] ⚡ Passive reconnect timed out for ${sanitizeLogText(sessionId)} — triggering urgent recovery.`);

            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                try { connection.destroy(); } catch {}
            }

            const sess = sessionManager.getSession(sessionId);
            if (sess) sess.urgentRecovery = true;

            const recoveryTimer = setTimeout(() => healthCheck().catch(() => {}), 2000);
            recoveryTimer.unref?.();
        }
    }

    connection.on(VoiceConnectionStatus.Disconnected, onVoiceDisconnected);

    return connection;
}

// ════════════════════════════════════════════════════════════════════════════
//  🔒  ensureVoiceSession (entry point for external callers)
// ════════════════════════════════════════════════════════════════════════════
async function ensureVoiceSession(input = {}) {
    if (st.isShuttingDown) throw new Error("SYSTEM_SHUTTING_DOWN");

    const token = String(input.token || "").trim();
    validateToken(token);

    const { guildId, channelId } = normalizeVoiceTarget(input);
    const guildName = input.guildName || "เซิร์ฟเวอร์ไม่ทราบชื่อ";
    const reason = input.reason || "ensure";
    const tokenHash = sessionManager.hashToken
        ? sessionManager.hashToken(token)
        : sha256(token);

    await repairFailedStopSessionForTokenGuild(token, guildId);

    const existing = sessionManager.findActiveVoiceSessionByTokenGuild?.(tokenHash, guildId);
    if (existing?.session) {
        const existingSession = existing.session;
        const sameChannel = String(existingSession.voiceId || "") === String(channelId);

        if (!sameChannel) {
            return {
                ok: false,
                action: "already_active_different_channel",
                sessionId: existing.id || existingSession.sessionId,
                session: existingSession,
                requested: { guildId, channelId },
                existing: {
                    guildId: existingSession.serverId,
                    channelId: existingSession.voiceId
                }
            };
        }

        const result = await startExistingSession({
            sessionId: existing.id || existingSession.sessionId,
            token,
            channelId,
            reason
        });

        return {
            ok: true,
            reused: true,
            ...result
        };
    }

    let sessionId = null;
    try {
        sessionId = await sessionManager.createSession(
            token,
            guildId,
            channelId,
            guildName,
            input.ownerId || null,
            input.ownerAvatar || null,
            input.ownerTag || null
        );

        await startSession(sessionId, token);

        return {
            ok: true,
            reused: false,
            action: "created",
            sessionId,
            session: sessionManager.getSession(sessionId)
        };
    } catch (err) {
        if (!sessionId && err.message === "ALREADY_ACTIVE_IN_GUILD") {
            const racedExisting = sessionManager.findActiveVoiceSessionByTokenGuild?.(tokenHash, guildId);
            if (racedExisting?.session && String(racedExisting.session.voiceId || "") === String(channelId)) {
                const result = await startExistingSession({
                    sessionId: racedExisting.id || racedExisting.session.sessionId,
                    token,
                    channelId,
                    reason
                });

                return {
                    ok: true,
                    reused: true,
                    raced: true,
                    ...result
                };
            }
        }

        if (sessionId) {
            await cleanupFailedEnsureSession(sessionId, input.ownerId, reason);
        }
        throw err;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🛑  REGION 9: STOP / PAUSE / CLEANUP
// ════════════════════════════════════════════════════════════════════════════
async function repairFailedStopSessionForTokenGuild(tokenString, serverId) {
    const tokenHash = sessionManager.hashToken
        ? sessionManager.hashToken(tokenString)
        : sha256(tokenString);
    let repaired = 0;
    let blocked = 0;

    for (const [sessionId, session] of sessionManager.getAllSessions()) {
        if (!session || String(session.serverId) !== String(serverId)) continue;
        if (!["stop_cleanup_failed", "session_delete_failed"].includes(session.stoppedReason)) continue;
        if (getSessionTokenHash(sessionId, session) !== tokenHash) continue;

        const cleanup = await cleanupSessionVoiceConnection(sessionId, session, tokenHash);
        clearReconnect(sessionId);
        recoveryTimestamps.delete(sessionId);

        if (!cleanup.ok || !cleanup.shouldDeleteRecord) {
            blocked++;
            await sessionManager.markSessionFailed?.(
                sessionId,
                "stop_cleanup_failed",
                session.stoppedBy || null,
                cleanup.safeError || cleanup.reason || "repair cleanup not verified"
            );
            continue;
        }

        const deleted = await sessionManager.deleteSession(sessionId);
        if (deleted) {
            repaired++;
            cleanupSessionClientIfUnused(tokenHash, cleanup.clientRef || session.client, sessionId, session, "failed-stop-repair");
        } else {
            blocked++;
            await sessionManager.markSessionFailed?.(
                sessionId,
                "stop_cleanup_failed",
                session.stoppedBy || null,
                "repair delete failed after verified cleanup"
            );
        }
    }

    if (repaired > 0) {
        console.log(`[WORKER] 🧹 Repaired ${repaired} failed voice session record(s) before restart attempt.`);
    }

    return { repaired, blocked };
}

async function stopSession(sessionId, options = {}) {
    if (st._isProtected?.(sessionId)) {
        console.warn(`[WORKER] 🛡️ Session ${sanitizeLogText(sessionId)} is PROTECTED — stop rejected by Shadow Protocol`);
        return false;
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
        console.warn(`[WORKER] ⚠️ Attempted to stop non-existent session: ${sanitizeLogText(sessionId)}`);
        return true;
    }

    if (!lockSession(sessionId)) {
        console.warn(`[WORKER] ⚠️ Session ${sanitizeLogText(sessionId)} is locked during stop — skipping`);
        return false;
    }

    try {
        const tokenHash = getSessionTokenHash(sessionId, session);
        const clientRef = session.client || getSessionClientFromPool(sessionId, session, tokenHash);

        await refreshSessionMetadataFast(sessionId, 1000).catch(() => {});

        stopNaturalTimer(sessionId);
        stopAutoDeafTimer(sessionId);

        const cleanup = await cleanupSessionVoiceConnection(sessionId, session, tokenHash);
        recoveryTimestamps.delete(sessionId);
        lastDMSent.delete(sessionId);
        lastOnlineDMSent.delete(sessionId);
        clearReconnect(sessionId);

        if (!cleanup.ok || !cleanup.shouldDeleteRecord) {
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
            return false;
        }

        if (options.notifyReason) {
            await sendSessionStoppedDM(sessionId, options.notifyReason).catch(() => {});
        }

        if (tokenHash && clientRef) {
            cleanupSessionClientIfUnused(tokenHash, clientRef, sessionId, session, "manual-stop");
        }

        const deleted = await sessionManager.deleteSession(sessionId);
        if (!deleted) {
            const markResult = await sessionManager.markSessionFailed?.(
                sessionId,
                "session_delete_failed",
                options.stoppedBy || null,
                "session delete failed after voice cleanup"
            );
            if (!(markResult?.ok ?? markResult)) {
                console.warn(`[WORKER] ⚠️ Session delete failed and failed state was not persisted for ${sanitizeLogText(sessionId)}: ${sanitizeLogText(markResult?.safeError || "UNKNOWN")}`);
            }
            return false;
        }

        console.log(`[WORKER] 🛑 Stopped session: ${sanitizeLogText(sessionId)}`);

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
    lastDMSent.clear();
    lastOnlineDMSent.clear();

    console.log(`[WORKER] ✅ Global Stop Complete. stopped=${stopped} failed=${failed}`);
}

async function pauseAll() {
    st.isShuttingDown = true;

    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] ⏸️ Global Pause: ${sessions.size} sessions...`);

    stopAllNaturalTimers();
    stopAllAutoDeafTimers();

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
                await startSession(id, token);
                resumed++;

                const warmUpJitter = randomInt(2000, 3500);
                await delay(warmUpJitter);
            } else {
                skipped++;
            }
        } catch (err) {
            failed++;
            console.error(`[WORKER] ❌ Failed to auto-resume ${id}: ${err.message}`);
        }
    }

    console.log(`[WORKER] ✅ Auto-resume complete: active=${activeToResume} resumed=${resumed} failed=${failed} skipped=${skipped} total=${sessions.size}`);
}

async function recoverSessionConnection(sessionId, tokenHash) {
    try {
        const session = sessionManager.getSession(sessionId);
        if (!session || st.isShuttingDown || !isSessionRunnable(session)) return;

        const recoveryJitter = randomInt(1000, 3000);
        await delay(recoveryJitter);

        if (st.isShuttingDown) return;

        const latest = sessionManager.getSession(sessionId);
        if (!latest || st.isShuttingDown || !isSessionRunnable(latest)) return;

        if (!latest.client) latest.client = getSessionClientFromPool(sessionId, latest, tokenHash);
        if (!latest.client?.isReady?.()) return;

        const conn = await connectToVoice(latest.client, latest.serverId, latest.voiceId, tokenHash, sessionId);
        if (conn) latest.connection = conn;

        console.log(`[HEARTBEAT] 💖 Restored connection for ${sanitizeLogText(sessionId)}.`);
        sendSessionOnlineDM(sessionId).catch(() => {});

        startNaturalTimer(sessionId);
        startAutoDeafTimer(sessionId);

    } catch (e) {
        console.error(`[HEARTBEAT] 💔 Recovery failed for ${sanitizeLogText(sessionId)}: ${e.message}`);
    } finally {
        const latest = sessionManager.getSession(sessionId);
        if (latest) latest.reconnecting = false;
        unlockSession(sessionId);
    }
}

function scheduleHealthRecovery(sessionId, session, tokenHash, now) {
    if (!lockSession(sessionId)) return false;

    session.reconnecting = true;
    recoveryTimestamps.set(sessionId, now);

    console.log(`[HEARTBEAT] 🩺 Queueing dead connection recovery for ${sanitizeLogText(sessionId)}...`);

    recoveryQueue.add(() => recoverSessionConnection(sessionId, tokenHash)).catch((e) => {
        console.error(`[HEARTBEAT] 💔 Recovery queue failed for ${sanitizeLogText(sessionId)}: ${e.message}`);
        const latest = sessionManager.getSession(sessionId);
        if (latest) latest.reconnecting = false;
        unlockSession(sessionId);
    });

    return true;
}

function processSessionHealthCheck(sessionId, session, now) {
    if (!isSessionRunnable(session)) return;

    const tokenHash = getSessionTokenHash(sessionId, session);
    if (!tokenHash) return;

    const pooledClient = getSessionClientFromPool(sessionId, session, tokenHash);
    if (!pooledClient) return;

    if (!session.client) session.client = pooledClient;
    if (!session.client?.isReady?.()) return;

    const connStatus = session.connection?.state?.status;
    const needsRecovery =
        !session.connection ||
        connStatus === VoiceConnectionStatus.Destroyed ||
        connStatus === VoiceConnectionStatus.Disconnected;

    const lastRecovered = recoveryTimestamps.get(sessionId) || 0;
    const isUrgent = session.urgentRecovery === true;
    const onCooldown = !isUrgent && (now - lastRecovered) < RECOVERY_COOLDOWN_MS;

    if (isUrgent) session.urgentRecovery = false;

    if (!needsRecovery) {
        sessionManager.touchSession(sessionId);
        return;
    }

    if (!onCooldown && !session.reconnecting && !isSessionLocked(sessionId)) {
        scheduleHealthRecovery(sessionId, session, tokenHash, now);
    }
}

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
    if (st.isShuttingDown) return;

    const now = Date.now();
    const savedHrs = await sessionManager.getSetting("idleTimeoutHrs", null).catch(() => null);
    const parsedHrs = Number.parseInt(savedHrs, 10);
    const maxIdle = (savedHrs && parsedHrs > 0)
        ? parsedHrs * 3600000
        : config.limits.idleTimeoutMs;
    const sessions = sessionManager.getAllSessions();

    for (const [id, session] of sessions) {
        const lastSeen = session.lastActivity ?? session.startedAt;

        if (now - lastSeen > maxIdle) {
            console.log(`[CLEANUP] 🧹 Session ${id} idle for ${Math.round((now - lastSeen) / 3600000)}h — shutting down.`);
            await sendSessionStoppedDM(id, "idle");
            const stopped = await stopSession(id);
            if (!stopped) {
                console.warn(`[CLEANUP] ⚠️ Idle cleanup could not stop ${id}; session remains visible for review.`);
            }
        }
    }
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
    scheduleHealthRecovery,
    healthCheck,
    cleanupIdleSessions,
};
