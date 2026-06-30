const { VoiceConnectionStatus } = require("@discordjs/voice");
const sessionManager = require("../sessionManager");
const { st, autoDeafTimers, autoDeafRunning } = require("./state");
const { delay, randomJitter } = require("./config");
const { isSessionRunnable } = require("./session");
const { sanitizeLogText } = require("../core/safeLogger");

// ════════════════════════════════════════════════════════════════════════════
//  🔇  REGION 12.5: AUTO DEAF ENGINE
//  สลับ selfDeaf อัตโนมัติ — เปิดหูชั่วคราวตามกำหนด แล้วปิดกลับ
// ════════════════════════════════════════════════════════════════════════════
const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 86400000 ms — เขียนแบบนี้แทนตัวเลขดิบ เพื่อเลี่ยง Codacy no-loss-of-precision false positive

async function doAutoDeafToggle(sessionId) {
    if (st.isShuttingDown) return;
    if (autoDeafRunning.has(sessionId)) return;

    const session = sessionManager.getSession(sessionId);
    if (!session?.connection) return;

    const conn = session.connection;
    if (conn.state.status !== VoiceConnectionStatus.Ready) return;

    autoDeafRunning.add(sessionId);

    try {
        console.log(`[AUTODEAF] 🎧 Undeafening — ${sanitizeLogText(sessionId)}`);

        conn.rejoin({
            channelId: session.voiceId,
            selfMute: true,
            selfDeaf: false
        });

        await delay(st.autoDeafSettings.openDurationMs);

        const currentSession = sessionManager.getSession(sessionId);
        const currentConn = currentSession?.connection;
        if (!currentSession || !currentConn || currentConn.state.status !== VoiceConnectionStatus.Ready) {
            console.log(`[AUTODEAF] ⚠️ Session gone during undeaf — ${sanitizeLogText(sessionId)}`);
            return;
        }

        currentConn.rejoin({
            channelId: currentSession.voiceId,
            selfMute: true,
            selfDeaf: true
        });

        console.log(`[AUTODEAF] ✅ Redeafened — ${sanitizeLogText(sessionId)}`);
    } catch (e) {
        console.warn(`[AUTODEAF] ⚠️ Error for ${sanitizeLogText(sessionId)}: ${e.message}`);
        try {
            const currentSession = sessionManager.getSession(sessionId);
            const currentConn = currentSession?.connection;
            if (!currentSession || !currentConn) return;
            currentConn.rejoin({
                channelId: currentSession.voiceId,
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
        console.log(`[AUTODEAF] ⏹️ Timer stopped — ${sanitizeLogText(sessionId)}`);
    }
}

function startAutoDeafTimer(sessionId) {
    if (!st.autoDeafSettings.enabled) return;

    const session = sessionManager.getSession(sessionId);
    if (!session || !isSessionRunnable(session)) {
        stopAutoDeafTimer(sessionId);
        return;
    }

    stopAutoDeafTimer(sessionId);

    const jitter = randomJitter(5 * 60 * 1000);
    const interval = Math.max(60000, st.autoDeafSettings.intervalMs + jitter);

    const id = setInterval(() => doAutoDeafToggle(sessionId), interval);
    id.unref?.();
    autoDeafTimers.set(sessionId, id);

    console.log(`[AUTODEAF] ▶️ Timer started for ${sanitizeLogText(sessionId)} (every ${Math.round(interval / 60000)} min, open ${st.autoDeafSettings.openDurationMs / 1000}s)`);
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
    // Validate and clamp settings before they reach setInterval/delay
    const validated = { ...st.autoDeafSettings, ...newSettings };

    if (validated.intervalMs !== undefined) {
        const raw = Number(validated.intervalMs);
        validated.intervalMs = Number.isFinite(raw) && raw > 0
            ? Math.max(60000, Math.min(ONE_DAY_MS, raw))
            : 3600000;
    }

    if (validated.openDurationMs !== undefined) {
        const raw = Number(validated.openDurationMs);
        validated.openDurationMs = Number.isFinite(raw) && raw > 0
            ? Math.max(5000, Math.min(600000, raw))
            : 60000;
    }

    st.autoDeafSettings = validated;

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
