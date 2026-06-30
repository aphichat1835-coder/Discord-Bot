const { VOICE_LOG_MAX } = require("./config");

const voiceEventLog = [];

function pushVoiceLog(type, sessionId, detail = "") {
    const session = require("../sessionManager").getSession(sessionId);
    voiceEventLog.push({
        ts: Date.now(),
        type,
        sessionId,
        account: session?.accountName || null,
        guild: session?.serverId || null,
        voice: session?.voiceId || null,
        detail
    });

    if (voiceEventLog.length > VOICE_LOG_MAX) {
        voiceEventLog.splice(0, voiceEventLog.length - VOICE_LOG_MAX);
    }
}

function getVoiceLogs() {
    return voiceEventLog.slice();
}

module.exports = { voiceEventLog, pushVoiceLog, getVoiceLogs };
