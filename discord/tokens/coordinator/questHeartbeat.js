'use strict';

/**
 * Generate safe Heartbeat body for Quest execution.
 * Prevents Discord from interpreting heartbeat as a 1-to-1 Call Stream,
 * which causes Discord to disconnect the account from Guild Voice!
 *
 * @param {object} coordinator TokenCoordinator instance
 * @param {string} token
 * @param {object} quest
 * @param {boolean} terminal
 * @returns {object} Payload to send to POST /quests/{id}/heartbeat
 */
function getSafeQuestHeartbeatPayload(coordinator, token, quest, terminal = false) {
    // Priority 1: Application ID heartbeat (safest, never touches voice state)
    if (quest?.applicationId) {
        return { application_id: quest.applicationId, terminal };
    }

    const hash = coordinator.hashToken(token);
    const state = coordinator.tokenStates.get(hash);
    const sessions = Array.from(state?.voiceSessions?.values() || []);

    // Priority 2: Explicit guild match when quest specifies guildId
    if (quest?.guildId && sessions.length > 0) {
        const match = sessions.find(s => s.guildId === String(quest.guildId));
        if (match?.guildId && match?.channelId) {
            return {
                stream_key: `guild:${match.guildId}:${match.channelId}`,
                terminal
            };
        }
    }

    // Single active voice session
    if (sessions.length === 1 && sessions[0].guildId && sessions[0].channelId) {
        return {
            stream_key: `guild:${sessions[0].guildId}:${sessions[0].channelId}`,
            terminal
        };
    }

    // Multiple active sessions across different guilds without explicit quest match:
    // Ambiguous stream key could disconnect the account from one of its guilds; fallback safely to call stream
    if (sessions.length > 1) {
        return {
            stream_key: `call:${quest?.id || 'default'}:1`,
            terminal
        };
    }

    // Priority 2 fallback: single legacy voice activity check
    const voice = coordinator.getVoiceActivity(token);
    if (voice?.guildId && voice?.channelId) {
        return {
            stream_key: `guild:${voice.guildId}:${voice.channelId}`,
            terminal
        };
    }

    // Priority 3: Fallback for accounts not in guild voice
    return {
        stream_key: `call:${quest?.id || 'default'}:1`,
        terminal
    };
}

module.exports = {
    getSafeQuestHeartbeatPayload
};
