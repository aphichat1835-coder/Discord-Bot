"use strict";

const path = require("node:path");
const rateLimitImport = require("express-rate-limit");
const ownerAuth = require("../index/auth");
const oauthRoutes = require("./routes/oauth");
const guildRoutes = require("./routes/guild");
const guildDashboardRoutes = require("./routes/guildDashboard");
const { createOAuthStartHandler } = require("./routes/oauthStart");
const { verificationHomePage } = require("./page");
const { verificationGuildPage } = require("./guildPage");
const {
    getVerificationDiagnostics,
    runVerificationMaintenance
} = require("./lifecycle");

const rateLimit = rateLimitImport.rateLimit || rateLimitImport.default || rateLimitImport;

function ownerGuilds(client) {
    return Array.from(client?.guilds?.cache?.values?.() || []).map(guild => ({
        id: String(guild.id),
        name: guild.name || String(guild.id),
        icon: guild.icon || null,
        memberCount: Number.isFinite(Number(guild.memberCount)) ? Number(guild.memberCount) : null,
        owner: true,
        isOwner: true,
        isAdmin: true,
        canManage: true,
        canManageGuild: true,
        canManageRoles: true,
        permissions: "8"
    }));
}

function ownerContext(client) {
    return (req, _res, next) => {
        const cookies = ownerAuth.parseCookies(req);
        const localPinBypass = !ownerAuth.PIN() && !ownerAuth.isProduction();
        req.verificationOwner = localPinBypass ||
            ownerAuth.verifyToken(cookies[ownerAuth.COOKIE_NAME]);
        req.verificationGuilds = req.verificationOwner ? ownerGuilds(client) : [];
        next();
    };
}

function serveGuildPage(req, res) {
    const guildId = String(req.params?.guildId || "");
    const guilds = Array.isArray(req.verificationGuilds) ? req.verificationGuilds : [];
    const canManage = /^\d{17,22}$/.test(guildId) &&
        guilds.some(guild => String(guild.id) === guildId);
    if (!canManage) return res.redirect(302, "/verification");
    return res.send(verificationGuildPage());
}

function verificationReadyMiddleware(sessionManager) {
    return (_req, res, next) => {
        const db = sessionManager.getDatabaseStatus?.();
        const verification = getVerificationDiagnostics();
        if (db?.connected !== true || verification.ready !== true) {
            return res.status(503).json({
                success: false,
                code: "verification_not_ready",
                error: "ระบบยืนยันกำลังเริ่มทำงาน กรุณาลองใหม่อีกครั้ง"
            });
        }
        return next();
    };
}

function createVerificationRateLimiter({ limit = 20, responseType = "json" } = {}) {
    return rateLimit({
        windowMs: 60 * 1000,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => {
            if (responseType === "text") {
                return res.status(429).send("มีการเริ่มยืนยันถี่เกินไป กรุณารอสักครู่แล้วลองใหม่");
            }
            return res.status(429).json({
                success: false,
                code: "rate_limited",
                error: "มีการยืนยันถี่เกินไป กรุณารอสักครู่แล้วลองใหม่"
            });
        }
    });
}

function registerVerificationRuntime({ app, express, client, sessionManager }) {
    const publicRoot = path.join(__dirname, "public");
    const callbackLimiter = createVerificationRateLimiter({ limit: 20 });
    const authStartLimiter = createVerificationRateLimiter({ limit: 12, responseType: "text" });
    const requireVerificationReady = verificationReadyMiddleware(sessionManager);

    app.use("/verification-assets", express.static(publicRoot, {
        etag: true,
        maxAge: process.env.STATIC_CACHE_MAX_AGE || "10m"
    }));

    app.get(
        "/auth/start",
        authStartLimiter,
        requireVerificationReady,
        createOAuthStartHandler()
    );
    app.post("/auth/callback", callbackLimiter, requireVerificationReady);
    app.use(oauthRoutes);

    const attachOwner = ownerContext(client);
    app.get("/guilds", ownerAuth.requirePin, (_req, res) => {
        res.redirect(302, "/verification");
    });
    app.get("/guild/:guildId", ownerAuth.requirePin, attachOwner, (req, res) => {
        return serveGuildPage(req, res);
    });
    app.get("/verification", ownerAuth.requirePin, attachOwner, (_req, res) => {
        res.send(verificationHomePage());
    });
    app.use(attachOwner, guildDashboardRoutes, guildRoutes);

    app.get("/api/verification/diagnostics", ownerAuth.requirePin, attachOwner, (_req, res) => {
        res.json({ success: true, verification: getVerificationDiagnostics() });
    });
    app.post(
        "/api/verification/retention/dry-run",
        ownerAuth.requirePin,
        ownerAuth.requireCsrf,
        attachOwner,
        async (_req, res) => {
            try {
                const summary = await runVerificationMaintenance({ dryRun: true });
                res.json({ success: true, summary });
            } catch (err) {
                res.status(500).json({ success: false, error: err?.message || "maintenance_failed" });
            }
        }
    );
}

module.exports = {
    registerVerificationRuntime,
    ownerGuilds,
    ownerContext,
    serveGuildPage,
    serveLegacyGuildPage: serveGuildPage,
    createVerificationRateLimiter,
    verificationReadyMiddleware
};