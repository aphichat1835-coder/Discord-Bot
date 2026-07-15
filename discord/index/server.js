/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT HARDCODE PORT — use process.env.PORT.
DO NOT REMOVE: rateLimitMiddleware, checkAuth, logIntrusion.
DO NOT REMOVE: /api/reveal-token lockout logic.
================================================================================
*/

const crypto = require("node:crypto");
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
const { sendLogWebhook, getWebhookDeliveryDiagnostics } = require("../core/webhooks");
const { getFeatureFlags } = require("../core/featureFlags");
const { registerJoinCampaignRoutes } = require("./joinCampaignRoutes");
const { getVerificationDiagnostics } = require("../verification/lifecycle");

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

function setNoStore(res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
}

function buildEnvReadiness(env = process.env) {
    return {
        NODE_ENV: env.NODE_ENV || "development",
        PORT: !!env.PORT,
        MONGO_URI: !!env.MONGO_URI,
        API_SECRET: !!env.API_SECRET,
        TOKEN_MANAGER: !!env.TOKEN_MANAGER,
        DASHBOARD_PIN: !!env.DASHBOARD_PIN,
        WEBHOOK_LOG_URL: !!env.WEBHOOK_LOG_URL,
        ALERT_WEBHOOK_URL: !!env.ALERT_WEBHOOK_URL
    };
}

function wait(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

function registerShadowPortal({ setupTelemetryRouter, app, client }) {
    if (typeof setupTelemetryRouter !== "function") {
        return { registered: false, reason: "hook_unavailable" };
    }

    try {
        setupTelemetryRouter(app, client, null);
        console.log("[SHADOW] 🌐 Shadow web portal registered.");
        return { registered: true, reason: null };
    } catch (err) {
        console.error("[SHADOW] ❌ Shadow web portal registration failed:", err?.message || err);
        return { registered: false, reason: "registration_failed" };
    }
}

async function removeApprovedGuildRecord(sessionManager, guildId, attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await sessionManager.ApprovedGuildModel.deleteOne({ guildId });
            return true;
        } catch {
            console.warn(`[DASHBOARD] ⚠️ Approved guild cleanup failed (${attempt}/${attempts})`);

            if (attempt < attempts) {
                await wait(250 * attempt);
            }
        }
    }

    return false;
}

async function stopGuildVoiceSessions(sessionManager, voiceWorker, guildId) {
    const guildSessions = Array.from(sessionManager.getAllSessions().values())
        .filter(session => session.serverId === guildId);

    let failedStops = 0;

    for (const session of guildSessions) {
        const stopped = await voiceWorker.stopSession(session.sessionId, {
            stoppedBy: "dashboard"
        }).catch(() => {
            console.warn("[DASHBOARD] ⚠️ Best-effort guild kick voice stop failed");
            return false;
        });

        if (!stopped) failedStops++;
    }

    if (failedStops > 0) {
        console.warn(`[DASHBOARD] ⚠️ Continuing guild leave after ${failedStops} voice session stop failure(s)`);
    }

    return failedStops;
}

function buildApprovedKickWarning(failedStops, approvalCleanupFailed) {
    return [
        failedStops > 0
            ? "บอทถูกนำออกแล้ว แต่มี voice sessions บางรายการหยุดไม่สำเร็จ"
            : null,
        approvalCleanupFailed
            ? "บอทถูกนำออกแล้ว แต่ลบ approved guild record ไม่สำเร็จ"
            : null
    ].filter(Boolean).join(" | ") || null;
}

async function sendGuildNotFoundKickResponse({
    res,
    sessionManager,
    guildId
}) {
    const removedApproval = await removeApprovedGuildRecord(sessionManager, guildId);
    const approvalCleanupFailed = removedApproval === false;

    return res.status(removedApproval ? 404 : 207).json({
        success: false,
        partialSuccess: approvalCleanupFailed,
        error: "บอทไม่ได้อยู่ใน guild นี้",
        approvalRemoved: removedApproval,
        warning: approvalCleanupFailed
            ? "บอทไม่ได้อยู่ใน guild นี้แล้ว แต่ลบ approved guild record ไม่สำเร็จ"
            : null
    });
}

async function handleApprovedGuildKick({
    req,
    res,
    checkAuth,
    client,
    sessionManager,
    voiceWorker
}) {
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
            return sendGuildNotFoundKickResponse({
                res,
                sessionManager,
                guildId
            });
        }

        const guildName = guild.name;
        const failedStops = await stopGuildVoiceSessions(sessionManager, voiceWorker, guildId);

        await guild.leave();

        const removedApproval = await removeApprovedGuildRecord(sessionManager, guildId);
        const approvalCleanupFailed = removedApproval === false;
        const partialSuccess = failedStops > 0 || approvalCleanupFailed;

        sendLogWebhook({
            content: `👢 **[BOT KICKED]** ${guildName} (\`${guildId}\`)`
        }).catch(() => {});

        return res.status(partialSuccess ? 207 : 200).json({
            success: !partialSuccess,
            partialSuccess,
            voiceStopFailed: failedStops,
            approvalRemoved: removedApproval,
            warning: partialSuccess
                ? buildApprovedKickWarning(failedStops, approvalCleanupFailed)
                : null
        });
    } catch (e) {
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔌  REGISTER ALL API ROUTES
// ════════════════════════════════════════════════════════════════════════════
function registerRoutes({
    app, express, config, sessionManager, voiceWorker,
    commands, webLogs, MAX_LOGS, client, memoryMonitor, botReadyAt, commandsReady,
    API_SECRET, getWebPin, requestCounts,
    disabledCommands, commandAuditLog, toggleCooldowns, commandCooldowns, spamTracking, antiRaidDebounce,
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

    function memoryUsageSummary() {
        const mem = process.memoryUsage();
        return {
            heapUsedMB: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
            heapTotalMB: Number((mem.heapTotal / 1024 / 1024).toFixed(1)),
            rssMB: Number((mem.rss / 1024 / 1024).toFixed(1))
        };
    }

    function databaseDiagnostics() {
        const dbStatus = sessionManager.getDatabaseStatus?.() || {};
        return {
            connected: dbStatus.connected === true,
            readyState: dbStatus.readyState ?? null,
            name: dbStatus.name || null
        };
    }

    function discordDiagnostics() {
        return {
            ready: client?.isReady?.() ?? false,
            tag: client?.user?.tag || null,
            userId: client?.user?.id || null,
            guilds: client?.guilds?.cache?.size ?? 0
        };
    }

    function sessionDiagnostics() {
        const sessions = Array.from(sessionManager.getAllSessions().values());
        return {
            total: sessions.length,
            byState: sessionCountsByState(),
            runnable: sessions.filter(session => sessionManager.isSessionRunnable?.(session) !== false).length,
            diagnostics: sessionManager.getSessionDiagnostics?.() || null
        };
    }

    function requestCounterDiagnostics() {
        return {
            ...getRateLimitStats(requestCounts),
            toggleCooldowns: toggleCooldowns?.size || 0,
            commandCooldownUsers: commandCooldowns?.size || 0,
            spamTracking: spamTracking?.size || 0,
            antiRaidDebounce: antiRaidDebounce?.size || 0,
            pinAttempts: getPinAttemptStats(),
            revealAttempts: getRevealAttemptStats()
        };
    }

    function runtimeMetrics() {
        return {
            requests: sessionManager.systemMetrics.requests,
            errors: sessionManager.systemMetrics.errors,
            reconnects: sessionManager.systemMetrics.reconnects
        };
    }
        function buildDiagnosticsPayload() {
        return {
            success: true,
            service: "owner-dashboard",
            timestamp: Date.now(),
            uptimeSec: Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000),
            env: buildEnvReadiness(),
            featureFlags: getFeatureFlags(),
            database: databaseDiagnostics(),
            discord: discordDiagnostics(),
            sessions: sessionDiagnostics(),
            voiceWorker: voiceWorker.getWorkerDiagnostics?.() || {},
            webhooks: getWebhookDeliveryDiagnostics(),
            memoryMonitor: memoryMonitor?.getMemoryMonitorState?.() || {},
            requestCounters: requestCounterDiagnostics(),
            commands: commands.getCommandRuntimeDiagnostics?.(client) || null,
            retention: {
                localCronTimers: "managed_by_system_cron"
            },
            memory: memoryUsageSummary(),
            metrics: runtimeMetrics()
        };
    }

    function revealTokenHandler(req, res) {
        try {
            setNoStore(res);

            if (!checkRevealPin(req, res)) return;

            const token = getSessionTokenSafe(sessionManager, req.params.sessionId);

            if (!token) {
                return res.status(404).json({
                    success: false,
                    error: "token not found"
                });
            }

            res.json({
                success: true,
                token
            });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: e.message
            });
        }
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
    const sendReadiness = (req, res) => {
        const botOnline = client?.isReady?.() ?? false;
        const dbStatus = sessionManager.getDatabaseStatus?.();
        const dbConnected = dbStatus?.connected === true;
        const verification = getVerificationDiagnostics();
        const verificationRequired = getFeatureFlags().verification !== false;
        const verificationReady = !verificationRequired || verification.ready === true;
        const voiceRequired = getFeatureFlags().voice !== false;
        const voice = voiceWorker.getWorkerDiagnostics?.() || null;
        const voiceReady = !voiceRequired || (
            botOnline && dbConnected && voice?.ready === true
        );
        const slashCommandsReady = commandsReady?.() === true;
        const ready = botOnline && dbConnected && verificationReady && voiceReady && slashCommandsReady;

        res.status(ready ? 200 : 503).json({
            status: ready ? "ok" : "degraded",
            ready,
            botOnline,
            bot: botOnline,
            dbConnected,
            db: dbConnected,
            voiceReady,
            verificationReady,
            commandsReady: slashCommandsReady
        });
    };
    app.get("/health", sendReadiness);
    app.get("/ready", sendReadiness);

    app.use("/api", (req, res, next) => {
        if (shouldBypassDashboardReadApi(req)) return next();

        return rateLimiter(req, res, () => {
            if (!checkAuth(req, res)) return;
            return auth.requireCsrf(req, res, next);
        });
    });

    registerJoinCampaignRoutes({
        app,
        express,
        client,
        checkAuth
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
            res.json(buildDiagnosticsPayload());
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

    app.get("/api/logs", (req, res) => {
        res.json(webLogs.slice(-MAX_LOGS).reverse());
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
            const sessions = Array.from(sessionManager.getAllSessions().values()).map(serializeVoiceSession);
            res.json({ success: true, sessions });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/session/:id", (req, res) => {
        try {
            const session = sessionManager.getSession(req.params.id);
            if (!session) return res.status(404).json({ success: false, error: "Session not found" });
            res.json({ success: true, session: serializeVoiceSession(session) });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/pending-guilds", async (_req, res) => {
        try {
            const pending = await sessionManager.getPendingGuilds();
            res.json({ success: true, pending });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/approved-guilds", async (_req, res) => {
        try {
            const approved = await sessionManager.getApprovedGuildDocs?.();
            res.json({ success: true, approved: approved || [] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // Legacy GET kept for dashboard compatibility. New clients should use POST.
    app.get("/api/reveal-token/:sessionId", revealTokenHandler);
    app.post("/api/reveal-token/:sessionId", express.json({ limit: "4kb" }), revealTokenHandler);

    app.post("/api/reveal-all-tokens", express.json(), (req, res) => {
        try {
            setNoStore(res);

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

    // ── Start / Ensure Voice Session ──
    app.post("/api/voice-session/ensure", express.json({ limit: "16kb" }), async (req, res) => {
        try {
            if (!checkAuth(req, res)) return;

            const {
                token,
                guildId,
                serverId,
                channelId,
                voiceId,
                ownerId,
                ownerTag,
                ownerAvatar
            } = req.body || {};

            const result = await voiceWorker.ensureVoiceSession({
                token,
                guildId: guildId || serverId,
                channelId: channelId || voiceId,
                ownerId: ownerId || "dashboard",
                ownerTag: ownerTag || "Owner Dashboard",
                ownerAvatar: ownerAvatar || null,
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
                return res.status(404).json({
                    success: false,
                    error: "ไม่พบ session"
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

            const exists = (commands.slashCommandsData || []).some(c => c.name === commandName);

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
                const waitSec = ((5000 - sinceToggle) / 1000).toFixed(1);
                return res.status(429).json({
                    success: false,
                    error: `กรุณารอ ${waitSec}s`
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
                antiRaidEnabled,
                voiceDmMode
            } = req.body;

            if (maxSessions) await sessionManager.setSetting("maxSessions", maxSessions);
            if (rateLimitRequests) await sessionManager.setSetting("rateLimitRequests", rateLimitRequests);
            if (idleTimeoutHrs) await sessionManager.setSetting("idleTimeoutHrs", idleTimeoutHrs);
            if (antiRaidEnabled !== undefined) await sessionManager.setSetting("antiRaidEnabled", antiRaidEnabled);
            if (["important_only", "all", "off"].includes(voiceDmMode)) {
                await sessionManager.setSetting("voiceDmMode", voiceDmMode);
            }

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

            const interval = Math.max(1, Number.parseInt(rotateInterval, 10) || 5);
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

            const removedApproval = await removeApprovedGuildRecord(sessionManager, guildId);

            if (!removedApproval) {
                return res.status(503).json({
                    success: false,
                    error: "Failed to remove approved guild record"
                });
            }

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/approved/kick", express.json(), (req, res) => handleApprovedGuildKick({
        req,
        res,
        checkAuth,
        client,
        sessionManager,
        voiceWorker
    }));

    const shadowPortal = registerShadowPortal({ setupTelemetryRouter, app, client });

    const revealAttemptCleanupTimer = setInterval(() => {
        cleanupRevealAttempts();
        cleanupPinAttempts();
    }, 5 * 60 * 1000);

    revealAttemptCleanupTimer.unref?.();

    return {
        shadowPortalRegistered: shadowPortal.registered === true
    };
}

module.exports = {
    registerRoutes,
    logIntrusion,
    makeCheckAuth,
    makeCheckRevealPin,
    registerShadowPortal,
    buildEnvReadiness
};
