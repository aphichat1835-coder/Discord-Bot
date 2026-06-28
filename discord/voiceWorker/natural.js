const { VoiceConnectionStatus } = require("@discordjs/voice");
const sessionManager = require("../sessionManager");
const { st, naturalTimers, naturalRunning } = require("./state");
const { delay, randomJitter } = require("./config");
const { isSessionRunnable } = require("./session");

// ════════════════════════════════════════════════════════════════════════════
//  🎭  REGION 12: NATURALNESS ENGINE
//  ทำให้บอทดูเป็นธรรมชาติ — เปิดไมค์+หูฟังชั่วคราวทุกๆ X ชั่วโมง
//  หมายเหตุ: ไม่มี scheduled leave/rejoin ออกจากห้องเอง
//  ใช้เฉพาะ conn.rejoin เพื่อเปลี่ยน mute/deaf state เท่านั้น
// ════════════════════════════════════════════════════════════════════════════
async function doNaturalBlink(sessionId) {
    if (st.isShuttingDown) return;
    if (naturalRunning.has(sessionId)) return;

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.connection) return;

    const conn = session.connection;
    if (conn.state.status !== VoiceConnectionStatus.Ready) return;

    naturalRunning.add(sessionId);

    try {
        console.log(`[NATURAL] 🎭 Blink start — ${sessionId}`);

        conn.rejoin({
            channelId: session.voiceId,
            selfMute: false,
            selfDeaf: false
        });

        await delay(st.naturalSettings.durationMs);

        const stillAlive = sessionManager.getSession(sessionId);
        if (!stillAlive || !conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
            console.log(`[NATURAL] ⚠️ Session gone during blink — ${sessionId}`);
            return;
        }

        conn.rejoin({
            channelId: session.voiceId,
            selfMute: true,
            selfDeaf: true
        });

        console.log(`[NATURAL] ✅ Blink done — ${sessionId}`);
    } catch (e) {
        console.warn(`[NATURAL] ⚠️ Blink error for ${sessionId}: ${e.message}`);
        try {
            conn.rejoin({
                channelId: session.voiceId,
                selfMute: true,
                selfDeaf: true
            });
        } catch {}
    } finally {
        naturalRunning.delete(sessionId);
    }
}

function stopNaturalTimer(sessionId) {
    const id = naturalTimers.get(sessionId);

    if (id) {
        clearInterval(id);
        naturalTimers.delete(sessionId);
        naturalRunning.delete(sessionId);
        console.log(`[NATURAL] ⏹️ Timer stopped — ${sessionId}`);
    }
}

function startNaturalTimer(sessionId) {
    if (!st.naturalSettings.enabled) return;

    const session = sessionManager.getSession(sessionId);
    if (!isSessionRunnable(session)) return;

    stopNaturalTimer(sessionId);

    const jitter = randomJitter(5 * 60 * 1000);
    const interval = Math.max(60000, st.naturalSettings.intervalMs + jitter);

    const id = setInterval(() => doNaturalBlink(sessionId), interval);
    id.unref?.();
    naturalTimers.set(sessionId, id);

    console.log(`[NATURAL] ▶️ Timer started for ${sessionId} (every ${Math.round(interval / 60000)} min, duration ${st.naturalSettings.durationMs / 1000}s)`);
}

function stopAllNaturalTimers() {
    for (const id of naturalTimers.values()) {
        clearInterval(id);
    }

    naturalTimers.clear();
    naturalRunning.clear();
    console.log("[NATURAL] ⏹️ All timers stopped.");
}

function applyNaturalSettings(newSettings) {
    st.naturalSettings = { ...st.naturalSettings, ...newSettings };

    if (!st.naturalSettings.enabled) {
        stopAllNaturalTimers();
        console.log("[NATURAL] 🔴 Disabled.");
        return;
    }

    for (const [sessionId, session] of sessionManager.getAllSessions()) {
        if (isSessionRunnable(session) && session.client?.isReady?.()) {
            startNaturalTimer(sessionId);
        }
    }

    console.log(`[NATURAL] 🟢 Enabled — interval ${st.naturalSettings.intervalMs / 60000} min, duration ${st.naturalSettings.durationMs / 1000}s`);
}

function getNaturalSettings() {
    return {
        ...st.naturalSettings,
        activeTimers: naturalTimers.size
    };
}

module.exports = {
    doNaturalBlink,
    startNaturalTimer,
    stopNaturalTimer,
    stopAllNaturalTimers,
    applyNaturalSettings,
    getNaturalSettings,
};
