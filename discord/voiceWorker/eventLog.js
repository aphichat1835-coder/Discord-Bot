const { VOICE_LOG_MAX } = require("./config");

const voiceEventLog = [];

function pushVoiceLog(type, sessionId, detail = "") {
    const session = require("../sessionManager").getSession(sessionId);
    const entry = {
        ts: Date.now(),
        type,
        sessionId,
        account: session?.accountName || null,
        guild: session?.serverId || null,
        voice: session?.voiceId || null,
        detail
    };
    voiceEventLog.push(entry);

    if (voiceEventLog.length > VOICE_LOG_MAX) {
        voiceEventLog.splice(0, voiceEventLog.length - VOICE_LOG_MAX);
    }

    try {
        const database = require("../../database/index");
        if (database?.repositories?.voiceEvent) {
            database.repositories.voiceEvent.record({
                eventType: type,
                sessionId,
                accountId: session?.accountName || null,
                guildId: session?.serverId || null,
                voiceId: session?.voiceId || null,
                detail: typeof detail === "string" ? detail : (detail ? JSON.stringify(detail) : null),
                occurredAt: entry.ts
            });
        }
    } catch (_) {
        // Safe suppression: voice worker must never crash if SQLite is busy or unavailable
    }
}

function getVoiceLogs() {
    return voiceEventLog.slice();
}

module.exports = { voiceEventLog, pushVoiceLog, getVoiceLogs };
