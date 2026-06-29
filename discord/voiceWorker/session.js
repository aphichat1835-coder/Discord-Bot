const crypto = require("node:crypto");
const sessionManager = require("../sessionManager");
const { sanitizeLogText } = require("../core/safeLogger");
const { st, clientPool, tokenLoginCooldowns } = require("./state");
const {
    TOKEN_LOGIN_COOLDOWN_TTL_MS,
    TOKEN_LOGIN_COOLDOWN_MAX_SIZE,
    delay,
} = require("./config");

// ════════════════════════════════════════════════════════════════════════════
//  🔐  REGION 3: TOKEN VALIDATION & SESSION MANAGER COMPAT
// ════════════════════════════════════════════════════════════════════════════
function validateToken(token) {
    if (typeof token !== "string" || token.length > 256) throw new Error("INVALID_TOKEN_FORMAT");
    const tokenRegex = /^[\w-]{24,}\.[\w-]{6,}\.[\w-]{27,}$/;
    if (!tokenRegex.test(token)) throw new Error("INVALID_TOKEN_FORMAT");
    return true;
}

function sanitizeLifecycleError(value) {
    return sanitizeLogText(value || "UNKNOWN_ERROR").slice(0, 300);
}

function isSessionRunnable(session) {
    if (typeof sessionManager.isSessionRunnable === "function") {
        return sessionManager.isSessionRunnable(session);
    }
    const state = session?.state || "active";
    return state === "active";
}

function shouldResumeSession(session) {
    if (typeof sessionManager.shouldResumeSession === "function") {
        return sessionManager.shouldResumeSession(session);
    }
    return (session?.state || "active") === "active";
}

function sha256(value) {
    return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function getSessionToken(sessionId) {
    if (typeof sessionManager.getSessionToken === "function") {
        return sessionManager.getSessionToken(sessionId);
    }
    if (typeof sessionManager.getToken === "function") {
        return sessionManager.getToken(sessionId);
    }
    return null;
}

function getSessionTokenHash(sessionId, session) {
    if (session?.tokenHash) return session.tokenHash;

    if (typeof sessionManager.getSessionTokenHash === "function") {
        const tokenHash = sessionManager.getSessionTokenHash(sessionId, session);
        if (tokenHash) {
            if (session) session.tokenHash = tokenHash;
            return tokenHash;
        }
    }

    const token = getSessionToken(sessionId);
    if (token) {
        const tokenHash = sha256(token);
        if (session) session.tokenHash = tokenHash;
        return tokenHash;
    }

    return null;
}

function lockSession(sessionId) {
    if (typeof sessionManager.lockSession === "function") {
        return sessionManager.lockSession(sessionId);
    }
    if (typeof sessionManager.acquireSessionLock === "function") {
        return sessionManager.acquireSessionLock(sessionId);
    }
    return true;
}

function unlockSession(sessionId) {
    if (typeof sessionManager.unlockSession === "function") {
        return sessionManager.unlockSession(sessionId);
    }
    if (typeof sessionManager.releaseSessionLock === "function") {
        return sessionManager.releaseSessionLock(sessionId);
    }
    return true;
}

function isSessionLocked(sessionId) {
    if (typeof sessionManager.isSessionLocked === "function") {
        return sessionManager.isSessionLocked(sessionId);
    }
    return false;
}

function addReconnect(sessionId) {
    if (typeof sessionManager.addReconnect === "function") {
        return sessionManager.addReconnect(sessionId);
    }
    if (typeof sessionManager.recordReconnectAttempt === "function") {
        return sessionManager.recordReconnectAttempt(sessionId);
    }
    return null;
}

function clearReconnect(sessionId) {
    if (typeof sessionManager.clearReconnect === "function") {
        return sessionManager.clearReconnect(sessionId);
    }
    if (typeof sessionManager.resetReconnectInfo === "function") {
        return sessionManager.resetReconnectInfo(sessionId);
    }
    return null;
}

async function updateSessionMetadata(sessionId, metadata = {}) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return false;

    for (const [key, value] of Object.entries(metadata)) {
        session[key] = value ?? null;
    }
    session.lastActivity = Date.now();

    if (typeof sessionManager.updateSessionMetadata === "function") {
        return sessionManager.updateSessionMetadata(sessionId, metadata);
    }

    return true;
}

function countActiveSessionsByTokenHash(tokenHash) {
    if (typeof sessionManager.countActiveSessionsByTokenHash === "function") {
        return sessionManager.countActiveSessionsByTokenHash(tokenHash);
    }

    let count = 0;
    const sessions = sessionManager.getAllSessions();
    for (const [id, session] of sessions) {
        if (getSessionTokenHash(id, session) === tokenHash) count++;
    }
    return count;
}

function getSessionShortId(sessionId) {
    if (typeof sessionManager.getSessionShortId === "function") {
        return sessionManager.getSessionShortId(sessionId);
    }
    return String(sessionId || "").replace(/^vc_/, "").slice(0, 10);
}

function getClientPoolKey(tokenHash, session) {
    if (!tokenHash || !session?.serverId) return null;
    return sha256(`voice-client:${tokenHash}:${session.serverId}`);
}

function getSessionClientFromPool(sessionId, session, tokenHash) {
    const clientKey = getClientPoolKey(tokenHash, session);
    if (!clientKey) return null;

    const pooledClient = clientPool.get(clientKey) || null;
    if (pooledClient && session && !session.client) {
        session.client = pooledClient;
    }

    debugVoiceSession("clientPool.get", sessionId, session, {
        hit: !!pooledClient,
        strategy: getClientPoolStrategyName()
    });

    return pooledClient;
}

function setSessionClientInPool(sessionId, session, tokenHash, client) {
    const clientKey = getClientPoolKey(tokenHash, session);
    if (!clientKey || !client) return false;

    clientPool.set(clientKey, client);
    if (session) session.client = client;
    debugVoiceSession("clientPool.set", sessionId, session, { strategy: getClientPoolStrategyName() });
    return true;
}

function deleteSessionClientFromPool(sessionId, session, tokenHash, clientRef = null) {
    const clientKey = getClientPoolKey(tokenHash, session);
    if (!clientKey) return false;

    const pooledClient = clientPool.get(clientKey);
    if (clientRef && pooledClient && pooledClient !== clientRef) return false;

    clientPool.delete(clientKey);
    debugVoiceSession("clientPool.delete", sessionId, session, { strategy: getClientPoolStrategyName() });
    return true;
}

function destroySessionClient(sessionId, session, tokenHash, reason = "cleanup", clientRef = null) {
    const targetClient = clientRef || session?.client || getSessionClientFromPool(sessionId, session, tokenHash);
    if (!targetClient) return false;

    try {
        disposeSelfClient(targetClient, reason);
    } catch (err) {
        console.warn(`[CLEANUP] ⚠️ Failed to destroy session client for ${getSessionShortId(sessionId)} (${reason}): ${sanitizeLifecycleError(err.message)}`);
    }

    deleteSessionClientFromPool(sessionId, session, tokenHash, targetClient);
    if (session && session.client === targetClient) session.client = null;
    console.log(`[CLEANUP] 🗑️ Destroyed session-owned client for ${getSessionShortId(sessionId)} (${reason}).`);
    return true;
}

function countOtherActiveSessionsForClient(tokenHash, currentSessionId, currentSession) {
    const currentKey = getClientPoolKey(tokenHash, currentSession);
    if (!currentKey) return 0;

    let count = 0;
    for (const [id, session] of sessionManager.getAllSessions()) {
        if (id === currentSessionId) continue;
        if (!isSessionRunnable(session)) continue;
        if (getSessionTokenHash(id, session) !== tokenHash) continue;
        if (getClientPoolKey(tokenHash, session) === currentKey) count++;
    }

    return count;
}

function cleanupSessionClientIfUnused(tokenHash, clientRef, currentSessionId, currentSession, reason = "cleanup") {
    if (!tokenHash || !clientRef) return false;

    const remaining = countOtherActiveSessionsForClient(tokenHash, currentSessionId, currentSession);
    if (remaining > 0) {
        console.log(`[CLEANUP] ♻️ Keeping session-owned client for ${getSessionShortId(currentSessionId)}. Remaining active sessions: ${remaining}`);
        return false;
    }

    return destroySessionClient(currentSessionId, currentSession, tokenHash, reason, clientRef);
}

function countActiveSessionsForAccountId(accountId) {
    if (!accountId) return 0;

    let count = 0;
    for (const session of sessionManager.getAllSessions().values()) {
        if (isSessionRunnable(session) && String(session.accountId || session.client?.user?.id || "") === String(accountId)) {
            count++;
        }
    }

    return count;
}

async function waitForTokenLoginCooldown(tokenHash) {
    if (!tokenHash) return;

    cleanupTokenLoginCooldowns();

    const minDelayMs = 3500;
    const previous = tokenLoginCooldowns.get(tokenHash)?.promise || Promise.resolve(0);

    const next = previous.catch(() => 0).then(async (lastLoginAt) => {
        const elapsed = Date.now() - Number(lastLoginAt || 0);

        if (elapsed < minDelayMs) {
            const jitter = crypto.randomInt(0, 1200);
            await delay(minDelayMs - elapsed + jitter);
        }

        return Date.now();
    });

    tokenLoginCooldowns.set(tokenHash, {
        promise: next,
        updatedAt: Date.now()
    });
    next.finally(() => {
        if (tokenLoginCooldowns.get(tokenHash)?.promise === next) tokenLoginCooldowns.delete(tokenHash);
    }).catch(() => {});
    await next;
}

function cleanupTokenLoginCooldowns(now = Date.now()) {
    for (const [tokenHash, entry] of tokenLoginCooldowns.entries()) {
        if (!entry?.updatedAt || now - entry.updatedAt > TOKEN_LOGIN_COOLDOWN_TTL_MS) {
            tokenLoginCooldowns.delete(tokenHash);
        }
    }

    while (tokenLoginCooldowns.size > TOKEN_LOGIN_COOLDOWN_MAX_SIZE) {
        const oldest = tokenLoginCooldowns.keys().next().value;
        if (!oldest) break;
        tokenLoginCooldowns.delete(oldest);
    }
}

function getClientPoolStrategyName() { return "tokenGuild"; }
function isVoiceDebugEnabled() { return process.env.VOICE_DEBUG_MULTI_CLIENT === "true"; }

function debugVoiceSession(event, sessionId, session, extra = {}) {
    if (!isVoiceDebugEnabled()) return;

    const allowedExtra = {};
    for (const key of ["hit", "strategy", "group", "selfVoice", "sameAccountSessions", "connectionStatus"]) {
        if (Object.hasOwn(extra, key)) {
            allowedExtra[key] = extra[key];
        }
    }

    const safe = {
        session: getSessionShortId(sessionId),
        accountId: session?.accountId || session?.client?.user?.id || null,
        guildId: session?.serverId || null,
        channelId: session?.voiceId || null,
        pool: getClientPoolStrategyName(),
        ...allowedExtra
    };

    console.log(`[VOICE-DEBUG] ${event} ${JSON.stringify(safe)}`);
}

function disposeSelfClient(client, reason = "cleanup") {
    if (!client) return false;

    try {
        client.destroy?.();
    } finally {
        try { client.removeAllListeners?.(); } catch {}
        try { clearSelfClientReferences(client); } catch (err) {
            console.warn(`[WORKER] ⚠️ Failed to clear self client references during ${reason}: ${sanitizeLifecycleError(err.message)}`);
        }
    }

    return true;
}

function clearSelfClientReferences(client) {
    if (!client) return;

    for (const channel of client.channels?.cache?.values?.() || []) {
        clearManagerCache(channel?.messages);
    }

    for (const guild of client.guilds?.cache?.values?.() || []) {
        clearManagerCache(guild.members);
        clearManagerCache(guild.channels);
        clearManagerCache(guild.voiceStates);
        clearManagerCache(guild.presences);
        clearManagerCache(guild.roles);
        clearManagerCache(guild.emojis);
    }

    clearManagerCache(client.guilds);
    clearManagerCache(client.channels);
    clearManagerCache(client.users);
}

function clearManagerCache(manager) {
    try {
        manager?.cache?.clear?.();
    } catch {}
}

function cacheDelete(cacheLike, key) {
    if (!cacheLike || !key) return false;
    try {
        if (typeof cacheLike.delete === "function") return cacheLike.delete(key);
        if (cacheLike.cache && typeof cacheLike.cache.delete === "function") return cacheLike.cache.delete(key);
    } catch {}
    return false;
}

module.exports = {
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
    updateSessionMetadata,
    countActiveSessionsByTokenHash,
    getSessionShortId,
    getClientPoolKey,
    getSessionClientFromPool,
    setSessionClientInPool,
    deleteSessionClientFromPool,
    destroySessionClient,
    countOtherActiveSessionsForClient,
    cleanupSessionClientIfUnused,
    countActiveSessionsForAccountId,
    waitForTokenLoginCooldown,
    cleanupTokenLoginCooldowns,
    getClientPoolStrategyName,
    isVoiceDebugEnabled,
    debugVoiceSession,
    disposeSelfClient,
    clearSelfClientReferences,
    clearManagerCache,
    cacheDelete,
};
