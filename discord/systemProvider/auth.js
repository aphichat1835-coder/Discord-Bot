"use strict";

const crypto = require("node:crypto");
const { escapeHtml, safeStyleContent } = require("./htmlUtils");

const MAIN_SESSION_COOKIE = "__da_session";
const MAIN_CSRF_COOKIE = "__da_csrf";
const DEFAULT_BRUTE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_KEYS = 1000;

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

function setPortalSecurityHeaders(res) {
    res.setHeader?.("Cache-Control", "no-store, private");
    res.setHeader?.("Pragma", "no-cache");
    res.setHeader?.("Referrer-Policy", "no-referrer");
    res.setHeader?.("X-Frame-Options", "DENY");
}

function renderShadowBlockedPage(minutes) {
    const safeMinutes = Math.max(1, Number(minutes || 1) || 1);
    return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>⛔ Blocked</title><style>body{background:#0f0f13;color:#ef4444;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}</style></head><body><div><div style="font-size:3em;margin-bottom:12px;">⛔</div><b>ลองผิดเกินกำหนด</b><br>ล็อกอีก ${escapeHtml(safeMinutes)} นาที</div></body></html>`;
}

function renderPortalUnavailablePage() {
    return "<!DOCTYPE html><html lang=\"th\"><head><meta charset=\"UTF-8\"><title>Unavailable</title></head><body><p>ระบบควบคุมยังไม่พร้อมใช้งาน</p></body></html>";
}

function renderShadowLoginPage(showInvalidPin, shadowCss = "") {
    return `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>🔐 Dashboard ควบคุมบอท</title>
<style>${safeStyleContent(shadowCss)}</style>
</head><body>
<div class="login-wrap">
<div class="login-box">
    <div class="login-icon">🔐</div>
    <div class="login-title">DASHBOARD CONTROL</div>
    <div class="login-sub">ยืนยันตัวตนก่อนดำเนินการ</div>
    ${showInvalidPin ? '<p style="color:var(--red2);margin-bottom:10px;font-size:0.82em;">❌ รหัสผ่านไม่ถูกต้อง</p>' : ''}
    <form id="shadow-login-form" method="POST" autocomplete="off">
        <input type="password" name="pin" placeholder="🔑 กรอกรหัสผ่าน..." style="text-align:center;margin-bottom:14px;" autocomplete="current-password" required>
        <button type="submit" class="btn btn-danger">เข้าสู่ระบบ</button>
    </form>
    <p id="shadow-login-error" style="color:var(--red2);font-size:0.75em;margin-top:12px;" hidden></p>
</div>
</div>
<script>
(function(){
  function cookie(name){
    for(const part of String(document.cookie||'').split(';')){
      const idx=part.indexOf('='); if(idx<0) continue;
      if(part.slice(0,idx).trim()!==name) continue;
      try{return decodeURIComponent(part.slice(idx+1).trim());}catch{return '';}
    }
    return '';
  }
  const form=document.getElementById('shadow-login-form');
  const errorBox=document.getElementById('shadow-login-error');
  form?.addEventListener('submit',async event=>{
    event.preventDefault();
    const body=new URLSearchParams(new FormData(form));
    const response=await fetch('/api/v1/telemetry/snapshot/login',{
      method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded','x-csrf-token':cookie('${MAIN_CSRF_COOKIE}')},
      body:body.toString(),
      credentials:'same-origin'
    }).catch(()=>null);
    if(response?.ok){ window.location.replace('/api/v1/telemetry/snapshot'); return; }
    errorBox.hidden=false;
    errorBox.textContent=response?.status===429?'ลองผิดเกินกำหนด กรุณารอแล้วลองใหม่':'ไม่สามารถเข้าสู่ระบบได้';
  });
})();
</script>
</body></html>`;
}

function readNonEmptyPin(value) {
    if (value === undefined || value === null) return "";
    const pin = String(value).trim();
    return pin || "";
}

function readSecret(getCookieSecret) {
    try {
        return readNonEmptyPin(typeof getCookieSecret === "function" ? getCookieSecret() : "");
    } catch {
        return "";
    }
}

function readVersion(getSessionVersion) {
    try {
        const version = Number(typeof getSessionVersion === "function" ? getSessionVersion() : 1);
        return Number.isSafeInteger(version) && version > 0 ? version : 1;
    } catch {
        return 1;
    }
}

function timingSafePinEqual(providedPin, expectedPin) {
    const provided = readNonEmptyPin(providedPin);
    const expected = readNonEmptyPin(expectedPin);
    if (!provided || !expected) return false;
    const providedBuffer = Buffer.from(provided, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function readShadowPin(getPin) {
    try {
        return readNonEmptyPin(typeof getPin === "function" ? getPin() : "");
    } catch {
        return "";
    }
}

function sessionPayload({ issuedAt, nonce, version }) {
    return `shadow:${issuedAt}:${nonce}:${version}`;
}

function createShadowSessionToken({ getCookieSecret, getSessionVersion } = {}) {
    const secret = readSecret(getCookieSecret);
    if (!secret) return "";
    const issuedAt = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const version = readVersion(getSessionVersion);
    const sig = crypto.createHmac("sha256", secret)
        .update(sessionPayload({ issuedAt, nonce, version }))
        .digest("hex");
    return `${issuedAt}.${nonce}.${version}.${sig}`;
}

function verifyShadowSessionToken(token, { ttlMs, getCookieSecret, getSessionVersion } = {}) {
    if (!token || typeof token !== "string") return false;
    const [issuedAt, nonce, rawVersion, sig, ...extra] = token.split(".");
    if (extra.length || !issuedAt || !nonce || !rawVersion || !sig) return false;

    const issuedMs = Number.parseInt(issuedAt, 10);
    const version = Number(rawVersion);
    const maxAge = Number(ttlMs);
    if (!Number.isFinite(issuedMs) || !Number.isFinite(maxAge) || maxAge <= 0) return false;
    if (Date.now() - issuedMs > maxAge || issuedMs > Date.now() + 60_000) return false;
    if (!/^[a-f0-9]{32}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(sig)) return false;
    if (!Number.isSafeInteger(version) || version !== readVersion(getSessionVersion)) return false;

    const secret = readSecret(getCookieSecret);
    if (!secret) return false;
    const expected = crypto.createHmac("sha256", secret)
        .update(sessionPayload({ issuedAt, nonce, version }))
        .digest("hex");
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
}

function issueShadowSessionCookie(res, { cookieName, ttlMs, getCookieSecret, getSessionVersion }) {
    const token = createShadowSessionToken({ ttlMs, getCookieSecret, getSessionVersion });
    if (!token) return false;
    res.cookie(cookieName, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: String(process.env.NODE_ENV || "").trim() === "production",
        path: "/api/v1/telemetry/snapshot",
        maxAge: ttlMs
    });
    return true;
}

function clearShadowSessionCookie(res, cookieName) {
    const options = {
        httpOnly: true,
        sameSite: "strict",
        secure: String(process.env.NODE_ENV || "").trim() === "production",
        path: "/api/v1/telemetry/snapshot"
    };
    if (typeof res.clearCookie === "function") res.clearCookie(cookieName, options);
    else res.cookie?.(cookieName, "", { ...options, maxAge: 0 });
}

function shortHash(value) {
    return crypto.createHash("sha256").update(String(value || "unknown")).digest("hex").slice(0, 16);
}

function bruteKey(req) {
    const ip = String(req.ip || "unknown");
    const session = readCookie(req, MAIN_SESSION_COOKIE) || (req.authenticatedByServerSecret ? "server-secret" : "anonymous");
    const actor = String(req.authenticatedOwnerId || req.user?.id || "owner-boundary");
    return `${shortHash(ip)}:${shortHash(session)}:${shortHash(actor)}`;
}

function createShadowPortalAuth({
    cookieName,
    ttlMs,
    getPin,
    getCookieSecret,
    getSessionVersion,
    getRecoveryPin,
    isBreakGlassEnabled = () => false,
    shadowCss = "",
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    lockoutMs = DEFAULT_LOCKOUT_MS,
    bruteTtlMs = DEFAULT_BRUTE_TTL_MS,
    maxBruteKeys = DEFAULT_MAX_KEYS,
    onAuthEvent = null
} = {}) {
    const bruteGuard = new Map();

    function emit(event, req, extra = {}) {
        if (typeof onAuthEvent !== "function") return;
        try {
            onAuthEvent({ event, ipHash: shortHash(req?.ip), at: Date.now(), ...extra });
        } catch {
            // Authentication must not fail because a best-effort alert callback threw.
        }
    }

    function cleanup(now = Date.now()) {
        for (const [key, rec] of bruteGuard) {
            if (!rec || now - Number(rec.updatedAt || 0) > bruteTtlMs) bruteGuard.delete(key);
        }
        while (bruteGuard.size > maxBruteKeys) {
            const oldest = bruteGuard.keys().next().value;
            if (!oldest) break;
            bruteGuard.delete(oldest);
        }
    }

    function trackFailedPin(req, providedPin) {
        if (!readNonEmptyPin(providedPin)) return;
        cleanup();
        const key = bruteKey(req);
        const rec = bruteGuard.get(key) || { attempts: 0, lockUntil: 0, updatedAt: 0 };
        rec.attempts += 1;
        rec.updatedAt = Date.now();
        if (rec.attempts >= maxAttempts) {
            rec.lockUntil = Date.now() + lockoutMs;
            rec.attempts = 0;
        }
        bruteGuard.set(key, rec);
        cleanup();
    }

    function lockMinutes(req) {
        cleanup();
        const rec = bruteGuard.get(bruteKey(req));
        if (!rec || rec.lockUntil <= Date.now()) return 0;
        return Math.ceil((rec.lockUntil - Date.now()) / 60_000);
    }

    function configured() {
        return Boolean(readShadowPin(getPin) && readSecret(getCookieSecret));
    }

    function hasValidSession(req) {
        return verifyShadowSessionToken(readCookie(req, cookieName), {
            ttlMs,
            getCookieSecret,
            getSessionVersion
        });
    }

    function authorize(req, res, _body, providedPin) {
        setPortalSecurityHeaders(res);
        if (!configured()) {
            res.status(503).send(renderPortalUnavailablePage());
            emit("disabled", req);
            return false;
        }

        if (hasValidSession(req)) return true;

        const blockedMinutes = lockMinutes(req);
        if (blockedMinutes > 0) {
            res.status(429).send(renderShadowBlockedPage(blockedMinutes));
            emit("locked", req, { blockedMinutes });
            return false;
        }

        const candidate = readNonEmptyPin(providedPin);
        if (!candidate) {
            res.status(401).send(renderShadowLoginPage(false, shadowCss));
            return false;
        }

        const shadowPin = readShadowPin(getPin);
        const recoveryEnabled = Boolean(typeof isBreakGlassEnabled === "function" && isBreakGlassEnabled());
        const recoveryPin = recoveryEnabled && typeof getRecoveryPin === "function"
            ? readNonEmptyPin(getRecoveryPin())
            : "";
        const validPin = timingSafePinEqual(candidate, shadowPin) || timingSafePinEqual(candidate, recoveryPin);

        if (validPin && issueShadowSessionCookie(res, {
            cookieName,
            ttlMs,
            getCookieSecret,
            getSessionVersion
        })) {
            bruteGuard.delete(bruteKey(req));
            emit(recoveryPin && timingSafePinEqual(candidate, recoveryPin) ? "break_glass_success" : "login_success", req);
            return true;
        }

        trackFailedPin(req, candidate);
        emit("login_failure", req);
        const remainingLock = lockMinutes(req);
        if (remainingLock > 0) {
            res.status(429).send(renderShadowBlockedPage(remainingLock));
            return false;
        }
        res.status(401).send(renderShadowLoginPage(true, shadowCss));
        return false;
    }

    function logout(res) {
        setPortalSecurityHeaders(res);
        clearShadowSessionCookie(res, cookieName);
    }

    return {
        authorize,
        hasValidSession,
        configured,
        logout,
        cleanup,
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
    clearShadowSessionCookie,
    readCookie,
    renderShadowBlockedPage,
    renderShadowLoginPage,
    renderPortalUnavailablePage,
    setPortalSecurityHeaders,
    timingSafePinEqual,
    _test: {
        escapeHtml,
        readNonEmptyPin,
        timingSafePinEqual,
        readShadowPin,
        bruteKey,
        shortHash
    }
};
