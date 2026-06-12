function getSafeSessionShortId(sessionId) {
    return String(sessionId || "").replace(/^vc_/, "").slice(0, 10);
}

function getSessionAccountLabel(session) {
    if (!session) return null;

    if (session.accountGlobalName && session.accountUsername) {
        return `${session.accountGlobalName} (@${session.accountUsername})`;
    }

    return session.accountTag ||
        session.accountUsername ||
        session.accountGlobalName ||
        session.accountId ||
        null;
}

function serializeVoiceSession(session) {
    if (!session) return null;

    return {
        sessionId: session.sessionId,
        shortId: getSafeSessionShortId(session.sessionId),

        serverId: session.serverId,
        serverName: session.serverName || null,
        guildIcon: session.guildIcon || null,

        voiceId: session.voiceId,
        voiceName: session.voiceName || null,

        ownerId: session.ownerId,
        ownerTag: session.ownerTag || null,
        ownerAvatar: session.ownerAvatar || null,

        accountId: session.accountId || null,
        accountUsername: session.accountUsername || null,
        accountGlobalName: session.accountGlobalName || null,
        accountTag: session.accountTag || null,
        accountAvatar: session.accountAvatar || null,
        accountLabel: getSessionAccountLabel(session),

        startedAt: session.startedAt,
        lastActivity: session.lastActivity,
        reconnectCount: session.reconnectCount || 0,
        tokenInvalid: !!session.tokenInvalid,
        reconnecting: !!session.reconnecting,
        hasConnection: !!session.connection,
        connectionStatus: session.connection?.state?.status || null,
        state: session.state || "active",
        stoppedAt: session.stoppedAt || null,
        stoppedReason: session.stoppedReason || null,
        stoppedBy: session.stoppedBy || null,
        lastStopError: session.lastStopError || null,
        clientReady: !!session.client?.isReady?.(),
        staleSuspected: (session.state || "active") === "active" && !session.connection,
        ghostSuspected: session.stoppedReason === "stop_cleanup_failed"
    };
}

function getSessionTokenSafe(sessionManager, sessionId) {
    if (typeof sessionManager.getSessionToken === "function") {
        return sessionManager.getSessionToken(sessionId);
    }

    if (typeof sessionManager.getToken === "function") {
        return sessionManager.getToken(sessionId);
    }

    return null;
}

module.exports = {
    getSafeSessionShortId,
    getSessionAccountLabel,
    serializeVoiceSession,
    getSessionTokenSafe
};
