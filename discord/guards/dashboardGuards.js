const crypto = require("node:crypto");
const { sendWebhookEvent } = require("../core/webhooks");
const safeLogger = require("../core/safeLogger");
const dashboardAuth = require("../index/auth");

const DASHBOARD_READ_API_BYPASS = new Set([]);

const DASHBOARD_READ_API_PREFIX_BYPASS = [];

const revealTokenAttempts = new Map();
const REVEAL_MAX = 5;
const REVEAL_LOCKOUT = 15 * 60 * 1000;
const REVEAL_ATTEMPT_TTL = 30 * 60 * 1000;
const REVEAL_ATTEMPT_MAX_KEYS = 1000;
const RATE_LIMIT_MAX_BUCKETS = Math.max(100, Number(process.env.RATE_LIMIT_MAX_BUCKETS || 5000) || 5000);

function safeDiscordInlineCode(value, maxLength = 180) {
    return String(value || "unknown")
        .replace(/[\r\n\t]+/g, " ")
        .replaceAll("`", "ˋ")
        .replaceAll("\\", "\\\\")
        .slice(0, Math.max(1, Number(maxLength) || 180));
}

function safeDiscordSummaryText(value, maxLength = 180) {
    return String(value || "unknown")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/([\\`*_{}[\]()#+\-.!|>~])/g, String.raw`\$1`)
        .slice(0, Math.max(1, Number(maxLength) || 180));
}

function getRequestPath(req) {
    const originalUrl = String(req?.originalUrl || "").split("?", 1)[0];
    if (originalUrl) return originalUrl.slice(0, 180);
    return `${req?.baseUrl || ""}${req?.path || ""}`.slice(0, 180) || "unknown";
}

function shouldBypassDashboardReadApi(req) {
    if (req.method !== "GET") return false;

    const fullPath = `${req.baseUrl || ""}${req.path || ""}`;
    return DASHBOARD_READ_API_BYPASS.has(fullPath) ||
        DASHBOARD_READ_API_PREFIX_BYPASS.some(prefix => fullPath.startsWith(prefix));
}

function logIntrusion(ip, path, reason = "blocked request") {
    safeLogger.warn("dashboard_request_blocked", { path, ip, reason });
    const rawPath = String(path || "unknown").slice(0, 180);
    const rawIp = String(ip || "unknown").slice(0, 120);
    const safePath = safeDiscordInlineCode(rawPath, 180);
    const safeIp = safeDiscordInlineCode(rawIp, 120);
    const secret = dashboardAuth.getApiSecret() || "dashboard-intrusion";
    const dedupeKey = crypto.createHmac("sha256", secret)
        .update(`${rawIp}|${reason}`)
        .digest("hex");

    const revealPinLocked = reason === "token reveal PIN locked";
    sendWebhookEvent({
        target: revealPinLocked ? "ALERT" : "LOG",
        severity: revealPinLocked ? "ERROR" : "WARNING",
        category: "SECURITY",
        code: revealPinLocked ? "security.token_reveal.pin_locked" : "security.dashboard.rate_limited",
        state: revealPinLocked ? "OPEN" : undefined,
        title: revealPinLocked ? "ล็อกการเปิดเผย Token ชั่วคราว" : "Dashboard ปฏิเสธคำขอที่ถี่เกินกำหนด",
        description: revealPinLocked
            ? "มีการกรอก PIN ผิดครบจำนวน ระบบจึงล็อกการเปิดเผย Token ชั่วคราว"
            : "Rate Limiter ปฏิเสธคำขอเพื่อป้องกันการใช้งานถี่ผิดปกติ",
        impact: revealPinLocked ? "ไม่สามารถเปิดเผย Token ผ่าน Dashboard ได้ระหว่างถูกล็อก" : undefined,
        action: revealPinLocked ? "ตรวจว่าเป็นการใช้งานของเจ้าของ แล้วรอให้ระยะล็อกสิ้นสุด" : undefined,
        context: {
            "เส้นทาง": safePath,
            "IP": safeIp,
            "สาเหตุ": safeDiscordSummaryText(reason, 80)
        },
        dedupeKey: `dashboard-blocked:${dedupeKey}`,
        dedupeMs: 15 * 60 * 1000,
        summaryLabel: `Dashboard ปฏิเสธคำขอจาก ${safeDiscordSummaryText(rawIp, 80)}`
    }).catch(() => {});
}

function logAuthRejected(req) {
    safeLogger.warn("dashboard_auth_rejected", { path: getRequestPath(req), ip: req?.ip });
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
        if (requestCounts.size > RATE_LIMIT_MAX_BUCKETS) {
            trimRateLimitBuckets(requestCounts, now, windowMs);
        }

        if (history.length > maxReq) {
            logIntrusion(ip, getRequestPath(req), "rate limit exceeded");
            return res.status(429).json({ error: "Too Many Requests" });
        }

        next();
    };
}

function trimRateLimitBuckets(requestCounts, now = Date.now(), windowMs = 60000) {
    for (const [key, timestamps] of requestCounts.entries()) {
        const active = Array.isArray(timestamps)
            ? timestamps.filter(t => now - Number(t || 0) < windowMs)
            : [];

        if (active.length) requestCounts.set(key, active);
        else requestCounts.delete(key);
    }

    while (requestCounts.size > RATE_LIMIT_MAX_BUCKETS) {
        const oldestKey = requestCounts.keys().next().value;
        if (!oldestKey) break;
        requestCounts.delete(oldestKey);
    }
}

function readAuthorizationSecret(req) {
    return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

function safeSecretEqual(provided, expected) {
    if (typeof provided !== "string" || typeof expected !== "string") return false;

    const providedBuffer = Buffer.from(provided, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");

    return providedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(providedBuffer, expectedBuffer);
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

        const authHeader = readAuthorizationSecret(req);
        const authBuf = Buffer.from(authHeader, "utf8");
        const secBuf = Buffer.from(configuredSecret, "utf8");

        if (authBuf.length !== secBuf.length) {
            logAuthRejected(req);
            res.status(401).json({ success: false, error: "Unauthorized" });
            return false;
        }

        if (!crypto.timingSafeEqual(authBuf, secBuf)) {
            logAuthRejected(req);
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

        if (rec.updatedAt && now - rec.updatedAt > REVEAL_ATTEMPT_TTL) {
            rec.count = 0;
            rec.lockedUntil = 0;
        }

        if (rec.lockedUntil > now) {
            const mins = Math.ceil((rec.lockedUntil - now) / 60000);
            res.status(429).json({ success: false, error: `ลองผิดเกินกำหนด ล็อค ${mins} นาที` });
            return null;
        }

        const { pin } = req.body || {};
        const webPin = (typeof getWebPin === "function") ? getWebPin() : null;

        if (!webPin || !safeSecretEqual(pin, webPin)) {
            rec.count = (rec.count || 0) + 1;

            const reachedLimit = rec.count >= REVEAL_MAX;
            if (reachedLimit) {
                rec.lockedUntil = now + REVEAL_LOCKOUT;
                rec.count = 0;
            }

            rec.updatedAt = now;
            revealTokenAttempts.set(ip, rec);
            trimRevealAttempts(now);
            if (reachedLimit) {
                logIntrusion(ip, getRequestPath(req), "token reveal PIN locked");
            }
            res.status(401).json({ success: false, error: "PIN ไม่ถูกต้อง" });
            return null;
        }

        revealTokenAttempts.delete(ip);
        return true;
    };
}

function trimRevealAttempts(now = Date.now()) {
    for (const [ip, rec] of revealTokenAttempts.entries()) {
        const staleUnlocked = !rec.lockedUntil && (!rec.updatedAt || now - rec.updatedAt > REVEAL_ATTEMPT_TTL);
        const expiredLock = rec.lockedUntil > 0 && rec.lockedUntil < now;
        if (staleUnlocked || expiredLock) {
            revealTokenAttempts.delete(ip);
        }
    }

    while (revealTokenAttempts.size > REVEAL_ATTEMPT_MAX_KEYS) {
        const oldestKey = revealTokenAttempts.keys().next().value;
        if (!oldestKey) break;
        revealTokenAttempts.delete(oldestKey);
    }
}

function cleanupRevealAttempts(now = Date.now()) {
    trimRevealAttempts(now);
}

function getRevealAttemptStats() {
    return {
        tracked: revealTokenAttempts.size,
        maxKeys: REVEAL_ATTEMPT_MAX_KEYS,
        ttlMs: REVEAL_ATTEMPT_TTL,
        lockoutMs: REVEAL_LOCKOUT
    };
}

function getRateLimitStats(requestCounts) {
    return {
        buckets: requestCounts?.size || 0,
        maxBuckets: RATE_LIMIT_MAX_BUCKETS
    };
}

module.exports = {
    DASHBOARD_READ_API_BYPASS,
    DASHBOARD_READ_API_PREFIX_BYPASS,
    revealTokenAttempts,
    shouldBypassDashboardReadApi,
    createRateLimiter,
    readAuthorizationSecret,
    safeSecretEqual,
    makeCheckAuth,
    makeCheckRevealPin,
    logIntrusion,
    safeDiscordInlineCode,
    safeDiscordSummaryText,
    getRequestPath,
    cleanupRevealAttempts,
    getRevealAttemptStats,
    trimRateLimitBuckets,
    getRateLimitStats
};
