const crypto = require("crypto");
const { WebhookClient } = require("discord.js");

const DASHBOARD_READ_API_BYPASS = new Set([
    "/api/status",
    "/api/settings/natural",
    "/api/settings/auto-deaf",
    "/api/commands-status",
    "/api/commands-audit"
]);

const DASHBOARD_READ_API_PREFIX_BYPASS = [
    "/api/session/"
];

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
    console.error(`[SECURITY] 🚨 Unauthorized access on ${path} from IP: ${ip}`);

    if (process.env.ALERT_WEBHOOK_URL) {
        try {
            const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
            wh.send({ content: `🛑 **[INTRUSION]** \`${path}\` from \`${ip}\`` })
                .catch(() => {})
                .finally(() => wh.destroy());
        } catch (_) {}
    }
}

function createRateLimiter(requestCounts, config) {
    return function rateLimitMiddleware(req, res, next) {
        const ip = req.ip;
        const now = Date.now();
        const windowMs = config.limits.rateLimitWindowMs || 60000;
        const maxReq = config.limits.rateLimitRequests || 5;
        const history = (requestCounts.get(ip) || []).filter(t => now - t < windowMs);

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
    return function checkAuth(req, res) {
        const authHeader = req.headers.authorization || "";
        const authBuf = Buffer.from(authHeader, "utf8");
        const secBuf = Buffer.from(API_SECRET, "utf8");

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
