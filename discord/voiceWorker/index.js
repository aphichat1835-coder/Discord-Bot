const sessionManager = require("../sessionManager");
const {
    st,
    clientPool,
    tokenLoginCooldowns,
    naturalTimers,
    naturalRunning,
    autoDeafTimers,
    autoDeafRunning,
    lastDMSent,
    lastOnlineDMSent,
    recoveryTimestamps,
    setShuttingDown,
    setProtectedChecker,
    setMainClient,
    getClientPoolSize,
} = require("./state");
const {
    CONFIG,
    RECOVERY_COOLDOWN_MS,
    DM_THROTTLE_MAX_SIZE,
    VOICE_LEAN_MODE,
    SELF_CLIENT_CACHE_LIMITS,
} = require("./config");
const {
    cleanupTokenLoginCooldowns,
    getClientPoolStrategyName,
    isSessionRunnable,
} = require("./session");
const {
    getClientCacheStats,
    sumCacheStats,
    getClientListenerStats,
    sumListenerStats,
    getVoiceLeanConfig,
    cleanupLeanActiveSessions,
    cleanupLeanClientCache,
    cleanupSelfClientCaches,
} = require("./cacheUtils");
const { voiceEventLog, getVoiceLogs } = require("./eventLog");
const { sendSessionStoppedDM, sendTokenInvalidDM, sendSessionOnlineDM } = require("./dm");
const {
    startNaturalTimer,
    stopNaturalTimer,
    stopAllNaturalTimers,
    applyNaturalSettings,
    getNaturalSettings,
} = require("./natural");
const {
    startAutoDeafTimer,
    stopAutoDeafTimer,
    stopAllAutoDeafTimers,
    applyAutoDeafSettings,
    getAutoDeafSettings,
} = require("./autoDeaf");
const { loginQueue, recoveryQueue } = require("./queue");
const {
    ensureVoiceSession,
    startSession,
    repairFailedStopSessionForTokenGuild,
    stopSession,
    stopAll,
    pauseAll,
    autoResume,
    healthCheck,
    cleanupIdleSessions,
} = require("./lifecycle");

// ════════════════════════════════════════════════════════════════════════════
//  📊  REGION 13 (part 1): DIAGNOSTICS
// ════════════════════════════════════════════════════════════════════════════
function getWorkerDiagnostics() {
    cleanupTokenLoginCooldowns();
    const pooledClients = [...clientPool.values()];
    const clientCacheStats = pooledClients.map(getClientCacheStats);
    const clientListenerStats = pooledClients.map(getClientListenerStats);
    const ready = !!st.mainClient && st.isShuttingDown !== true;
    let status = "ready";
    if (!st.mainClient) status = "initializing";
    else if (st.isShuttingDown === true) status = "stopping";

    return {
        ready,
        status,
        clientPool: clientPool.size,
        clientPoolStrategy: getClientPoolStrategyName(),
        selfClientCacheLimits: SELF_CLIENT_CACHE_LIMITS,
        selfClientCaches: sumCacheStats(clientCacheStats),
        selfClientCacheDetails: clientCacheStats,
        selfClientListeners: sumListenerStats(clientListenerStats),
        selfClientListenerDetails: clientListenerStats,
        tokenLoginCooldowns: tokenLoginCooldowns.size,
        naturalTimers: naturalTimers.size,
        naturalRunning: naturalRunning.size,
        autoDeafTimers: autoDeafTimers.size,
        autoDeafRunning: autoDeafRunning.size,
        loginQueue: loginQueue.size,
        loginQueueRunning: loginQueue.running,
        loginQueuePending: loginQueue.pending,
        loginQueueRejectedFull: loginQueue.rejectedFull,
        recoveryQueue: recoveryQueue.size,
        recoveryQueueRunning: recoveryQueue.running,
        recoveryQueuePending: recoveryQueue.pending,
        recoveryQueueRejectedFull: recoveryQueue.rejectedFull,
        lastDMSent: lastDMSent.size,
        lastOnlineDMSent: lastOnlineDMSent.size,
        recoveryTimestamps: recoveryTimestamps.size,
        voiceEventLog: voiceEventLog.length,
        voiceLean: getVoiceLeanConfig(),
        lastLeanCleanup: st.lastLeanCleanup
    };
}

// ── Volatile state cleanup helpers ──
function deleteExpiredSessionEntries(map, activeSessionIds, now, ttlMs) {
    for (const [sessionId, ts] of map.entries()) {
        const isExpired = now - Number(ts || 0) > ttlMs;
        if (!activeSessionIds.has(sessionId) || isExpired) {
            map.delete(sessionId);
        }
    }
}

function trimMapToMaxSize(map, maxSize) {
    if (!Number.isFinite(maxSize) || maxSize <= 0 || map.size <= maxSize) return;

    const overflow = map.size - maxSize;
    const oldest = [...map.entries()]
        .sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0))
        .slice(0, overflow);

    for (const [key] of oldest) {
        map.delete(key);
    }
}

function deleteInactiveSessionIds(set, activeSessionIds) {
    for (const sessionId of set) {
        if (!activeSessionIds.has(sessionId)) {
            set.delete(sessionId);
        }
    }
}

function stopInactiveSessionTimers(timerMap, activeSessionIds, stopTimer) {
    for (const [sessionId] of timerMap.entries()) {
        if (!activeSessionIds.has(sessionId)) {
            stopTimer(sessionId);
        }
    }
}

function cleanupVolatileState(now = Date.now(), options = {}) {
    const sessions = sessionManager.getAllSessions();
    const activeSessionIds = new Set();
    const recoverableSessionIds = new Set();
    for (const [sessionId, session] of sessions) {
        if (isSessionRunnable(session)) activeSessionIds.add(sessionId);
        if (["stop_cleanup_failed", "session_delete_failed"].includes(session?.stoppedReason)) {
            recoverableSessionIds.add(sessionId);
        }
    }

    const dmTtlMs = Math.max(CONFIG.DM_THROTTLE_MS * 6, 5 * 60 * 1000);
    const recoveryTtlMs = Math.max(RECOVERY_COOLDOWN_MS * 6, 10 * 60 * 1000);

    deleteExpiredSessionEntries(lastDMSent, activeSessionIds, now, dmTtlMs);
    deleteExpiredSessionEntries(lastOnlineDMSent, activeSessionIds, now, dmTtlMs);
    trimMapToMaxSize(lastDMSent, DM_THROTTLE_MAX_SIZE);
    trimMapToMaxSize(lastOnlineDMSent, DM_THROTTLE_MAX_SIZE);
    const recoveryPreserveIds = new Set([...activeSessionIds, ...recoverableSessionIds]);
    deleteExpiredSessionEntries(recoveryTimestamps, recoveryPreserveIds, now, recoveryTtlMs);
    deleteInactiveSessionIds(naturalRunning, activeSessionIds);
    deleteInactiveSessionIds(autoDeafRunning, activeSessionIds);
    stopInactiveSessionTimers(naturalTimers, activeSessionIds, stopNaturalTimer);
    stopInactiveSessionTimers(autoDeafTimers, activeSessionIds, stopAutoDeafTimer);

    const selfClientCacheCleanup = options.cleanupSelfClientCaches
        ? cleanupSelfClientCaches(now)
        : null;
    const leanCleanup = VOICE_LEAN_MODE
        ? cleanupLeanActiveSessions(now, options.forceLeanCleanup === true)
        : null;

    return {
        ...getWorkerDiagnostics(),
        selfClientCacheCleanup,
        leanCleanup
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  REGION 13 (part 2): EXPORTS
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
    setMainClient,
    setShuttingDown,
    setProtectedChecker,
    getClientPoolSize,
    getWorkerDiagnostics,
    cleanupVolatileState,
    ensureVoiceSession,

    startSession,
    repairFailedStopSessionForTokenGuild,
    stopSession,
    stopAll,
    pauseAll,

    autoResume,
    healthCheck,
    cleanupIdleSessions,

    getVoiceLogs,
    sendSessionStoppedDM,
    sendTokenInvalidDM,
    sendSessionOnlineDM,

    applyNaturalSettings,
    startNaturalTimer,
    stopNaturalTimer,
    getNaturalSettings,

    applyAutoDeafSettings,
    startAutoDeafTimer,
    stopAutoDeafTimer,
    getAutoDeafSettings,

    _test: {
        cleanupLeanClientCache,
        cleanupLeanActiveSessions,
        getClientCacheStats,
        getVoiceLeanConfig
    }
};
