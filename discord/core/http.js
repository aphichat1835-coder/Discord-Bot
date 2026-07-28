"use strict";

const { getReleaseIdentity } = require("./releaseIdentity");
const { installShutdownCoordinator } = require("./runtimeLifecycle");

// Install the best-effort shutdown contract before index.js registers process
// handlers. The installer is idempotent and does not attach signals by itself.
installShutdownCoordinator();

function applySecurityHeaders(req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
}

function applySensitiveResponseHeaders(req, res, next) {
    const requestPath = String(req.path || req.originalUrl || "").split("?", 1)[0];
    const sensitive = requestPath === "/api" ||
        requestPath.startsWith("/api/") ||
        requestPath === "/auth" ||
        requestPath.startsWith("/auth/");

    if (sensitive) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
    }
    next();
}

function buildHealthPayload(options = {}) {
    const shuttingDown = options.shuttingDown ?? (global.__APP_SHUTTING_DOWN === true);
    return {
        status: shuttingDown ? "stopping" : "ok",
        healthy: !shuttingDown,
        timestamp: options.timestamp ?? Date.now(),
        uptimeSec: options.uptimeSec ?? Math.floor(process.uptime()),
        release: options.release || getReleaseIdentity(options.env)
    };
}

function buildStoppingReadinessPayload(options = {}) {
    return {
        status: "stopping",
        ready: false,
        botOnline: false,
        bot: false,
        dbConnected: false,
        db: false,
        voiceReady: false,
        verificationReady: false,
        commandsReady: false,
        release: options.release || getReleaseIdentity(options.env)
    };
}

const HEALTH_ROUTE_GUARD = Symbol("health-route-guard");

function registerHealthRoute(app) {
    if (typeof app?.get !== "function" || app[HEALTH_ROUTE_GUARD]) return false;
    app.get("/health", (_req, res) => {
        const payload = buildHealthPayload();
        return res.status(payload.healthy ? 200 : 503).json(payload);
    });
    app[HEALTH_ROUTE_GUARD] = true;
    return true;
}

function applyReadinessShutdownGuard(req, res, next) {
    if (req.path !== "/ready" || global.__APP_SHUTTING_DOWN !== true) return next();
    return res.status(503).json(buildStoppingReadinessPayload());
}

function createHttpApp(express, options = {}) {
    const app = express();
    const jsonLimit = options.jsonLimit || "64kb";
    const urlencodedLimit = options.urlencodedLimit || "64kb";

    if (Object.hasOwn(options, "trustProxy")) {
        app.set("trust proxy", options.trustProxy);
    }

    app.disable("x-powered-by");
    app.use(applySecurityHeaders);
    app.use(applySensitiveResponseHeaders);
    registerHealthRoute(app);
    app.use(applyReadinessShutdownGuard);
    app.use(express.json({ limit: jsonLimit }));
    app.use(express.urlencoded({ extended: true, limit: urlencodedLimit }));

    return app;
}

module.exports = {
    applySecurityHeaders,
    applySensitiveResponseHeaders,
    applyReadinessShutdownGuard,
    buildHealthPayload,
    buildStoppingReadinessPayload,
    registerHealthRoute,
    createHttpApp
};