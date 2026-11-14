"use strict";

const { VoiceConnectionStatus } = require("@discordjs/voice");
const sessionManager = require("./sessionManager");
const { st } = require("./state");
const { sanitizeLogText } = require("../core/safeLogger");
const { isSessionRunnable } = require("./session");

const MOVE_DEBOUNCE_MS = 3 * 60 * 1000; // 3 minutes trailing debounce

const moveTracking = new Map();

function formatTime(timestamp) {
    try {
        return new Date(timestamp).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok" });
    } catch {
        return new Date(timestamp).toLocaleTimeString();
    }
}

async function sendMoveNotification() {
    // Channel Lock Alert DM is retired per owner directive:
    // Flyback happens automatically without sending any DM to avoid noise.
    return null;
}

function recordMoveIncident() {
    // Channel Lock Alert DM retired per owner directive.
    return null;
}

function isVoiceMoveEventApplicable(sessionId, client, newState, deps = {}) {
    if (st.isShuttingDown) return null;

    const selfUserId = client?.user?.id;
    if (!selfUserId || String(newState?.id || "") !== String(selfUserId)) {
        return null;
    }

    const getSession = deps.getSession || (id => sessionManager.getSession(id));
    const session = getSession(sessionId);
    const runnable = deps.isSessionRunnable || isSessionRunnable;
    if (!session || !runnable(session)) {
        return null;
    }

    if (String(newState.guild?.id || "") !== String(session.serverId || "")) {
        return null;
    }

    if (!newState.channelId || String(newState.channelId) === String(session.voiceId)) {
        return null;
    }

    return session;
}

const FLYBACK_THROTTLE_MS = 1500;
const flybackTimestamps = new Map();
const flybackTimers = new Map();

function executeFlybackRejoin(session, sessionId, deps = {}) {
    const conn = session?.connection;
    if (!conn || conn.state?.status === VoiceConnectionStatus.Destroyed) {
        return;
    }

    const now = Date.now();
    const lastFlyback = flybackTimestamps.get(sessionId) || 0;
    const elapsed = now - lastFlyback;
    const throttleMs = Number.isFinite(Number(deps.throttleMs)) ? Number(deps.throttleMs) : FLYBACK_THROTTLE_MS;

    const performRejoin = () => {
        flybackTimestamps.set(sessionId, Date.now());
        flybackTimers.delete(sessionId);
        try {
            conn.rejoin({
                channelId: session.voiceId,
                selfMute: true,
                selfDeaf: true
            });
        } catch (err) {
            console.warn(`[WORKER] ⚠️ Flyback rejoin failed for ${sanitizeLogText(sessionId)}: ${err.message}`);
        }
    };

    if (elapsed >= throttleMs) {
        if (flybackTimers.has(sessionId)) {
            clearTimeout(flybackTimers.get(sessionId));
            flybackTimers.delete(sessionId);
        }
        performRejoin();
    } else if (!flybackTimers.has(sessionId)) {
        const setTimer = deps.setTimeout || setTimeout;
        const remaining = throttleMs - elapsed;
        const timer = setTimer(() => {
            performRejoin();
        }, remaining);
        timer.unref?.();
        flybackTimers.set(sessionId, timer);
    }
}

function handleVoiceStateUpdate(sessionId, client, oldState, newState, deps = {}) {
    const session = isVoiceMoveEventApplicable(sessionId, client, newState, deps);
    if (!session) return false;

    const fromName = oldState?.channel?.name || oldState?.channelId || "ห้องเดิม";
    const toName = newState.channel?.name || newState.channelId || "ห้องใหม่";
    console.log(`[WORKER] 🧲 Bot moved from ${fromName} to ${toName} — flying back to target channel ${session.voiceName || session.voiceId} (${sanitizeLogText(sessionId)})`);

    executeFlybackRejoin(session, sessionId, deps);
    return true;
}

function cancelMoveTracking(sessionId) {
    if (flybackTimers.has(sessionId)) {
        clearTimeout(flybackTimers.get(sessionId));
        flybackTimers.delete(sessionId);
    }
    flybackTimestamps.delete(sessionId);

    const record = moveTracking.get(sessionId);
    if (record) {
        if (record.timer) clearTimeout(record.timer);
        moveTracking.delete(sessionId);
        return true;
    }
    return false;
}

function clearAllMoveTrackers() {
    for (const timer of flybackTimers.values()) {
        clearTimeout(timer);
    }
    flybackTimers.clear();
    flybackTimestamps.clear();

    for (const record of moveTracking.values()) {
        if (record.timer) clearTimeout(record.timer);
    }
    moveTracking.clear();
}

function getMoveTracking(sessionId) {
    return moveTracking.get(sessionId) || null;
}

module.exports = {
    MOVE_DEBOUNCE_MS,
    handleVoiceStateUpdate,
    recordMoveIncident,
    sendMoveNotification,
    cancelMoveTracking,
    clearAllMoveTrackers,
    getMoveTracking,
    _test: {
        moveTracking,
        formatTime
    }
};
