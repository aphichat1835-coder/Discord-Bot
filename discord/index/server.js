/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT HARDCODE PORT — use process.env.PORT.
DO NOT REMOVE: rateLimitMiddleware, checkAuth, logIntrusion.
DO NOT REMOVE: /api/reveal-token lockout logic.
================================================================================
*/

const crypto = require("crypto");
const auth = require("./auth");
const {
    serializeVoiceSession,
    getSessionTokenSafe
} = require("./sessionSerializer");
const {
    buildCommandStatusPayload,
    buildCommandAuditPayload,
    buildRuntimeStatusPayload
} = require("./dashboardState");
const {
    shouldBypassDashboardReadApi,
    createRateLimiter,
    makeCheckAuth,
    makeCheckRevealPin,
    logIntrusion,
    cleanupRevealAttempts
} = require("../guards/dashboardGuards");
const { sendLogWebhook } = require("../core/webhooks");

function safeRedirectPath(value) {
    const raw = String(value || "/").trim();
    if (!raw.startsWith("/") || raw.startsWith("//")) return "/";

    try {
        const parsed = new URL(raw, "http://dashboard.local");
        return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
    } catch {
        return "/";
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔌  REGISTER ALL API ROUTES
// ════════════════════════════════════════════════════════════════════════════
function registerRoutes({
    app, express, config, sessionManager, voiceWorker,
    commands, webLogs, MAX_LOGS, client, botReadyAt,
    API_SECRET, getWebPin, requestCounts,
    disabledCommands, commandAuditLog, toggleCooldowns,
    startRotateTimer, setupTelemetryRouter
}) {
    const checkAuth      = makeCheckAuth(API_SECRET);
    const checkRevealPin = makeCheckRevealPin(getWebPin);
    const rateLimiter    = createRateLimiter(requestCounts, config, sessionManager);

    // ── PIN Authentication Routes ──
    app.get("/auth/pin", (req, res) => {
        const next = req.query.next || "/";
        res.send(auth.pinPageHTML(false, next));
    });

    app.post("/auth/pin", require("express").urlencoded({ extended: false }), (req, res) => {
        const { pin, next } = req.body || {};
        const correctPin = auth.PIN();

        const safeNextPath = safeRedirectPath(next);
        if (!correctPin) return res.status(303).set("Location", safeNextPath).end();

        const ip = req.ip;

        if (!app._pinAttempts) app._pinAttempts = new Map();

        const attempts = app._pinAttempts.get(ip) || {
            count: 0,
            resetAt: Date.now() + 600000
        };

        if (Date.now() > attempts.resetAt) {
            attempts.count = 0;
            attempts.resetAt = Date.now() + 600000;
        }

        if (attempts.count >= 8) {
            return res.status(429).send("Too many attempts. Wait 10 minutes.");
        }

        const pinBuf = Buffer.from(pin || "", "utf8");
        const corBuf = Buffer.from(correctPin, "utf8");
        const valid  = pinBuf.length === corBuf.length && crypto.timingSafeEqual(pinBuf, corBuf);

        if (!valid) {
            attempts.count++;
            app._pinAttempts.set(ip, attempts);
            const safeNext = (next || "/").replace(/[<>"]/g, "");
            return res.send(auth.pinPageHTML(true, safeNext));
        }

        app._pinAttempts.delete(ip);

        const token    = auth.makeToken();
        const isProd   = process.env.NODE_ENV === "production";
        const safePath = safeRedirectPath(next);

        res.setHeader("Set-Cookie", auth.setCookieHeader(token, isProd));
        res.redirect(safePath);
    });

    app.get("/auth/logout", (req, res) => {
        res.setHeader("Set-Cookie", `${auth.COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly`);
        res.redirect("/auth/pin");
    });

    // ── Health / Ping ──
    app.get("/ping", (req, res) => res.status(200).send("OK"));

    app.get("/health", (req, res) => {
        const uptimeSec = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000);
        const botOnline = client?.isReady?.() ?? false;
        const dbStatus = sessionManager.getDatabaseStatus?.();
        const dbConnected = dbStatus?.connected === true;
        const ready = botOnline && dbConnected;

        res.status(ready ? 200 : 503).json({
            status: ready ? "ok" : "degraded",
            uptime: uptimeSec,
            sessions: sessionManager.getAllSessions().size,
            botOnline,
            dbConnected
        });
    });

    app.use("/api", (req, res, next) => {
        if (shouldBypassDashboardReadApi(req)) return next();

        return rateLimiter(req, res, () => {
            if (!checkAuth(req, res)) return;
            next();
        });
    });

    // ── API Status real-time JSON ──
    app.get("/api/status", (req, res) => {
        try {
            res.json(buildRuntimeStatusPayload({
                sessionManager,
                voiceWorker,
                webLogs,
                client,
                config,
                botReadyAt,
                serializeVoiceSession
            }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── Dashboard READ-ONLY routes ──
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

    // ── Shadow Portal ──
    if (typeof setupTelemetryRouter === "function") {
        setupTelemetryRouter(app, client, null);
        console.log("[SHADOW] 🌐 Shadow web portal registered.");
    }

    // ── Session Detail API ──
    app.get("/api/session/:sessionId", (req, res) => {
        try {
            const sid = req.params.sessionId;
            const session = sessionManager.getSession(sid);

            if (!session) return res.json({ found: false });

            const allLogs = voiceWorker.getVoiceLogs();
            const sessionLogs = allLogs.filter(l => l.sessionId === sid).slice(0, 40);

            res.json({
                found: true,
                session: serializeVoiceSession(session),
                voiceLogs: sessionLogs
            });
        } catch (e) {
            res.status(500).json({ found: false, error: e.message });
        }
    });

    // ── Reveal Token APIs ──
    app.post("/api/reveal-token", express.json(), (req, res) => {
        try {
            if (!checkRevealPin(req, res)) return;

            const { sessionId } = req.body || {};
            const token = getSessionTokenSafe(sessionManager, sessionId);

            if (!token) {
                return res.status(404).json({
                    success: false,
                    error: "ไม่พบ session นี้"
                });
            }

            res.json({ success: true, token });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });
        app.post("/api/reveal-all-tokens", express.json(), (req, res) => {
        try {
            if (!checkRevealPin(req, res)) return;

            const allSessions = Array.from(sessionManager.getAllSessions().values())
                .filter(session => sessionManager.isSessionRunnable?.(session) !== false);
            const tokens = {};

            for (const s of allSessions) {
                const tok = getSessionTokenSafe(sessionManager, s.sessionId);
                if (tok) tokens[s.sessionId] = tok;
            }

            res.json({ success: true, tokens });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
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
                return res.status(404).json({
                    success: false,
                    error: "ไม่พบ session"
                });
            }

            const stopped = await voiceWorker.stopSession(sessionId, {
                stoppedBy: "dashboard",
                notifyReason: "manual"
            });

            if (!stopped) {
                return res.status(409).json({
                    success: false,
                    error: "ไม่สามารถหยุด session นี้ได้"
                });
            }

            console.log(`[DASHBOARD] 🛑 Session ${sessionId} stopped via dashboard`);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Commands Status / Toggle / Audit ──
    app.get("/api/commands-status", (req, res) => {
        try {
            res.json(buildCommandStatusPayload(commands, disabledCommands));
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/commands/toggle", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { commandName } = req.body || {};

            if (!commandName || typeof commandName !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "ไม่ระบุชื่อคำสั่ง"
                });
            }

            const exists = (commands.slashCommandsData || []).find(c => c.name === commandName);

            if (!exists) {
                return res.status(404).json({
                    success: false,
                    error: `ไม่พบคำสั่ง /${commandName}`
                });
            }

            const toggleKey   = `${req.ip}:${commandName}`;
            const lastToggle  = toggleCooldowns.get(toggleKey) || 0;
            const sinceToggle = Date.now() - lastToggle;

            if (sinceToggle < 5000) {
                const wait = ((5000 - sinceToggle) / 1000).toFixed(1);
                return res.status(429).json({
                    success: false,
                    error: `กรุณารอ ${wait}s`
                });
            }

            toggleCooldowns.set(toggleKey, Date.now());

            if (disabledCommands.has(commandName)) {
                disabledCommands.delete(commandName);
            } else {
                disabledCommands.add(commandName);
            }

            await sessionManager.setSetting("disabledCommands", [...disabledCommands]);

            const nowEnabled = !disabledCommands.has(commandName);

            if (commandAuditLog.length >= 100) commandAuditLog.shift();

            commandAuditLog.push({
                commandName,
                action: nowEnabled ? "enabled" : "disabled",
                ip: req.ip,
                timestamp: Date.now()
            });

            sendLogWebhook({
                content: `⚡ \`/${commandName}\` ถูก**${nowEnabled ? "เปิด ✅" : "ปิด ❌"}** โดย IP \`${req.ip}\``
            }).catch(() => {});

            res.json({
                success: true,
                commandName,
                enabled: nowEnabled
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/commands-audit", (req, res) => {
        res.json(buildCommandAuditPayload(commandAuditLog));
    });

    // ── Settings ──
    app.post("/api/settings", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                maxSessions,
                rateLimitRequests,
                idleTimeoutHrs,
                antiRaidEnabled
            } = req.body;

            if (maxSessions) await sessionManager.setSetting("maxSessions", maxSessions);
            if (rateLimitRequests) await sessionManager.setSetting("rateLimitRequests", rateLimitRequests);
            if (idleTimeoutHrs) await sessionManager.setSetting("idleTimeoutHrs", idleTimeoutHrs);
            if (antiRaidEnabled !== undefined) await sessionManager.setSetting("antiRaidEnabled", antiRaidEnabled);

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Presence ──
    app.post("/api/presence", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                botStatus,
                botActivityType,
                botActivity,
                botNote
            } = req.body;

            if (!["online", "idle", "dnd", "invisible"].includes(botStatus)) {
                return res.status(400).json({
                    success: false,
                    error: "สถานะไม่ถูกต้อง"
                });
            }

            if (!botActivity?.trim()) {
                return res.status(400).json({
                    success: false,
                    error: "กรุณากรอกข้อความกิจกรรม"
                });
            }

            const actType = ["WATCHING", "LISTENING", "PLAYING", "COMPETING"].includes(botActivityType)
                ? botActivityType
                : "WATCHING";

            await sessionManager.setSetting("botStatus", botStatus);
            await sessionManager.setSetting("botActivityType", actType);
            await sessionManager.setSetting("botActivity", botActivity.trim().slice(0, 128));
            await sessionManager.setSetting("botNote", (botNote || "").trim().slice(0, 128));

            if (client?.isReady?.()) {
                const activities = [
                    {
                        name: botActivity.trim().slice(0, 128),
                        type: actType
                    }
                ];

                if (botNote?.trim()) {
                    activities.push({
                        name: botNote.trim().slice(0, 128),
                        type: "CUSTOM"
                    });
                }

                client.user.setPresence({
                    status: botStatus,
                    activities
                });
            }

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/presence/rotate", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                rotateEnabled,
                rotateInterval,
                rotateMessages
            } = req.body;

            if (typeof rotateEnabled !== "boolean") {
                return res.status(400).json({
                    success: false,
                    error: "rotateEnabled ต้องเป็น boolean"
                });
            }

            const interval = Math.max(1, parseInt(rotateInterval) || 5);
            const msgs = Array.isArray(rotateMessages)
                ? rotateMessages.map(m => String(m).trim().slice(0, 128)).filter(Boolean)
                : [];

            await sessionManager.setSetting("rotateEnabled", rotateEnabled);
            await sessionManager.setSetting("rotateInterval", interval);
            await sessionManager.setSetting("rotateMessages", msgs);

            await startRotateTimer();

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

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

            const safeInterval = Math.max(60000, parseInt(intervalMs) || 3600000);
            const safeDuration = Math.min(120000, Math.max(5000, parseInt(durationMs) || 30000));

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

            const safeInterval = Math.max(60000, parseInt(intervalMs) || 3600000);
            const safeOpenDuration = Math.min(600000, Math.max(5000, parseInt(openDurationMs) || 60000));

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

    // ── Whitelist ──
    app.post("/api/whitelist/add", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { userId } = req.body;

            if (!userId || typeof userId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid userId"
                });
            }

            await sessionManager.addWhitelist(userId, "dashboard");
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/whitelist/remove", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { userId } = req.body;

            if (!userId || typeof userId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid userId"
                });
            }

            await sessionManager.removeWhitelist(userId);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Approved Guilds ──
    app.post("/api/approve", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { guildId } = req.body;

            if (!guildId || typeof guildId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid guildId"
                });
            }

            await sessionManager.ApprovedGuildModel.updateOne(
                { guildId },
                { $setOnInsert: { guildId } },
                { upsert: true }
            );

            await sessionManager.PendingGuildModel.deleteOne({ guildId });

            const guild = client.guilds.cache.get(guildId);
            sendLogWebhook({
                content: `✅ **[GUILD APPROVED]** ${guild ? `${guild.name} (\`${guildId}\`)` : `\`${guildId}\``}`
            }).catch(() => {});

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/approved/remove", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { guildId } = req.body;

            if (!guildId || typeof guildId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid guildId"
                });
            }

            await sessionManager.ApprovedGuildModel.deleteOne({ guildId });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/approved/kick", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { guildId } = req.body;

            if (!guildId || typeof guildId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid guildId"
                });
            }

            const guild = client.guilds.cache.get(guildId);

            if (!guild) {
                return res.status(404).json({
                    success: false,
                    error: "บอทไม่ได้อยู่ใน guild นี้"
                });
            }

            const guildName = guild.name;
            const guildSessions = Array.from(sessionManager.getAllSessions().values())
                .filter(s => s.serverId === guildId);

            let failedStops = 0;
            for (const s of guildSessions) {
                const stopped = await voiceWorker.stopSession(s.sessionId, { stoppedBy: "dashboard" }).catch((stopErr) => {
                    console.warn(`[DASHBOARD] ⚠️ Best-effort guild kick voice stop failed for session ${s.sessionId}: ${stopErr.message}`);
                    return false;
                });
                if (!stopped) failedStops++;
            }

            if (failedStops > 0) {
                console.warn(`[DASHBOARD] ⚠️ Continuing guild leave after ${failedStops} voice session stop failure(s) for guild ${guildId}`);
            }

            await guild.leave();
            await sessionManager.ApprovedGuildModel.deleteOne({ guildId });

            sendLogWebhook({
                content: `👢 **[BOT KICKED]** ${guildName} (\`${guildId}\`)`
            }).catch(() => {});

            res.status(failedStops > 0 ? 207 : 200).json({
                success: failedStops === 0,
                partialSuccess: failedStops > 0,
                voiceStopFailed: failedStops,
                warning: failedStops > 0 ? "บอทถูกนำออกแล้ว แต่มี voice sessions บางรายการหยุดไม่สำเร็จ" : null
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    setInterval(() => cleanupRevealAttempts(), 5 * 60 * 1000);
}

module.exports = {
    registerRoutes,
    logIntrusion,
    makeCheckAuth,
    makeCheckRevealPin
};
