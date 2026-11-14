'use strict';

const { cleanupInactiveTokenState } = require('./tokenState');

/**
 * Dynamic Activity Registry: Acquire an activity slot for a token
 * @param {object} coordinator
 * @param {string} token
 * @param {string} subsystem
 * @param {object} [metadata]
 * @returns {boolean}
 */
function acquireActivity(coordinator, token, subsystem, metadata = {}) {
    const hash = coordinator.hashToken(token);
    if (!hash || !subsystem) return false;

    const state = coordinator._getOrCreateState(hash);
    state.activities.set(String(subsystem), {
        ...metadata,
        startedAt: Date.now()
    });
    state.lastActivity = Date.now();

    // Multi-Session Voice Activity Isolation
    if (subsystem === 'voice') {
        const sessionId = String(metadata?.sessionId || metadata?.guildId || `voice_${Date.now()}`);
        const sessionDetails = {
            guildId: String(metadata?.guildId || ''),
            channelId: String(metadata?.channelId || ''),
            sessionId,
            activeAt: Date.now()
        };
        state.voiceSessions.set(sessionId, sessionDetails);
        // Backward compatibility reference points to most recently active session
        state.voice = sessionDetails;
    } else if (subsystem === 'quest') {
        state.quest = {
            startedAt: Date.now(),
            questId: metadata?.questId || null,
            mode: metadata?.mode || 'scheduled'
        };
    }

    coordinator.emit('token:activity_start', { tokenHash: hash, subsystem, metadata });
    return true;
}

function _releaseSpecificVoiceSession(coordinator, hash, state, targetSessionId, options) {
    if (!state.voiceSessions?.has(targetSessionId)) {
        // Stale or already unregistered session cleanup is safe and idempotent
        return { handled: true, success: true };
    }

    const wasDeleted = state.voiceSessions.delete(targetSessionId);
    if (state.voiceSessions.size > 0) {
        // Pick the most recently active remaining session
        const remaining = Array.from(state.voiceSessions.values());
        remaining.sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0));
        state.voice = remaining[0];
        state.lastActivity = Date.now();
        coordinator.emit('token:activity_end', { tokenHash: hash, subsystem: 'voice', options });
        return { handled: true, success: true };
    }

    state.voice = null;
    const deleted = Boolean(state.activities?.delete('voice')) || wasDeleted;
    return { handled: false, deleted };
}

function _releaseLegacyVoiceSession(state) {
    if (state.voiceSessions && state.voiceSessions.size > 1) {
        // Ambiguous unregister when multiple voice sessions active
        return { handled: true, success: false };
    }

    state.voiceSessions?.clear();
    state.voice = null;
    state.activities?.delete('voice');
    return { handled: false, deleted: true };
}

function _handleVoiceRelease(coordinator, hash, state, options) {
    let targetSessionId = typeof options === 'string' ? options : (options?.sessionId || null);
    if (!targetSessionId && typeof options === 'object' && options?.guildId) {
        const targetGuildId = String(options.guildId);
        if (state.voiceSessions?.has(targetGuildId)) {
            targetSessionId = targetGuildId;
        } else if (state.voiceSessions && state.voiceSessions.size > 0) {
            for (const [sId, sess] of state.voiceSessions.entries()) {
                if (String(sess.guildId) === targetGuildId) {
                    targetSessionId = sId;
                    break;
                }
            }
        }
    }

    if (targetSessionId) {
        return _releaseSpecificVoiceSession(coordinator, hash, state, targetSessionId, options);
    }
    return _releaseLegacyVoiceSession(state);
}

function _cleanupInactiveTokenState(coordinator, hash, state) {
    cleanupInactiveTokenState(coordinator, hash, state);
}

/**
 * Dynamic Activity Registry: Release an activity slot for a token
 * @param {object} coordinator
 * @param {string} token
 * @param {string} subsystem
 * @param {object|string} [options]
 * @returns {boolean}
 */
function releaseActivity(coordinator, token, subsystem, options = {}) {
    const hash = coordinator.hashToken(token);
    if (!hash || !subsystem) return false;

    const state = coordinator.tokenStates.get(hash);
    if (!state) return false;

    let deleted = false;
    if (subsystem === 'voice') {
        const voiceRes = _handleVoiceRelease(coordinator, hash, state, options);
        if (voiceRes.handled) return voiceRes.success;
        deleted = voiceRes.deleted;
    } else {
        if (subsystem === 'quest') state.quest = null;
        deleted = Boolean(state.activities?.delete(String(subsystem)));
    }

    state.lastActivity = Date.now();
    _cleanupInactiveTokenState(coordinator, hash, state);

    coordinator.emit('token:activity_end', { tokenHash: hash, subsystem, options });
    return Boolean(deleted);
}

/**
 * Check if a token currently has a specific active activity
 * @param {object} coordinator
 * @param {string} token
 * @param {string} subsystem
 * @param {object|string} [options]
 * @returns {boolean}
 */
function hasActivity(coordinator, token, subsystem, options = {}) {
    const hash = coordinator.hashToken(token);
    if (!hash) return false;
    const state = coordinator.tokenStates.get(hash);
    if (!state) return false;

    if (subsystem === 'voice') {
        const targetSessionId = typeof options === 'string' ? options : (options?.sessionId || null);
        if (targetSessionId) {
            return Boolean(state.voiceSessions?.has(targetSessionId));
        }
        const targetGuildId = options?.guildId || null;
        if (targetGuildId && state.voiceSessions) {
            return Array.from(state.voiceSessions.values()).some(s => s.guildId === targetGuildId);
        }
        return Boolean((state.voiceSessions && state.voiceSessions.size > 0) || (state.voice?.guildId && state.voice?.channelId));
    }
    if (subsystem === 'quest') return Boolean(state.quest);
    return Boolean(state.activities?.has(String(subsystem)));
}

/**
 * Get all active activities for a token
 * @param {object} coordinator
 * @param {string} token
 * @returns {Array<{ subsystem: string, startedAt: number, metadata: object }>}
 */
function getActivities(coordinator, token) {
    const hash = coordinator.hashToken(token);
    if (!hash) return [];
    const state = coordinator.tokenStates.get(hash);
    if (!state?.activities) return [];

    const list = [];
    for (const [sub, meta] of state.activities.entries()) {
        list.push({
            subsystem: sub,
            startedAt: meta?.startedAt || Date.now(),
            metadata: meta
        });
    }
    return list;
}

/**
 * Register that a token is actively connected to a Discord voice channel
 * @param {object} coordinator
 * @param {string} token
 * @param {{ guildId: string, channelId: string, sessionId?: string, client?: any }} details
 */
function registerVoiceActivity(coordinator, token, details) {
    return acquireActivity(coordinator, token, 'voice', details);
}

/**
 * Unregister voice activity for a token
 * @param {object} coordinator
 * @param {string} token
 * @param {object|string} [options] Optional sessionId or { sessionId, guildId }
 */
function unregisterVoiceActivity(coordinator, token, options = {}) {
    return releaseActivity(coordinator, token, 'voice', options);
}

/**
 * Check if a token currently has an active voice connection
 * @param {object} coordinator
 * @param {string} token
 * @param {object|string} [options] Optional sessionId or { sessionId, guildId }
 * @returns {boolean}
 */
function isVoiceActive(coordinator, token, options = {}) {
    return hasActivity(coordinator, token, 'voice', options);
}

/**
 * Get active voice details for a token
 * @param {object} coordinator
 * @param {string} token
 * @param {object|string} [options] Optional sessionId or { sessionId, guildId }
 * @returns {{ guildId: string, channelId: string, sessionId: string, activeAt: number } | null}
 */
function getVoiceActivity(coordinator, token, options = {}) {
    const hash = coordinator.hashToken(token);
    const state = coordinator.tokenStates.get(hash);
    if (!state) return null;

    const targetSessionId = typeof options === 'string' ? options : (options?.sessionId || null);
    if (targetSessionId && state.voiceSessions?.has(targetSessionId)) {
        return state.voiceSessions.get(targetSessionId);
    }

    const targetGuildId = options?.guildId || null;
    if (targetGuildId && state.voiceSessions) {
        const match = Array.from(state.voiceSessions.values()).find(s => s.guildId === targetGuildId);
        if (match) return match;
    }

    if (state.voiceSessions && state.voiceSessions.size > 0) {
        const sessions = Array.from(state.voiceSessions.values());
        sessions.sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0));
        return sessions[0];
    }

    return state.voice || null;
}

/**
 * Notify that quest execution has started on a token
 * @param {object} coordinator
 * @param {string} token
 * @param {object} [metadata]
 */
function notifyQuestStart(coordinator, token, metadata = {}) {
    return acquireActivity(coordinator, token, 'quest', metadata);
}

/**
 * Notify that quest execution has completed on a token
 * @param {object} coordinator
 * @param {string} token
 */
function notifyQuestEnd(coordinator, token) {
    return releaseActivity(coordinator, token, 'quest');
}

/**
 * Check if a quest is currently running for a token
 * @param {object} coordinator
 * @param {string} token
 * @returns {boolean}
 */
function isQuestActive(coordinator, token) {
    return hasActivity(coordinator, token, 'quest');
}

/**
 * Check if voice health check should apply grace debounce
 * @param {object} coordinator
 * @param {string} token
 * @returns {boolean}
 */
function shouldDebounceVoiceHealthCheck(coordinator, token) {
    return isQuestActive(coordinator, token);
}

module.exports = {
    acquireActivity,
    _releaseSpecificVoiceSession,
    _releaseLegacyVoiceSession,
    _handleVoiceRelease,
    _cleanupInactiveTokenState,
    releaseActivity,
    hasActivity,
    getActivities,
    registerVoiceActivity,
    unregisterVoiceActivity,
    isVoiceActive,
    getVoiceActivity,
    notifyQuestStart,
    notifyQuestEnd,
    isQuestActive,
    shouldDebounceVoiceHealthCheck
};
