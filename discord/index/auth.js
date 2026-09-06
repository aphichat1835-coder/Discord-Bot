/*
 * PIN Gate สำหรับ Main Dashboard (Service 1)
 * ใช้ DASHBOARD_PIN env var — production ต้องตั้งค่าเสมอ
 * Cookie ลงนามด้วย HMAC-SHA256 / API_SECRET
 */
const crypto = require('node:crypto');

const COOKIE_NAME = '__da';
const CSRF_COOKIE_NAME = '__da_csrf';
const PIN         = () => process.env.DASHBOARD_PIN;
const DEFAULT_MAX_AGE_MS = 24 * 3600 * 1000; // 24 ชั่วโมง
const MIN_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function getApiSecret() {
    return String(process.env.API_SECRET || '').trim();
}

function requireApiSecret() {
    const secret = getApiSecret();
    if (!secret) {
        throw new Error('API_SECRET is required for dashboard auth.');
    }
    return secret;
}

function isProduction() {
    return String(process.env.NODE_ENV || '').trim() === 'production';
}

function readDurationMs(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function getSessionMaxAgeMs() {
    return readDurationMs(process.env.DASHBOARD_SESSION_MAX_AGE_MS, DEFAULT_MAX_AGE_MS, {
        min: MIN_MAX_AGE_MS,
        max: MAX_MAX_AGE_MS
    });
}

function getSessionRefreshAfterMs() {
    const maxAge = getSessionMaxAgeMs();
    const fallback = Math.min(30 * 60 * 1000, Math.max(60 * 1000, Math.floor(maxAge / 4)));
    return readDurationMs(process.env.DASHBOARD_SESSION_REFRESH_AFTER_MS, fallback, {
        min: 60 * 1000,
        max: Math.max(60 * 1000, maxAge - 60 * 1000)
    });
}

// ── Parse cookies from header ──
function parseCookies(req) {
    const result = {};
    const raw    = req.headers.cookie || '';
    raw.split(';').forEach(c => {
        const idx = c.indexOf('=');
        if (idx < 0) return;
        try {
            const k = decodeURIComponent(c.slice(0, idx).trim());
            const v = decodeURIComponent(c.slice(idx + 1).trim());
            if (k) result[k] = v;
        } catch {
            // Ignore one malformed cookie instead of breaking the whole PIN gate.
        }
    });
    return result;
}

// ── Issue signed cookie value ──
function makeToken() {
    const ts  = Date.now().toString();
    const sig = crypto.createHmac('sha256', requireApiSecret()).update(ts).digest('hex').slice(0, 40);
    return `${ts}.${sig}`;
}

// ── Verify signed cookie value ──
function verifyToken(token) {
    if (!token || typeof token !== 'string') return false;
    try {
        const secret = getApiSecret();
        if (!secret) return false;
        const dot = token.lastIndexOf('.');
        if (dot < 0) return false;
        const ts  = token.slice(0, dot);
        const sig = token.slice(dot + 1);
        const issuedAt = Number.parseInt(ts, 10);
        if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > getSessionMaxAgeMs() || issuedAt > Date.now() + 60000) return false;
        const expected = crypto.createHmac('sha256', secret).update(ts).digest('hex').slice(0, 40);
        if (sig.length !== expected.length) return false;
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
}

function getTokenIssuedAt(token) {
    if (!verifyToken(token)) return 0;
    const dot = token.lastIndexOf('.');
    return Number.parseInt(token.slice(0, dot), 10) || 0;
}

function shouldRefreshToken(token) {
    const issuedAt = getTokenIssuedAt(token);
    return issuedAt > 0 && Date.now() - issuedAt >= getSessionRefreshAfterMs();
}

function makeCsrfToken(sessionToken) {
    if (!verifyToken(sessionToken)) return '';
    return crypto
        .createHmac('sha256', requireApiSecret())
        .update(`csrf:${sessionToken}`)
        .digest('hex');
}

function verifyCsrfToken(sessionToken, csrfToken) {
    if (!csrfToken || typeof csrfToken !== 'string') return false;
    const expected = makeCsrfToken(sessionToken);
    if (!expected || csrfToken.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(csrfToken), Buffer.from(expected));
}

// ── Set-Cookie header helper ──
function setCookieHeader(token, prod = isProduction()) {
    const maxAge = Math.floor(getSessionMaxAgeMs() / 1000);
    const flags  = `Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${prod ? '; Secure' : ''}`;
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; ${flags}`;
}

function setCsrfCookieHeader(token, prod = isProduction()) {
    const maxAge = Math.floor(getSessionMaxAgeMs() / 1000);
    const csrfToken = makeCsrfToken(token);
    const flags = `Max-Age=${maxAge}; Path=/; SameSite=Strict${prod ? '; Secure' : ''}`;
    return `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; ${flags}`;
}

function setSessionCookieHeaders(token, prod = isProduction()) {
    return [
        setCookieHeader(token, prod),
        setCsrfCookieHeader(token, prod)
    ];
}

function clearSessionCookieHeaders(prod = isProduction()) {
    const secure = prod ? '; Secure' : '';
    return [
        `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure}`,
        `${CSRF_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Strict${secure}`
    ];
}

function requireCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase())) return next();
    if (!PIN()) return next();
    if (req.authenticatedByServerSecret === true) return next();

    const cookies = parseCookies(req);
    const sessionToken = cookies[COOKIE_NAME];
    const csrfToken = String(req.headers['x-csrf-token'] || '').trim();

    if (!verifyCsrfToken(sessionToken, csrfToken)) {
        return res.status(403).json({
            success: false,
            error: 'CSRF token is missing or invalid'
        });
    }

    return next();
}

// ── Middleware: ถ้าไม่มี cookie ถูกต้อง → redirect PIN page ──
function requirePin(req, res, next) {
    if (!PIN()) {
        if (isProduction()) {
            return res.status(503).send('DASHBOARD_PIN is required in production.');
        }
        return next();
    }
    const cookies = parseCookies(req);
    if (verifyToken(cookies[COOKIE_NAME])) {
        if (shouldRefreshToken(cookies[COOKIE_NAME])) {
            res.setHeader('Set-Cookie', setSessionCookieHeaders(makeToken()));
        }
        return next();
    }
    const next_path = encodeURIComponent(req.originalUrl || '/');
    res.redirect(`/auth/pin?next=${next_path}`);
}

function escapeAttr(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── PIN entry page HTML ──
function pinPageHTML(error = false, next = '/') {
    return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="theme-color" content="#07050f"><meta name="color-scheme" content="dark">
<title>เข้าสู่ Owner Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI','Noto Sans Thai',sans-serif;background:#07050f;
       background-image:radial-gradient(ellipse at 20% 25%,rgba(124,58,237,.14) 0%,transparent 55%),
                        radial-gradient(ellipse at 80% 75%,rgba(168,85,247,.09) 0%,transparent 55%);
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;color:#ede9fe}
  .card{background:rgba(20,15,40,.9);border:1px solid rgba(120,80,255,.2);border-radius:22px;
        padding:48px 36px;width:100%;max-width:340px;text-align:center;
        box-shadow:0 24px 56px rgba(0,0,0,.6);backdrop-filter:blur(20px)}
  .icon{font-size:2.4rem;margin-bottom:16px}
  h1{font-size:1.25rem;font-weight:800;background:linear-gradient(135deg,#a855f7,#d8b4fe);
     -webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
  .sub{font-size:.8rem;color:rgba(255,255,255,.35);margin-bottom:28px;line-height:1.6}
  .err{font-size:.78rem;color:#f87171;margin-bottom:14px;
       background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);
       border-radius:8px;padding:8px 14px}
  .pin-wrap{position:relative;margin-bottom:16px}
  input[type=password]{width:100%;background:rgba(255,255,255,.05);color:#ede9fe;
    border:1px solid rgba(120,80,255,.25);padding:13px 16px;border-radius:12px;
    font-size:1.1rem;letter-spacing:6px;text-align:center;outline:none;
    font-family:monospace;transition:border-color .15s,box-shadow .15s}
  input[type=password]::placeholder{letter-spacing:normal;font-size:.85rem;color:rgba(255,255,255,.25)}
  input[type=password]:focus{border-color:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,.18)}
  button{width:100%;padding:13px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;
         border:none;border-radius:12px;font-size:.92rem;font-weight:700;cursor:pointer;
         transition:all .18s;font-family:inherit}
  button:hover{box-shadow:0 0 20px rgba(124,58,237,.45);transform:translateY(-1px)}
  button:active{transform:scale(.98)}
  :focus-visible{outline:3px solid rgba(216,180,254,.9);outline-offset:3px}
  button[aria-busy=true]{opacity:.72;cursor:wait;transform:none}
  .attempts{font-size:.7rem;color:rgba(255,255,255,.2);margin-top:14px}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
</style>
</head>
<body>
<div class="card">
  <div class="icon" aria-hidden="true">🛡️</div>
  <h1>Owner Dashboard</h1>
  <p class="sub">กรอกรหัสผ่านเจ้าของเพื่อเข้าสู่ศูนย์ควบคุม</p>
  ${error ? '<div class="err" role="alert">❌ รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่</div>' : ''}
  <form id="pinForm" method="POST" action="/auth/pin">
    <input type="hidden" name="next" value="${escapeAttr(next)}">
    <div class="pin-wrap">
      <label class="sr-only" for="ownerPin">รหัสผ่านเจ้าของ</label>
      <input id="ownerPin" type="password" name="pin" placeholder="กรอกรหัสผ่าน..." autofocus required autocomplete="current-password">
    </div>
    <button type="submit">🔐 เข้าสู่ Dashboard</button>
  </form>
  <p class="attempts">Phomueangtai Enterprise — Admin Only</p>
</div>
<script>
document.getElementById('pinForm').addEventListener('submit',function(){
  const button=this.querySelector('button');
  button.disabled=true;
  button.setAttribute('aria-busy','true');
  button.textContent='⏳ กำลังตรวจสอบ...';
});
</script>
</body>
</html>`;
}

module.exports = {
    requirePin,
    requireCsrf,
    makeToken,
    verifyToken,
    makeCsrfToken,
    verifyCsrfToken,
    setCookieHeader,
    setCsrfCookieHeader,
    setSessionCookieHeaders,
    clearSessionCookieHeaders,
    parseCookies,
    pinPageHTML,
    escapeAttr,
    isProduction,
    getApiSecret,
    getSessionMaxAgeMs,
    getSessionRefreshAfterMs,
    shouldRefreshToken,
    PIN,
    COOKIE_NAME,
    CSRF_COOKIE_NAME
};
