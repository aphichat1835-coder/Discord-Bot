/*
 * PIN Gate สำหรับ Main Dashboard (Service 1)
 * ใช้ DASHBOARD_PIN env var — ถ้าไม่ตั้งค่า = ไม่มี gate
 * Cookie ลงนามด้วย HMAC-SHA256 / API_SECRET
 */
const crypto = require('crypto');

const COOKIE_NAME = '__da';
const MAX_AGE_MS  = 8 * 3600 * 1000; // 8 ชั่วโมง
const SECRET      = () => process.env.API_SECRET || 'fallback';
const PIN         = () => process.env.DASHBOARD_PIN;

// ── Parse cookies from header ──
function parseCookies(req) {
    const result = {};
    const raw    = req.headers.cookie || '';
    raw.split(';').forEach(c => {
        const idx = c.indexOf('=');
        if (idx < 0) return;
        const k = c.slice(0, idx).trim();
        const v = c.slice(idx + 1).trim();
        result[k] = decodeURIComponent(v);
    });
    return result;
}

// ── Issue signed cookie value ──
function makeToken() {
    const ts  = Date.now().toString();
    const sig = crypto.createHmac('sha256', SECRET()).update(ts).digest('hex').slice(0, 40);
    return `${ts}.${sig}`;
}

// ── Verify signed cookie value ──
function verifyToken(token) {
    if (!token || typeof token !== 'string') return false;
    try {
        const dot = token.lastIndexOf('.');
        if (dot < 0) return false;
        const ts  = token.slice(0, dot);
        const sig = token.slice(dot + 1);
        if (Date.now() - parseInt(ts) > MAX_AGE_MS) return false;
        const expected = crypto.createHmac('sha256', SECRET()).update(ts).digest('hex').slice(0, 40);
        if (sig.length !== expected.length) return false;
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
}

// ── Set-Cookie header helper ──
function setCookieHeader(token, isProduction) {
    const maxAge = Math.floor(MAX_AGE_MS / 1000);
    const flags  = `Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${isProduction ? '; Secure' : ''}`;
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; ${flags}`;
}

// ── Middleware: ถ้าไม่มี cookie ถูกต้อง → redirect PIN page ──
function requirePin(req, res, next) {
    if (!PIN()) return next(); // ไม่ได้ตั้ง DASHBOARD_PIN = ไม่ต้องมี gate
    const cookies = parseCookies(req);
    if (verifyToken(cookies[COOKIE_NAME])) return next();
    const next_path = encodeURIComponent(req.originalUrl || '/');
    res.redirect(`/auth/pin?next=${next_path}`);
}

// ── PIN entry page HTML ──
function pinPageHTML(error = false, next = '/') {
    return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Dashboard — ยืนยันตัวตน</title>
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
  .attempts{font-size:.7rem;color:rgba(255,255,255,.2);margin-top:14px}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🛡️</div>
  <h1>Admin Dashboard</h1>
  <p class="sub">กรุณากรอกรหัสผ่านเพื่อเข้าถึง</p>
  ${error ? '<div class="err">❌ รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่</div>' : ''}
  <form method="POST" action="/auth/pin">
    <input type="hidden" name="next" value="${next.replace(/"/g,'&quot;')}">
    <div class="pin-wrap">
      <input type="password" name="pin" placeholder="กรอกรหัสผ่าน..." autofocus autocomplete="current-password">
    </div>
    <button type="submit">🔐 เข้าสู่ Dashboard</button>
  </form>
  <p class="attempts">Phomueangtai Enterprise — Admin Only</p>
</div>
</body>
</html>`;
}

module.exports = { requirePin, makeToken, verifyToken, setCookieHeader, parseCookies, pinPageHTML, PIN, COOKIE_NAME };
