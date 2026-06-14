const crypto = require("node:crypto");
const { sendLogWebhook } = require("../core/webhooks");
const safeLogger = require("../core/safeLogger");
const dashboardAuth = require("../index/auth");

const DASHBOARD_READ_API_BYPASS = new Set([]);

const DASHBOARD_READ_API_PREFIX_BYPASS = [];

const revealTokenAttempts = new Map();
const REVEAL_MAX = 5;
const REVEAL_LOCKOUT = 15 * 60 * 1000;

function shouldBypassDashboardReadApi(req) {
    if (req.method !== "GET") return false;

    const fullPath = `${req.baseUrl || ""}${req.path || ""}`;
    return DASHBOARD_READ_API_BYPASS.has(fullPath) ||
        DASHBOARD_READ_API_PREFIX_BYPASS.some(prefix => fullPath.startsWith(prefix));
}

function logIntrusion(ip, path) {
    safeLogger.warn("dashboard_unauthorized_access", { path, ip });

    sendLogWebhook({ content: `🛑 **[INTRUSION]** \`${path}\` from \`${ip}\`` }).catch(() => {});
}

function createRateLimiter(requestCounts, config, sessionManager = null) {
    return function rateLimitMiddleware(req, res, next) {
        const ip = req.ip;
        const now = Date.now();
        const windowMs = config.limits.rateLimitWindowMs || 60000;
        const dynamicMaxReq = Number(sessionManager?.getCachedSetting?.("rateLimitRequests", config.limits.rateLimitRequests));
        const maxReq = Number.isFinite(dynamicMaxReq) && dynamicMaxReq > 0
            ? dynamicMaxReq
            : config.limits.rateLimitRequests || 5;
        const history = (requestCounts.get(ip) || []).filter(t => now - t < windowMs);

        // Expired buckets are also pruned by discord/index/system.js; this keeps
        // the write path from retaining an empty stale bucket before reusing it.
        if (!history.length) requestCounts.delete(ip);

        history.push(now);
        requestCounts.set(ip, history);

        if (history.length > maxReq) {
            logIntrusion(ip, req.path);
            return res.status(429).json({ error: "Too Many Requests" });
        }

        next();
    };
}

function makeCheckAuth(API_SECRET) {
    const configuredSecret = typeof API_SECRET === "string" ? API_SECRET : "";

    return function checkAuth(req, res) {
        if (!dashboardAuth.PIN()) return true;

        if (!configuredSecret) {
            safeLogger.error("dashboard_api_secret_missing", { path: req.path });
            res.status(500).json({ success: false, error: "Server auth is not configured" });
            return false;
        }

        const cookies = dashboardAuth.parseCookies(req);
        if (dashboardAuth.verifyToken(cookies[dashboardAuth.COOKIE_NAME])) {
            return true;
        }

        const authHeader = req.headers.authorization || "";
        const authBuf = Buffer.from(authHeader, "utf8");
        const secBuf = Buffer.from(configuredSecret, "utf8");

        if (authBuf.length !== secBuf.length) {
            logIntrusion(req.ip, req.path);
            res.status(401).json({ success: false, error: "Unauthorized" });
            return false;
        }

        if (!crypto.timingSafeEqual(authBuf, secBuf)) {
            logIntrusion(req.ip, req.path);
            res.status(401).json({ success: false, error: "Unauthorized" });
            return false;
        }

        return true;
    };
}

function makeCheckRevealPin(getWebPin) {
    return function checkRevealPin(req, res) {
        const ip = req.ip;
        const now = Date.now();
        const rec = revealTokenAttempts.get(ip) || { count: 0, lockedUntil: 0 };

        if (rec.lockedUntil > now) {
            const mins = Math.ceil((rec.lockedUntil - now) / 60000);
            res.status(429).json({ success: false, error: `ลองผิดเกินกำหนด ล็อค ${mins} นาที` });
            return null;
        }

        const { pin } = req.body || {};
        const webPin = (typeof getWebPin === "function") ? getWebPin() : null;

        if (!webPin || pin !== webPin) {
            rec.count = (rec.count || 0) + 1;

            if (rec.count >= REVEAL_MAX) {
                rec.lockedUntil = now + REVEAL_LOCKOUT;
                rec.count = 0;
            }

            revealTokenAttempts.set(ip, rec);
            logIntrusion(ip, req.path);
            res.status(401).json({ success: false, error: "PIN ไม่ถูกต้อง" });
            return null;
        }

        revealTokenAttempts.delete(ip);
        return true;
    };
}

function cleanupRevealAttempts(now = Date.now()) {
    for (const [ip, rec] of revealTokenAttempts.entries()) {
        if (rec.lockedUntil > 0 && rec.lockedUntil < now) {
            revealTokenAttempts.delete(ip);
        }
    }
}

module.exports = {
    DASHBOARD_READ_API_BYPASS,
    DASHBOARD_READ_API_PREFIX_BYPASS,
    revealTokenAttempts,
    shouldBypassDashboardReadApi,
    createRateLimiter,
    makeCheckAuth,
    makeCheckRevealPin,
    logIntrusion,
    cleanupRevealAttempts
};
