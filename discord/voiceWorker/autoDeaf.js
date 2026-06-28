const { VoiceConnectionStatus } = require("@discordjs/voice");
const sessionManager = require("../sessionManager");
const { st, autoDeafTimers, autoDeafRunning } = require("./state");
const { delay, randomJitter } = require("./config");
const { isSessionRunnable } = require("./session");

// ════════════════════════════════════════════════════════════════════════════
//  🔇  REGION 12.5: AUTO DEAF ENGINE
//  สลับ selfDeaf อัตโนมัติ — เปิดหูชั่วคราวตามกำหนด แล้วปิดกลับ
// ════════════════════════════════════════════════════════════════════════════
async function doAutoDeafToggle(sessionId) {
    if (st.isShuttingDown) return;
    if (autoDeafRunning.has(sessionId)) return;

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.connection) return;

    const conn = session.connection;
    if (conn.state.status !== VoiceConnectionStatus.Ready) return;

    autoDeafRunning.add(sessionId);

    try {
        console.log(`[AUTODEAF] 🎧 Undeafening — ${sessionId}`);

        conn.rejoin({
            channelId: session.voiceId,
            selfMute: true,
            selfDeaf: false
        });

        await delay(st.autoDeafSettings.openDurationMs);

        const stillAlive = sessionManager.getSession(sessionId);
        if (!stillAlive || !conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
            console.log(`[AUTODEAF] ⚠️ Session gone during undeaf — ${sessionId}`);
            return;
        }

        conn.rejoin({
            channelId: session.voiceId,
            selfMute: true,
            selfDeaf: true
        });

        console.log(`[AUTODEAF] ✅ Redeafened — ${sessionId}`);
    } catch (e) {
        console.warn(`[AUTODEAF] ⚠️ Error for ${sessionId}: ${e.message}`);
        try {
            conn.rejoin({
                channelId: session.voiceId,
                selfMute: true,
                selfDeaf: true
            });
        } catch {}
    } finally {
        autoDeafRunning.delete(sessionId);
    }
}

function stopAutoDeafTimer(sessionId) {
    const id = autoDeafTimers.get(sessionId);

    if (id) {
        clearInterval(id);
        autoDeafTimers.delete(sessionId);
        autoDeafRunning.delete(sessionId);
        console.log(`[AUTODEAF] ⏹️ Timer stopped — ${String(sessionId).slice(0, 36)}`);
    }
}

function startAutoDeafTimer(sessionId) {
    if (!st.autoDeafSettings.enabled) return;

    const session = sessionManager.getSession(sessionId);
    if (!isSessionRunnable(session)) return;

    stopAutoDeafTimer(sessionId);

    const jitter = randomJitter(5 * 60 * 1000);
    const interval = Math.max(60000, st.autoDeafSettings.intervalMs + jitter);

    const id = setInterval(() => doAutoDeafToggle(sessionId), interval);
    id.unref?.();
    autoDeafTimers.set(sessionId, id);

    console.log(`[AUTODEAF] ▶️ Timer started for ${sessionId} (every ${Math.round(interval / 60000)} min, open ${st.autoDeafSettings.openDurationMs / 1000}s)`);
}

function stopAllAutoDeafTimers() {
    for (const id of autoDeafTimers.values()) {
        clearInterval(id);
    }

    autoDeafTimers.clear();
    autoDeafRunning.clear();
    console.log("[AUTODEAF] ⏹️ All timers stopped.");
}

function applyAutoDeafSettings(newSettings) {
    st.autoDeafSettings = { ...st.autoDeafSettings, ...newSettings };

    if (!st.autoDeafSettings.enabled) {
        stopAllAutoDeafTimers();
        console.log("[AUTODEAF] 🔴 Disabled.");
        return;
    }

    for (const [sessionId, session] of sessionManager.getAllSessions()) {
        if (isSessionRunnable(session) && session.client?.isReady?.()) {
            startAutoDeafTimer(sessionId);
        }
    }

    console.log(`[AUTODEAF] 🟢 Enabled — interval ${st.autoDeafSettings.intervalMs / 60000} min, open ${st.autoDeafSettings.openDurationMs / 1000}s`);
}

function getAutoDeafSettings() {
    return {
        ...st.autoDeafSettings,
        activeTimers: autoDeafTimers.size
    };
}

module.exports = {
    doAutoDeafToggle,
    startAutoDeafTimer,
    stopAutoDeafTimer,
    stopAllAutoDeafTimers,
    applyAutoDeafSettings,
    getAutoDeafSettings,
};
