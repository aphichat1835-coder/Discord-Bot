'use strict';

const { cleanToken } = require("../sessions/tokenUtils");
const { getPrimaryOwnerId } = require("../core/env");
const {
    serializeVoiceSession,
    getSessionTokenSafe
} = require("./sessionSerializer");

function voiceSessionEnsureErrorStatus(errorMessage) {
    const badRequestErrors = [
        "INVALID_TOKEN_FORMAT",
        "INVALID_GUILD_ID",
        "INVALID_VOICE_CHANNEL_ID",
        "GUILD_NOT_FOUND",
        "CHANNEL_NOT_FOUND"
    ];
    const conflictErrors = [
        "ALREADY_ACTIVE_IN_GUILD",
        "already_active_different_channel",
        "SESSION_LOCKED",
        "VOICE_QUEUE_BUSY"
    ];
    const unavailableErrors = [
        "DATABASE_NOT_CONNECTED",
        "SYSTEM_SHUTTING_DOWN"
    ];

    if (badRequestErrors.includes(errorMessage)) return 400;
    if (conflictErrors.includes(errorMessage)) return 409;
    if (unavailableErrors.includes(errorMessage)) return 503;
    return 500;
}

async function handleReconnectSession({
    req,
    res,
    checkAuth,
    sessionManager,
    voiceWorker
}) {
    if (!checkAuth(req, res)) return;

    try {
        const { sessionId } = req.body || {};

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: "ไม่ระบุ sessionId"
            });
        }

        const session = sessionManager.getSession(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                error: "ไม่พบ session ในระบบ"
            });
        }

        const result = await voiceWorker.forceReconnectSession(sessionId);

        if (!result?.ok) {
            return res.status(400).json({
                success: false,
                error: result?.error || "ไม่สามารถเชื่อมต่อใหม่ได้"
            });
        }

        console.log("[DASHBOARD] 🔄 Session reconnect triggered via dashboard");
        return res.json({ success: true, ready: !!result.ready });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

function registerVoiceRoutes({
    app,
    express,
    config,
    sessionManager,
    voiceWorker,
    client,
    checkAuth
}) {
    // ── Dashboard Voice READ-ONLY routes ──
    app.get("/api/settings/natural", (req, res) => {
        try {
            res.json({ success: true, settings: voiceWorker.getNaturalSettings() });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/settings/auto-deaf", (req, res) => {
        try {
            res.json({ success: true, settings: voiceWorker.getAutoDeafSettings() });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/voice-logs", (req, res) => {
        try {
            res.json(voiceWorker.getVoiceLogs().slice(-300).reverse());
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/sessions", (req, res) => {
        try {
            const sessions = Array.from(sessionManager.getAllSessions().values()).map(session => ({
                ...serializeVoiceSession(session),
                token: getSessionTokenSafe(sessionManager, session.sessionId)
            }));
            res.json({ success: true, sessions });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/session/:id", (req, res) => {
        try {
            const session = sessionManager.getSession(req.params.id);
            if (!session) return res.status(404).json({ success: false, error: "Session not found" });
            const voiceLogs = voiceWorker.getVoiceLogs()
                .filter(entry => String(entry?.sessionId || "") === String(req.params.id))
                .slice(-100)
                .reverse();
            res.json({
                success: true,
                session: {
                    ...serializeVoiceSession(session),
                    token: getSessionTokenSafe(sessionManager, session.sessionId)
                },
                voiceLogs
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Start / Ensure Voice Session ──
    app.post("/api/voice-session/ensure", express.json({ limit: "16kb" }), async (req, res) => {
        try {
            if (!checkAuth(req, res)) return;

            const {
                token,
                guildId,
                serverId,
                channelId,
                voiceId
            } = req.body || {};

            const primaryOwnerId = getPrimaryOwnerId();
            const dashboardOwner = client.users.cache.get(primaryOwnerId) || null;

            const result = await voiceWorker.ensureVoiceSession({
                token: cleanToken(token),
                guildId: guildId || serverId,
                channelId: channelId || voiceId,
                ownerId: primaryOwnerId,
                ownerTag: dashboardOwner?.tag || "เจ้าของบอท",
                ownerAvatar: dashboardOwner?.displayAvatarURL?.({ forceStatic: false, size: 256 }) || null,
                reason: "dashboard_api"
            });

            if (result.ok === false) {
                return res.status(409).json({
                    success: false,
                    action: result.action,
                    sessionId: result.sessionId,
                    requested: result.requested,
                    existing: result.existing,
                    error: result.action
                });
            }

            res.json({
                success: true,
                action: result.action,
                reused: result.reused === true,
                sessionId: result.sessionId
            });
        } catch (e) {
            const status = voiceSessionEnsureErrorStatus(e.message);

            res.status(status).json({
                success: false,
                error: e.message
            });
        }
    });

    // ── Stop Session ──
    app.post("/api/stop-session", express.json({ limit: "8kb" }), async (req, res) => {
        try {
            if (!checkAuth(req, res)) return;

            const { sessionId } = req.body || {};

            if (!sessionId) {
                return res.status(400).json({
                    success: false,
                    error: "ไม่ระบุ sessionId"
                });
            }

            const session = sessionManager.getSession(sessionId);

            if (!session) {
                return res.json({
                    success: true,
                    action: "already_removed"
                });
            }

            const stopped = await voiceWorker.stopSession(sessionId, {
                stoppedBy: "dashboard",
                notifyReason: "manual",
                actorNotified: true
            });

            if (!stopped) {
                return res.status(409).json({
                    success: false,
                    error: "ไม่สามารถหยุด session นี้ได้"
                });
            }

            console.log("[DASHBOARD] 🛑 Session stopped via dashboard");
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Reconnect Session ──
    const onReconnectSession = (req, res) => handleReconnectSession({
        req,
        res,
        checkAuth,
        sessionManager,
        voiceWorker
    });

    app.post("/api/reconnect-session", express.json({ limit: "8kb" }), onReconnectSession);
    app.post("/api/voice/session/reconnect", express.json({ limit: "8kb" }), onReconnectSession);

    // ── Natural Settings ──
    app.post("/api/settings/natural", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                enabled,
                intervalMs,
                durationMs
            } = req.body;

            if (typeof enabled !== "boolean") {
                return res.status(400).json({
                    success: false,
                    error: "enabled ต้องเป็น boolean"
                });
            }

            const safeInterval = Math.max(60000, Number.parseInt(intervalMs, 10) || 3600000);
            const safeDuration = Math.min(120000, Math.max(5000, Number.parseInt(durationMs, 10) || 30000));

            await sessionManager.setSetting("naturalEnabled", enabled);
            await sessionManager.setSetting("naturalIntervalMs", safeInterval);
            await sessionManager.setSetting("naturalDurationMs", safeDuration);

            voiceWorker.applyNaturalSettings({
                enabled,
                intervalMs: safeInterval,
                durationMs: safeDuration
            });

            res.json({
                success: true,
                settings: voiceWorker.getNaturalSettings()
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Auto Deaf Settings ──
    app.post("/api/settings/auto-deaf", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                enabled,
                intervalMs,
                openDurationMs
            } = req.body;

            if (typeof enabled !== "boolean") {
                return res.status(400).json({
                    success: false,
                    error: "enabled ต้องเป็น boolean"
                });
            }

            const safeInterval = Math.max(60000, Number.parseInt(intervalMs, 10) || 3600000);
            const safeOpenDuration = Math.min(600000, Math.max(5000, Number.parseInt(openDurationMs, 10) || 60000));

            await sessionManager.setSetting("autoDeafEnabled", enabled);
            await sessionManager.setSetting("autoDeafIntervalMs", safeInterval);
            await sessionManager.setSetting("autoDeafOpenDurationMs", safeOpenDuration);

            voiceWorker.applyAutoDeafSettings({
                enabled,
                intervalMs: safeInterval,
                openDurationMs: safeOpenDuration
            });

            res.json({
                success: true,
                settings: voiceWorker.getAutoDeafSettings()
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });
}

module.exports = {
    registerVoiceRoutes,
    voiceSessionEnsureErrorStatus,
    handleReconnectSession,
    _test: {
        voiceSessionEnsureErrorStatus,
        handleReconnectSession
    }
};
