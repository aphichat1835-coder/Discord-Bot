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
    cleanupRevealAttempts,
    getRevealAttemptStats,
    getRateLimitStats
} = require("../guards/dashboardGuards");
const { sendLogWebhook } = require("../core/webhooks");
const { getFeatureFlags } = require("../core/featureFlags");

function safeRedirectPath(value) {
    const raw = String(value || "/").trim();
    if (!raw.startsWith("/") || raw.startsWith("//")) return "/";

    try {
        const parsed = new URL(raw, "https://dashboard.local");
        return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
    } catch {
        return "/";
    }
}

function hashAuditIp(ip) {
    const raw = String(ip || "unknown");
    const secret = auth.getApiSecret() || "dashboard-audit";
    const hash = crypto
        .createHmac("sha256", secret)
        .update(raw)
        .digest("hex")
        .slice(0, 12);

    return `ip#${hash}`;
}

// ════════════════════════════════════════════════════════════════════════════
//  🔌  REGISTER ALL API ROUTES
// ════════════════════════════════════════════════════════════════════════════
function registerRoutes({
    app, express, config, sessionManager, voiceWorker,
    commands, webLogs, MAX_LOGS, client, auditLogger, memoryMonitor, botReadyAt,
    API_SECRET, getWebPin, requestCounts,
    disabledCommands, commandAuditLog, toggleCooldowns, commandCooldowns, spamTracking, antiRaidLogDebounce,
    startRotateTimer, setupTelemetryRouter
}) {
    const checkAuth      = makeCheckAuth(API_SECRET);
    const checkRevealPin = makeCheckRevealPin(getWebPin);
    const rateLimiter    = createRateLimiter(requestCounts, config, sessionManager);
    const PIN_ATTEMPT_TTL_MS = 10 * 60 * 1000;
    const PIN_ATTEMPT_MAX_KEYS = Math.max(100, Number(process.env.PIN_ATTEMPT_MAX_KEYS || 1000) || 1000);
    const ROTATE_MESSAGES_MAX = Math.max(1, Number(process.env.ROTATE_MESSAGES_MAX || 20) || 20);

    function getPinAttempts() {
        if (!app._pinAttempts) app._pinAttempts = new Map();
        return app._pinAttempts;
    }

    function cleanupPinAttempts(now = Date.now()) {
        const attemptsMap = getPinAttempts();

        for (const [ip, attempts] of attemptsMap.entries()) {
            if (!attempts?.resetAt || attempts.resetAt < now) {
                attemptsMap.delete(ip);
            }
        }

        while (attemptsMap.size > PIN_ATTEMPT_MAX_KEYS) {
            const oldestKey = attemptsMap.keys().next().value;
            if (!oldestKey) break;
            attemptsMap.delete(oldestKey);
        }
    }

    function getPinAttemptStats() {
        cleanupPinAttempts();
        return {
            tracked: getPinAttempts().size,
            maxKeys: PIN_ATTEMPT_MAX_KEYS,
            ttlMs: PIN_ATTEMPT_TTL_MS
        };
    }

    function sessionCountsByState() {
        const counts = {};
        for (const session of sessionManager.getAllSessions().values()) {
            const state = session?.state || "active";
            counts[state] = (counts[state] || 0) + 1;
        }
        return counts;
    }

    function envReadiness() {
        return {
            NODE_ENV: process.env.NODE_ENV || "development",
            PORT: !!process.env.PORT,
            MONGO_URI: !!process.env.MONGO_URI,
            API_SECRET: !!process.env.API_SECRET,
            BOT_TOKEN: !!process.env.BOT_TOKEN,
            DASHBOARD_PIN: !!process.env.DASHBOARD_PIN,
            WEBHOOK_LOG_URL: !!process.env.WEBHOOK_LOG_URL,
            ALERT_WEBHOOK_URL: !!process.env.ALERT_WEBHOOK_URL
        };
    }

    // ── PIN Authentication Routes ──
    app.get("/auth/pin", (req, res) => {
        const next = req.query.next || "/";
        res.send(auth.pinPageHTML(false, next));
    });

    app.post("/auth/pin", require("express").urlencoded({ extended: false }), (req, res) => {
        const { pin, next } = req.body || {};
        const correctPin = auth.PIN();

        if (!correctPin) return res.redirect("/");

        const ip = req.ip;

        const pinAttempts = getPinAttempts();
        cleanupPinAttempts();

        const attempts = pinAttempts.get(ip) || {
            count: 0,
            resetAt: Date.now() + PIN_ATTEMPT_TTL_MS
        };

        if (Date.now() > attempts.resetAt) {
            attempts.count = 0;
            attempts.resetAt = Date.now() + PIN_ATTEMPT_TTL_MS;
        }

        if (attempts.count >= 8) {
            return res.status(429).send("Too many attempts. Wait 10 minutes.");
        }

        const pinBuf = Buffer.from(pin || "", "utf8");
        const corBuf = Buffer.from(correctPin, "utf8");
        const valid  = pinBuf.length === corBuf.length && crypto.timingSafeEqual(pinBuf, corBuf);

        if (!valid) {
            attempts.count++;
            pinAttempts.set(ip, attempts);
            const safeNext = (next || "/").replace(/[<>"]/g, "");
            return res.send(auth.pinPageHTML(true, safeNext));
        }

        pinAttempts.delete(ip);

        if (!auth.getApiSecret()) {
            return res.status(503).send("API_SECRET is required for dashboard auth.");
        }

        const token    = auth.makeToken();
        const isProd   = auth.isProduction();
        const safePath = safeRedirectPath(next);

        res.setHeader("Set-Cookie", auth.setSessionCookieHeaders(token, isProd));
        res.redirect(safePath);
    });

    app.get("/auth/logout", (req, res) => {
        res.setHeader("Set-Cookie", auth.clearSessionCookieHeaders(auth.isProduction()));
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
            return auth.requireCsrf(req, res, next);
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

    app.get("/api/diagnostics", (req, res) => {
        try {
            const dbStatus = sessionManager.getDatabaseStatus?.() || {};
            const workerDiagnostics = voiceWorker.getWorkerDiagnostics?.() || {};
            const auditStats = auditLogger?.getAuditStats?.() || {};
            const memoryState = memoryMonitor?.getMemoryMonitorState?.() || {};

            res.json({
                success: true,
                service: "owner-dashboard",
                timestamp: Date.now(),
                uptimeSec: Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000),
                env: envReadiness(),
                featureFlags: getFeatureFlags(),
                database: {
                    connected: dbStatus.connected === true,
                    readyState: dbStatus.readyState ?? null,
                    name: dbStatus.name || null
                },
                discord: {
                    ready: client?.isReady?.() ?? false,
                    tag: client?.user?.tag || null,
                    guilds: client?.guilds?.cache?.size ?? 0
                },
                sessions: {
                    total: sessionManager.getAllSessions().size,
                    byState: sessionCountsByState(),
                    diagnostics: sessionManager.getSessionDiagnostics?.() || null
                },
                voiceWorker: workerDiagnostics,
                audit: auditStats,
                memoryMonitor: memoryState,
                requestCounters: {
                    ...getRateLimitStats(requestCounts),
                    toggleCooldowns: toggleCooldowns?.size || 0,
                    commandCooldownUsers: commandCooldowns?.size || 0,
                    spamTracking: spamTracking?.size || 0,
                    antiRaidLogDebounce: antiRaidLogDebounce?.size || 0,
                    pinAttempts: getPinAttemptStats(),
                    revealAttempts: getRevealAttemptStats()
                },
                commands: commands.getCommandRuntimeDiagnostics?.(client) || null
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/diagnostics", (req, res) => {
        try {
            const sessions = Array.from(sessionManager.getAllSessions().values());
            const sessionCounts = sessions.reduce((acc, session) => {
                const state = session?.state || "active";
                acc[state] = (acc[state] || 0) + 1;
                return acc;
            }, {});
            const mem = process.memoryUsage();
            const dbStatus = sessionManager.getDatabaseStatus?.() || {};
            const readiness = {
                apiSecret: !!auth.getApiSecret(),
                webPin: !!getWebPin?.(),
                mongoUri: !!process.env.MONGO_URI,
                discordToken: !!process.env.DISCORD_TOKEN,
                dashboardPublicUrl: !!(
                    process.env.DASHBOARD_URL ||
                    process.env.PUBLIC_DASHBOARD_URL ||
                    process.env.PUBLIC_BASE_URL ||
                    process.env.DASHBOARD_PUBLIC_URL
                )
            };

            res.json({
                success: true,
                timestamp: Date.now(),
                uptimeSec: Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000),
                env: readiness,
                database: dbStatus,
                discord: {
                    ready: client?.isReady?.() ?? false,
                    userId: client?.user?.id || null,
                    guilds: client?.guilds?.cache?.size ?? 0
                },
                sessions: {
                    total: sessions.length,
                    byState: sessionCounts,
                    runnable: sessions.filter(session => sessionManager.isSessionRunnable?.(session) !== false).length,
                    diagnostics: sessionManager.getSessionDiagnostics?.() || null
                },
                voiceWorker: voiceWorker.getWorkerDiagnostics?.() || {},
                audit: auditLogger?.getAuditStats?.() || {},
                memoryMonitor: memoryMonitor?.getMemoryMonitorState?.() || null,
                requestCounters: {
                    ...getRateLimitStats(requestCounts),
                    toggleCooldowns: toggleCooldowns?.size || 0,
                    commandCooldownUsers: commandCooldowns?.size || 0,
                    spamTracking: spamTracking?.size || 0,
                    antiRaidLogDebounce: antiRaidLogDebounce?.size || 0,
                    pinAttempts: getPinAttemptStats(),
                    revealAttempts: getRevealAttemptStats()
                },
                commands: commands.getCommandRuntimeDiagnostics?.(client) || null,
                retention: {
                    localCronTimers: "managed_by_system_cron"
                },
                memory: {
                    heapUsedMB: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
                    heapTotalMB: Number((mem.heapTotal / 1024 / 1024).toFixed(1)),
                    rssMB: Number((mem.rss / 1024 / 1024).toFixed(1))
                },
                metrics: {
                    requests: sessionManager.systemMetrics.requests,
                    errors: sessionManager.systemMetrics.errors,
                    reconnects: sessionManager.systemMetrics.reconnects
                }
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
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

            const auditIp     = hashAuditIp(req.ip);
            const toggleKey   = `${auditIp}:${commandName}`;
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
                ip: auditIp,
                timestamp: Date.now()
            });

            sendLogWebhook({
                content: `⚡ \`/${commandName}\` ถูก**${nowEnabled ? "เปิด ✅" : "ปิด ❌"}** โดย \`${auditIp}\``
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
                ? rotateMessages.map(m => String(m).trim().slice(0, 128)).filter(Boolean).slice(0, ROTATE_MESSAGES_MAX)
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

    const revealAttemptCleanupTimer = setInterval(() => {
        cleanupRevealAttempts();
        cleanupPinAttempts();
    }, 5 * 60 * 1000);
    revealAttemptCleanupTimer.unref?.();
}

module.exports = {
    registerRoutes,
    logIntrusion,
    makeCheckAuth,
    makeCheckRevealPin
};
