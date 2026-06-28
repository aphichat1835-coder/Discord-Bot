const sessionManager = require("../sessionManager");
const { VOICE_LOG_MAX } = require("./config");
const { getSessionShortId } = require("./session");
const { getAccountLabel, getGuildLabel, getVoiceLabel } = require("./display");

// ════════════════════════════════════════════════════════════════════════════
//  📊  REGION 11: VOICE EVENT LOG
// ════════════════════════════════════════════════════════════════════════════
const voiceEventLog = [];

function pushVoiceLog(type, sessionId, detail = "") {
    const session = sessionManager.getSession(sessionId);

    voiceEventLog.unshift({
        ts: Date.now(),
        type,
        sessionId,
        shortId: getSessionShortId(sessionId),
        account: session ? getAccountLabel(session) : null,
        guild: session ? getGuildLabel(session) : null,
        voice: session ? getVoiceLabel(session) : null,
        detail
    });

    if (voiceEventLog.length > VOICE_LOG_MAX) {
        voiceEventLog.length = VOICE_LOG_MAX;
    }
}

function getVoiceLogs() {
    return voiceEventLog.slice();
}

module.exports = { voiceEventLog, pushVoiceLog, getVoiceLogs };
