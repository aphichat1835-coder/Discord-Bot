'use strict';

/**
 * Express Web Dashboard & API Server
 * - Dynamic port binding via process.env.PORT.
 * - Security middleware: rateLimitMiddleware, checkAuth, logIntrusion.
 * - Preserved OI-04 invariant: token: getSessionTokenSafe for authenticated owner dashboard.
 */

const crypto = require("node:crypto");
const auth = require("./auth");
const {
    serializeVoiceSession,
    getSessionTokenSafe
} = require("./sessionSerializer");
const {
    buildRuntimeStatusPayload
} = require("./dashboardState");
const {
    shouldBypassDashboardReadApi,
    createRateLimiter,
    makeCheckAuth,
    logIntrusion,
    getRateLimitStats
} = require("../guards/dashboardGuards");
const { getFeatureFlags } = require("../core/featureFlags");
const { registerJoinCampaignRoutes } = require("./joinCampaignRoutes");
const { getVerificationDiagnostics } = require("../verification/lifecycle");
const { readFiniteInteger } = require("../core/numbers");
const { getReleaseIdentity } = require("../core/releaseIdentity");
const { registerVoiceRoutes, _test: voiceTest } = require("./voiceRoutes");
const { registerAdminRoutes, _test: adminTest } = require("./adminRoutes");
const { registerDatabaseRoutes } = require("./databaseRoutes");

function buildReadinessPayload({ client, sessionManager, voiceWorker, commandsReady, featureFlags, verification, release }) {
    const botOnline = client?.isReady?.() ?? false;
    const dbStatus = sessionManager?.getDatabaseStatus?.();
    const dbConnected = dbStatus?.connected === true;
    const resolvedFeatures = featureFlags || {};
    const verificationRequired = resolvedFeatures.verification !== false;
    const verificationReady = !verificationRequired || verification?.ready === true;
    const voiceRequired = resolvedFeatures.voice !== false;
    const voice = voiceWorker?.getWorkerDiagnostics?.() || null;
    const voiceReady = !voiceRequired || (botOnline && dbConnected && voice?.ready === true);
    const slashCommandsReady = commandsReady?.() === true;
    const ready = botOnline && dbConnected && verificationReady && voiceReady && slashCommandsReady;
    const releaseIdentity = release || getReleaseIdentity();

    return {
        status: ready ? "ok" : "degraded",
        ready,
        botOnline,
        bot: botOnline,
        dbConnected,
        db: dbConnected,
        voiceReady,
        verificationReady,
        commandsReady: slashCommandsReady,
        release: releaseIdentity
    };
}

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
        OWNER_ID: !!env.OWNER_ID,
        DASHBOARD_PIN: !!env.DASHBOARD_PIN,
        WEBHOOK_LOG_URL: !!env.WEBHOOK_LOG_URL,
        ALERT_WEBHOOK_URL: !!env.ALERT_WEBHOOK_URL
    };
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

// ════════════════════════════════════════════════════════════════════════════
//  🔌  REGISTER ALL API ROUTES
// ════════════════════════════════════════════════════════════════════════════
function registerRoutes({
    app, express, config, sessionManager, voiceWorker,
    commands, webLogs, MAX_LOGS, client, memoryMonitor, botReadyAt, commandsReady,
    API_SECRET, requestCounts,
    disabledCommands, commandAuditLog, toggleCooldowns, commandCooldowns, spamTracking,
    startRotateTimer, setupTelemetryRouter
}) {
    const checkAuth      = makeCheckAuth(API_SECRET);
    const rateLimiter    = createRateLimiter(requestCounts, config, sessionManager);
    const PIN_ATTEMPT_TTL_MS = 10 * 60 * 1000;
    const PIN_ATTEMPT_MAX_KEYS = readFiniteInteger(process.env.PIN_ATTEMPT_MAX_KEYS, { fallback: 1000, min: 100, max: 100000 });
    const ROTATE_MESSAGES_MAX = readFiniteInteger(process.env.ROTATE_MESSAGES_MAX, { fallback: 20, min: 1, max: 500 });

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
            pinAttempts: getPinAttemptStats()
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

    app.post("/auth/logout", auth.requirePin, auth.requireCsrf, (req, res) => {
        setNoStore(res);
        res.setHeader("Set-Cookie", auth.clearSessionCookieHeaders(auth.isProduction()));
        return res.status(200).json({ success: true });
    });

    // ── Health / Ping ──
    app.get("/ping", (req, res) => res.status(200).send("OK"));
    const sendReadiness = (req, res) => {
        const payload = buildReadinessPayload({
            client,
            sessionManager,
            voiceWorker,
            commandsReady,
            featureFlags: getFeatureFlags(),
            verification: getVerificationDiagnostics()
        });
        return res.status(payload.ready ? 200 : 503).json(payload);
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
                serializeVoiceSession,
                getSessionToken: sessionId => getSessionTokenSafe(sessionManager, sessionId)
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

    app.get("/api/logs", (req, res) => {
        res.json(webLogs.slice(-MAX_LOGS).reverse());
    });

    // ── Delegate Subsystem Routes ──
    registerVoiceRoutes({
        app,
        express,
        config,
        sessionManager,
        voiceWorker,
        client,
        checkAuth
    });

    registerAdminRoutes({
        app,
        express,
        sessionManager,
        voiceWorker,
        commands,
        client,
        checkAuth,
        disabledCommands,
        commandAuditLog,
        toggleCooldowns,
        startRotateTimer,
        ROTATE_MESSAGES_MAX
    });

    registerDatabaseRoutes({
        app,
        express,
        checkAuth
    });

    const shadowPortal = registerShadowPortal({ setupTelemetryRouter, app, client });

    app.use((err, req, res, next) => {
        console.error(`[HTTP] ❌ ${req.method} ${req.path} failed: ${err.message}`);
        if (res.headersSent) return next(err);
        return res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" });
    });

    const pinAttemptCleanupTimer = setInterval(() => {
        cleanupPinAttempts();
    }, 5 * 60 * 1000);

    pinAttemptCleanupTimer.unref?.();

    return {
        shadowPortalRegistered: shadowPortal.registered === true,
        stop() {
            clearInterval(pinAttemptCleanupTimer);
        }
    };
}

module.exports = {
    registerRoutes,
    logIntrusion,
    makeCheckAuth,
    registerShadowPortal,
    buildEnvReadiness,
    _test: {
        buildReadinessPayload,
        ...adminTest,
        ...voiceTest
    }
};
