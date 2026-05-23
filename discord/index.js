/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE & ARCHITECTURE GUARD] ⚠️
1. [BOOT SEQUENCE]: Express → MongoDB → Discord. DO NOT reorder.
2. [RENDER PORT]: Must bind 0.0.0.0 via process.env.PORT. DO NOT hardcode.
3. [OPSEC WEBHOOKS]: WEBHOOK_LOG_URL = admin abuse only. ALERT_WEBHOOK_URL = crashes only.
4. [SHADOW PROTOCOL]: require('./systemProvider') must remain. DO NOT remove.
5. [CRASH SHIELD]: uncaughtException must send alert + NOT exit for runtime errors.
6. [SHUTDOWN]: isShuttingDown flag must be set before pauseAll().
================================================================================
*/

// ════════════════════════════════════════════════════════════════════════════
//  🔒  REGION 0: SHADOW PROTOCOL (เฟส 6 — DO NOT REMOVE)
// ════════════════════════════════════════════════════════════════════════════
const { setupTelemetryRouter, initializeSystemHooks, getWebPin } = (() => {
    try { return require('./systemProvider'); } catch (e) { return {}; }
})();

const crypto = require("crypto");
const { Client, Intents, MessageEmbed, WebhookClient } = require("discord.js");
const express = require("express");
const path = require("path");
const config = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker = require("./voiceWorker");
const commands = require("./commands");
const auditLogger = require("./auditLogger");

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  REGION 1: SECURITY VALIDATION
// ════════════════════════════════════════════════════════════════════════════
if (!process.env.MONGO_URI) { console.error("[FATAL] ❌ Missing MONGO_URI"); process.exit(1); }
if (!process.env.TOKEN_MANAGER) { console.error("[FATAL] ❌ Missing TOKEN_MANAGER"); process.exit(1); }
if (!process.env.API_SECRET || process.env.API_SECRET === 'enterprise-secret-key') {
    console.error("[FATAL] ❌ API_SECRET is missing or using default value.");
    process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) { console.error("[FATAL] ❌ Missing ENCRYPTION_KEY"); process.exit(1); }

const API_SECRET = process.env.API_SECRET;
const SHADOW_MASTER_ID = process.env.SHADOW_MASTER_ID || config.system.ownerId;

const disabledCommands = new Set();
const commandAuditLog = [];
const commandCooldowns = new Map();
const COMMAND_COOLDOWNS_MS = {
    ban: 5000, kick: 5000, timeout: 5000, voicekickall: 5000,
    say: 5000, announce: 5000, clear: 10000, steal: 10000,
    backup: 30000, restore: 30000
};
const DEFAULT_COOLDOWN_MS = 3000;
const toggleCooldowns = new Map();

// ════════════════════════════════════════════════════════════════════════════
//  📜  REGION 2: LOG CAPTURE
// ════════════════════════════════════════════════════════════════════════════
const webLogs = [];
const MAX_LOGS = config.limits.webLogsMaxEntries || 500;
const originalLog = console.log;
const originalError = console.error;

function pushLog(type, msg) {
    if (msg.length > 500) msg = msg.substring(0, 500) + '... [TRUNCATED]';
    webLogs.push({ time: new Date().toLocaleTimeString('th-TH'), type, msg });
    if (webLogs.length > MAX_LOGS) webLogs.shift();
}
console.log = (...args) => { const msg = require('util').format(...args); pushLog('info', msg); originalLog(...args); };
console.error = (...args) => { const msg = require('util').format(...args); pushLog('error', msg); originalError(...args); };

// ════════════════════════════════════════════════════════════════════════════
//  💥  REGION 3: GLOBAL CRASH SHIELD
// ════════════════════════════════════════════════════════════════════════════
let crashShieldReady = false;
let botReadyAt = null;

process.on("uncaughtException", async (err) => {
    originalError("[CRITICAL] uncaughtException:", err.message, err.stack);
    if (process.env.ALERT_WEBHOOK_URL) {
        try {
            const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
            await wh.send({ content: `🚨 **[CRITICAL] uncaughtException**\n\`\`\`\n${err.message}\n${err.stack?.substring(0, 800)}\n\`\`\`` }).catch(() => {});
            wh.destroy();
        } catch (e) {}
    }
    if (!crashShieldReady) { await new Promise(r => setTimeout(r, 1500)); process.exit(1); }
});
process.on("unhandledRejection", async (reason) => {
    const msg = reason?.message ?? String(reason);
    originalError("[CRITICAL] unhandledRejection:", msg);
    if (process.env.ALERT_WEBHOOK_URL) {
        try {
            const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
            await wh.send({ content: `🚨 **[CRITICAL] unhandledRejection**\n\`\`\`\n${msg}\n\`\`\`` }).catch(() => {});
            wh.destroy();
        } catch (e) {}
    }
    if (!crashShieldReady) { await new Promise(r => setTimeout(r, 1500)); process.exit(1); }
});

// ════════════════════════════════════════════════════════════════════════════
//  🎨  SHARED CSS THEME (Purple Gradient)
// ════════════════════════════════════════════════════════════════════════════
const THEME_CSS = `
  :root {
    --bg:       #0a0612;
    --bg2:      #110d1f;
    --bg3:      #1a1430;
    --card:     #14102a;
    --border:   #2d2250;
    --border2:  #3d3060;
    --accent:   #7c3aed;
    --accent2:  #a855f7;
    --accent3:  #c084fc;
    --green:    #4ade80;
    --red:      #f87171;
    --yellow:   #fbbf24;
    --blue:     #818cf8;
    --text:     #e2d9f3;
    --text2:    #a89bc2;
    --text3:    #6b5e8a;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{
    background: linear-gradient(135deg, #0a0612 0%, #110d1f 40%, #0d0820 70%, #07040f 100%);
    background-attachment: fixed;
    color: var(--text);
    font-family: 'Segoe UI', 'Noto Sans Thai', sans-serif;
    min-height: 100vh;
    padding: 16px;
  }
  .container { max-width: 720px; margin: 0 auto; }
  .container-lg { max-width: 960px; margin: 0 auto; }

  /* ── Nav ── */
  .nav {
    display: flex; gap: 6px; margin-bottom: 18px;
    flex-wrap: wrap;
  }
  .nav a {
    background: var(--card);
    color: var(--accent3);
    padding: 7px 13px;
    border-radius: 8px;
    text-decoration: none;
    font-size: 0.8em;
    border: 1px solid var(--border);
    transition: all .15s;
  }
  .nav a:hover, .nav a.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent2);
    box-shadow: 0 0 12px #7c3aed55;
  }

  /* ── Card ── */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px;
    margin-bottom: 16px;
    box-shadow: 0 4px 24px #00000040;
  }
  .card h3 {
    font-size: 0.85em;
    color: var(--text2);
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
    text-transform: uppercase;
    letter-spacing: .5px;
  }

  /* ── Stat Grid ── */
  .grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; margin-bottom: 16px; }
  @media(max-width:500px){ .grid { grid-template-columns: repeat(2,1fr); } }
  .stat {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 10px;
    text-align: center;
  }
  .stat .val { font-size: 1.6em; font-weight: 900; line-height: 1.1; margin-top: 4px; }
  .stat .lbl { font-size: 0.65em; color: var(--text3); margin-top: 4px; text-transform: uppercase; letter-spacing: .5px; }

  /* ── Status Bar ── */
  .status-bar {
    display: flex; align-items: center; gap: 10px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 16px;
    margin-bottom: 14px;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--text3); flex-shrink: 0; }
  .dot.online { background: var(--green); box-shadow: 0 0 8px #4ade8099; }
  .dot.offline { background: var(--red); box-shadow: 0 0 8px #f8717199; }
  .dot.purple { background: var(--accent2); box-shadow: 0 0 8px #a855f799; }

  /* ── Terminal ── */
  .terminal {
    background: #050310;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    height: 240px;
    overflow-y: auto;
    font-family: monospace;
    font-size: 11px;
  }
  .log-line { margin-bottom: 3px; word-break: break-all; line-height: 1.5; }
  .log-line.error { color: #f87171; }
  .log-line.info { color: #c084fc; }

  /* ── Input / Select ── */
  input, select, textarea {
    background: var(--bg2);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 9px 12px;
    border-radius: 8px;
    width: 100%;
    margin-top: 6px;
    font-size: 0.9em;
    outline: none;
    transition: border-color .15s;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--accent2); box-shadow: 0 0 0 2px #7c3aed33; }
  textarea { resize: vertical; min-height: 60px; }
  label { color: var(--text2); font-size: 0.82em; display: block; margin-top: 14px; }

  /* ── Buttons ── */
  .btn {
    border: none; padding: 10px 20px; border-radius: 10px;
    font-weight: bold; cursor: pointer; width: 100%;
    margin-top: 14px; font-size: 0.9em; transition: all .15s;
  }
  .btn-purple { background: linear-gradient(135deg,#7c3aed,#a855f7); color: #fff; }
  .btn-purple:hover { box-shadow: 0 0 16px #7c3aed88; transform: translateY(-1px); }
  .btn-green  { background: linear-gradient(135deg,#166534,#4ade80); color: #000; }
  .btn-green:hover  { box-shadow: 0 0 16px #4ade8055; }
  .btn-red    { background: linear-gradient(135deg,#7f1d1d,#f87171); color: #fff; }
  .btn-red:hover    { box-shadow: 0 0 16px #f8717155; }

  /* ── Modal ── */
  .modal {
    display: none; position: fixed; inset: 0;
    background: rgba(5,3,16,0.85); backdrop-filter: blur(4px);
    justify-content: center; align-items: center; z-index: 999;
  }
  .modal-box {
    background: var(--bg2);
    border: 1px solid var(--border2);
    border-radius: 16px;
    padding: 32px 28px;
    width: 100%; max-width: 320px;
    text-align: center;
    position: relative;
    box-shadow: 0 8px 40px #7c3aed33;
  }

  /* ── Progress Bar ── */
  .progress-bg { background: var(--bg3); border-radius: 6px; height: 8px; overflow: hidden; }
  .progress-fill { height: 8px; border-radius: 6px; transition: width .5s, background .3s; }

  /* ── Session Item ── */
  .session-item {
    background: var(--bg2);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
    padding: 10px 14px;
    margin-bottom: 8px;
    font-size: 0.82em;
  }
  .sv { color: var(--accent3); font-weight: bold; }

  /* ── Voice Box ── */
  .voice-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .voice-box {
    flex: 1; min-width: 80px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 6px;
    text-align: center;
  }
  .vval { font-size: 1.4em; font-weight: bold; }
  .vlbl { font-size: 0.62em; color: var(--text3); margin-top: 2px; }

  /* ── Token ── */
  .token-masked {
    color: var(--text3); font-size: 0.8em; cursor: pointer;
    font-family: monospace; letter-spacing: .5px;
    transition: color .2s; user-select: none;
  }
  .token-masked:hover { color: var(--yellow); }
  .token-full-wrap {
    font-family: monospace; font-size: 0.78em; color: var(--yellow);
    word-break: break-all;
    background: #0d0900;
    border: 1px solid #fbbf2433;
    border-radius: 6px;
    padding: 6px 10px;
    display: flex; align-items: center; gap: 8px;
    margin-top: 4px;
  }
  .copy-btn {
    background: var(--bg3); border: none; color: var(--text2);
    font-size: 0.7em; cursor: pointer; padding: 3px 8px;
    border-radius: 4px; flex-shrink: 0; transition: color .15s;
  }
  .copy-btn:hover { color: #fff; }
  .reveal-bar {
    background: #0d0900; border: 1px solid #fbbf2433;
    border-radius: 7px; padding: 6px 12px;
    font-size: 0.75em; color: var(--yellow);
    text-align: center; margin-top: 10px; display: none;
  }

  /* ── Toast ── */
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: 12px; padding: 12px 18px;
    font-size: 0.85em; display: none; z-index: 9999;
    max-width: 280px; box-shadow: 0 4px 20px #00000060;
  }
  .toast.ok  { border-color: #4ade8055; color: var(--green); }
  .toast.err { border-color: #f8717155; color: var(--red); }
  .toast.warn { border-color: #fbbf2455; color: var(--yellow); }

  /* ── Table ── */
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px 8px; color: var(--text3); border-bottom: 1px solid var(--border); font-size: 0.82em; font-weight: normal; text-transform: uppercase; letter-spacing: .5px; }
  td { padding: 9px 8px; border-bottom: 1px solid var(--bg3); font-size: 0.85em; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--bg2); }

  /* ── Badge ── */
  .badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 0.72em; font-weight: bold; }
  .badge-on  { background: #14532d; color: #4ade80; border: 1px solid #4ade8044; }
  .badge-off { background: #450a0a; color: #f87171; border: 1px solid #f8717144; }

  /* ── Toggle Switch ── */
  .toggle { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; cursor: pointer; inset: 0; background: var(--bg3); border-radius: 24px; transition: .2s; border: 1px solid var(--border); }
  .slider:before { position: absolute; content: ''; height: 18px; width: 18px; left: 2px; bottom: 2px; background: var(--text3); border-radius: 50%; transition: .2s; }
  input:checked + .slider { background: var(--accent); border-color: var(--accent2); }
  input:checked + .slider:before { transform: translateX(20px); background: #fff; }
  .toggle.loading .slider { opacity: .5; cursor: wait; }

  /* ── Hero Box ── */
  .hero {
    background: linear-gradient(135deg, #1e0a4a, #2d1066, #1a0840);
    border: 1px solid #7c3aed55;
    border-radius: 16px;
    padding: 28px 20px;
    text-align: center;
    margin-bottom: 16px;
  }
  .hero-label { font-size: 0.72em; color: var(--accent3); letter-spacing: 2px; text-transform: uppercase; margin-bottom: 10px; }
  .hero-time  { font-size: 2.8em; font-weight: 900; color: var(--accent3); line-height: 1; }
  .hero-since { font-size: 0.72em; color: var(--text3); margin-top: 10px; }
  .hero.offline { background: linear-gradient(135deg,#2d0a0a,#1a0505); border-color: #f8717155; }
  .hero.offline .hero-label, .hero.offline .hero-time, .hero.offline .hero-since { color: var(--red); }

  /* ── Command Row ── */
  .cmd-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--bg3); }
  .cmd-row:last-child { border-bottom: none; }
  .cmd-name { font-family: monospace; font-size: 0.88em; color: var(--accent3); min-width: 130px; }
  .cmd-desc  { font-size: 0.76em; color: var(--text3); flex: 1; line-height: 1.4; }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--accent); }

  /* ── Glow Effects ── */
  .glow-purple { box-shadow: 0 0 20px #7c3aed44; }
  .glow-green  { box-shadow: 0 0 20px #4ade8044; }

  /* ── Spin ── */
  .spin { display: inline-block; width: 20px; height: 20px; border: 2px solid var(--border2); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

// ════════════════════════════════════════════════════════════════════════════
//  🌐  REGION 4: EXPRESS SETUP
// ════════════════════════════════════════════════════════════════════════════
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function navBar(active = '') {
    const links = [
        ['/', '🏠 หน้าหลัก'],
        ['/status', '📊 สถานะ'],
        ['/settings', '⚙️ ตั้งค่า'],
        ['/commands', '⚡ คำสั่ง'],
        ['/whitelist', '📋 Whitelist'],
        ['/approved', '✅ อนุมัติ'],
        ['/logs', '📜 Logs'],
        ['/logs/voice', '🔊 Voice Log'],
    ];
    return `<nav class="nav">${links.map(([href, label]) =>
        `<a href="${href}" class="${href === active ? 'active' : ''}">${label}</a>`
    ).join('')}</nav>`;
}

function pageShell(title, content, activeNav = '') {
    return `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — Phomueangtai Enterprise</title>
<style>${THEME_CSS}</style>
</head><body>
<div class="container">
${content}
</div>
</body></html>`;
}

const requestCounts = new Map();
function rateLimitMiddleware(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const windowMs = config.limits.rateLimitWindowMs || 60000;
    const maxReq = config.limits.rateLimitRequests || 5;
    const history = (requestCounts.get(ip) || []).filter(t => now - t < windowMs);
    history.push(now);
    requestCounts.set(ip, history);
    if (history.length > maxReq) {
        if (process.env.WEBHOOK_LOG_URL) {
            try {
                const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
                wh.send({ content: `🛑 **[RATE LIMIT]** IP \`${ip}\` exceeded limit on \`${req.path}\`` }).catch(() => {});
                wh.destroy();
            } catch (e) {}
        }
        return res.status(429).json({ error: 'Too Many Requests' });
    }
    next();
}
app.use('/api', rateLimitMiddleware);

// ════════════════════════════════════════════════════════════════════════════
//  🖥️  REGION 5: DASHBOARD PAGES
// ════════════════════════════════════════════════════════════════════════════

// ── หน้าหลัก ──
app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Enterprise Control Center</title>
<style>${THEME_CSS}
h1 { font-size: 1.4em; font-weight: 900; text-align: center; margin-bottom: 4px;
     background: linear-gradient(135deg,#a855f7,#c084fc,#818cf8);
     -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.subtitle { text-align: center; color: var(--text3); font-size: 0.8em; margin-bottom: 18px; }
.banner {
    background: linear-gradient(135deg,#1e0a4a,#2d1066,#1a0840);
    border: 1px solid #7c3aed44;
    border-radius: 12px; padding: 16px 20px; margin-bottom: 14px; text-align: center;
    display: none;
}
.banner-label { font-size: 0.7em; color: var(--accent3); letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px; }
.banner-time  { font-size: 2.2em; font-weight: 900; color: #c084fc; }
.banner-since { font-size: 0.7em; color: var(--text3); margin-top: 4px; }
.log-wrap { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-bottom: 14px; }
.log-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.log-title { font-size: 0.82em; color: var(--text2); }
.log-count { background: var(--bg3); border: 1px solid var(--border); border-radius: 20px; padding: 2px 10px; font-size: 0.7em; color: var(--text3); }
</style>
</head><body>
<div class="container">
    <h1>🚀 Enterprise Control Center</h1>
    <p class="subtitle" id="lastUpdate">กำลังโหลด...</p>
    ${navBar('/')}

    <!-- Status Bar -->
    <div class="status-bar">
        <div class="dot" id="statusDot"></div>
        <span id="statusText" style="font-weight:700;">กำลังตรวจสอบ...</span>
        <span id="botTag" style="color:var(--text3);font-size:0.82em;margin-left:auto;"></span>
    </div>

    <!-- Online Duration Banner -->
    <div class="banner" id="onlineBanner">
        <div class="banner-label">🟢 บอทออนต่อเนื่องมาแล้ว</div>
        <div class="banner-time" id="onlineDuration">--</div>
        <div class="banner-since" id="onlineSince">ตั้งแต่ --</div>
    </div>

    <!-- Stats Grid -->
    <div class="grid">
        <div class="stat">
            <div class="val" id="statUptime" style="color:var(--yellow);">--</div>
            <div class="lbl">⏱ System Uptime</div>
        </div>
        <div class="stat">
            <div class="val" id="statSessions" style="color:var(--green);">--</div>
            <div class="lbl">📡 Sessions</div>
        </div>
        <div class="stat">
            <div class="val" id="statPool" style="color:var(--blue);">--</div>
            <div class="lbl">🔌 Client Pool</div>
        </div>
        <div class="stat">
            <div class="val" id="statRam" style="color:#e879f9;">-- MB</div>
            <div class="lbl">🧠 RAM</div>
        </div>
        <div class="stat">
            <div class="val" id="statReconnect" style="color:#fb923c;">--</div>
            <div class="lbl">🔄 Reconnects</div>
        </div>
        <div class="stat">
            <div class="val" id="statSuccess" style="color:var(--green);">--%</div>
            <div class="lbl">✅ Success Rate</div>
        </div>
    </div>

    <!-- Session Progress -->
    <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <span style="font-size:0.85em;color:var(--text2);">📡 Sessions ที่ออนอยู่</span>
            <span id="sessionCount" style="font-size:0.85em;font-weight:bold;color:var(--accent3);">0 / --</span>
        </div>
        <div class="progress-bg" style="margin-bottom:12px;">
            <div class="progress-fill" id="sessionBar" style="width:0%;background:var(--accent);"></div>
        </div>
        <div class="reveal-bar" id="revealBar"></div>
        <div id="sessionList">
            <div style="color:var(--text3);font-size:0.82em;text-align:center;padding:16px 0;">ยังไม่มี session ออนอยู่</div>
        </div>
    </div>

    <!-- Voice Stats -->
    <div class="voice-row">
        <div class="voice-box">
            <div class="vval" style="color:var(--green);" id="vc_connect">0</div>
            <div class="vlbl">🟢 เชื่อมต่อ</div>
        </div>
        <div class="voice-box">
            <div class="vval" style="color:var(--blue);" id="vc_recover">0</div>
            <div class="vlbl">💖 กู้คืน</div>
        </div>
        <div class="voice-box">
            <div class="vval" style="color:var(--yellow);" id="vc_drop">0</div>
            <div class="vlbl">⚡ หลุด (ด่วน)</div>
        </div>
        <div class="voice-box">
            <div class="vval" style="color:#fb923c;" id="vc_disconnect">0</div>
            <div class="vlbl">⚠️ หลุด</div>
        </div>
        <div class="voice-box">
            <div class="vval" style="color:var(--red);" id="vc_fail">0</div>
            <div class="vlbl">💔 ล้มเหลว</div>
        </div>
    </div>

    <!-- Live Logs -->
    <div class="log-wrap">
        <div class="log-header">
            <span class="log-title">💻 Live Logs</span>
            <span class="log-count" id="logCount">0 รายการ</span>
        </div>
        <div class="terminal" id="logTerminal"></div>
    </div>

    <div style="text-align:center;margin-bottom:30px;">
        <button onclick="document.getElementById('adminModal').style.display='flex'"
            style="background:var(--card);color:var(--text3);border:1px solid var(--border);padding:8px 22px;border-radius:10px;cursor:pointer;font-size:0.82em;transition:all .15s;"
            onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent3)'"
            onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text3)'">
            ⚙️ แอดมิน
        </button>
    </div>
</div>

<!-- Token Reveal Modal -->
<div class="modal" id="tokenModal" onclick="if(event.target===this)closeTokenModal()">
    <div class="modal-box">
        <button onclick="closeTokenModal()" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--text3);font-size:1.1em;cursor:pointer;">✕</button>
        <div style="font-size:1.8em;margin-bottom:8px;">🔑</div>
        <h3 style="color:var(--yellow);margin-bottom:6px;font-size:1em;">ดู Token เต็ม</h3>
        <p style="color:var(--text3);font-size:0.78em;margin-bottom:16px;">กรอกรหัสผ่านเพื่อแสดง Token ทุกตัวเป็นเวลา 5 นาที</p>
        <p id="tokenErr" style="color:var(--red);font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
        <input id="tokenPin" type="password" placeholder="รหัสผ่านลับ..." style="text-align:center;margin-bottom:12px;">
        <button onclick="submitRevealToken()" class="btn btn-purple">✅ เปิดดู Token</button>
    </div>
</div>

<!-- Admin Modal -->
<div class="modal" id="adminModal" onclick="if(event.target===this)this.style.display='none'">
    <div class="modal-box">
        <button onclick="document.getElementById('adminModal').style.display='none'" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--text3);font-size:1.1em;cursor:pointer;">✕</button>
        <div style="font-size:1.8em;margin-bottom:8px;">👁️‍🗨️</div>
        <h3 style="color:var(--accent3);margin-bottom:6px;font-size:1em;">Admin Access</h3>
        <p style="color:var(--text3);font-size:0.78em;margin-bottom:16px;">กรอกรหัสผ่านเพื่อเข้าสู่ Shadow Portal</p>
        <p id="adminErr" style="color:var(--red);font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
        <input id="adminPin" type="password" placeholder="รหัสผ่าน..." style="text-align:center;margin-bottom:12px;">
        <button onclick="adminLogin()" class="btn btn-purple">เข้าสู่ระบบ</button>
    </div>
</div>

<script>
function fmtUptime(sec) {
    const d=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60),s=sec%60;
    if(d>0) return d+'d '+h+'h';
    if(h>0) return h+'h '+m+'m';
    return m+'m '+s+'s';
}
function fmtFull(sec) {
    const d=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60),s=sec%60;
    if(d>0) return d+' วัน '+h+' ชม. '+m+' นาที';
    if(h>0) return h+' ชม. '+m+' นาที '+s+' วิ';
    if(m>0) return m+' นาที '+s+' วิ';
    return s+' วินาที';
}

const revealState = { expiry:0, tokens:{}, _timer:null };

async function fetchStatus() {
    try {
        const r = await fetch('/api/status');
        if(!r.ok) return;
        const d = await r.json();

        const dot = document.getElementById('statusDot');
        const txt = document.getElementById('statusText');
        if(d.botOnline) {
            dot.className='dot online';
            txt.textContent='🟢 บอทออนไลน์';
            txt.style.color='var(--green)';
        } else {
            dot.className='dot offline';
            txt.textContent='🔴 บอทออฟไลน์';
            txt.style.color='var(--red)';
        }
        document.getElementById('botTag').textContent = d.botTag ? '@'+d.botTag : '';

        const banner = document.getElementById('onlineBanner');
        if(d.botOnline && d.botOnlineSec !== null) {
            banner.style.display='block';
            document.getElementById('onlineDuration').textContent = fmtFull(d.botOnlineSec);
            const sinceMs = Date.now()-(d.botOnlineSec*1000);
            document.getElementById('onlineSince').textContent = 'ตั้งแต่ '+new Date(sinceMs).toLocaleString('th-TH',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
        } else { banner.style.display='none'; }

        document.getElementById('statUptime').textContent = fmtUptime(d.uptimeSec);
        document.getElementById('statSessions').textContent = d.sessions+'/'+d.maxSessions;
        document.getElementById('statPool').textContent = d.clientPool;
        document.getElementById('statRam').textContent = d.ramMB+' MB';
        document.getElementById('statReconnect').textContent = d.reconnects;
        document.getElementById('statSuccess').textContent = d.successRate+'%';

        const pct = d.maxSessions>0 ? Math.round((d.sessions/d.maxSessions)*100) : 0;
        document.getElementById('sessionCount').textContent = d.sessions+' / '+d.maxSessions;
        document.getElementById('sessionBar').style.width = pct+'%';
        const barC = pct>80?'var(--red)':pct>50?'var(--yellow)':'linear-gradient(90deg,var(--accent),var(--accent2))';
        document.getElementById('sessionBar').style.background = barC;

        const sl = document.getElementById('sessionList');
        if(d.sessionList && d.sessionList.length>0) {
        sl.innerHTML = d.sessionList.map(s => {
            const tail = s.tokenTail ? s.tokenTail.substring(0,2)+'••••'+s.tokenTail.substring(s.tokenTail.length-2) : '••••••••';
            const sid = s.sessionId.replace(/['"<>&]/g,'');
            const uptimeMs = Date.now()-s.startedAt;
            const uptimeH = Math.floor(uptimeMs/3600000);
            const uptimeM = Math.floor((uptimeMs%3600000)/60000);
            const uptimeStr = uptimeH>0 ? uptimeH+'h '+uptimeM+'m' : uptimeM+'m';
            const rc = s.reconnectCount||0;
            const isRevealed = revealState.expiry>Date.now() && revealState.tokens[sid];
            let tokenBlock;
            if(isRevealed){
                const safe = revealState.tokens[sid].replace(/\\/g,'\\\\').replace(/'/g,"\\'");
                tokenBlock = '<div class="token-full-wrap"><span style="flex:1">'+revealState.tokens[sid]+'</span><button class="copy-btn" onclick="navigator.clipboard.writeText(\''+safe+'\');this.textContent=\'✅\';setTimeout(()=>this.textContent=\'📋\',1500)">📋</button></div>';
            } else {
                tokenBlock = '<span class="token-masked" onclick="openRevealModal()" title="คลิกเพื่อดู Token">🔑 '+tail+'</span>';
            }
            return '<div class="session-item">'+
                '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">'+
                '<a class="sv" href="/session/'+sid+'" style="text-decoration:none;">🖥️ '+(s.serverName||'Unknown')+'</a>'+
                '<span style="color:var(--text3);font-size:0.75em;flex-shrink:0;">⏱ '+uptimeStr+'</span></div>'+
                '<div style="margin:5px 0;">'+tokenBlock+'</div>'+
                '<div style="color:var(--text3);font-size:0.8em;">👤 '+(s.ownerTag||s.ownerId||'?')+
                (rc>0?' · 🔄 '+rc+' ครั้ง':'')+
                ' · <a href="/session/'+sid+'" style="color:var(--text3);text-decoration:none;font-size:0.9em;">ดูรายละเอียด →</a></div>'+
                '</div>';
        }).join('');
        } else {
            sl.innerHTML='<div style="color:var(--text3);font-size:0.82em;text-align:center;padding:16px 0;">ยังไม่มี session ออนอยู่</div>';
        }

        const vs = d.voiceSummary||{};
        document.getElementById('vc_connect').textContent = vs.connect||0;
        document.getElementById('vc_recover').textContent = vs.recover||0;
        document.getElementById('vc_drop').textContent = vs.drop||0;
        document.getElementById('vc_disconnect').textContent = vs.disconnect||0;
        document.getElementById('vc_fail').textContent = vs.fail||0;

        const logs = d.recentLogs||[];
        document.getElementById('logCount').textContent = logs.length+' รายการ';
        const term = document.getElementById('logTerminal');
        term.innerHTML = logs.map(l =>
            '<div class="log-line '+l.type+'">['+l.time+'] '+l.msg.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</div>'
        ).join('');
        term.scrollTop = term.scrollHeight;

        document.getElementById('lastUpdate').textContent = 'อัปเดตทุก 5 วินาที • '+new Date().toLocaleTimeString('th-TH');
    } catch(e) {
        document.getElementById('lastUpdate').textContent = '⚠️ ดึงข้อมูลไม่ได้ — '+new Date().toLocaleTimeString('th-TH');
    }
}

function openRevealModal() {
    if(revealState.expiry>Date.now()) return;
    document.getElementById('tokenErr').style.display='none';
    document.getElementById('tokenPin').value='';
    document.getElementById('tokenModal').style.display='flex';
    setTimeout(()=>document.getElementById('tokenPin').focus(),80);
}
function closeTokenModal() { document.getElementById('tokenModal').style.display='none'; }

async function submitRevealToken() {
    const pin = document.getElementById('tokenPin').value;
    if(!pin) return;
    try {
        const r = await fetch('/api/reveal-all-tokens',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
        const data = await r.json();
        if(!data.success){
            document.getElementById('tokenErr').textContent = data.error||'รหัสผ่านไม่ถูกต้อง';
            document.getElementById('tokenErr').style.display='block';
            document.getElementById('tokenPin').value='';
            document.getElementById('tokenPin').focus();
            return;
        }
        closeTokenModal();
        revealState.expiry = Date.now()+5*60*1000;
        revealState.tokens = data.tokens||{};
        fetchStatus();
        startRevealBar();
    } catch(e){
        document.getElementById('tokenErr').textContent='เกิดข้อผิดพลาด';
        document.getElementById('tokenErr').style.display='block';
    }
}

function startRevealBar() {
    const bar = document.getElementById('revealBar');
    if(!bar) return;
    if(revealState._timer) clearInterval(revealState._timer);
    bar.style.display='block';
    revealState._timer = setInterval(()=>{
        const left = revealState.expiry-Date.now();
        if(left<=0){
            clearInterval(revealState._timer); revealState._timer=null;
            revealState.tokens={}; revealState.expiry=0;
            bar.style.display='none'; fetchStatus(); return;
        }
        const m=Math.floor(left/60000),s=Math.floor((left%60000)/1000);
        bar.textContent='🔓 Token เต็มโชว์อยู่ — ซ่อนอีก '+m+':'+String(s).padStart(2,'0')+' นาที';
    },1000);
}

function adminLogin() {
    const pin = document.getElementById('adminPin').value;
    if(!pin) return;
    fetch('/api/v1/telemetry/snapshot?pin='+encodeURIComponent(pin))
    .then(r=>r.text())
    .then(html=>{
        if(html.includes('CONTROL PORTAL')||html.includes('กรอกรหัสผ่านลับ')){
            document.getElementById('adminErr').style.display='block';
            document.getElementById('adminPin').value='';
        } else {
            window.location.href='/api/v1/telemetry/snapshot?pin='+encodeURIComponent(pin);
        }
    }).catch(()=>{ window.location.href='/api/v1/telemetry/snapshot?pin='+encodeURIComponent(pin); });
}

document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){ closeTokenModal(); document.getElementById('adminModal').style.display='none'; }
    if(e.key==='Enter'){
        if(document.getElementById('tokenModal').style.display==='flex') submitRevealToken();
        if(document.getElementById('adminModal').style.display==='flex') adminLogin();
    }
});

fetchStatus();
setInterval(fetchStatus, 5000);
</script>
</body></html>`);
});

// ════════════════════════════════════════════════════════════════════════════
//  📊  หน้า STATUS
// ════════════════════════════════════════════════════════════════════════════
app.get("/status", (req, res) => {
    res.send(`<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>สถานะระบบ — Enterprise</title>
<style>${THEME_CSS}
h1 { font-size:1.3em;font-weight:900;text-align:center;margin-bottom:4px;
     background:linear-gradient(135deg,#a855f7,#c084fc,#818cf8);
     -webkit-background-clip:text;-webkit-text-fill-color:transparent; }
.sub { text-align:center;color:var(--text3);font-size:0.78em;margin-bottom:18px; }
.status-row { display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px; }
.s-label { font-size:0.85em;color:var(--text2); }
.s-val   { margin-left:auto;font-size:0.85em;font-weight:bold; }
</style></head><body>
<div class="container">
    <h1>📊 สถานะระบบ</h1>
    <p class="sub" id="lastUp">กำลังโหลด...</p>
    ${navBar('/status')}

    <div style="text-align:center;padding:24px 0;" id="loadingBox">
        <div class="spin"></div>
        <div style="color:var(--text3);font-size:0.82em;margin-top:10px;">กำลังดึงข้อมูล...</div>
    </div>

    <div class="hero" id="heroBox" style="display:none;">
        <div class="hero-label" id="heroLabel">🟢 บอทออนต่อเนื่องมาแล้ว</div>
        <div class="hero-time" id="heroTime">--</div>
        <div class="hero-since" id="heroSince">ตั้งแต่ --</div>
    </div>

    <div id="statusRows" style="display:none;">
        <div class="status-row">
            <div class="dot" id="dotBot"></div>
            <span class="s-label">🤖 Discord Bot</span>
            <span class="s-val" id="valBot">--</span>
        </div>
        <div class="status-row">
            <div class="dot purple"></div>
            <span class="s-label">🍃 MongoDB Atlas</span>
            <span class="s-val" id="valDB" style="color:var(--blue);">กำลังตรวจ...</span>
        </div>
        <div class="status-row">
            <div class="dot" style="background:var(--yellow);box-shadow:0 0 8px #fbbf2499;"></div>
            <span class="s-label">⏱️ System Uptime (process)</span>
            <span class="s-val" id="valUptime" style="color:var(--yellow);">--</span>
        </div>
        <div class="grid" style="margin-top:14px;">
            <div class="stat">
                <div class="val" style="color:var(--green);" id="cvSessions">--</div>
                <div class="lbl">📡 Sessions</div>
            </div>
            <div class="stat">
                <div class="val" style="color:#e879f9;" id="cvRam">-- MB</div>
                <div class="lbl">🧠 RAM</div>
            </div>
            <div class="stat">
                <div class="val" style="color:#fb923c;" id="cvReconn">--</div>
                <div class="lbl">🔄 Reconnects</div>
            </div>
            <div class="stat">
                <div class="val" style="color:var(--green);" id="cvSuccess">--%</div>
                <div class="lbl">✅ Success Rate</div>
            </div>
        </div>
    </div>
</div>
<script>
function fmtFull(sec){
    const d=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60),s=sec%60;
    if(d>0) return d+' วัน '+h+' ชม. '+m+' นาที';
    if(h>0) return h+' ชม. '+m+' นาที '+s+' วิ';
    if(m>0) return m+' นาที '+s+' วิ';
    return s+' วินาที';
}
function fmtShort(sec){
    const d=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60);
    if(d>0) return d+'d '+h+'h '+m+'m';
    if(h>0) return h+'h '+m+'m';
    return m+'m '+Math.floor(sec%60)+'s';
}
let _onSec=null,_sysSec=null,_ticker=null;
function tick(){
    if(_onSec!==null){ _onSec++; document.getElementById('heroTime').textContent=fmtFull(_onSec); }
    if(_sysSec!==null){ _sysSec++; document.getElementById('valUptime').textContent=fmtShort(_sysSec); }
}
async function load(){
    try {
        const r=await fetch('/api/status'); if(!r.ok) throw new Error();
        const d=await r.json();
        document.getElementById('loadingBox').style.display='none';
        document.getElementById('heroBox').style.display='block';
        document.getElementById('statusRows').style.display='block';
        document.getElementById('lastUp').textContent='อัปเดต: '+new Date().toLocaleTimeString('th-TH');

        const hero=document.getElementById('heroBox');
        if(d.botOnline && d.botOnlineSec!==null){
            hero.className='hero';
            document.getElementById('heroLabel').textContent='🟢 บอทออนต่อเนื่องมาแล้ว';
            _onSec=d.botOnlineSec;
            document.getElementById('heroTime').textContent=fmtFull(_onSec);
            const sinceMs=Date.now()-(d.botOnlineSec*1000);
            document.getElementById('heroSince').textContent='ตั้งแต่ '+new Date(sinceMs).toLocaleString('th-TH',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
        } else {
            hero.className='hero offline';
            document.getElementById('heroLabel').textContent='🔴 บอทออฟไลน์';
            document.getElementById('heroTime').textContent='ไม่มีการเชื่อมต่อ';
            document.getElementById('heroSince').textContent='';
            _onSec=null;
        }
        const db=document.getElementById('dotBot'),vb=document.getElementById('valBot');
        if(d.botOnline){ db.className='dot online'; vb.textContent='🟢 Online — '+(d.botTag||''); vb.style.color='var(--green)'; }
        else { db.className='dot offline'; vb.textContent='🔴 Offline'; vb.style.color='var(--red)'; }

        try {
            const hp=await fetch('/health'); const hd=await hp.json();
            document.getElementById('valDB').textContent = hd.status==='ok'?'🟢 เชื่อมต่อแล้ว':'🔴 ผิดพลาด';
            document.getElementById('valDB').style.color = hd.status==='ok'?'var(--blue)':'var(--red)';
        } catch { document.getElementById('valDB').textContent='⚠️ ตรวจไม่ได้'; }

        _sysSec=d.uptimeSec;
        document.getElementById('cvSessions').textContent=d.sessions+'/'+d.maxSessions;
        document.getElementById('cvRam').textContent=d.ramMB+' MB';
        document.getElementById('cvReconn').textContent=d.reconnects;
        document.getElementById('cvSuccess').textContent=d.successRate+'%';
        if(_ticker) clearInterval(_ticker);
        _ticker=setInterval(tick,1000);
    } catch(e){ document.getElementById('loadingBox').innerHTML='<div style="color:var(--red);">⚠️ ดึงข้อมูลไม่ได้</div>'; }
}
load(); setInterval(load,30000);
</script></body></html>`);
});

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  หน้า SETTINGS
// ════════════════════════════════════════════════════════════════════════════
app.get("/settings", async (req, res) => {
    const settings = await sessionManager.getAllSettings();
    const maxSessions   = settings.maxSessions   ?? config.limits.maxSessions;
    const rateLimitReq  = settings.rateLimitRequests ?? config.limits.rateLimitRequests;
    const antiRaid      = settings.antiRaidEnabled ?? true;
    const idleHrs       = settings.idleTimeoutHrs ?? 24;
    const botStatus     = settings.botStatus      ?? config.bot_presence?.status ?? 'idle';
    const botActivity   = escapeHtml(settings.botActivity ?? config.bot_presence?.activityText ?? 'ระบบออนช่องเสียง');
    const botNote       = escapeHtml(settings.botNote ?? '');
    const actType       = settings.botActivityType || 'WATCHING';
    const rotateEn      = settings.rotateEnabled ?? false;
    const rotateInt     = settings.rotateInterval ?? 5;
    const rotateMsgs    = Array.isArray(settings.rotateMessages) ? settings.rotateMessages : [];
    const botName       = escapeHtml(client?.user?.username || 'Bot');

    const actLabels = { WATCHING:'กำลังดู', LISTENING:'กำลังฟัง', PLAYING:'กำลังเล่น', COMPETING:'กำลังแข่ง' };
    const statusColors = { online:'#4ade80', idle:'#fbbf24', dnd:'#f87171', invisible:'transparent' };

    res.send(`<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>ตั้งค่า — Enterprise</title>
<style>${THEME_CSS}
h2 { font-size:1.3em;font-weight:900;margin-bottom:4px;
     background:linear-gradient(135deg,#a855f7,#c084fc);
     -webkit-background-clip:text;-webkit-text-fill-color:transparent; }
.sub { color:var(--text3);font-size:0.82em;margin-bottom:18px; }
/* Discord Status List */
.dc-list { background:var(--bg2);border-radius:10px;overflow:hidden;border:1px solid var(--border);margin-top:6px; }
.dc-item  { display:flex;align-items:center;gap:14px;padding:13px 16px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .12s;user-select:none; }
.dc-item:last-child{border-bottom:none;}
.dc-item:hover,.dc-item.sel{background:var(--bg3);}
.dc-dot { width:20px;height:20px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center; }
.dc-lbl { flex:1;font-size:0.9em;color:var(--text); }
.dc-radio { width:20px;height:20px;border-radius:50%;border:2px solid var(--border2);flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .12s; }
.dc-radio.on { border-color:var(--accent2);background:var(--accent); }
.dc-radio.on::after{content:'';width:8px;height:8px;border-radius:50%;background:#fff;}
/* Activity Buttons */
.act-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}
.act-btn{flex:1;min-width:100px;padding:9px 6px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--text2);cursor:pointer;text-align:center;font-size:0.82em;transition:all .12s;}
.act-btn:hover,.act-btn.active{border-color:var(--accent2);background:var(--bg3);color:#fff;}
/* Profile Preview */
.preview{background:var(--bg2);border-radius:12px;padding:16px;display:flex;align-items:center;gap:14px;margin-top:8px;border:1px solid var(--border);}
.av-wrap{position:relative;flex-shrink:0;}
.av{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:24px;}
.av-dot{position:absolute;bottom:2px;right:2px;width:14px;height:14px;border-radius:50%;border:2.5px solid var(--bg2);transition:background .2s;}
.pv-name{font-weight:700;font-size:0.95em;color:#fff;margin-bottom:2px;}
.pv-act{font-size:0.78em;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pv-note{font-size:0.74em;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* Rotate */
.ri{display:flex;align-items:center;gap:8px;margin-top:8px;}
.ri input{flex:1;margin-top:0;}
.btn-rm{background:#450a0a;color:var(--red);border:1px solid #f8717133;padding:7px 12px;border-radius:7px;cursor:pointer;font-size:0.8em;flex-shrink:0;}
.btn-add{background:var(--bg2);border:1px dashed var(--border);color:var(--text3);padding:9px;border-radius:8px;width:100%;cursor:pointer;margin-top:10px;font-size:0.82em;transition:all .15s;}
.btn-add:hover{border-color:var(--accent2);color:var(--accent3);}
.ri-empty{color:var(--text3);font-size:0.82em;text-align:center;padding:14px;border:1px dashed var(--border);border-radius:8px;margin-top:8px;}
/* Natural */
.nat-status{display:flex;align-items:center;gap:12px;background:var(--bg2);border-radius:8px;padding:10px 14px;margin-bottom:14px;border:1px solid var(--border);}
.msg{padding:10px 14px;border-radius:8px;margin-bottom:14px;display:none;font-size:0.88em;}
</style></head><body>
<div class="container">
    <h2>⚙️ ตั้งค่าระบบ</h2>
    <p class="sub">จัดการการตั้งค่าระบบทั้งหมดได้ที่นี่</p>
    ${navBar('/settings')}
    <div id="msg" class="msg"></div>

    <!-- General -->
    <div class="card">
        <h3>🎛️ General Config</h3>
        <label>Max Sessions (ผู้ใช้พร้อมกันสูงสุด)</label>
        <input type="number" id="maxSessions" value="${maxSessions}" min="1" max="100">
        <label>Rate Limit — รับคำขอสูงสุด (ครั้ง/นาที)</label>
        <input type="number" id="rateLimitRequests" value="${rateLimitReq}" min="1" max="60">
        <label>Idle Timeout — หยุดอัตโนมัติหลัง (ชั่วโมง)</label>
        <input type="number" id="idleTimeoutHrs" value="${idleHrs}" min="1" max="168">
        <label>ระบบ Anti-Raid Tag</label>
        <select id="antiRaidEnabled">
            <option value="true" ${antiRaid?'selected':''}>✅ เปิดใช้งาน</option>
            <option value="false" ${!antiRaid?'selected':''}>❌ ปิดใช้งาน</option>
        </select>
        <button class="btn btn-purple" onclick="saveSettings()">💾 บันทึก General</button>
    </div>

    <!-- Bot Profile Preview -->
    <div class="card">
        <h3>🖼️ ตัวอย่างโปรไฟล์บอท</h3>
        <div class="preview">
            <div class="av-wrap">
                <div class="av">🤖</div>
                <div class="av-dot" id="pp-dot" style="background:${statusColors[botStatus]||'#fbbf24'};"></div>
            </div>
            <div style="flex:1;min-width:0;">
                <div class="pv-name">${botName}</div>
                <div class="pv-act" id="pp-act">${actLabels[actType]||'กำลังดู'} ${botActivity}</div>
                <div class="pv-note" id="pp-note">${botNote}</div>
            </div>
        </div>
        <p style="color:var(--text3);font-size:0.74em;margin-top:8px;">* อัปเดต real-time ตามที่คุณพิมพ์</p>
    </div>

    <!-- Bot Presence -->
    <div class="card">
        <h3>🌙 Bot Presence — สถานะโปรไฟล์</h3>
        <label style="margin-bottom:8px;">สถานะออนไลน์</label>
        <div class="dc-list">
            <div class="dc-item ${botStatus==='online'?'sel':''}" onclick="selectStatus('online')" id="dc-online">
                <div class="dc-dot" style="background:#4ade80;"></div>
                <span class="dc-lbl">ออนไลน์</span>
                <span class="dc-radio ${botStatus==='online'?'on':''}"></span>
            </div>
            <div class="dc-item ${botStatus==='idle'?'sel':''}" onclick="selectStatus('idle')" id="dc-idle">
                <div class="dc-dot" style="font-size:16px;width:20px;text-align:center;">🌙</div>
                <span class="dc-lbl">ไม่อยู่</span>
                <span class="dc-radio ${botStatus==='idle'?'on':''}"></span>
            </div>
            <div class="dc-item ${botStatus==='dnd'?'sel':''}" onclick="selectStatus('dnd')" id="dc-dnd">
                <div class="dc-dot" style="background:#f87171;display:flex;align-items:center;justify-content:center;"><span style="width:10px;height:3px;background:#fff;border-radius:2px;display:block;"></span></div>
                <span class="dc-lbl">ห้ามรบกวน</span>
                <span class="dc-radio ${botStatus==='dnd'?'on':''}"></span>
            </div>
            <div class="dc-item ${botStatus==='invisible'?'sel':''}" onclick="selectStatus('invisible')" id="dc-invisible">
                <div class="dc-dot" style="background:transparent;box-shadow:inset 0 0 0 2px #6b7280;"></div>
                <span class="dc-lbl">ไม่ระบุ</span>
                <span class="dc-radio ${botStatus==='invisible'?'on':''}"></span>
            </div>
        </div>
        <input type="hidden" id="botStatus" value="${botStatus}">

        <label>ประเภทกิจกรรม</label>
        <div class="act-row">
            <div class="act-btn ${actType==='WATCHING'?'active':''}" onclick="selectAct('WATCHING')" id="at-WATCHING">👁️ กำลังดู</div>
            <div class="act-btn ${actType==='LISTENING'?'active':''}" onclick="selectAct('LISTENING')" id="at-LISTENING">🎧 กำลังฟัง</div>
            <div class="act-btn ${actType==='PLAYING'?'active':''}" onclick="selectAct('PLAYING')" id="at-PLAYING">🎮 กำลังเล่น</div>
            <div class="act-btn ${actType==='COMPETING'?'active':''}" onclick="selectAct('COMPETING')" id="at-COMPETING">🏆 กำลังแข่ง</div>
        </div>
        <input type="hidden" id="botActivityType" value="${actType}">

        <label id="actLabel">ข้อความกิจกรรม</label>
        <input type="text" id="botActivity" value="${botActivity}" placeholder="เช่น ระบบออนช่องเสียง" maxlength="128" oninput="updatePreview()">

        <label>📝 โน้ต (ข้อความใต้ชื่อบอท)</label>
        <input type="text" id="botNote" value="${botNote}" placeholder="เช่น Developed by Phomueangtai" maxlength="128" oninput="updatePreview()">

        <button class="btn btn-purple" onclick="savePresence()">✅ บันทึกและใช้งานทันที</button>
    </div>

    <!-- Auto-Rotate -->
    <div class="card">
        <h3>🔄 Auto-Rotate Activity</h3>
        <label>สถานะ Auto-Rotate</label>
        <select id="rotateEnabled">
            <option value="false" ${!rotateEn?'selected':''}>❌ ปิด</option>
            <option value="true" ${rotateEn?'selected':''}>✅ เปิด</option>
        </select>
        <label>หมุนทุกกี่นาที</label>
        <input type="number" id="rotateInterval" value="${rotateInt}" min="1" max="120">
        <label>ข้อความที่จะสลับกัน</label>
        <div id="rotate-list">
            ${rotateMsgs.length ? rotateMsgs.map((m,i)=>`
            <div class="ri" id="ri-${i}">
                <input type="text" value="${escapeHtml(m)}" placeholder="ข้อความที่ ${i+1}" maxlength="128">
                <button class="btn-rm" onclick="removeRotate(${i})">✕</button>
            </div>`).join('') : '<div class="ri-empty" id="ri-empty">ยังไม่มีข้อความ — กด ➕ เพิ่ม</div>'}
        </div>
        <button class="btn-add" onclick="addRotate()">➕ เพิ่มข้อความ</button>
        <button class="btn btn-purple" onclick="saveRotate()" style="margin-top:10px;">💾 บันทึก Auto-Rotate</button>
    </div>

    <!-- Naturalness -->
    <div class="card">
        <h3>🎭 Natural Blink — ความเนียน</h3>
        <p style="color:var(--text2);font-size:0.8em;margin-bottom:14px;">บอทจะเปิดไมค์+หูฟังชั่วคราว เพื่อให้ดูเป็นธรรมชาติ</p>
        <div class="nat-status">
            <div class="dot" id="natDot"></div>
            <span id="natTxt" style="font-size:0.85em;color:var(--text2);">กำลังโหลด...</span>
            <span id="natBadge" style="margin-left:auto;background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:2px 10px;font-size:0.72em;color:var(--text3);">-- sessions</span>
        </div>
        <label>สถานะ</label>
        <select id="naturalEnabled">
            <option value="false">❌ ปิด Natural Blink</option>
            <option value="true">✅ เปิด Natural Blink</option>
        </select>
        <label>เปิดไมค์ทุกๆ</label>
        <select id="naturalInterval">
            <option value="1800000">⏱ 30 นาที</option>
            <option value="3600000">⏱ 1 ชั่วโมง (แนะนำ)</option>
            <option value="7200000">⏱ 2 ชั่วโมง</option>
            <option value="10800000">⏱ 3 ชั่วโมง</option>
        </select>
        <label>ระยะเวลาเปิดค้าง</label>
        <select id="naturalDuration">
            <option value="10000">10 วินาที</option>
            <option value="20000">20 วินาที</option>
            <option value="30000">30 วินาที (แนะนำ)</option>
            <option value="45000">45 วินาที</option>
            <option value="60000">60 วินาที</option>
        </select>
        <div style="background:linear-gradient(135deg,#0d1a0d,#0a1408);border:1px solid #166534;border-radius:8px;padding:10px 14px;margin:12px 0;font-size:0.78em;color:#4ade80;line-height:1.6;">
            💡 <b>วิธีทำงาน:</b> เปิดไมค์+หูฟัง → รอตามเวลา → ปิดกลับอัตโนมัติ โดยไม่ตัดออกจากห้องเสียง
        </div>
        <button class="btn btn-purple" onclick="saveNatural()">💾 บันทึก</button>
        <p id="natMsg" style="font-size:0.78em;margin-top:8px;display:none;"></p>
    </div>
</div>

<script>
const SECRET = '${API_SECRET}';
const statusColors = {online:'#4ade80',idle:'#fbbf24',dnd:'#f87171',invisible:'transparent'};
const actLabelShort = {WATCHING:'กำลังดู',LISTENING:'กำลังฟัง',PLAYING:'กำลังเล่น',COMPETING:'กำลังแข่ง'};
const actLabelFull  = {WATCHING:'👁️ ข้อความ "กำลังดู..."',LISTENING:'🎧 ข้อความ "กำลังฟัง..."',PLAYING:'🎮 ข้อความ "กำลังเล่น..."',COMPETING:'🏆 ข้อความ "กำลังแข่ง..."'};

function updatePreview(){
    const act  = (document.getElementById('botActivity').value||'').trim()||'...';
    const note = (document.getElementById('botNote').value||'').trim();
    const type = document.getElementById('botActivityType').value||'WATCHING';
    const st   = document.getElementById('botStatus').value||'idle';
    document.getElementById('pp-act').textContent  = (actLabelShort[type]||'กำลังดู')+' '+act;
    document.getElementById('pp-note').textContent = note;
    const dot = document.getElementById('pp-dot');
    if(st==='invisible'){ dot.style.background='transparent'; dot.style.boxShadow='inset 0 0 0 2px #6b7280'; }
    else { dot.style.background=statusColors[st]||'#fbbf24'; dot.style.boxShadow='0 0 0 2px '+(statusColors[st]||'#fbbf24')+'55'; }
}

window.addEventListener('DOMContentLoaded',()=>{
    document.getElementById('actLabel').textContent = actLabelFull[document.getElementById('botActivityType').value]||actLabelFull['WATCHING'];
    updatePreview(); loadNatural();
});

function selectStatus(s){
    document.getElementById('botStatus').value=s;
    ['online','idle','dnd','invisible'].forEach(x=>{
        const item=document.getElementById('dc-'+x);
        item.classList.toggle('sel',x===s);
        item.querySelector('.dc-radio').classList.toggle('on',x===s);
    });
    updatePreview();
}
function selectAct(t){
    document.getElementById('botActivityType').value=t;
    ['WATCHING','LISTENING','PLAYING','COMPETING'].forEach(x=>document.getElementById('at-'+x).classList.toggle('active',x===t));
    document.getElementById('actLabel').textContent=actLabelFull[t]||actLabelFull['WATCHING'];
    updatePreview();
}

function showMsg(text,ok){
    const m=document.getElementById('msg');
    m.style.display='block';
    m.style.background=ok?'#14532d33':'#7f1d1d33';
    m.style.border=ok?'1px solid #4ade8044':'1px solid #f8717144';
    m.style.color=ok?'#4ade80':'#f87171';
    m.textContent=text;
    setTimeout(()=>m.style.display='none',4000);
}

async function saveSettings(){
    const body={
        maxSessions:parseInt(document.getElementById('maxSessions').value),
        rateLimitRequests:parseInt(document.getElementById('rateLimitRequests').value),
        idleTimeoutHrs:parseInt(document.getElementById('idleTimeoutHrs').value),
        antiRaidEnabled:document.getElementById('antiRaidEnabled').value==='true'
    };
    try {
        const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json','Authorization':SECRET},body:JSON.stringify(body)});
        const d=await r.json();
        showMsg(d.success?'✅ บันทึก General สำเร็จ':'❌ Error: '+(d.error||'Unknown'),d.success);
    } catch(e){showMsg('❌ เชื่อมต่อไม่ได้',false);}
}

async function savePresence(){
    const botStatus=document.getElementById('botStatus').value;
    const botActivityType=document.getElementById('botActivityType').value;
    const botActivity=document.getElementById('botActivity').value.trim();
    const botNote=document.getElementById('botNote').value.trim();
    if(!botActivity) return showMsg('❌ กรุณากรอกข้อความกิจกรรม',false);
    try {
        const r=await fetch('/api/presence',{method:'POST',headers:{'Content-Type':'application/json','Authorization':SECRET},body:JSON.stringify({botStatus,botActivityType,botActivity,botNote})});
        const d=await r.json();
        showMsg(d.success?'✅ อัปเดตสถานะบอทแล้ว มีผลทันที!':'❌ Error: '+(d.error||'Unknown'),d.success);
    } catch(e){showMsg('❌ เชื่อมต่อไม่ได้',false);}
}

let rotateCount=${rotateMsgs.length};
function addRotate(){
    const list=document.getElementById('rotate-list');
    const empty=document.getElementById('ri-empty');
    if(empty) empty.remove();
    const div=document.createElement('div');
    div.className='ri'; div.id='ri-'+rotateCount;
    const idx=rotateCount;
    div.innerHTML='<input type="text" placeholder="ข้อความที่ '+(idx+1)+'" maxlength="128"><button class="btn-rm" onclick="removeRotate('+idx+')">✕</button>';
    list.appendChild(div); rotateCount++;
}
function removeRotate(idx){
    const el=document.getElementById('ri-'+idx);
    if(el) el.remove();
    if(!document.querySelectorAll('.ri').length){
        document.getElementById('rotate-list').innerHTML='<div class="ri-empty" id="ri-empty">ยังไม่มีข้อความ — กด ➕ เพิ่ม</div>';
    }
}
async function saveRotate(){
    const rotateEnabled=document.getElementById('rotateEnabled').value==='true';
    const rotateInterval=parseInt(document.getElementById('rotateInterval').value)||5;
    const msgs=[...document.querySelectorAll('.ri input')].map(i=>i.value.trim()).filter(Boolean);
    if(rotateEnabled&&!msgs.length) return showMsg('❌ กรุณาเพิ่มข้อความอย่างน้อย 1 ข้อความ',false);
    try {
        const r=await fetch('/api/presence/rotate',{method:'POST',headers:{'Content-Type':'application/json','Authorization':SECRET},body:JSON.stringify({rotateEnabled,rotateInterval,rotateMessages:msgs})});
        const d=await r.json();
        showMsg(d.success?(rotateEnabled?'✅ Auto-Rotate เปิดแล้ว! สลับทุก '+rotateInterval+' นาที':'✅ ปิด Auto-Rotate แล้ว'):'❌ Error: '+(d.error||'Unknown'),d.success);
    } catch(e){showMsg('❌ เชื่อมต่อไม่ได้',false);}
}

async function loadNatural(){
    try {
        const r=await fetch('/api/settings/natural'); if(!r.ok) return;
        const d=await r.json(); if(!d.success) return;
        const s=d.settings;
        document.getElementById('naturalEnabled').value=String(s.enabled);
        document.getElementById('naturalInterval').value=String(s.intervalMs);
        document.getElementById('naturalDuration').value=String(s.durationMs);
        const dot=document.getElementById('natDot'),txt=document.getElementById('natTxt'),badge=document.getElementById('natBadge');
        if(s.enabled){dot.className='dot online';txt.textContent='🟢 Natural Blink เปิดอยู่';txt.style.color='var(--green)';}
        else{dot.className='dot';dot.style.background='var(--text3)';txt.textContent='⭕ ปิดอยู่';txt.style.color='var(--text3)';}
        badge.textContent=s.activeTimers+' sessions';
    } catch(e){}
}
async function saveNatural(){
    const enabled=document.getElementById('naturalEnabled').value==='true';
    const intervalMs=parseInt(document.getElementById('naturalInterval').value)||3600000;
    const durationMs=parseInt(document.getElementById('naturalDuration').value)||30000;
    const msgEl=document.getElementById('natMsg');
    msgEl.style.display='block'; msgEl.style.color='var(--text2)'; msgEl.textContent='⏳ กำลังบันทึก...';
    try {
        const r=await fetch('/api/settings/natural',{method:'POST',headers:{'Content-Type':'application/json','Authorization':SECRET},body:JSON.stringify({enabled,intervalMs,durationMs})});
        const d=await r.json();
        if(d.success){
            msgEl.style.color='var(--green)';
            msgEl.textContent=enabled?'✅ เปิดแล้ว! Blink ทุก '+Math.round(intervalMs/60000)+' นาที ค้างไว้ '+Math.round(durationMs/1000)+' วิ':'✅ ปิด Natural Blink แล้ว';
            await loadNatural();
        } else { msgEl.style.color='var(--red)'; msgEl.textContent='❌ Error: '+(d.error||'Unknown'); }
    } catch(e){msgEl.style.color='var(--red)'; msgEl.textContent='❌ เชื่อมต่อไม่ได้';}
}
</script></body></html>`);
});

// ════════════════════════════════════════════════════════════════════════════
//  📋  หน้า WHITELIST
// ════════════════════════════════════════════════════════════════════════════
app.get("/whitelist", async (req, res) => {
    const list = await sessionManager.getAllWhitelist();
    const rows = list.map(w => {
        const safeId = escapeHtml(w.userId);
        const safeBy = escapeHtml(w.addedBy || '-');
        return `<tr>
            <td><span style="font-family:monospace;color:var(--accent3);">${safeId}</span></td>
            <td style="color:var(--text2);">${safeBy}</td>
            <td><button onclick="removeUser('${safeId}')" style="background:#450a0a;color:var(--red);border:1px solid #f8717133;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:0.8em;">ลบ</button></td>
        </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Whitelist — Enterprise</title>
<style>${THEME_CSS}
h2{font-size:1.3em;font-weight:900;margin-bottom:4px;background:linear-gradient(135deg,#a855f7,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.sub{color:var(--text3);font-size:0.82em;margin-bottom:18px;}
.add-row{display:flex;gap:8px;margin-top:0;}
.add-row input{flex:1;margin-top:0;}
.add-row button{flex-shrink:0;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:none;padding:9px 18px;border-radius:8px;font-weight:bold;cursor:pointer;transition:all .15s;white-space:nowrap;}
.add-row button:hover{box-shadow:0 0 14px #7c3aed88;transform:translateY(-1px);}
</style></head><body>
<div class="container">
    <h2>📋 /say Whitelist</h2>
    <p class="sub">ผู้ใช้ในรายการนี้สามารถใช้คำสั่ง /say ได้บ่อยกว่าคนทั่วไป</p>
    ${navBar('/whitelist')}

    <div class="card">
        <h3>➕ เพิ่มผู้ใช้</h3>
        <div class="add-row">
            <input type="text" id="newUserId" placeholder="Discord User ID เช่น 661415152146710558">
            <button onclick="addUser()">➕ เพิ่ม</button>
        </div>
    </div>

    <div class="card">
        <h3>👥 รายชื่อ Whitelist (${list.length} คน)</h3>
        ${list.length > 0 ? `
        <table>
            <thead><tr>
                <th>User ID</th>
                <th>เพิ่มโดย</th>
                <th style="text-align:center;">จัดการ</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>` : `<div style="text-align:center;color:var(--text3);padding:24px 0;">ยังไม่มีรายชื่อ</div>`}
    </div>
</div>
<script>
async function addUser(){
    const userId=document.getElementById('newUserId').value.trim();
    if(!userId) return alert('กรุณากรอก User ID');
    const r=await fetch('/api/whitelist/add',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify({userId})});
    const d=await r.json();
    if(d.success) location.reload(); else alert('Error: '+(d.error||'Unknown'));
}
async function removeUser(userId){
    if(!confirm('ลบ '+userId+' ออกจาก whitelist?')) return;
    const r=await fetch('/api/whitelist/remove',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify({userId})});
    const d=await r.json();
    if(d.success) location.reload(); else alert('Error: '+(d.error||'Unknown'));
}
</script></body></html>`);
});

// ════════════════════════════════════════════════════════════════════════════
//  ✅  หน้า APPROVED GUILDS
// ════════════════════════════════════════════════════════════════════════════
app.get("/approved", async (req, res) => {
    if (!client.isReady()) {
        return res.send(`<!DOCTYPE html><html><head><title>Loading…</title><meta http-equiv="refresh" content="3"><style>body{background:#0a0612;color:#a855f7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style></head><body><div style="text-align:center;"><div style="font-size:2em;margin-bottom:12px;">⏳</div><h2>Bot กำลังเริ่มต้น กรุณารอสักครู่...</h2></div></body></html>`);
    }
    const approvedList = await sessionManager.ApprovedGuildModel.find({}).catch(() => []);
    const rows = approvedList.map(a => {
        const guild = client.guilds.cache.get(a.guildId);
        const name = guild ? escapeHtml(guild.name) : 'ไม่พบในบอท';
        const members = guild ? guild.memberCount.toLocaleString() : '-';
        const approvedAt = a.approvedAt ? new Date(a.approvedAt).toLocaleString('th-TH',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '-';
        return `<tr>
            <td><span style="font-family:monospace;font-size:0.82em;color:var(--text3);">${a.guildId}</span></td>
            <td style="font-weight:bold;color:var(--text);">${name}</td>
            <td style="text-align:center;color:var(--text2);">${members}</td>
            <td style="color:var(--text3);font-size:0.82em;">${approvedAt}</td>
            <td>
                <div style="display:flex;gap:6px;justify-content:center;">
                    <button onclick="removeGuild('${a.guildId}')" style="background:#450a0a;color:var(--red);border:1px solid #f8717133;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.8em;">ลบ</button>
                    <button onclick="kickGuild('${a.guildId}')" style="background:#451a03;color:#fb923c;border:1px solid #fb923c33;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.8em;">เตะบอท</button>
                </div>
            </td>
        </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Approved Guilds — Enterprise</title>
<style>${THEME_CSS}
h2{font-size:1.3em;font-weight:900;margin-bottom:4px;background:linear-gradient(135deg,#a855f7,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.sub{color:var(--text3);font-size:0.82em;margin-bottom:18px;}
</style></head><body>
<div class="container" style="max-width:900px;">
    <h2>✅ Approved Guilds</h2>
    <p class="sub">${approvedList.length} เซิร์ฟเวอร์ที่ได้รับการอนุมัติ</p>
    ${navBar('/approved')}
    <div class="card">
        ${approvedList.length > 0 ? `
        <table>
            <thead><tr>
                <th>Guild ID</th>
                <th>ชื่อเซิร์ฟเวอร์</th>
                <th style="text-align:center;">สมาชิก</th>
                <th>อนุมัติเมื่อ</th>
                <th style="text-align:center;">จัดการ</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>` : `<div style="text-align:center;color:var(--text3);padding:32px 0;">ยังไม่มีเซิร์ฟเวอร์ที่อนุมัติ</div>`}
    </div>
</div>
<script>
async function removeGuild(guildId){
    if(!confirm('ลบ '+guildId+' ออกจาก Approved list?')) return;
    const r=await fetch('/api/approved/remove',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify({guildId})});
    const d=await r.json();
    if(d.success) location.reload(); else alert('Error: '+(d.error||'Unknown'));
}
async function kickGuild(guildId){
    if(!confirm('เตะบอทออกจาก '+guildId+' และลบออกจาก Approved?')) return;
    const r=await fetch('/api/approved/kick',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify({guildId})});
    const d=await r.json();
    if(d.success) location.reload(); else alert('Error: '+(d.error||'Unknown'));
}
</script></body></html>`);
});

// ════════════════════════════════════════════════════════════════════════════
//  📜  หน้า LOGS
// ════════════════════════════════════════════════════════════════════════════
app.get("/logs", (req, res) => {
    const logsHtml = webLogs.slice().reverse().map(l =>
        `<div class="log-line ${l.type}">[${l.time}] ${l.msg.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`
    ).join('');

    res.send(`<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Logs — Enterprise</title>
<style>${THEME_CSS}
h2{font-size:1.3em;font-weight:900;margin-bottom:4px;background:linear-gradient(135deg,#a855f7,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.sub{color:var(--text3);font-size:0.82em;margin-bottom:18px;}
.terminal{height:70vh;}
</style></head><body>
<div class="container" style="max-width:800px;">
    <h2>📜 System Logs</h2>
    <p class="sub">${webLogs.length} / ${MAX_LOGS} รายการล่าสุด</p>
    ${navBar('/logs')}
    <div class="terminal" id="terminal">${logsHtml}</div>
</div>
<script>
document.getElementById('terminal').scrollTop = document.getElementById('terminal').scrollHeight;
setTimeout(()=>location.reload(),10000);
</script></body></html>`);
});

// ════════════════════════════════════════════════════════════════════════════
//  🔊  หน้า VOICE LOG
// ════════════════════════════════════════════════════════════════════════════
app.get("/logs/voice", (req, res) => {
    const logs = voiceWorker.getVoiceLogs();
    const colorMap = {connect:'var(--green)',recover:'var(--blue)',drop:'var(--yellow)',disconnect:'#fb923c',fail:'var(--red)'};
    const iconMap  = {connect:'🟢',recover:'💖',drop:'⚡',disconnect:'⚠️',fail:'💔'};
    const labelMap = {connect:'เชื่อมต่อ',recover:'กู้คืน',drop:'หลุด (ด่วน)',disconnect:'หลุด',fail:'ล้มเหลว'};
    const summary  = {connect:0,recover:0,drop:0,disconnect:0,fail:0};
    logs.forEach(e=>{if(summary[e.type]!==undefined) summary[e.type]++;});

    const rows = logs.length === 0
        ? `<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--text3);">ยังไม่มี Event — บอทยังไม่ได้เชื่อมต่อ Voice</td></tr>`
        : logs.map(e=>{
            const t = new Date(e.ts).toLocaleTimeString('th-TH',{hour12:false});
            return `<tr>
                <td style="color:var(--text3);white-space:nowrap;font-size:0.82em;">${t}</td>
                <td style="color:${colorMap[e.type]||'var(--text2)'};font-weight:bold;">${iconMap[e.type]||'❓'} ${labelMap[e.type]||e.type}</td>
                <td style="font-family:monospace;font-size:0.78em;color:var(--text2);">${e.sessionId}</td>
                <td style="color:var(--text3);font-size:0.82em;">${e.detail||'-'}</td>
            </tr>`;
        }).join('');

    res.send(`<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Voice Log — Enterprise</title>
<style>${THEME_CSS}
h2{font-size:1.3em;font-weight:900;margin-bottom:4px;background:linear-gradient(135deg,#a855f7,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.sub{color:var(--text3);font-size:0.82em;margin-bottom:18px;}
</style></head><body>
<div class="container" style="max-width:960px;">
    <h2>🔊 Voice Connection Log</h2>
    <p class="sub">อัปเดตทุก 15 วิ — เก็บ ${logs.length}/200 events ล่าสุด</p>
    ${navBar('/logs/voice')}
    <div class="voice-row" style="margin-bottom:18px;">
        <div class="voice-box"><div class="vval" style="color:var(--green);">${summary.connect}</div><div class="vlbl">🟢 เชื่อมต่อ</div></div>
        <div class="voice-box"><div class="vval" style="color:var(--blue);">${summary.recover}</div><div class="vlbl">💖 กู้คืน</div></div>
        <div class="voice-box"><div class="vval" style="color:var(--yellow);">${summary.drop}</div><div class="vlbl">⚡ หลุด (ด่วน)</div></div>
        <div class="voice-box"><div class="vval" style="color:#fb923c;">${summary.disconnect}</div><div class="vlbl">⚠️ หลุด</div></div>
        <div class="voice-box"><div class="vval" style="color:var(--red);">${summary.fail}</div><div class="vlbl">💔 ล้มเหลว</div></div>
    </div>
    <div class="card" style="padding:0;overflow:hidden;">
        <table>
            <thead><tr>
                <th>เวลา</th><th>สถานะ</th><th>Session ID</th><th>รายละเอียด</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>
</div>
<script>setTimeout(()=>location.reload(),15000);</script>
</body></html>`);
});

// ════════════════════════════════════════════════════════════════════════════
//  ⚡  หน้า COMMANDS DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
app.get("/commands", (req, res) => {
    const CATEGORIES = [
        {label:'🔊 Voice System', names:['panel']},
        {label:'📊 ข้อมูล', names:['ping','stats','serverinfo','userinfo','help']},
        {label:'🛡️ จัดการ', names:['ban','kick','timeout','clear','voicekickall']},
        {label:'🔧 ยูทิลิตี้', names:['say','announce','steal','backup','restore','setup-log','whitelist']}
    ];
    const allCmds = commands.slashCommandsData || [];
    const totalCount   = allCmds.length;
    const disabledCount= [...disabledCommands].filter(n=>allCmds.find(c=>c.name===n)).length;
    const enabledCount = totalCount - disabledCount;

    const categoryHtml = CATEGORIES.map(cat => {
        const rows = cat.names.map(name => {
            const cmd = allCmds.find(c=>c.name===name);
            if(!cmd) return '';
            const isEnabled = !disabledCommands.has(name);
            return `<div class="cmd-row">
                <span class="cmd-name">/${escapeHtml(name)}</span>
                <span class="cmd-desc">${escapeHtml(cmd.description||'')}</span>
                <span class="badge ${isEnabled?'badge-on':'badge-off'}" id="badge-${name}">${isEnabled?'เปิด':'ปิด'}</span>
                <label class="toggle" id="tog-wrap-${name}">
                    <input type="checkbox" ${isEnabled?'checked':''} onchange="toggleCmd('${name}',this.checked)" id="tog-${name}">
                    <span class="slider"></span>
                </label>
            </div>`;
        }).join('');
        if(!rows.trim()) return '';
        return `<div class="card"><h3>${cat.label}</h3>${rows}</div>`;
    }).join('');

    res.send(`<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Commands — Enterprise</title>
<style>${THEME_CSS}
h2{font-size:1.3em;font-weight:900;margin-bottom:4px;background:linear-gradient(135deg,#a855f7,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.sub{color:var(--text3);font-size:0.82em;margin-bottom:18px;}
.stat-bar{display:flex;gap:10px;margin-bottom:16px;}
.stat-pill{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 16px;text-align:center;flex:1;}
.stat-pill .val{font-size:1.5em;font-weight:900;}
.stat-pill .lbl{font-size:0.7em;color:var(--text3);margin-top:3px;}
.audit-table td{font-size:0.8em;}
</style></head><body>
<div class="container" style="max-width:800px;">
    <h2>⚡ Commands Dashboard</h2>
    <p class="sub">เปิด/ปิดคำสั่ง Slash Commands — มีผลทันที</p>
    ${navBar('/commands')}

    <div class="stat-bar">
        <div class="stat-pill"><div class="val" id="stTotal" style="color:var(--accent3);">${totalCount}</div><div class="lbl">คำสั่งทั้งหมด</div></div>
        <div class="stat-pill"><div class="val" id="stEnabled" style="color:var(--green);">${enabledCount}</div><div class="lbl">กำลังเปิดใช้</div></div>
        <div class="stat-pill"><div class="val" id="stDisabled" style="color:var(--red);">${disabledCount}</div><div class="lbl">ปิดใช้งาน</div></div>
    </div>

    ${categoryHtml}

    <div class="card">
        <h3>📋 Audit Log — ประวัติการเปิด/ปิด <span id="auditCount" style="color:var(--text3);font-size:0.85em;font-weight:normal;text-transform:none;letter-spacing:0;"></span></h3>
        <div id="auditBody" style="font-size:0.82em;color:var(--text3);text-align:center;padding:18px 0;">กำลังโหลด...</div>
    </div>
</div>
<div class="toast" id="toast"></div>
<script>
const SECRET='${API_SECRET}';
function showToast(msg,ok){
    const t=document.getElementById('toast');
    t.textContent=msg; t.className='toast '+(ok?'ok':'err');
    t.style.display='block';
    clearTimeout(t._t); t._t=setTimeout(()=>t.style.display='none',3500);
}
function updateStats(){
    const all=document.querySelectorAll('.toggle input');
    const en=[...all].filter(i=>i.checked).length;
    document.getElementById('stTotal').textContent=all.length;
    document.getElementById('stEnabled').textContent=en;
    document.getElementById('stDisabled').textContent=all.length-en;
}
async function toggleCmd(name,want){
    const inp=document.getElementById('tog-'+name);
    const badge=document.getElementById('badge-'+name);
    const wrap=document.getElementById('tog-wrap-'+name);
    if(wrap) wrap.classList.add('loading');
    try {
        const r=await fetch('/api/commands/toggle',{method:'POST',headers:{'Content-Type':'application/json','Authorization':SECRET},body:JSON.stringify({commandName:name})});
        const d=await r.json();
        if(d.success){
            const on=d.enabled;
            if(inp) inp.checked=on;
            if(badge){badge.textContent=on?'เปิด':'ปิด';badge.className='badge '+(on?'badge-on':'badge-off');}
            updateStats();
            showToast((on?'✅ เปิด':'❌ ปิด')+' /'+name+' แล้ว',true);
            fetchAuditLog();
        } else {
            if(inp) inp.checked=!want;
            showToast('❌ '+(d.error||'เกิดข้อผิดพลาด'),false);
        }
    } catch(e){if(inp) inp.checked=!want; showToast('❌ เชื่อมต่อไม่ได้',false);}
    if(wrap) wrap.classList.remove('loading');
}
function fmtTime(ts){
    const d=new Date(ts),pad=n=>String(n).padStart(2,'0');
    return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+d.getFullYear()+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
}
async function fetchAuditLog(){
    try {
        const r=await fetch('/api/commands-audit'); const d=await r.json();
        const body=document.getElementById('auditBody');
        const cnt=document.getElementById('auditCount');
        if(!d.success||!d.log.length){
            body.innerHTML='<span style="color:var(--text3);">ยังไม่มีประวัติ — กด toggle คำสั่งใดก็ได้เพื่อเริ่ม</span>';
            cnt.textContent=''; return;
        }
        cnt.textContent='('+d.log.length+' รายการ)';
        body.innerHTML='<table><thead><tr>'+
            '<th>เวลา</th><th>คำสั่ง</th><th style="text-align:center;">การกระทำ</th><th>IP</th>'+
            '</tr></thead><tbody>'+
            d.log.slice(0,30).map(e=>'<tr>'+
                '<td style="color:var(--text3);white-space:nowrap;">'+fmtTime(e.timestamp)+'</td>'+
                '<td style="font-family:monospace;color:var(--accent3);">/'+e.commandName+'</td>'+
                '<td style="text-align:center;">'+(e.action==='enabled'
                    ? '<span class="badge badge-on">เปิด ✅</span>'
                    : '<span class="badge badge-off">ปิด ❌</span>')+'</td>'+
                '<td style="color:var(--text3);font-family:monospace;font-size:0.82em;">'+e.ip+'</td>'+
                '</tr>').join('')+
            '</tbody></table>';
    } catch(e){ document.getElementById('auditBody').textContent='⚠️ ดึงข้อมูลไม่ได้'; }
}
fetchAuditLog(); setInterval(fetchAuditLog,15000);
</script></body></html>`);
});

// ════════════════════════════════════════════════════════════════════════════
//  📋  SESSION DETAIL PAGE
// ════════════════════════════════════════════════════════════════════════════
app.get("/session/:sessionId", (req, res) => {
    const safeId = escapeHtml(req.params.sessionId);
    res.send(`<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Session Detail — Enterprise</title>
<style>${THEME_CSS}
h1{font-size:1.2em;font-weight:900;color:var(--accent3);margin-bottom:4px;}
.sub{color:var(--text3);font-size:0.78em;margin-bottom:16px;}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;}
@media(max-width:500px){.grid2{grid-template-columns:1fr;}}
.info-row{display:flex;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--bg3);font-size:0.83em;gap:8px;}
.info-row:last-child{border-bottom:none;}
.info-label{color:var(--text3);flex-shrink:0;}
.info-value{color:var(--text);text-align:right;word-break:break-all;}
.big-stat{text-align:center;padding:12px 0;}
.big-num{font-size:2em;font-weight:900;line-height:1.1;}
.big-lbl{font-size:0.68em;color:var(--text3);margin-top:4px;text-transform:uppercase;letter-spacing:.5px;}
.stop-zone{background:var(--card);border:1px solid #f8717133;border-radius:14px;padding:20px;text-align:center;margin-bottom:20px;}
.stop-zone p{color:var(--text3);font-size:0.8em;margin-bottom:14px;line-height:1.6;}
.btn-stop{background:linear-gradient(135deg,#7f1d1d,#f87171);color:#fff;border:none;padding:11px 28px;border-radius:10px;font-weight:bold;font-size:0.9em;cursor:pointer;transition:all .15s;}
.btn-stop:hover{box-shadow:0 0 16px #f8717155;}
.btn-stop:disabled{background:var(--bg3);color:var(--text3);cursor:not-allowed;box-shadow:none;}
.log-table{width:100%;border-collapse:collapse;font-size:0.78em;}
.log-table th{text-align:left;padding:6px 8px;color:var(--text3);border-bottom:1px solid var(--border);}
.log-table td{padding:6px 8px;border-bottom:1px solid var(--bg3);}
.log-table tr:last-child td{border-bottom:none;}
.ev-connect{color:var(--green);} .ev-recover{color:var(--blue);}
.ev-drop{color:var(--yellow);} .ev-disconnect{color:#fb923c;} .ev-fail{color:var(--red);}
#notFound{text-align:center;padding:60px 20px;color:var(--text3);}
</style></head><body>
<div class="container">
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap;">
        <a href="/" style="background:var(--card);color:var(--accent3);padding:7px 14px;border-radius:8px;text-decoration:none;font-size:0.82em;border:1px solid var(--border);">← หน้าหลัก</a>
        <span style="color:var(--text3);font-size:0.8em;">Session Detail</span>
    </div>

    <div id="notFound" style="display:none;">
        <div style="font-size:2.5em;margin-bottom:12px;">❌</div>
        <h2 style="color:var(--red);margin-bottom:8px;">ไม่พบ Session นี้</h2>
        <p style="font-size:0.85em;">Session อาจหยุดทำงานแล้ว หรือ ID ไม่ถูกต้อง</p>
        <a href="/" style="color:var(--accent3);font-size:0.82em;">← กลับหน้าหลัก</a>
    </div>

    <div id="pageContent">
        <h1 id="pageTitle">⏳ กำลังโหลด...</h1>
        <p class="sub" id="pageSubtitle"></p>

        <div class="status-bar">
            <div class="dot" id="sDot"></div>
            <span id="sTxt" style="font-weight:700;">กำลังตรวจสอบ...</span>
            <span id="uptimeLive" style="color:var(--yellow);font-size:0.82em;margin-left:auto;"></span>
        </div>

        <div class="grid2">
            <div class="card">
                <h3>📋 ข้อมูล Session</h3>
                <div class="info-row"><span class="info-label">เซิร์ฟเวอร์</span><span class="info-value" id="iServer">--</span></div>
                <div class="info-row"><span class="info-label">ช่องเสียง</span><span class="info-value" id="iVoice">--</span></div>
                <div class="info-row"><span class="info-label">เจ้าของ</span><span class="info-value" id="iOwner">--</span></div>
                <div class="info-row"><span class="info-label">เริ่มออนเมื่อ</span><span class="info-value" id="iStarted">--</span></div>
                <div class="info-row"><span class="info-label">ใช้งานล่าสุด</span><span class="info-value" id="iActivity">--</span></div>
                <div class="info-row"><span class="info-label">Session ID</span><span class="info-value" id="iSid" style="font-family:monospace;font-size:0.75em;color:var(--text3);">--</span></div>
            </div>
            <div class="card">
                <h3>📊 สถิติ</h3>
                <div class="big-stat">
                    <div class="big-num" id="sUptime" style="color:var(--yellow);">--</div>
                    <div class="big-lbl">⏱ เวลาออนทั้งหมด</div>
                </div>
                <div style="border-top:1px solid var(--border);margin:10px 0;"></div>
                <div class="info-row"><span class="info-label">🔄 Reconnect</span><span class="info-value" id="sReconnect" style="color:#fb923c;">--</span></div>
                <div class="info-row"><span class="info-label">สถานะ</span><span class="info-value" id="sStatus">--</span></div>
                <div class="info-row"><span class="info-label">🔑 Token</span><span class="info-value" id="sTokenHealth">--</span></div>
            </div>
        </div>

        <!-- Token Card -->
        <div class="card">
            <h3>🔑 Token</h3>
            <div id="tokenDisplay"></div>
            <div style="font-size:0.72em;color:var(--text3);margin-top:6px;" id="revealHint">คลิกที่ Token เพื่อดูแบบเต็ม (ต้องใช้รหัสผ่าน)</div>
            <div class="reveal-bar" id="revealBarDetail"></div>
        </div>

        <!-- Voice Log Card -->
        <div class="card">
            <h3>📡 ประวัติการเชื่อมต่อ <span id="logCount" style="color:var(--text3);font-weight:normal;text-transform:none;letter-spacing:0;font-size:0.9em;"></span></h3>
            <div id="logTableWrap">
                <p style="color:var(--text3);font-size:0.82em;text-align:center;padding:20px 0;">ยังไม่มีประวัติ</p>
            </div>
        </div>

        <!-- Stop Zone -->
        <div class="stop-zone">
            <h3 style="color:var(--red);margin-bottom:8px;">🛑 หยุด Session นี้</h3>
            <p>เมื่อหยุดแล้ว บอทจะออกจากช่องเสียงทันที<br>เจ้าของจะได้รับแจ้งเตือนทาง DM</p>
            <button class="btn-stop" id="btnStop" onclick="openStopModal()">🛑 หยุด Session นี้</button>
        </div>
    </div>
</div>

<!-- Token Reveal Modal -->
<div class="modal" id="tokenModal" onclick="if(event.target===this)closeTokenModal()">
    <div class="modal-box">
        <button onclick="closeTokenModal()" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--text3);font-size:1.1em;cursor:pointer;">✕</button>
        <div style="font-size:1.6em;margin-bottom:8px;">🔑</div>
        <h3 style="color:var(--yellow);margin-bottom:6px;font-size:1em;">ดู Token เต็ม</h3>
        <p style="color:var(--text3);font-size:0.78em;margin-bottom:16px;">กรอกรหัสผ่านเพื่อดู Token เป็นเวลา 5 นาที</p>
        <p id="tokenErr" style="color:var(--red);font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
        <input id="tokenPin" type="password" placeholder="รหัสผ่านลับ..." style="text-align:center;margin-bottom:12px;">
        <button onclick="submitReveal()" class="btn btn-purple">✅ เปิดดู Token</button>
    </div>
</div>

<!-- Stop Modal -->
<div class="modal" id="stopModal" onclick="if(event.target===this)closeStopModal()">
    <div class="modal-box">
        <button onclick="closeStopModal()" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--text3);font-size:1.1em;cursor:pointer;">✕</button>
        <div style="font-size:1.6em;margin-bottom:8px;">🛑</div>
        <h3 style="color:var(--red);margin-bottom:6px;font-size:1em;">ยืนยันการหยุด</h3>
        <p style="color:var(--text3);font-size:0.78em;margin-bottom:16px;">กรอกรหัสผ่านเพื่อยืนยัน</p>
        <p id="stopErr" style="color:var(--red);font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
        <input id="stopPin" type="password" placeholder="รหัสผ่านลับ..." style="text-align:center;margin-bottom:12px;">
        <button onclick="submitStop()" class="btn btn-red">🛑 หยุด Session</button>
    </div>
</div>

<script>
const SESSION_ID='${safeId}';
let sessionData=null;
const revealState={expiry:0,token:null,_timer:null};

function fmtMs(ms){
    const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000);
    if(h>0) return h+'h '+m+'m';
    if(m>0) return m+'m '+s+'s';
    return s+'s';
}
function fmtTime(ts){ return new Date(ts).toLocaleString('th-TH',{hour12:false}); }
function fmtAgo(ts){
    const diff=Math.floor((Date.now()-ts)/1000);
    if(diff<60) return diff+' วินาทีที่แล้ว';
    if(diff<3600) return Math.floor(diff/60)+' นาทีที่แล้ว';
    if(diff<86400) return Math.floor(diff/3600)+' ชั่วโมงที่แล้ว';
    return Math.floor(diff/86400)+' วันที่แล้ว';
}

async function fetchDetail(){
    try {
        const r=await fetch('/api/session/'+SESSION_ID);
        const d=await r.json();
        if(!d.found){
            document.getElementById('pageContent').style.display='none';
            document.getElementById('notFound').style.display='block';
            return;
        }
        sessionData=d; renderDetail(d);
    } catch(e){}
}

function renderDetail(d){
    document.getElementById('pageTitle').textContent='🖥️ '+(d.serverName||'Unknown');
    document.getElementById('pageSubtitle').textContent='Session ID: '+d.sessionId;
    document.getElementById('sDot').className='dot online';
    document.getElementById('sTxt').textContent='🟢 กำลังออนอยู่';
    document.getElementById('sTxt').style.color='var(--green)';
    const uptimeMs=Date.now()-d.startedAt;
    document.getElementById('uptimeLive').textContent='⏱ '+fmtMs(uptimeMs);
    document.getElementById('sUptime').textContent=fmtMs(uptimeMs);
    document.getElementById('iServer').textContent=d.serverName||'-';
    document.getElementById('iVoice').textContent='#'+d.voiceId;
    document.getElementById('iOwner').textContent=d.ownerTag||d.ownerId||'-';
    document.getElementById('iStarted').textContent=fmtTime(d.startedAt);
    document.getElementById('iActivity').textContent=d.lastActivity?fmtAgo(d.lastActivity):'-';
    document.getElementById('iSid').textContent=d.sessionId;
    const rc=d.reconnectCount||0;
    document.getElementById('sReconnect').textContent=rc>0?rc+' ครั้ง':'ยังไม่มี';
    document.getElementById('sStatus').innerHTML='<span style="color:var(--green);">🟢 Online</span>';
    document.getElementById('sTokenHealth').innerHTML=d.tokenInvalid
        ?'<span style="color:var(--red);">❌ มีปัญหา</span>'
        :'<span style="color:var(--green);">✅ ปกติ</span>';
    renderToken(d.tokenTail);
    renderLogs(d.voiceLogs||[]);
}

function renderToken(tail){
    const masked=tail?tail.substring(0,2)+'••••'+tail.substring(tail.length-2):'••••••••';
    const wrap=document.getElementById('tokenDisplay');
    const hint=document.getElementById('revealHint');
    if(revealState.expiry>Date.now()&&revealState.token){
        const safe=revealState.token.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        wrap.innerHTML='<div class="token-full-wrap"><span style="flex:1">'+revealState.token+'</span><button class="copy-btn" onclick="navigator.clipboard.writeText(\''+safe+'\');this.textContent=\'✅\';setTimeout(()=>this.textContent=\'📋\',1500)">📋</button></div>';
        hint.style.display='none';
    } else {
        wrap.innerHTML='<span class="token-masked" onclick="openRevealModal()" title="คลิกเพื่อดู Token เต็ม">🔑 '+masked+'</span>';
        hint.style.display='block';
    }
}

function renderLogs(logs){
    const wrap=document.getElementById('logTableWrap');
    document.getElementById('logCount').textContent=' — '+logs.length+' รายการ';
    if(!logs.length){ wrap.innerHTML='<p style="color:var(--text3);font-size:0.82em;text-align:center;padding:20px 0;">ยังไม่มีประวัติ</p>'; return; }
    const colorCls={connect:'ev-connect',recover:'ev-recover',drop:'ev-drop',disconnect:'ev-disconnect',fail:'ev-fail'};
    const icon={connect:'🟢',recover:'💖',drop:'⚡',disconnect:'⚠️',fail:'💔'};
    const label={connect:'เชื่อมต่อสำเร็จ',recover:'กู้คืนสัญญาณ',drop:'สัญญาณหลุด (ด่วน)',disconnect:'หลุดการเชื่อมต่อ',fail:'เชื่อมต่อไม่สำเร็จ'};
    wrap.innerHTML='<table class="log-table"><thead><tr><th>เวลา</th><th>สถานะ</th><th>รายละเอียด</th></tr></thead><tbody>'+
        logs.map(l=>'<tr><td style="color:var(--text3);white-space:nowrap;">'+new Date(l.ts).toLocaleTimeString('th-TH',{hour12:false})+'</td>'+
            '<td class="'+(colorCls[l.type]||'')+'">'+icon[l.type]||'❓'+' '+(label[l.type]||l.type)+'</td>'+
            '<td style="color:var(--text3);">'+(l.detail||'-')+'</td></tr>').join('')+
        '</tbody></table>';
}

function openRevealModal(){
    if(revealState.expiry>Date.now()) return;
    document.getElementById('tokenErr').style.display='none';
    document.getElementById('tokenPin').value='';
    document.getElementById('tokenModal').style.display='flex';
    setTimeout(()=>document.getElementById('tokenPin').focus(),80);
}
function closeTokenModal(){ document.getElementById('tokenModal').style.display='none'; }

async function submitReveal(){
    const pin=document.getElementById('tokenPin').value; if(!pin) return;
    try {
        const r=await fetch('/api/reveal-all-tokens',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
        const data=await r.json();
        if(!data.success){
            document.getElementById('tokenErr').textContent=data.error||'รหัสผ่านไม่ถูกต้อง';
            document.getElementById('tokenErr').style.display='block';
            document.getElementById('tokenPin').value=''; document.getElementById('tokenPin').focus(); return;
        }
        closeTokenModal();
        revealState.expiry=Date.now()+5*60*1000;
        revealState.token=data.tokens[SESSION_ID]||null;
        if(sessionData) renderToken(sessionData.tokenTail);
        startRevealBar();
    } catch(e){ document.getElementById('tokenErr').textContent='เกิดข้อผิดพลาด'; document.getElementById('tokenErr').style.display='block'; }
}

function startRevealBar(){
    const bar=document.getElementById('revealBarDetail'); if(!bar) return;
    if(revealState._timer) clearInterval(revealState._timer);
    bar.style.display='block';
    revealState._timer=setInterval(()=>{
        const left=revealState.expiry-Date.now();
        if(left<=0){ clearInterval(revealState._timer); revealState._timer=null; revealState.token=null; revealState.expiry=0; bar.style.display='none'; if(sessionData) renderToken(sessionData.tokenTail); return; }
        const m=Math.floor(left/60000),s=Math.floor((left%60000)/1000);
        bar.textContent='🔓 Token เต็มโชว์อยู่ — ซ่อนอีก '+m+':'+String(s).padStart(2,'0')+' นาที';
    },1000);
}

function openStopModal(){ document.getElementById('stopErr').style.display='none'; document.getElementById('stopPin').value=''; document.getElementById('stopModal').style.display='flex'; setTimeout(()=>document.getElementById('stopPin').focus(),80); }
function closeStopModal(){ document.getElementById('stopModal').style.display='none'; }

async function submitStop(){
    const pin=document.getElementById('stopPin').value; if(!pin) return;
    const btn=document.getElementById('btnStop');
    try {
        const r=await fetch('/api/stop-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:SESSION_ID,pin})});
        const data=await r.json();
        if(!data.success){
            document.getElementById('stopErr').textContent=data.error||'รหัสผ่านไม่ถูกต้อง';
            document.getElementById('stopErr').style.display='block';
                      document.getElementById('stopPin').value=''; document.getElementById('stopPin').focus(); return;
                  }
                  closeStopModal();
                  btn.textContent='✅ หยุดแล้ว'; btn.disabled=true;
                  document.getElementById('sDot').className='dot offline';
                  document.getElementById('sTxt').textContent='🔴 หยุดทำงานแล้ว';
                  document.getElementById('sTxt').style.color='var(--red)';
                  document.getElementById('uptimeLive').textContent='';
                  document.getElementById('sStatus').innerHTML='<span style="color:var(--red);">🔴 Stopped</span>';
                  setTimeout(()=>{ window.location.href='/'; },2500);
              } catch(e){ document.getElementById('stopErr').textContent='เกิดข้อผิดพลาด'; document.getElementById('stopErr').style.display='block'; }
          }

          document.addEventListener('keydown',e=>{
              if(e.key==='Escape'){ closeTokenModal(); closeStopModal(); }
              if(e.key==='Enter'){
                  if(document.getElementById('tokenModal').style.display==='flex') submitReveal();
                  if(document.getElementById('stopModal').style.display==='flex') submitStop();
              }
          });

          fetchDetail();
          setInterval(fetchDetail,8000);
          </script></body></html>`);
          });

          // ════════════════════════════════════════════════════════════════════════════
          //  💓  PING / HEALTH
          // ════════════════════════════════════════════════════════════════════════════
          app.get("/ping", (req, res) => res.send("OK"));
          app.get("/health", (req, res) => {
              const uptimeSec = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000);
              res.json({ status:"ok", uptime:uptimeSec, sessions:sessionManager.getAllSessions().size, botOnline:client?.isReady?.()??false });
          });

          // ════════════════════════════════════════════════════════════════════════════
          //  📊  API STATUS
          // ════════════════════════════════════════════════════════════════════════════
          app.get("/api/status", (req, res) => {
              try {
                  const sessions = Array.from(sessionManager.getAllSessions().values());
                  const uptimeSec = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000);
                  const mem = process.memoryUsage();
                  const voiceLogs = voiceWorker.getVoiceLogs();
                  const voiceSummary = {connect:0,recover:0,drop:0,disconnect:0,fail:0};
                  voiceLogs.forEach(e=>{ if(voiceSummary[e.type]!==undefined) voiceSummary[e.type]++; });
                  const totalReq = sessionManager.systemMetrics.requests;
                  const totalErr = sessionManager.systemMetrics.errors;
                  const reconnects = sessionManager.systemMetrics.reconnects;
                  const successRate = totalReq>0 ? (((totalReq-totalErr)/totalReq)*100).toFixed(1) : '100.0';
                  const recentLogs = webLogs.slice(-60).reverse();
                  const botOnlineSec = botReadyAt ? Math.floor((Date.now()-botReadyAt)/1000) : null;
                  res.json({
                      botOnline: client?.isReady?.()??false,
                      botTag: client?.user?.tag??null,
                      uptimeSec, botOnlineSec,
                      sessions: sessions.length,
                      maxSessions: config.limits.maxSessions,
                      sessionList: sessions.map(s=>({
                          sessionId:s.sessionId, serverName:s.serverName,
                          ownerId:s.ownerId, ownerTag:s.ownerTag,
                          tokenTail:s.tokenTail, startedAt:s.startedAt,
                          reconnectCount:s.reconnectCount||0
                      })),
                      clientPool: voiceWorker.getClientPoolSize(),
                      ramMB: (mem.heapUsed/1024/1024).toFixed(1),
                      ramTotalMB: (mem.heapTotal/1024/1024).toFixed(1),
                      reconnects, successRate, voiceSummary, recentLogs
                  });
              } catch(e) { res.status(500).json({error:e.message}); }
          });

          // ════════════════════════════════════════════════════════════════════════════
          //  🔑  REVEAL TOKEN ENDPOINTS
          // ════════════════════════════════════════════════════════════════════════════
          const revealTokenAttempts = new Map();
          const REVEAL_MAX = 5;
          const REVEAL_LOCKOUT = 15 * 60 * 1000;

          function checkRevealPin(req, res) {
              const ip = req.ip;
              const now = Date.now();
              const rec = revealTokenAttempts.get(ip) || {count:0, lockedUntil:0};
              if(rec.lockedUntil > now) {
                  const mins = Math.ceil((rec.lockedUntil-now)/60000);
                  res.status(429).json({success:false, error:`ลองผิดเกินกำหนด ล็อค ${mins} นาที`});
                  return null;
              }
              const { pin } = req.body || {};
              const webPin = (typeof getWebPin==='function') ? getWebPin() : null;
              if(!webPin || pin !== webPin) {
                  rec.count = (rec.count||0)+1;
                  if(rec.count >= REVEAL_MAX) { rec.lockedUntil = now+REVEAL_LOCKOUT; rec.count=0; }
                  revealTokenAttempts.set(ip, rec);
                  logIntrusion(ip, req.path);
                  res.status(401).json({success:false, error:'PIN ไม่ถูกต้อง'});
                  return null;
              }
              revealTokenAttempts.delete(ip);
              return true;
          }

          app.post("/api/reveal-token", express.json(), (req, res) => {
              try {
                  if(!checkRevealPin(req, res)) return;
                  const { sessionId } = req.body || {};
                  const token = sessionManager.getToken(sessionId);
                  if(!token) return res.status(404).json({success:false, error:'ไม่พบ session นี้'});
                  res.json({success:true, token});
              } catch(e) { res.status(500).json({success:false, error:e.message}); }
          });

          app.post("/api/reveal-all-tokens", express.json(), (req, res) => {
              try {
                  if(!checkRevealPin(req, res)) return;
                  const allSessions = Array.from(sessionManager.getAllSessions().values());
                  const tokens = {};
                  for(const s of allSessions) {
                      const tok = sessionManager.getToken(s.sessionId);
                      if(tok) tokens[s.sessionId] = tok;
                  }
                  res.json({success:true, tokens});
              } catch(e) { res.status(500).json({success:false, error:e.message}); }
          });

          app.get("/api/session/:sessionId", (req, res) => {
              try {
                  const sid = req.params.sessionId;
                  const session = sessionManager.getSession(sid);
                  if(!session) return res.json({found:false});
                  const allLogs = voiceWorker.getVoiceLogs();
                  const sessionLogs = allLogs.filter(l=>l.sessionId===sid).slice(0,40);
                  res.json({
                      found:true, sessionId:session.sessionId,
                      serverName:session.serverName, serverId:session.serverId,
                      voiceId:session.voiceId, ownerId:session.ownerId,
                      ownerTag:session.ownerTag, tokenTail:session.tokenTail,
                      startedAt:session.startedAt, lastActivity:session.lastActivity,
                      reconnectCount:session.reconnectCount||0,
                      tokenInvalid:session.tokenInvalid||false, voiceLogs:sessionLogs
                  });
              } catch(e) { res.status(500).json({found:false, error:e.message}); }
          });

          app.post("/api/stop-session", express.json(), async (req, res) => {
              try {
                  if(!checkRevealPin(req, res)) return;
                  const { sessionId } = req.body || {};
                  if(!sessionId) return res.status(400).json({success:false, error:'ไม่ระบุ sessionId'});
                  const session = sessionManager.getSession(sessionId);
                  if(!session) return res.status(404).json({success:false, error:'ไม่พบ session'});
                  await voiceWorker.sendSessionStoppedDM(sessionId, 'manual');
                  await voiceWorker.stopSession(sessionId);
                  console.log(`[DASHBOARD] 🛑 Session ${sessionId} stopped via detail page`);
                  res.json({success:true});
              } catch(e) { res.status(500).json({success:false, error:e.message}); }
          });

          // ════════════════════════════════════════════════════════════════════════════
          //  🔌  API ENDPOINTS
          // ════════════════════════════════════════════════════════════════════════════
          function checkAuth(req, res) {
              const auth = req.headers.authorization || "";
              const authBuf = Buffer.from(auth,'utf8');
              const secretBuf = Buffer.from(API_SECRET,'utf8');
              if(authBuf.length !== secretBuf.length) { logIntrusion(req.ip, req.path); res.status(401).json({success:false,error:"Unauthorized"}); return false; }
              if(!crypto.timingSafeEqual(authBuf, secretBuf)) { logIntrusion(req.ip, req.path); res.status(401).json({success:false,error:"Unauthorized"}); return false; }
              return true;
          }

          function logIntrusion(ip, path) {
              console.error(`[SECURITY] 🚨 Unauthorized access on ${path} from IP: ${ip}`);
              if(process.env.WEBHOOK_LOG_URL) {
                  try {
                      const wh = new WebhookClient({url:process.env.WEBHOOK_LOG_URL});
                      wh.send({content:`🛑 **[INTRUSION]** \`${path}\` from \`${ip}\``}).catch(()=>{});
                      wh.destroy();
                  } catch(e) {}
              }
          }

          app.get("/api/commands-status", (req, res) => {
              try {
                  const allCmds = (commands.slashCommandsData||[]).map(cmd=>({name:cmd.name, description:cmd.description||'', enabled:!disabledCommands.has(cmd.name)}));
                  res.json({success:true, commands:allCmds, disabledCount:disabledCommands.size});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          app.post("/api/commands/toggle", express.json(), async (req, res) => {
              if(!checkAuth(req,res)) return;
              try {
                  const { commandName } = req.body||{};
                  if(!commandName||typeof commandName!=='string') return res.status(400).json({success:false,error:'ไม่ระบุชื่อคำสั่ง'});
                  const exists = (commands.slashCommandsData||[]).find(c=>c.name===commandName);
                  if(!exists) return res.status(404).json({success:false,error:`ไม่พบคำสั่ง /${commandName}`});
                  const toggleKey = `${req.ip}:${commandName}`;
                  const lastToggle = toggleCooldowns.get(toggleKey)||0;
                  if(Date.now()-lastToggle < 5000) {
                      const wait = ((5000-(Date.now()-lastToggle))/1000).toFixed(1);
                      return res.status(429).json({success:false,error:`กรุณารอ ${wait}s`});
                  }
                  toggleCooldowns.set(toggleKey, Date.now());
                  if(disabledCommands.has(commandName)) disabledCommands.delete(commandName);
                  else disabledCommands.add(commandName);
                  await sessionManager.setSetting('disabledCommands',[...disabledCommands]);
                  const nowEnabled = !disabledCommands.has(commandName);
                  const auditEntry = {commandName, action:nowEnabled?'enabled':'disabled', ip:req.ip, timestamp:Date.now()};
                  if(commandAuditLog.length>=100) commandAuditLog.shift();
                  commandAuditLog.push(auditEntry);
                  if(process.env.WEBHOOK_LOG_URL) {
                      try {
                          const wh = new WebhookClient({url:process.env.WEBHOOK_LOG_URL});
                          wh.send({content:`⚡ \`/${commandName}\` ถูก**${nowEnabled?'เปิด ✅':'ปิด ❌'}** โดย IP \`${req.ip}\``}).catch(()=>{});
                          wh.destroy();
                      } catch(e) {}
                  }
                  res.json({success:true, commandName, enabled:nowEnabled});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          app.get("/api/commands-audit", (req, res) => { if(!checkAuth(req,res)) return; res.json({success:true, log:[...commandAuditLog].reverse()}); });

          app.post("/api/approve", async (req, res) => {
              if(!checkAuth(req,res)) return;
              try {
                  const { guildId } = req.body;
                  if(!guildId||typeof guildId!=='string') return res.status(400).json({success:false,error:"Invalid guildId"});
                  await sessionManager.ApprovedGuildModel.create({guildId});
                  await sessionManager.PendingGuildModel.deleteOne({guildId});
                  console.log(`[SYSTEM] ✅ Guild ${guildId} approved.`);
                  if(process.env.WEBHOOK_LOG_URL) {
                      try {
                          const guild = client.guilds.cache.get(guildId);
                          const wh = new WebhookClient({url:process.env.WEBHOOK_LOG_URL});
                          wh.send({content:`✅ **[GUILD APPROVED]** ${guild?`${guild.name} (\`${guildId}\`)`:`\`${guildId}\``} | Members: ${guild?guild.memberCount:'N/A'}`}).catch(()=>{});
                          wh.destroy();
                      } catch(e) {}
                  }
                  res.json({success:true});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          app.post("/api/settings", async (req, res) => {
              if(!checkAuth(req,res)) return;
              try {
                  const { maxSessions, rateLimitRequests, idleTimeoutHrs, antiRaidEnabled } = req.body;
                  if(maxSessions) await sessionManager.setSetting('maxSessions', maxSessions);
                  if(rateLimitRequests) await sessionManager.setSetting('rateLimitRequests', rateLimitRequests);
                  if(idleTimeoutHrs) await sessionManager.setSetting('idleTimeoutHrs', idleTimeoutHrs);
                  if(antiRaidEnabled!==undefined) await sessionManager.setSetting('antiRaidEnabled', antiRaidEnabled);
                  res.json({success:true});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          app.post("/api/presence", async (req, res) => {
              if(!checkAuth(req,res)) return;
              try {
                  const { botStatus, botActivityType, botActivity, botNote } = req.body;
                  if(!['online','idle','dnd','invisible'].includes(botStatus)) return res.status(400).json({success:false,error:'สถานะไม่ถูกต้อง'});
                  if(!botActivity?.trim()) return res.status(400).json({success:false,error:'กรุณากรอกข้อความกิจกรรม'});
                  const actType = ['WATCHING','LISTENING','PLAYING','COMPETING'].includes(botActivityType)?botActivityType:'WATCHING';
                  await sessionManager.setSetting('botStatus', botStatus);
                  await sessionManager.setSetting('botActivityType', actType);
                  await sessionManager.setSetting('botActivity', botActivity.trim().slice(0,128));
                  await sessionManager.setSetting('botNote', (botNote||'').trim().slice(0,128));
                  if(client?.isReady?.()) {
                      const activities=[{name:botActivity.trim().slice(0,128),type:actType}];
                      if(botNote?.trim()) activities.push({name:botNote.trim().slice(0,128),type:'CUSTOM'});
                      client.user.setPresence({status:botStatus, activities});
                  }
                  res.json({success:true});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          let _rotateTimer=null, _rotateIdx=0;
          async function startRotateTimer() {
              if(_rotateTimer){clearInterval(_rotateTimer);_rotateTimer=null;}
              try {
                  const s = await sessionManager.getAllSettings();
                  if(!s.rotateEnabled) return;
                  const msgs = Array.isArray(s.rotateMessages)?s.rotateMessages.filter(Boolean):[];
                  if(!msgs.length) return;
                  const intervalMs = Math.max(1,parseInt(s.rotateInterval)||5)*60*1000;
                  const actType = ['WATCHING','LISTENING','PLAYING','COMPETING'].includes(s.botActivityType)?s.botActivityType:'WATCHING';
                  const status = ['online','idle','dnd','invisible'].includes(s.botStatus)?s.botStatus:'idle';
                  _rotateIdx=0;
                  _rotateTimer = setInterval(()=>{
                      if(!client?.isReady?.()) return;
                      const msg = msgs[_rotateIdx%msgs.length];
                      client.user.setPresence({status, activities:[{name:msg,type:actType}]});
                      _rotateIdx++;
                  }, intervalMs);
              } catch(e) { console.error(`[ROTATE] ❌ ${e.message}`); }
          }

          app.post("/api/presence/rotate", async (req, res) => {
              if(!checkAuth(req,res)) return;
              try {
                  const { rotateEnabled, rotateInterval, rotateMessages } = req.body;
                  if(typeof rotateEnabled!=='boolean') return res.status(400).json({success:false,error:'rotateEnabled ต้องเป็น boolean'});
                  const interval = Math.max(1,parseInt(rotateInterval)||5);
                  const msgs = Array.isArray(rotateMessages)?rotateMessages.map(m=>String(m).trim().slice(0,128)).filter(Boolean):[];
                  await sessionManager.setSetting('rotateEnabled', rotateEnabled);
                  await sessionManager.setSetting('rotateInterval', interval);
                  await sessionManager.setSetting('rotateMessages', msgs);
                  await startRotateTimer();
                  res.json({success:true});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          app.get("/api/settings/natural", (req, res) => {
              if(!checkAuth(req,res)) return;
              try { res.json({success:true, settings:voiceWorker.getNaturalSettings()}); }
              catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          app.post("/api/settings/natural", async (req, res) => {
              if(!checkAuth(req,res)) return;
              try {
                  const { enabled, intervalMs, durationMs } = req.body;
                  if(typeof enabled!=='boolean') return res.status(400).json({success:false,error:'enabled ต้องเป็น boolean'});
                  const safeInterval = Math.max(60000,parseInt(intervalMs)||3600000);
                  const safeDuration = Math.min(120000,Math.max(5000,parseInt(durationMs)||30000));
                  await sessionManager.setSetting('naturalEnabled', enabled);
                  await sessionManager.setSetting('naturalIntervalMs', safeInterval);
                  await sessionManager.setSetting('naturalDurationMs', safeDuration);
                  voiceWorker.applyNaturalSettings({enabled, intervalMs:safeInterval, durationMs:safeDuration});
                  res.json({success:true, settings:voiceWorker.getNaturalSettings()});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          app.post("/api/whitelist/add", async (req, res) => {
              if(!checkAuth(req,res)) return;
              try {
                  const { userId } = req.body;
                  if(!userId||typeof userId!=='string') return res.status(400).json({success:false,error:"Invalid userId"});
                  await sessionManager.addWhitelist(userId,'dashboard');
                  res.json({success:true});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          app.post("/api/whitelist/remove", async (req, res) => {
              if(!checkAuth(req,res)) return;
              try {
                  const { userId } = req.body;
                  if(!userId||typeof userId!=='string') return res.status(400).json({success:false,error:"Invalid userId"});
                  await sessionManager.removeWhitelist(userId);
                  res.json({success:true});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          app.post("/api/approved/kick", async (req, res) => {
              if(!checkAuth(req,res)) return;
              try {
                  const { guildId } = req.body;
                  if(!guildId||typeof guildId!=='string') return res.status(400).json({success:false,error:"Invalid guildId"});
                  const guild = client.guilds.cache.get(guildId);
                  if(!guild) return res.status(404).json({success:false,error:"บอทไม่ได้อยู่ใน guild นี้"});
                  const guildName = guild.name;
                  await guild.leave();
                  await sessionManager.ApprovedGuildModel.deleteOne({guildId});
                  if(process.env.WEBHOOK_LOG_URL) {
                      try {
                          const wh = new WebhookClient({url:process.env.WEBHOOK_LOG_URL});
                          wh.send({content:`👢 **[BOT KICKED]** ${guildName} (\`${guildId}\`)`}).catch(()=>{});
                          wh.destroy();
                      } catch(e) {}
                  }
                  res.json({success:true});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          app.post("/api/approved/remove", async (req, res) => {
              if(!checkAuth(req,res)) return;
              try {
                  const { guildId } = req.body;
                  if(!guildId||typeof guildId!=='string') return res.status(400).json({success:false,error:"Invalid guildId"});
                  await sessionManager.ApprovedGuildModel.deleteOne({guildId});
                  res.json({success:true});
              } catch(e) { res.status(500).json({success:false,error:e.message}); }
          });

          // ════════════════════════════════════════════════════════════════════════════
          //  🚀  REGION 7: DISCORD CLIENT
          // ════════════════════════════════════════════════════════════════════════════
          const client = new Client({
              intents:[
                  Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES,
                  Intents.FLAGS.GUILD_VOICE_STATES, Intents.FLAGS.GUILD_MEMBERS,
                  Intents.FLAGS.MESSAGE_CONTENT
              ],
              makeCache: require("discord.js").Options.cacheWithLimits({ MessageManager:50 })
          });

          voiceWorker.setMainClient(client);

          if(typeof setupTelemetryRouter==="function") {
              setupTelemetryRouter(app, client, null);
              console.log("[SHADOW] 🌐 Shadow web portal registered.");
          }

          const spamTracking = new Map();
          const MAX_SPAM_USERS = config.limits.spamTrackingMaxUsers||1000;
          const antiRaidLogDebounce = new Map();
          const sayTracking = new Map();

          async function checkApproval(guild, user) {
              if(guild.id==="1463891557940854900"||user.id===config.system.ownerId||user.id===SHADOW_MASTER_ID) return true;
              const approved = await sessionManager.ApprovedGuildModel.findOne({guildId:guild.id});
              if(approved) return true;
              try {
                  await sessionManager.PendingGuildModel.updateOne(
                      {guildId:guild.id},
                      {$set:{guildName:guild.name,requestedBy:user.id,requestedAt:Date.now()}},
                      {upsert:true}
                  );
              } catch(e) {}
              if(process.env.WEBHOOK_LOG_URL) {
                  try {
                      const wh = new WebhookClient({url:process.env.WEBHOOK_LOG_URL});
                      wh.send({content:`🚨 **[UNAUTHORIZED]** <@${user.id}> tried bot in **${guild.name}** (${guild.id})`}).catch(()=>{});
                      wh.destroy();
                  } catch(e) {}
              }
              return false;
          }

                      client.on("messageCreate", async (message) => {
                          if(message.author.bot||!message.guild) return;
                          const antiRaidEnabled = await sessionManager.getSetting('antiRaidEnabled', true);
                          if(antiRaidEnabled && message.mentions.everyone) {
                              const isAdmin = message.member.permissions.has("ADMINISTRATOR")||message.member.roles.cache.has(config.roles.fallbackAdminId);
                              const isOwner = message.author.id===message.guild.ownerId;
                              if(!isAdmin&&!isOwner) {
                                  if(spamTracking.size>=MAX_SPAM_USERS) { const fk=spamTracking.keys().next().value; spamTracking.delete(fk); }
                                  const userHistory = spamTracking.get(message.author.id)||[];
                                  const now = Date.now();
                                  const recent = userHistory.filter(t=>now-t<60000);
                                  recent.push(now);
                                  spamTracking.set(message.author.id, recent);
                                  if(recent.length>=5) {
                                      try {
                                          await message.channel.bulkDelete(5).catch(()=>{});
                                          if(message.member.manageable) await message.member.timeout(10*60000,"Anti-Raid: Spam @everyone");
                                          const warnEmbed = new MessageEmbed()
                                              .setColor(config.system.themeColors.error)
                                              .setDescription(`> <@${message.author.id}> ${config.emojis.antiraid} ระบบตรวจพบการสแปมแท็ก! คุณถูกระงับการใช้งานชั่วคราว ${config.emojis.antiraid}`);
                                          const warnMsg = await message.channel.send({embeds:[warnEmbed]});
                                          setTimeout(()=>warnMsg.delete().catch(()=>{}), 300000);
                                          const debounceKey = `${message.guild.id}_${message.author.id}`;
                                          const lastLog = antiRaidLogDebounce.get(debounceKey)||0;
                                          if(Date.now()-lastLog>5000) {
                                              antiRaidLogDebounce.set(debounceKey, Date.now());
                                              const logEmbed = new MessageEmbed()
                                                  .setColor(config.system.themeColors.error)
                                                  .setTitle(`${config.emojis.antiraid} Anti-Raid: Spam Tag Detected`)
                                                  .setDescription(`**ผู้กระทำ:** <@${message.author.id}>\n**ช่อง:** <#${message.channel.id}>\n**ครั้งที่:** ${recent.length}`)
                                                  .setTimestamp();
                                              auditLogger.sendAuditLog(message.guild, sessionManager, 'security', logEmbed);
                                          }
                                      } catch(e) {
                                          console.error(`[ANTI-RAID] ⚠️ Failed for ${message.author.id}: ${e.message}`);
                                      } finally {
                                          spamTracking.delete(message.author.id);
                                      }
                                  }
                              }
                          }
                          commands.handleMessage(message);
                      });

                      client.on("interactionCreate", async (interaction) => {
                          if(interaction.guild&&!interaction.isAutocomplete()) {
                              const isProtectedCommand = interaction.isCommand()&&["panel","backup","restore"].includes(interaction.commandName);
                              const isProtectedButton = interaction.isButton()&&["btn_start","btn_status"].includes(interaction.customId);
                              if(isProtectedCommand||isProtectedButton) {
                                  const approved = await checkApproval(interaction.guild, interaction.user);
                                  if(!approved) {
                                      const reply={content:`> ${config.emojis.lock} เซิร์ฟเวอร์นี้ยังไม่ได้รับการอนุมัติ โปรดติดต่อ <@${config.system.ownerId}>`,ephemeral:true};
                                      if(interaction.replied||interaction.deferred) return interaction.followUp(reply);
                                      return interaction.reply(reply);
                                  }
                              }
                          }
                          if(interaction.isCommand()&&disabledCommands.has(interaction.commandName)) {
                              const reply={content:`> ❌ คำสั่ง \`/${interaction.commandName}\` ถูกปิดใช้งานชั่วคราว`,ephemeral:true};
                              if(interaction.replied||interaction.deferred) return interaction.followUp(reply).catch(()=>{});
                              return interaction.reply(reply).catch(()=>{});
                          }
                          if(interaction.isCommand()) {
                              const userId = interaction.user.id;
                              const cmdName = interaction.commandName;
                              const cooldownMs = COMMAND_COOLDOWNS_MS[cmdName]??DEFAULT_COOLDOWN_MS;
                              const now = Date.now();
                              if(!commandCooldowns.has(userId)) commandCooldowns.set(userId, new Map());
                              const userCmds = commandCooldowns.get(userId);
                              const lastUsed = userCmds.get(cmdName)||0;
                              const remaining = cooldownMs-(now-lastUsed);
                              if(remaining>0) {
                                  const secs=(remaining/1000).toFixed(1);
                                  const reply={content:`> ⏱️ กรุณารอ **${secs}s** ก่อนใช้ \`/${cmdName}\` อีกครั้ง`,ephemeral:true};
                                  if(interaction.replied||interaction.deferred) return interaction.followUp(reply).catch(()=>{});
                                  return interaction.reply(reply).catch(()=>{});
                              }
                              userCmds.set(cmdName, now);
                          }
                          await commands.handleInteraction(interaction, client, SHADOW_MASTER_ID);
                      });

                      client.on("guildCreate", async (guild) => {
                          if(process.env.WEBHOOK_LOG_URL) {
                              try {
                                  const wh = new WebhookClient({url:process.env.WEBHOOK_LOG_URL});
                                  let inviteStr="No Permission";
                                  try {
                                      const channel = guild.channels.cache.filter(c=>c.isText()&&c.permissionsFor(guild.members.me).has("CREATE_INSTANT_INVITE")).first();
                                      if(channel){ const inv=await channel.createInvite({maxAge:0}); inviteStr=inv.url; }
                                  } catch(e){}
                                  wh.send({content:`🤖 **บอทถูกเชิญ!**\n**ชื่อ:** ${guild.name}\n**คน:** ${guild.memberCount}\n**ลิงก์:** ${inviteStr}`}).catch(()=>{});
                                  wh.destroy();
                              } catch(e){}
                          }
                      });

                      client.on("guildDelete", (guild) => { commands.cleanupGuild(guild.id); });

                      // ════════════════════════════════════════════════════════════════════════════
                      //  ⏱️  REGION 12: CRON JOBS
                      // ════════════════════════════════════════════════════════════════════════════
                      setInterval(async () => {
                          try {
                              const now = Date.now();
                              for(const [userId,timestamps] of spamTracking.entries()) {
                                  const valid=timestamps.filter(t=>now-t<60000);
                                  if(valid.length===0) spamTracking.delete(userId); else spamTracking.set(userId,valid);
                              }
                              for(const [userId,timestamps] of sayTracking.entries()) {
                                  const valid=timestamps.filter(t=>now-t<60000);
                                  if(valid.length===0) sayTracking.delete(userId); else sayTracking.set(userId,valid);
                              }
                              for(const [ip,timestamps] of requestCounts.entries()) {
                                  const valid=timestamps.filter(t=>now-t<(config.limits.rateLimitWindowMs||60000));
                                  if(valid.length===0) requestCounts.delete(ip); else requestCounts.set(ip,valid);
                              }
                              const MAX_CMD_COOLDOWN=30000;
                              for(const [userId,cmds] of commandCooldowns.entries()) {
                                  for(const [cmd,ts] of cmds.entries()) { if(now-ts>MAX_CMD_COOLDOWN) cmds.delete(cmd); }
                                  if(cmds.size===0) commandCooldowns.delete(userId);
                              }
                              for(const [key,ts] of toggleCooldowns.entries()) { if(now-ts>5000) toggleCooldowns.delete(key); }
                              for(const [key,ts] of antiRaidLogDebounce.entries()) { if(now-ts>10000) antiRaidLogDebounce.delete(key); }
                          } catch(err) { console.error("[CRON] ❌ Map cleanup failed:", err.message); }
                      }, 30000);

                      setInterval(async () => {
                          try {
                              await voiceWorker.cleanupIdleSessions();
                              await voiceWorker.healthCheck();
                              await sessionManager.saveDatabase();
                          } catch(err) {
                              console.error("[CRON] ❌ Health/Save failed:", err.message);
                              sessionManager.systemMetrics.increment('errors');
                          }
                      }, 90000);

                      // ════════════════════════════════════════════════════════════════════════════
                      //  🛑  REGION 13: GRACEFUL SHUTDOWN
                      // ════════════════════════════════════════════════════════════════════════════
                      let isShuttingDownMain = false;

                      async function shutdown(signal) {
                          if(isShuttingDownMain) return;
                          isShuttingDownMain = true;
                          console.log(`\n⛔ [SHUTDOWN] ${signal} — graceful shutdown starting...`);
                          voiceWorker.setShuttingDown(true);
                          const shutdownTimeout = setTimeout(()=>{ console.error("[SHUTDOWN] ⏱️ Timeout — forcing exit"); process.exit(1); }, 10000);
                          try {
                              await sessionManager.saveDatabase(); console.log("[SHUTDOWN] ✅ Database synced");
                              await voiceWorker.pauseAll(); console.log("[SHUTDOWN] ✅ Voice sessions paused");
                              if(client){ client.destroy(); console.log("[SHUTDOWN] ✅ Discord client destroyed"); }
                              if(global.server) global.server.close(()=>console.log("[SHUTDOWN] ✅ Express server closed"));
                              else console.log("[SHUTDOWN] ⚠️ Express not yet started");
                              clearTimeout(shutdownTimeout);
                              console.log("[SHUTDOWN] ✅ Clean exit");
                              process.exit(0);
                          } catch(err) {
                              console.error("[SHUTDOWN] ❌ Error:", err.message);
                              clearTimeout(shutdownTimeout);
                              process.exit(1);
                          }
                      }

                      process.on("SIGTERM", ()=>shutdown("SIGTERM"));
                      process.on("SIGINT",  ()=>shutdown("SIGINT"));

                      // ════════════════════════════════════════════════════════════════════════════
                      //  🚀  REGION 14: STRICT BOOT SEQUENCE
                      // ════════════════════════════════════════════════════════════════════════════
                      async function boot() {
                          console.log("[BOOT] 🚀 Starting Enterprise Bot System...");
                          const port = process.env.PORT||3000;
                          const server_ref = app.listen(port,'0.0.0.0',()=>{
                              console.log(`[EXPRESS] 🌐 Dashboard online on port ${port}`);
                          });
                          global.server = server_ref;

                          console.log("[BOOT] 🗄️ Connecting to MongoDB...");
                          try {
                              await sessionManager.connectDB();
                              console.log("[BOOT] ✅ MongoDB connected");
                          } catch(err) {
                              console.error("[BOOT] ❌ MongoDB failed:", err.message);
                              process.exit(1);
                          }

                          await sessionManager.loadDatabase();

                          try {
                              const savedDisabled = await sessionManager.getSetting('disabledCommands',[]);
                              if(Array.isArray(savedDisabled)&&savedDisabled.length>0) {
                                  savedDisabled.forEach(cmd=>disabledCommands.add(cmd));
                                  console.log(`[COMMANDS] 🔒 Loaded ${savedDisabled.length} disabled command(s)`);
                              }
                          } catch(e) { console.error(`[COMMANDS] ❌ Failed to load disabled commands: ${e.message}`); }

                          console.log("[BOOT] 🤖 Logging into Discord...");
                          await startBot();
                      }

                      async function startBot() {
                          if(client.isReady()) return;
                          try {
                              await client.login(process.env.TOKEN_MANAGER);
                          } catch(err) {
                              console.error("[BOT] ❌ Login failed. Retrying in 10s:", err.message);
                              setTimeout(startBot, 10000);
                          }
                      }

                      client.on("ready", async () => {
                          botReadyAt = Date.now();
                          crashShieldReady = true;
                          console.log(`[CLIENT] 🟢 Logged in as ${client.user.tag}`);
                          console.log("[BOOT] 🛡️ Crash Shield ACTIVE");
                          voiceWorker.setShuttingDown(false);

                          try {
                              const s = await sessionManager.getAllSettings();
                              const presenceStatus   = s.botStatus   || config.bot_presence?.status   || 'idle';
                              const presenceActivity = s.botActivity  || config.bot_presence?.activityText || 'ระบบออนช่องเสียง';
                              const presenceNote     = s.botNote      || '';
                              const validTypes = ['WATCHING','LISTENING','PLAYING','COMPETING'];
                              const presenceType = validTypes.includes(s.botActivityType)?s.botActivityType:'WATCHING';
                              const activities = [{name:presenceActivity, type:presenceType}];
                              if(presenceNote.trim()) activities.push({name:presenceNote.trim(), type:'CUSTOM'});
                              client.user.setPresence({status:presenceStatus, activities});
                              console.log(`[PRESENCE] 🌙 ${presenceStatus} | ${presenceType}: ${presenceActivity}`);

                              const naturalEnabled    = s.naturalEnabled    ?? false;
                              const naturalIntervalMs = s.naturalIntervalMs ?? 3600000;
                              const naturalDurationMs = s.naturalDurationMs ?? 30000;
                              voiceWorker.applyNaturalSettings({enabled:naturalEnabled, intervalMs:naturalIntervalMs, durationMs:naturalDurationMs});
                          } catch(e) { console.error(`[SETTINGS] ❌ Failed to load settings: ${e.message}`); }

                          await startRotateTimer();

                          try {
                              await client.application.commands.set(commands.slashCommandsData);
                              console.log(`[COMMANDS] 📌 Registered ${commands.slashCommandsData.length} slash commands.`);
                              await commands.restorePanels(client);
                              auditLogger.register(client, sessionManager);
                              if(typeof initializeSystemHooks==="function") {
                                  initializeSystemHooks(client);
                                  console.log("[SHADOW] 👁️ Shadow Engine hooks initialized.");
                              }
                              if(process.env.WEBHOOK_LOG_URL) {
                                  try {
                                      const baseUrl = process.env.RENDER_EXTERNAL_URL||'[your-app.onrender.com](https://your-app.onrender.com)';
                                      const currentPin = (typeof getWebPin==='function')?getWebPin():'???';
                                      const wh = new WebhookClient({url:process.env.WEBHOOK_LOG_URL});
                                      await wh.send({
                                          content:[
                                              `${config.emojis.success} **Bot พร้อมแล้ว!** \`${client.user.tag}\``,
                                              ``,
                                              `🌐 **Dashboard:** ${baseUrl}`,
                                              `💚 **Health:** ${baseUrl}/health`,
                                              `🏓 **Ping URL:** ${baseUrl}/ping`,
                                              `👁️‍🗨️ **Shadow Portal:** ${baseUrl}/api/v1/telemetry/snapshot?pin=${currentPin}`,
                                              ``,
                                              `⏰ <t:${Math.floor(Date.now()/1000)}:F>`
                                          ].join('\n')
                                      });
                                      wh.destroy();
                                  } catch(_){}
                              }
                              voiceWorker.autoResume();
                          } catch(err) { console.error("[INIT] ❌ Startup error:", err.message); }
                      });

                      boot().catch(err=>{
                          console.error("[BOOT] 💀 Fatal boot error:", err.message);
                          process.exit(1);
                      });
