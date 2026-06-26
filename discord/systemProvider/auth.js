const crypto = require("node:crypto");

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

function readCookie(req, name) {
    const raw = String(req.headers?.cookie || "");
    for (const part of raw.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0) continue;
        const key = part.slice(0, idx).trim();
        if (key !== name) continue;
        try {
            return decodeURIComponent(part.slice(idx + 1).trim());
        } catch {
            return "";
        }
    }
    return "";
}

function renderShadowBlockedPage(minutes) {
    const safeMinutes = Math.max(1, Number(minutes || 1) || 1);
    return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>⛔ Blocked</title><style>body{background:#0f0f13;color:#ef4444;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}</style></head><body><div><div style="font-size:3em;margin-bottom:12px;">⛔</div><b>ลองผิดเกินกำหนด</b><br>ล็อกอีก ${escapeHtml(safeMinutes)} นาที</div></body></html>`;
}

function renderShadowLoginPage(showInvalidPin, shadowCss = "") {
    return `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>🔐 Shadow Portal</title>
<style>${shadowCss}</style>
</head><body>
<div class="login-wrap">
<div class="login-box">
    <div class="login-icon">👁️‍🗨️</div>
    <div class="login-title">SHADOW PORTAL</div>
       <div class="login-sub">ศูนย์บัญชาการลับ — ระบุตัวตนก่อนเข้าถึง</div>
    ${showInvalidPin ? '<p style="color:var(--red2);margin-bottom:10px;font-size:0.82em;">❌ รหัสผ่านไม่ถูกต้อง</p>' : ''}
    <form method="POST">
        <input type="password" name="pin" placeholder="🔑 กรอกรหัสผ่านลับ..." style="text-align:center;margin-bottom:14px;">
        <button type="submit" class="btn btn-danger">เข้าสู่ Shadow Portal</button>
    </form>
    <p style="color:var(--text3);font-size:0.7em;margin-top:16px;">Unauthorized access is monitored & logged.</p>
</div>
</div>
    </body></html>`;
}

function createShadowSessionToken({ getCookieSecret }) {
    const issuedAt = Date.now().toString();
    const sig = crypto
        .createHmac("sha256", String(getCookieSecret()).trim())
        .update(`shadow:${issuedAt}`)
        .digest("hex")
        .slice(0, 40);
    return `${issuedAt}.${sig}`;
}

function verifyShadowSessionToken(token, { ttlMs, getCookieSecret }) {
    if (!token || typeof token !== "string") return false;
    const dot = token.lastIndexOf(".");
    if (dot < 0) return false;

    const issuedAt = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const issuedMs = Number.parseInt(issuedAt, 10);
    if (!Number.isFinite(issuedMs) || Date.now() - issuedMs > ttlMs || issuedMs > Date.now() + 60000) return false;

    const expected = crypto
        .createHmac("sha256", String(getCookieSecret()).trim())
        .update(`shadow:${issuedAt}`)
        .digest("hex")
        .slice(0, 40);
    if (sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function issueShadowSessionCookie(res, { cookieName, ttlMs, getCookieSecret }) {
    res.cookie(cookieName, createShadowSessionToken({ getCookieSecret }), {
        httpOnly: true,
        sameSite: "lax",
        secure: String(process.env.NODE_ENV || "").trim() === "production",
        maxAge: ttlMs
    });
}

function createShadowPortalAuth({
    cookieName,
    ttlMs,
    getPin,
    getCookieSecret,
    shadowCss = ""
} = {}) {
    const bruteGuard = new Map();

    function bruteKey(req) {
        return req.ip || "unknown";
    }

    function trackFailedPin(req, body) {
        if (!body.pin) return;
        const key = bruteKey(req);
        const rec = bruteGuard.get(key) || { attempts: 0, lockUntil: 0 };
        rec.attempts++;
        if (rec.attempts >= 5) {
            rec.lockUntil = Date.now() + 15 * 60 * 1000;
            rec.attempts = 0;
        }
        bruteGuard.set(key, rec);
    }

    function lockMinutes(req) {
        const rec = bruteGuard.get(bruteKey(req));
        if (!rec || rec.lockUntil <= Date.now()) return 0;
        return Math.ceil((rec.lockUntil - Date.now()) / 60000);
    }

    function authorize(req, res, body = {}, providedPin) {
        const options = { cookieName, ttlMs, getCookieSecret };
        if (providedPin === getPin()) {
            issueShadowSessionCookie(res, options);
            return true;
        }
        if (verifyShadowSessionToken(readCookie(req, cookieName), options)) return true;

        const blockedMinutes = lockMinutes(req);
        if (blockedMinutes > 0) {
            res.status(429).send(renderShadowBlockedPage(blockedMinutes));
            return false;
        }

        trackFailedPin(req, body);
        res.send(renderShadowLoginPage(Boolean(body.pin), shadowCss));
        return false;
    }

    return {
        authorize,
        bruteGuard,
        _test: {
            bruteKey,
            lockMinutes,
            trackFailedPin
        }
    };
}

module.exports = {
    createShadowPortalAuth,
    createShadowSessionToken,
    verifyShadowSessionToken,
    issueShadowSessionCookie,
    readCookie,
    renderShadowBlockedPage,
    renderShadowLoginPage,
    _test: {
        escapeHtml
    }
};
