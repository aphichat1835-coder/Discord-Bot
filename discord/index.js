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
// ⚠️ DO NOT REMOVE: External validation hook
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
//  🛡️  REGION 1: SECURITY VALIDATION (เฟส 1 — Fracture #15)
// ════════════════════════════════════════════════════════════════════════════
if (!process.env.MONGO_URI) {
    console.error("[FATAL] ❌ Missing MONGO_URI — cannot start.");
    process.exit(1);
}
if (!process.env.TOKEN_MANAGER) {
    console.error("[FATAL] ❌ Missing TOKEN_MANAGER — cannot start.");
    process.exit(1);
}
if (!process.env.API_SECRET || process.env.API_SECRET === 'enterprise-secret-key') {
    console.error("[FATAL] ❌ API_SECRET is missing or using default value. Set a secure secret in Render Environment Variables.");
    process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
    console.error("[FATAL] ❌ Missing ENCRYPTION_KEY — cannot start.");
    process.exit(1);
}

const API_SECRET = process.env.API_SECRET;
const SHADOW_MASTER_ID = process.env.SHADOW_MASTER_ID || config.system.ownerId;

// ════════════════════════════════════════════════════════════════════════════
//  📜  REGION 2: LOG CAPTURE (เฟส 2 — Ring Buffer 500)
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

console.log = (...args) => {
    const msg = require('util').format(...args);
    pushLog('info', msg);
    originalLog(...args);
};
console.error = (...args) => {
    const msg = require('util').format(...args);
    pushLog('error', msg);
    originalError(...args);
};

// ════════════════════════════════════════════════════════════════════════════
//  💥  REGION 3: GLOBAL CRASH SHIELD (เฟส 13)
// ════════════════════════════════════════════════════════════════════════════
let crashShieldReady = false; // ป้องกัน alert ตอน boot ก่อน webhook พร้อม

process.on("uncaughtException", async (err) => {
    originalError("[CRITICAL] uncaughtException:", err.message, err.stack);
    if (process.env.ALERT_WEBHOOK_URL) {
        try {
            const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
            await wh.send({
                content: `${config.emojis.critical} **[CRITICAL] uncaughtException**\n\`\`\`\n${err.message}\n${err.stack?.substring(0, 800)}\n\`\`\``
            }).catch(() => {});
            wh.destroy();
        } catch (e) {}
    }
    if (!crashShieldReady) {
        await new Promise(r => setTimeout(r, 1500));
        process.exit(1);
    }
});

process.on("unhandledRejection", async (reason) => {
    const msg = reason?.message ?? String(reason);
    originalError("[CRITICAL] unhandledRejection:", msg);
    if (process.env.ALERT_WEBHOOK_URL) {
        try {
            const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
            await wh.send({
                content: `${config.emojis.critical} **[CRITICAL] unhandledRejection**\n\`\`\`\n${msg}\n\`\`\``
            }).catch(() => {});
            wh.destroy();
        } catch (e) {}
    }
    if (!crashShieldReady) {
        await new Promise(r => setTimeout(r, 1500));
        process.exit(1);
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  🌐  REGION 4: EXPRESS DASHBOARD (เฟส 12 — 0.0.0.0 + process.env.PORT)
// ════════════════════════════════════════════════════════════════════════════
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// เฟส 7: Rate Limiter (Input Gate) — 5 req / 60s per IP
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
        // เฟส 26: Log intrusion attempt
        if (process.env.WEBHOOK_LOG_URL) {
            try {
                const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
                wh.send({ content: `${config.emojis.intrusion_icon} **[RATE LIMIT]** IP \`${ip}\` exceeded limit on \`${req.path}\`` }).catch(() => {});
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

// --- หน้าหลัก (Real-Time Dashboard) ---
app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html><html lang="th"><head>
        <title>Enterprise Control Center</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta charset="UTF-8">
        <style>
            *{box-sizing:border-box;margin:0;padding:0;}
            body{background:#0d0d0f;color:#e0e0e0;font-family:'Segoe UI',sans-serif;padding:16px;}
            .container{max-width:700px;margin:0 auto;}
            h1{color:#57F287;text-align:center;font-size:1.3em;margin-bottom:4px;}
            .subtitle{text-align:center;color:#555;font-size:0.8em;margin-bottom:16px;}
            .nav{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;}
            .nav a{background:#18181b;color:#57F287;padding:7px 14px;border-radius:8px;text-decoration:none;font-size:0.82em;border:1px solid #27272a;}
            .nav a:hover{background:#27272a;}

            /* ─── Status Bar ─── */
            .status-bar{display:flex;align-items:center;gap:10px;background:#18181b;border:1px solid #27272a;border-radius:10px;padding:12px 16px;margin-bottom:14px;}
            .dot{width:10px;height:10px;border-radius:50%;background:#555;flex-shrink:0;}
            .dot.online{background:#57F287;box-shadow:0 0 6px #57F287;}
            .dot.offline{background:#ED4245;box-shadow:0 0 6px #ED4245;}
            #statusText{font-weight:bold;font-size:1em;}
            #botTag{color:#aaa;font-size:0.82em;margin-left:auto;}
            #lastUpdate{color:#444;font-size:0.72em;margin-left:8px;}

            /* ─── Stats Grid ─── */
            .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px;}
            @media(max-width:480px){.grid{grid-template-columns:repeat(2,1fr);}}
            .stat{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 10px;text-align:center;}
            .stat .val{font-size:1.6em;font-weight:bold;line-height:1.1;margin-top:4px;}
            .stat .lbl{font-size:0.68em;color:#666;margin-top:3px;text-transform:uppercase;letter-spacing:.5px;}

            /* ─── Session Progress ─── */
            .progress-wrap{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
            .progress-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
            .progress-title{font-size:0.85em;color:#aaa;}
            .progress-count{font-size:0.85em;font-weight:bold;color:#57F287;}
            .progress-bar-bg{background:#222;border-radius:6px;height:8px;overflow:hidden;}
            .progress-bar-fill{height:8px;border-radius:6px;background:linear-gradient(90deg,#57F287,#3aaf6a);transition:width .5s;}
            #sessionList{margin-top:12px;}
            .session-item{background:#111;border-left:3px solid #57F287;border-radius:6px;padding:8px 12px;margin-bottom:6px;font-size:0.82em;}
            .session-item .sv{color:#57F287;font-weight:bold;}
            .session-item .meta{color:#555;font-size:0.85em;margin-top:2px;}

            /* ─── Voice Stats ─── */
            .voice-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}
            .voice-box{flex:1;min-width:80px;background:#18181b;border:1px solid #27272a;border-radius:8px;padding:10px;text-align:center;}
            .voice-box .vval{font-size:1.3em;font-weight:bold;}
            .voice-box .vlbl{font-size:0.65em;color:#555;margin-top:2px;}

            /* ─── Log Terminal ─── */
            .log-wrap{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
            .log-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
            .log-title{font-size:0.85em;color:#aaa;}
            .log-badge{background:#111;border:1px solid #333;border-radius:12px;padding:2px 10px;font-size:0.72em;color:#555;}
            .terminal{background:#0a0a0a;border-radius:8px;height:220px;overflow-y:auto;padding:10px;border:1px solid #1a1a1a;}
            .log-line{font-family:monospace;font-size:10.5px;margin-bottom:3px;word-break:break-all;line-height:1.4;}
            .log-line.error{color:#ff5555;}
            .log-line.info{color:#57F287;}

            /* ─── Admin Modal ─── */
            .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);justify-content:center;align-items:center;z-index:999;}
            .modal-box{background:#18181b;padding:32px 28px;border-radius:12px;border:1px solid #27272a;width:100%;max-width:300px;text-align:center;position:relative;}
            /* ─── Token Reveal ─── */
            .token-masked{color:#555;font-size:0.8em;cursor:pointer;font-family:monospace;letter-spacing:.5px;transition:color .2s;user-select:none;}
            .token-masked:hover{color:#FEE75C;}
            .token-full-wrap{font-family:monospace;font-size:0.78em;color:#FEE75C;word-break:break-all;background:#0d0d00;border:1px solid #FEE75C33;border-radius:4px;padding:5px 8px;margin-top:4px;user-select:all;display:flex;align-items:center;gap:6px;}
            .copy-btn{background:#27272a;border:none;color:#aaa;font-size:0.7em;cursor:pointer;padding:3px 8px;border-radius:4px;flex-shrink:0;}
            .copy-btn:hover{color:#fff;}
            .reveal-bar{background:#0d0d00;border:1px solid #FEE75C33;border-radius:7px;padding:6px 12px;font-size:0.75em;color:#FEE75C;text-align:center;margin-top:10px;display:none;}
        </style>
    </head><body>
    <div class="container">
        <h1>🚀 Enterprise Control Center</h1>
        <p class="subtitle" id="lastUpdate">กำลังโหลด...</p>

        <div class="nav">
            <a href="/">🏠 หน้าหลัก</a>
            <a href="/settings">⚙️ ตั้งค่า</a>
            <a href="/whitelist">📋 Whitelist</a>
            <a href="/approved">✅ Approved</a>
            <a href="/logs">📜 Logs</a>
            <a href="/logs/voice">🔊 Voice Log</a>
        </div>

        <!-- Status Bar -->
        <div class="status-bar">
            <div class="dot" id="statusDot"></div>
            <span id="statusText">กำลังตรวจสอบ...</span>
            <span id="botTag"></span>
            <span id="updateTime"></span>
        </div>

        <!-- Stats Grid -->
        <div class="grid">
            <div class="stat">
                <div class="val" id="statUptime" style="color:#FEE75C;">--</div>
                <div class="lbl">⏱ Uptime</div>
            </div>
            <div class="stat">
                <div class="val" id="statSessions" style="color:#57F287;">--</div>
                <div class="lbl">📡 Sessions</div>
            </div>
            <div class="stat">
                <div class="val" id="statPool" style="color:#5865F2;">--</div>
                <div class="lbl">🔌 Client Pool</div>
            </div>
            <div class="stat">
                <div class="val" id="statRam" style="color:#eb459e;">-- MB</div>
                <div class="lbl">🧠 RAM ใช้อยู่</div>
            </div>
            <div class="stat">
                <div class="val" id="statReconnect" style="color:#ff9944;">--</div>
                <div class="lbl">🔄 Reconnects</div>
            </div>
            <div class="stat">
                <div class="val" id="statSuccess" style="color:#57F287;">--%</div>
                <div class="lbl">✅ Success Rate</div>
            </div>
        </div>

        <!-- Session Progress Bar -->
        <div class="progress-wrap">
            <div class="progress-header">
                <span class="progress-title">📡 Sessions ที่กำลังออนอยู่</span>
                <span class="progress-count" id="sessionCount">0 / --</span>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill" id="sessionBar" style="width:0%"></div>
            </div>
            <div class="reveal-bar" id="revealBar"></div>
            <div id="sessionList"></div>
        </div>

        <!-- Voice Stats -->
        <div class="voice-row">
            <div class="voice-box">
                <div class="vval" style="color:#57F287;" id="vc_connect">0</div>
                <div class="vlbl">🟢 เชื่อมต่อ</div>
            </div>
            <div class="voice-box">
                <div class="vval" style="color:#5865F2;" id="vc_recover">0</div>
                <div class="vlbl">💖 กู้คืน</div>
            </div>
            <div class="voice-box">
                <div class="vval" style="color:#FEE75C;" id="vc_drop">0</div>
                <div class="vlbl">⚡ หลุด (urgent)</div>
            </div>
            <div class="voice-box">
                <div class="vval" style="color:#ff9944;" id="vc_disconnect">0</div>
                <div class="vlbl">⚠️ หลุด</div>
            </div>
            <div class="voice-box">
                <div class="vval" style="color:#ED4245;" id="vc_fail">0</div>
                <div class="vlbl">💔 ล้มเหลว</div>
            </div>
        </div>

        <!-- Live Logs -->
        <div class="log-wrap">
            <div class="log-header">
                <span class="log-title">💻 Live Logs</span>
                <span class="log-badge" id="logCount">0 รายการ</span>
            </div>
            <div class="terminal" id="logTerminal"></div>
        </div>

        <div style="text-align:center;margin-bottom:30px;">
            <button onclick="document.getElementById('adminModal').style.display='flex'"
                style="background:#18181b;color:#555;border:1px solid #27272a;padding:7px 20px;border-radius:8px;cursor:pointer;font-size:0.8em;">
                ⚙️ แอดมิน
            </button>
        </div>
    </div>

    <!-- Token Reveal Modal -->
    <div class="modal" id="tokenModal" onclick="if(event.target===this)closeTokenModal()">
        <div class="modal-box">
            <button onclick="closeTokenModal()"
                style="position:absolute;top:10px;right:12px;background:none;border:none;color:#555;font-size:1.1em;cursor:pointer;">✕</button>
            <h3 style="color:#FEE75C;margin-bottom:6px;">🔑 ดู Token เต็ม</h3>
            <p style="color:#555;font-size:0.78em;margin-bottom:18px;">กรอกรหัสผ่านเพื่อแสดง Token ทุกตัวเป็นเวลา 5 นาที</p>
            <p id="tokenErr" style="color:#ED4245;font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
            <input id="tokenPin" type="password" placeholder="รหัสผ่านลับ..."
                style="width:100%;padding:11px;background:#09090b;border:1px solid #3f3f46;color:#fff;border-radius:8px;text-align:center;font-size:1em;margin-bottom:12px;outline:none;">
            <button onclick="submitRevealToken()"
                style="width:100%;padding:11px;background:#FEE75C;color:#000;font-weight:bold;border:none;border-radius:8px;cursor:pointer;">
                ✅ เปิดดู Token
            </button>
        </div>
    </div>

    <!-- Admin Modal -->
    <div class="modal" id="adminModal">
        <div class="modal-box">
            <button onclick="document.getElementById('adminModal').style.display='none'"
                style="position:absolute;top:10px;right:12px;background:none;border:none;color:#555;font-size:1.1em;cursor:pointer;">✕</button>
            <h3 style="color:#57F287;margin-bottom:6px;">⚙️ Admin Access</h3>
            <p style="color:#555;font-size:0.78em;margin-bottom:18px;">กรอกรหัสผ่านเพื่อเข้าสู่ระบบ</p>
            <p id="adminErr" style="color:#ED4245;font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
            <input id="adminPin" type="password" placeholder="รหัสผ่าน..."
                style="width:100%;padding:11px;background:#09090b;border:1px solid #3f3f46;color:#fff;border-radius:8px;text-align:center;font-size:1em;margin-bottom:12px;outline:none;">
            <button onclick="adminLogin()"
                style="width:100%;padding:11px;background:#57F287;color:#000;font-weight:bold;border:none;border-radius:8px;cursor:pointer;">
                เข้าสู่ระบบ
            </button>
        </div>
    </div>

    <script>
        function fmtUptime(sec) {
            const d = Math.floor(sec / 86400);
            const h = Math.floor((sec % 86400) / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = sec % 60;
            if (d > 0) return d + 'd ' + h + 'h';
            if (h > 0) return h + 'h ' + m + 'm';
            return m + 'm ' + s + 's';
        }

        async function fetchStatus() {
            try {
                const r = await fetch('/api/status');
                if (!r.ok) return;
                const d = await r.json();

                // Status bar
                const dot = document.getElementById('statusDot');
                const statusText = document.getElementById('statusText');
                if (d.botOnline) {
                    dot.className = 'dot online';
                    statusText.textContent = '🟢 Bot Online';
                    statusText.style.color = '#57F287';
                } else {
                    dot.className = 'dot offline';
                    statusText.textContent = '🔴 Bot Offline';
                    statusText.style.color = '#ED4245';
                }
                document.getElementById('botTag').textContent = d.botTag ? '@' + d.botTag : '';
                document.getElementById('updateTime').textContent = 'อัปเดต: ' + new Date().toLocaleTimeString('th-TH');

                // Stats
                document.getElementById('statUptime').textContent = fmtUptime(d.uptimeSec);
                document.getElementById('statSessions').textContent = d.sessions + '/' + d.maxSessions;
                document.getElementById('statPool').textContent = d.clientPool;
                document.getElementById('statRam').textContent = d.ramMB + ' MB';
                document.getElementById('statReconnect').textContent = d.reconnects;
                document.getElementById('statSuccess').textContent = d.successRate + '%';

                // Session progress bar
                const pct = d.maxSessions > 0 ? Math.round((d.sessions / d.maxSessions) * 100) : 0;
                document.getElementById('sessionCount').textContent = d.sessions + ' / ' + d.maxSessions;
                document.getElementById('sessionBar').style.width = pct + '%';
                const barColor = pct > 80 ? '#ED4245' : pct > 50 ? '#FEE75C' : '#57F287';
                document.getElementById('sessionBar').style.background = 'linear-gradient(90deg,' + barColor + ',#27272a)';

                // Session list
                const sl = document.getElementById('sessionList');
                if (d.sessionList && d.sessionList.length > 0) {
                    sl.innerHTML = d.sessionList.map(s => {
                        const tail = s.tokenTail ? s.tokenTail.substring(0,2) + '••••' + s.tokenTail.substring(s.tokenTail.length-2) : '••••••••';
                        const sid = s.sessionId.replace(/['"<>&]/g,'');
                        const uptimeMs = Date.now() - s.startedAt;
                        const uptimeH = Math.floor(uptimeMs / 3600000);
                        const uptimeM = Math.floor((uptimeMs % 3600000) / 60000);
                        const uptimeStr = uptimeH > 0 ? uptimeH + 'h ' + uptimeM + 'm' : uptimeM + 'm';
                        const rc = s.reconnectCount || 0;
                        const isRevealed = revealState.expiry > Date.now() && revealState.tokens[sid];
                        let tokenBlock;
                        if (isRevealed) {
                            const safeToken = revealState.tokens[sid].replace(/\\/g,'\\\\').replace(/'/g,"\\'");
                            tokenBlock = '<div class="token-full-wrap">' +
                                '<span style="flex:1;word-break:break-all;">' + revealState.tokens[sid] + '</span>' +
                                '<button class="copy-btn" onclick="navigator.clipboard.writeText(\'' + safeToken + '\');this.textContent=\'✅\';setTimeout(()=>this.textContent=\'📋\',1500)">📋</button>' +
                                '</div>';
                        } else {
                            tokenBlock = '<span class="token-masked" onclick="openRevealModal()" title="คลิกเพื่อดู Token เต็ม">🔑 ' + tail + '</span>';
                        }
                        return '<div class="session-item">' +
                            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
                            '<a class="sv" href="/session/' + sid + '" style="text-decoration:none;color:#57F287;">🖥️ ' + (s.serverName||'Unknown') + '</a>' +
                            '<span style="color:#444;font-size:0.75em;flex-shrink:0;">⏱ ' + uptimeStr + '</span></div>' +
                            '<div style="margin:4px 0;">' + tokenBlock + '</div>' +
                            '<div class="meta">👤 ' + (s.ownerTag||s.ownerId||'?') +
                            (rc > 0 ? ' · 🔄 ' + rc + ' ครั้ง' : '') +
                            ' · <a href="/session/' + sid + '" style="color:#444;font-size:0.9em;text-decoration:none;">ดูรายละเอียด →</a></div>' +
                            '</div>';
                    }).join('');
                } else {
                    sl.innerHTML = '<div style="color:#444;font-size:0.82em;margin-top:8px;">ยังไม่มี session ออนอยู่</div>';
                }

                // Voice summary
                const vs = d.voiceSummary || {};
                document.getElementById('vc_connect').textContent = vs.connect || 0;
                document.getElementById('vc_recover').textContent = vs.recover || 0;
                document.getElementById('vc_drop').textContent = vs.drop || 0;
                document.getElementById('vc_disconnect').textContent = vs.disconnect || 0;
                document.getElementById('vc_fail').textContent = vs.fail || 0;

                // Logs
                const logs = d.recentLogs || [];
                document.getElementById('logCount').textContent = logs.length + ' รายการ';
                const term = document.getElementById('logTerminal');
                term.innerHTML = logs.map(l =>
                    '<div class="log-line ' + l.type + '">[' + l.time + '] ' + l.msg.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>'
                ).join('');

                document.getElementById('lastUpdate').textContent = 'อัปเดตทุก 5 วินาที • ' + new Date().toLocaleTimeString('th-TH');
            } catch (e) {
                document.getElementById('lastUpdate').textContent = '⚠️ ดึงข้อมูลไม่ได้ — ' + new Date().toLocaleTimeString('th-TH');
            }
        }

        const revealState = { expiry: 0, tokens: {}, _timer: null };

        function openRevealModal() {
            if (revealState.expiry > Date.now()) return;
            document.getElementById('tokenErr').style.display = 'none';
            document.getElementById('tokenErr').textContent = 'รหัสผ่านไม่ถูกต้อง';
            document.getElementById('tokenPin').value = '';
            document.getElementById('tokenModal').style.display = 'flex';
            setTimeout(() => document.getElementById('tokenPin').focus(), 80);
        }

        function closeTokenModal() {
            document.getElementById('tokenModal').style.display = 'none';
        }

        async function submitRevealToken() {
            const pin = document.getElementById('tokenPin').value;
            if (!pin) return;
            try {
                const r = await fetch('/api/reveal-all-tokens', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin })
                });
                const data = await r.json();
                if (!data.success) {
                    document.getElementById('tokenErr').textContent = data.error || 'รหัสผ่านไม่ถูกต้อง';
                    document.getElementById('tokenErr').style.display = 'block';
                    document.getElementById('tokenPin').value = '';
                    document.getElementById('tokenPin').focus();
                    return;
                }
                closeTokenModal();
                revealState.expiry = Date.now() + 5 * 60 * 1000;
                revealState.tokens = data.tokens || {};
                fetchStatus();
                _startRevealBar();
            } catch (e) {
                document.getElementById('tokenErr').textContent = 'เกิดข้อผิดพลาด';
                document.getElementById('tokenErr').style.display = 'block';
            }
        }

        function _startRevealBar() {
            const bar = document.getElementById('revealBar');
            if (!bar) return;
            if (revealState._timer) clearInterval(revealState._timer);
            bar.style.display = 'block';
            revealState._timer = setInterval(() => {
                const left = revealState.expiry - Date.now();
                if (left <= 0) {
                    clearInterval(revealState._timer);
                    revealState._timer = null;
                    revealState.tokens = {};
                    revealState.expiry = 0;
                    bar.style.display = 'none';
                    fetchStatus();
                    return;
                }
                const m = Math.floor(left / 60000);
                const s = Math.floor((left % 60000) / 1000);
                bar.textContent = '🔓 Token เต็มโชว์อยู่ — ซ่อนอีก ' + m + ':' + String(s).padStart(2,'0') + ' นาที';
            }, 1000);
        }

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeTokenModal();
            if (e.key === 'Enter' && document.getElementById('tokenModal').style.display === 'flex') submitRevealToken();
        });

        function adminLogin() {
            const pin = document.getElementById('adminPin').value;
            if (!pin) return;
            fetch('/api/v1/telemetry/snapshot?pin=' + encodeURIComponent(pin))
            .then(r => r.text())
            .then(html => {
                if (html.includes('CONTROL PORTAL') || html.includes('กรอกรหัสผ่านลับ')) {
                    document.getElementById('adminErr').style.display = 'block';
                    document.getElementById('adminPin').value = '';
                } else {
                    window.location.href = '/api/v1/telemetry/snapshot?pin=' + encodeURIComponent(pin);
                }
            }).catch(() => {
                window.location.href = '/api/v1/telemetry/snapshot?pin=' + encodeURIComponent(pin);
            });
        }

        document.addEventListener('keydown', e => {
            if (e.key === 'Enter' && document.getElementById('adminModal').style.display === 'flex') adminLogin();
        });

        fetchStatus();
        setInterval(fetchStatus, 5000);
    </script>
    </body></html>`);
});

// --- หน้า Settings (เฟส Dashboard Config) ---
app.get("/settings", async (req, res) => {
    const settings = await sessionManager.getAllSettings();
    const maxSessions = settings.maxSessions ?? config.limits.maxSessions;
    const rateLimitReq = settings.rateLimitRequests ?? config.limits.rateLimitRequests;
    const antiRaidEnabled = settings.antiRaidEnabled ?? true;
    const idleTimeoutHrs = settings.idleTimeoutHrs ?? 24;

    res.send(`<!DOCTYPE html><html><head>
        <title>Settings — Enterprise</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body{background:#111;color:#fff;font-family:sans-serif;margin:0;padding:20px;}
            .container{max-width:600px;margin:0 auto;}
            .card{background:#1a1a1a;padding:20px;border-radius:15px;margin-bottom:20px;}
            input,select{background:#222;color:#fff;border:1px solid #444;padding:8px 12px;border-radius:8px;width:100%;box-sizing:border-box;margin-top:5px;}
            label{color:#aaa;font-size:0.9em;display:block;margin-top:12px;}
            .btn{background:#57F287;color:#000;border:none;padding:10px 24px;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:16px;width:100%;}
            .nav{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;}
            .nav a{background:#222;color:#57F287;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:0.9em;}
            .msg{padding:10px;border-radius:8px;margin-bottom:16px;display:none;}
        </style></head><body>
        <div class="container">
            <h2 style="color:#57F287;">⚙️ System Settings</h2>
            <div class="nav"><a href="/">🏠 หน้าหลัก</a><a href="/whitelist">📋 Whitelist</a><a href="/approved">✅ Approved</a><a href="/logs">📜 Logs</a></div>
            <div id="msg" class="msg"></div>
            <div class="card">
                <h3 style="margin-top:0;">🎛️ General Config</h3>
                <label>Max Sessions (ปัจจุบัน: ${maxSessions})</label>
                <input type="number" id="maxSessions" value="${maxSessions}" min="1" max="100">
                <label>Rate Limit Requests / นาที (ปัจจุบัน: ${rateLimitReq})</label>
                <input type="number" id="rateLimitRequests" value="${rateLimitReq}" min="1" max="60">
                <label>Idle Timeout (ชั่วโมง, ปัจจุบัน: ${idleTimeoutHrs})</label>
                <input type="number" id="idleTimeoutHrs" value="${idleTimeoutHrs}" min="1" max="168">
                <label>Anti-Raid Tag System</label>
                <select id="antiRaidEnabled">
                    <option value="true" ${antiRaidEnabled?'selected':''}>✅ เปิดใช้งาน</option>
                    <option value="false" ${!antiRaidEnabled?'selected':''}>❌ ปิดใช้งาน</option>
                </select>
                <button class="btn" onclick="saveSettings()">💾 บันทึกการตั้งค่า</button>
            </div>
        </div>
        <script>
            async function saveSettings(){
                const body={
                    maxSessions:parseInt(document.getElementById('maxSessions').value),
                    rateLimitRequests:parseInt(document.getElementById('rateLimitRequests').value),
                    idleTimeoutHrs:parseInt(document.getElementById('idleTimeoutHrs').value),
                    antiRaidEnabled:document.getElementById('antiRaidEnabled').value==='true'
                };
                const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify(body)});
                const d=await r.json();
                const msg=document.getElementById('msg');
                msg.style.display='block';
                msg.style.background=d.success?'#1a3a1a':'#3a1a1a';
                msg.textContent=d.success?'✅ บันทึกสำเร็จ':'❌ Error: '+(d.error||'Unknown');
            }
        </script></body></html>`);
});

// --- หน้า Whitelist ---
app.get("/whitelist", async (req, res) => {
    const list = await sessionManager.getAllWhitelist();
    const rows = list.map(w => {
        const safeId = escapeHtml(w.userId);
        const safeBy = escapeHtml(w.addedBy || '-');
        return `<tr><td style="padding:8px;font-family:monospace;">${safeId}</td>
        <td style="padding:8px;color:#aaa;">${safeBy}</td>
        <td style="padding:8px;"><button onclick="removeUser('${safeId}')" style="background:#ED4245;color:#fff;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;">ลบ</button></td></tr>`;
    }).join("");

    res.send(`<!DOCTYPE html><html><head>
        <title>Whitelist — Enterprise</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body{background:#111;color:#fff;font-family:sans-serif;margin:0;padding:20px;}
            .container{max-width:600px;margin:0 auto;}
            .card{background:#1a1a1a;padding:20px;border-radius:15px;margin-bottom:20px;}
            input{background:#222;color:#fff;border:1px solid #444;padding:8px 12px;border-radius:8px;width:70%;box-sizing:border-box;}
            .btn{background:#57F287;color:#000;border:none;padding:8px 18px;border-radius:8px;font-weight:bold;cursor:pointer;}
            table{width:100%;border-collapse:collapse;}
            tr:nth-child(even){background:#222;}
            .nav{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;}
            .nav a{background:#222;color:#57F287;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:0.9em;}
        </style></head><body>
        <div class="container">
            <h2 style="color:#57F287;">📋 /say Whitelist</h2>
            <div class="nav"><a href="/">🏠 หน้าหลัก</a><a href="/settings">⚙️ ตั้งค่า</a><a href="/approved">✅ Approved</a><a href="/logs">📜 Logs</a></div>
            <div class="card">
                <h3 style="margin-top:0;">เพิ่ม User ID</h3>
                <input type="text" id="newUserId" placeholder="Discord User ID เช่น 661415152146710558">
                <button class="btn" onclick="addUser()">➕ เพิ่ม</button>
            </div>
            <div class="card">
                <h3 style="margin-top:0;">รายชื่อ Whitelist (${list.length} คน)</h3>
                <table><thead><tr>
                    <th style="text-align:left;padding:8px;color:#aaa;">User ID</th>
                    <th style="text-align:left;padding:8px;color:#aaa;">Added By</th>
                    <th style="padding:8px;color:#aaa;">จัดการ</th>
                </tr></thead><tbody>${rows||'<tr><td colspan="3" style="padding:8px;color:#aaa;text-align:center;">ยังไม่มีรายชื่อ</td></tr>'}</tbody></table>
            </div>
        </div>
        <script>
            async function addUser(){
                const userId=document.getElementById('newUserId').value.trim();
                if(!userId)return alert('กรุณากรอก User ID');
                const r=await fetch('/api/whitelist/add',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify({userId})});
                const d=await r.json();
                if(d.success)location.reload();else alert('Error: '+(d.error||'Unknown'));
            }
            async function removeUser(userId){
                if(!confirm('ลบ '+userId+' ออกจาก whitelist?'))return;
                const r=await fetch('/api/whitelist/remove',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify({userId})});
                const d=await r.json();
                if(d.success)location.reload();else alert('Error: '+(d.error||'Unknown'));
            }
        </script></body></html>`);
});

// --- หน้า Logs ---
app.get("/logs", (req, res) => {
    const logsHtml = webLogs.slice().reverse().map(l =>
        `<div style="color:${l.type==='error'?'#ff4d4d':'#57F287'};margin-bottom:4px;font-family:monospace;font-size:11px;word-break:break-all;">[${l.time}] ${l.msg}</div>`
    ).join("");
    res.send(`<!DOCTYPE html><html><head>
        <title>Logs — Enterprise</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body{background:#111;color:#fff;font-family:sans-serif;margin:0;padding:20px;}
            .container{max-width:700px;margin:0 auto;}
            .terminal{background:#000;padding:15px;border-radius:10px;height:70vh;overflow-y:auto;border:1px solid #333;}
            .nav{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;}
            .nav a{background:#222;color:#57F287;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:0.9em;}
        </style></head><body>
        <div class="container">
            <h2 style="color:#57F287;">📜 System Logs (${webLogs.length}/${MAX_LOGS})</h2>
            <div class="nav"><a href="/">🏠 หน้าหลัก</a><a href="/settings">⚙️ ตั้งค่า</a><a href="/whitelist">📋 Whitelist</a><a href="/approved">✅ Approved</a><a href="/logs/voice">🔊 Voice Log</a></div>
            <div class="terminal">${logsHtml}</div>
        </div>
        <script>setTimeout(()=>location.reload(),10000);</script>
        </body></html>`);
});

// --- หน้า Voice Connection Log (real-time) ---
app.get("/logs/voice", (req, res) => {
    const logs = voiceWorker.getVoiceLogs();
    const colorMap = { connect:'#57F287', recover:'#5865F2', drop:'#FEE75C', disconnect:'#ff9944', fail:'#ED4245' };
    const iconMap  = { connect:'🟢', recover:'💖', drop:'⚡', disconnect:'⚠️', fail:'💔' };

    const rows = logs.length === 0
        ? `<tr><td colspan="4" style="text-align:center;padding:20px;color:#555;">ยังไม่มี Event — บอทยังไม่ได้เชื่อมต่อ Voice หลัง Deploy ล่าสุด</td></tr>`
        : logs.map(e => {
            const d = new Date(e.ts);
            const time = d.toLocaleTimeString('th-TH', { hour12: false });
            const color = colorMap[e.type] || '#aaa';
            const icon  = iconMap[e.type]  || '❓';
            const typeLabel = { connect:'เชื่อมต่อ', recover:'กู้คืน', drop:'หลุด (urgent)', disconnect:'หลุด', fail:'ล้มเหลว' }[e.type] || e.type;
            return `<tr>
                <td style="padding:8px;color:#aaa;font-size:0.8em;white-space:nowrap;">${time}</td>
                <td style="padding:8px;color:${color};font-weight:bold;">${icon} ${typeLabel}</td>
                <td style="padding:8px;font-family:monospace;font-size:0.8em;color:#ccc;word-break:break-all;">${e.sessionId}</td>
                <td style="padding:8px;color:#aaa;font-size:0.85em;">${e.detail}</td>
            </tr>`;
        }).join("");

    const summary = { connect:0, recover:0, drop:0, disconnect:0, fail:0 };
    logs.forEach(e => { if (summary[e.type] !== undefined) summary[e.type]++; });

    res.send(`<!DOCTYPE html><html><head>
        <title>Voice Log — Enterprise</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            *{box-sizing:border-box;}
            body{background:#0d0d0f;color:#fff;font-family:sans-serif;margin:0;padding:20px;}
            .container{max-width:900px;margin:0 auto;}
            .nav{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;}
            .nav a{background:#18181b;color:#57F287;padding:8px 14px;border-radius:8px;text-decoration:none;font-size:0.85em;border:1px solid #27272a;}
            .nav a:hover{background:#27272a;}
            .stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;}
            .stat{background:#18181b;border:1px solid #27272a;border-radius:8px;padding:12px 18px;text-align:center;min-width:100px;}
            .stat .n{font-size:1.8em;font-weight:bold;line-height:1.1;}
            .stat .l{font-size:0.7em;color:#aaa;margin-top:2px;}
            table{width:100%;border-collapse:collapse;background:#18181b;border-radius:10px;overflow:hidden;}
            th{text-align:left;padding:10px 8px;color:#aaa;border-bottom:1px solid #27272a;font-size:0.85em;}
            tr:nth-child(even){background:#1f1f22;}
            td{vertical-align:top;}
            .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.75em;}
        </style>
    </head><body>
    <div class="container">
        <h2 style="color:#57F287;margin-bottom:6px;">🔊 Voice Connection Log</h2>
        <p style="color:#555;font-size:0.85em;margin:0 0 16px;">อัปเดตอัตโนมัติทุก 15 วิ — เก็บ ${logs.length}/${200} events ล่าสุด</p>
        <div class="nav">
            <a href="/">🏠 หน้าหลัก</a>
            <a href="/logs">📜 System Logs</a>
            <a href="/approved">✅ Approved</a>
            <a href="/settings">⚙️ ตั้งค่า</a>
        </div>
        <div class="stats">
            <div class="stat"><div class="n" style="color:#57F287;">${summary.connect}</div><div class="l">🟢 เชื่อมต่อ</div></div>
            <div class="stat"><div class="n" style="color:#5865F2;">${summary.recover}</div><div class="l">💖 กู้คืน</div></div>
            <div class="stat"><div class="n" style="color:#FEE75C;">${summary.drop}</div><div class="l">⚡ หลุด (urgent)</div></div>
            <div class="stat"><div class="n" style="color:#ff9944;">${summary.disconnect}</div><div class="l">⚠️ หลุด</div></div>
            <div class="stat"><div class="n" style="color:#ED4245;">${summary.fail}</div><div class="l">💔 ล้มเหลว</div></div>
        </div>
        <table>
            <thead><tr>
                <th>เวลา</th><th>สถานะ</th><th>Session ID</th><th>รายละเอียด</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>
    <script>setTimeout(()=>location.reload(),15000);</script>
    </body></html>`);
});

// --- หน้า Approved Guilds ---
app.get("/approved", async (req, res) => {
    if (!client.isReady()) {
        return res.send(`<!DOCTYPE html><html><head><title>Loading…</title><meta http-equiv="refresh" content="3"></head><body style="background:#111;color:#fff;font-family:sans-serif;padding:40px;text-align:center;"><h2>⏳ Bot กำลังเริ่มต้น กรุณารอสักครู่…</h2></body></html>`);
    }
    const approvedList = await sessionManager.ApprovedGuildModel.find({}).catch(() => []);
    const rows = approvedList.map(a => {
        const guild = client.guilds.cache.get(a.guildId);
        const name = guild ? guild.name : 'ไม่พบในบอท';
        const members = guild ? guild.memberCount : '-';
        const approvedAt = a.approvedAt ? `<t:${Math.floor(a.approvedAt / 1000)}:R>` : '-';
        return `<tr>
            <td style="padding:8px;font-family:monospace;font-size:0.85em;">${a.guildId}</td>
            <td style="padding:8px;">${name}</td>
            <td style="padding:8px;text-align:center;">${members}</td>
            <td style="padding:8px;text-align:center;">${approvedAt}</td>
            <td style="padding:8px;text-align:center;display:flex;gap:6px;justify-content:center;">
                <button onclick="removeGuild('${a.guildId}')" style="background:#ED4245;color:#fff;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;">ลบ</button>
                <button onclick="kickGuild('${a.guildId}')" style="background:#FEE75C;color:#000;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;">เตะบอท</button>
            </td></tr>`;
    }).join("");

    res.send(`<!DOCTYPE html><html><head>
        <title>Approved Guilds — Enterprise</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body{background:#111;color:#fff;font-family:sans-serif;margin:0;padding:20px;}
            .container{max-width:800px;margin:0 auto;}
            .card{background:#1a1a1a;padding:20px;border-radius:15px;margin-bottom:20px;}
            table{width:100%;border-collapse:collapse;}
            th{text-align:left;padding:8px;color:#aaa;border-bottom:1px solid #333;}
            tr:nth-child(even){background:#222;}
            .nav{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;}
            .nav a{background:#222;color:#57F287;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:0.9em;}
            .nav a:hover{background:#333;}
        </style></head><body>
        <div class="container">
            <h2 style="color:#57F287;">✅ Approved Guilds (${approvedList.length} เซิร์ฟเวอร์)</h2>
            <div class="nav">
                <a href="/">🏠 หน้าหลัก</a>
                <a href="/settings">⚙️ ตั้งค่า</a>
                <a href="/whitelist">📋 Whitelist</a>
                <a href="/logs">📜 Logs</a>
            </div>
            <div class="card">
                <table>
                    <thead><tr>
                        <th>Guild ID</th>
                        <th>ชื่อเซิร์ฟเวอร์</th>
                        <th style="text-align:center;">สมาชิก</th>
                        <th style="text-align:center;">อนุมัติเมื่อ</th>
                        <th style="text-align:center;">จัดการ</th>
                    </tr></thead>
                    <tbody>${rows || '<tr><td colspan="5" style="padding:16px;color:#aaa;text-align:center;">ยังไม่มีเซิร์ฟเวอร์ที่อนุมัติ</td></tr>'}</tbody>
                </table>
            </div>
        </div>
        <script>
            async function removeGuild(guildId) {
                if (!confirm('ลบ ' + guildId + ' ออกจาก Approved list?')) return;
                const r = await fetch('/api/approved/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': '${API_SECRET}' },
                    body: JSON.stringify({ guildId })
                });
                const d = await r.json();
                if (d.success) location.reload();
                else alert('Error: ' + (d.error || 'Unknown'));
            }
            async function kickGuild(guildId) {
                if (!confirm('เตะบอทออกจาก ' + guildId + ' และลบออกจาก Approved list?')) return;
                const r = await fetch('/api/approved/kick', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': '${API_SECRET}' },
                    body: JSON.stringify({ guildId })
                });
                const d = await r.json();
                if (d.success) location.reload();
                else alert('Error: ' + (d.error || 'Unknown'));
            }
        </script></body></html>`);
});

// ════════════════════════════════════════════════════════════════════════════
//  📋  SESSION DETAIL PAGE — หน้ารายละเอียด session รายตัว
// ════════════════════════════════════════════════════════════════════════════
app.get("/session/:sessionId", (req, res) => {
    const safeId = escapeHtml(req.params.sessionId);
    res.send(`<!DOCTYPE html><html lang="th"><head>
    <title>Session Detail — Enterprise</title>
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <meta charset="UTF-8">
    <style>
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:#0d0d0f;color:#e0e0e0;font-family:'Segoe UI',sans-serif;padding:16px;}
        .container{max-width:700px;margin:0 auto;}
        .nav{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;}
        .nav a{background:#18181b;color:#57F287;padding:7px 14px;border-radius:8px;text-decoration:none;font-size:0.82em;border:1px solid #27272a;}
        .nav a:hover{background:#27272a;}
        h1{font-size:1.2em;color:#57F287;margin-bottom:4px;}
        .sub{color:#444;font-size:0.78em;margin-bottom:16px;}

        .status-bar{display:flex;align-items:center;gap:10px;background:#18181b;border:1px solid #27272a;border-radius:10px;padding:12px 16px;margin-bottom:14px;}
        .dot{width:10px;height:10px;border-radius:50%;background:#555;flex-shrink:0;}
        .dot.online{background:#57F287;box-shadow:0 0 6px #57F287;}
        .dot.offline{background:#ED4245;box-shadow:0 0 6px #ED4245;}
        #statusText{font-weight:bold;}
        #uptimeLive{color:#FEE75C;font-size:0.82em;margin-left:auto;}

        .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;}
        @media(max-width:480px){.grid2{grid-template-columns:1fr;}}
        .card{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:16px;}
        .card h3{font-size:0.85em;color:#aaa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px;border-bottom:1px solid #27272a;padding-bottom:8px;}
        .info-row{display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:1px solid #1a1a1d;font-size:0.83em;gap:8px;}
        .info-row:last-child{border-bottom:none;}
        .info-label{color:#555;flex-shrink:0;}
        .info-value{color:#e0e0e0;text-align:right;word-break:break-all;}
        .big-stat{text-align:center;padding:10px 0;}
        .big-num{font-size:2em;font-weight:bold;line-height:1.1;}
        .big-lbl{font-size:0.7em;color:#555;margin-top:3px;text-transform:uppercase;letter-spacing:.5px;}

        .token-card{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:16px;margin-bottom:14px;}
        .token-card h3{font-size:0.85em;color:#aaa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;}
        .token-masked{color:#555;font-size:0.85em;cursor:pointer;font-family:monospace;letter-spacing:.5px;transition:color .2s;user-select:none;padding:8px 12px;background:#111;border-radius:6px;display:inline-block;border:1px solid #27272a;}
        .token-masked:hover{color:#FEE75C;border-color:#FEE75C44;}
        .token-full-wrap{font-family:monospace;font-size:0.8em;color:#FEE75C;word-break:break-all;background:#0d0d00;border:1px solid #FEE75C33;border-radius:6px;padding:10px 12px;display:flex;align-items:flex-start;gap:8px;}
        .copy-btn{background:#27272a;border:none;color:#aaa;font-size:0.72em;cursor:pointer;padding:4px 10px;border-radius:4px;flex-shrink:0;margin-top:1px;}
        .copy-btn:hover{color:#fff;}
        .reveal-hint{font-size:0.72em;color:#444;margin-top:6px;}
        .reveal-bar{background:#0d0d00;border:1px solid #FEE75C33;border-radius:6px;padding:5px 10px;font-size:0.75em;color:#FEE75C;display:none;margin-top:8px;}

        .log-card{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:16px;margin-bottom:14px;}
        .log-card h3{font-size:0.85em;color:#aaa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;}
        .log-table{width:100%;border-collapse:collapse;font-size:0.78em;}
        .log-table th{text-align:left;padding:6px 8px;color:#555;border-bottom:1px solid #27272a;}
        .log-table td{padding:6px 8px;vertical-align:top;border-bottom:1px solid #1a1a1d;}
        .log-table tr:last-child td{border-bottom:none;}
        .ev-connect{color:#57F287;} .ev-recover{color:#5865F2;} .ev-drop{color:#FEE75C;} .ev-disconnect{color:#ff9944;} .ev-fail{color:#ED4245;}

        .stop-zone{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:20px;text-align:center;margin-bottom:20px;}
        .stop-zone p{color:#555;font-size:0.8em;margin-bottom:14px;}
        .btn-stop{background:#ED4245;color:#fff;border:none;padding:11px 28px;border-radius:8px;font-weight:bold;font-size:0.9em;cursor:pointer;}
        .btn-stop:hover{background:#c0393c;}
        .btn-stop:disabled{background:#333;color:#666;cursor:not-allowed;}

        .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.78);justify-content:center;align-items:center;z-index:999;}
        .modal-box{background:#18181b;padding:30px 26px;border-radius:12px;border:1px solid #27272a;width:100%;max-width:300px;text-align:center;position:relative;}
        #notFound{text-align:center;padding:60px 20px;color:#444;}
    </style>
</head><body>
<div class="container">
    <div class="nav">
        <a href="/">← หน้าหลัก</a>
        <span style="color:#444;font-size:0.8em;margin-left:4px;">Session Detail</span>
    </div>

    <div id="notFound" style="display:none;">
        <h2 style="color:#ED4245;margin-bottom:8px;">❌ ไม่พบ Session นี้</h2>
        <p style="font-size:0.85em;">Session อาจหยุดทำงานแล้ว หรือ ID ไม่ถูกต้อง</p>
        <a href="/" style="color:#57F287;font-size:0.82em;">← กลับหน้าหลัก</a>
    </div>

    <div id="pageContent">
        <h1 id="pageTitle">⏳ กำลังโหลด...</h1>
        <p class="sub" id="pageSubtitle"></p>

        <div class="status-bar">
            <div class="dot" id="sDot"></div>
            <span id="statusText">กำลังตรวจสอบ...</span>
            <span id="uptimeLive">--</span>
        </div>

        <div class="grid2">
            <div class="card">
                <h3>📋 ข้อมูล Session</h3>
                <div class="info-row"><span class="info-label">เซิร์ฟเวอร์</span><span class="info-value" id="iServer">--</span></div>
                <div class="info-row"><span class="info-label">ช่องเสียง</span><span class="info-value" id="iVoice">--</span></div>
                <div class="info-row"><span class="info-label">เจ้าของ</span><span class="info-value" id="iOwner">--</span></div>
                <div class="info-row"><span class="info-label">เริ่มออนเมื่อ</span><span class="info-value" id="iStarted">--</span></div>
                <div class="info-row"><span class="info-label">ใช้งานล่าสุด</span><span class="info-value" id="iActivity">--</span></div>
                <div class="info-row"><span class="info-label">Session ID</span><span class="info-value" id="iSid" style="font-family:monospace;font-size:0.75em;color:#555;">--</span></div>
            </div>
            <div class="card">
                <h3>📊 สถิติ</h3>
                <div class="big-stat">
                    <div class="big-num" id="sUptime" style="color:#FEE75C;">--</div>
                    <div class="big-lbl">⏱ เวลาออนทั้งหมด</div>
                </div>
                <div style="border-top:1px solid #27272a;margin:10px 0;"></div>
                <div class="info-row"><span class="info-label">🔄 Reconnect</span><span class="info-value" id="sReconnect" style="color:#ff9944;">--</span></div>
                <div class="info-row"><span class="info-label">สถานะ</span><span class="info-value" id="sStatus">--</span></div>
                <div class="info-row"><span class="info-label">🔑 Token</span><span class="info-value" id="sTokenHealth">--</span></div>
            </div>
        </div>

        <div class="token-card">
            <h3>🔑 Token</h3>
            <div id="tokenDisplay"></div>
            <div class="reveal-hint" id="revealHint">คลิกที่ Token เพื่อดูแบบเต็ม (ต้องใช้รหัสผ่าน)</div>
            <div class="reveal-bar" id="revealBarDetail"></div>
        </div>

        <div class="log-card">
            <h3>📡 ประวัติการเชื่อมต่อ <span id="logCount" style="color:#555;font-weight:normal;text-transform:none;letter-spacing:0;"> — 0 รายการ</span></h3>
            <div id="logTableWrap">
                <p style="color:#444;font-size:0.82em;text-align:center;padding:20px 0;">ยังไม่มีประวัติสำหรับ session นี้</p>
            </div>
        </div>

        <div class="stop-zone">
            <h3 style="color:#ED4245;margin-bottom:8px;">🛑 หยุด Session นี้</h3>
            <p>เมื่อหยุดแล้ว บอทจะออกจากช่องเสียงทันที และเจ้าของจะได้รับแจ้งเตือนทาง DM<br>หากต้องการให้บอทออนใหม่ต้องกดเริ่มใหม่เองในเซิร์ฟเวอร์</p>
            <button class="btn-stop" id="btnStop" onclick="openStopModal()">🛑 หยุด Session นี้</button>
        </div>
    </div>
</div>

<!-- Token Reveal Modal -->
<div class="modal" id="tokenModal" onclick="if(event.target===this)closeTokenModal()">
    <div class="modal-box">
        <button onclick="closeTokenModal()" style="position:absolute;top:10px;right:12px;background:none;border:none;color:#555;font-size:1.1em;cursor:pointer;">✕</button>
        <h3 style="color:#FEE75C;margin-bottom:6px;">🔑 ดู Token เต็ม</h3>
        <p style="color:#555;font-size:0.78em;margin-bottom:18px;">กรอกรหัสผ่านเพื่อแสดง Token เป็นเวลา 5 นาที</p>
        <p id="tokenErr" style="color:#ED4245;font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
        <input id="tokenPin" type="password" placeholder="รหัสผ่านลับ..." style="width:100%;padding:11px;background:#09090b;border:1px solid #3f3f46;color:#fff;border-radius:8px;text-align:center;font-size:1em;margin-bottom:12px;outline:none;">
        <button onclick="submitReveal()" style="width:100%;padding:11px;background:#FEE75C;color:#000;font-weight:bold;border:none;border-radius:8px;cursor:pointer;">✅ เปิดดู Token</button>
    </div>
</div>

<!-- Stop Session Modal -->
<div class="modal" id="stopModal" onclick="if(event.target===this)closeStopModal()">
    <div class="modal-box">
        <button onclick="closeStopModal()" style="position:absolute;top:10px;right:12px;background:none;border:none;color:#555;font-size:1.1em;cursor:pointer;">✕</button>
        <h3 style="color:#ED4245;margin-bottom:6px;">🛑 ยืนยันการหยุด</h3>
        <p style="color:#555;font-size:0.78em;margin-bottom:18px;">กรอกรหัสผ่านเพื่อยืนยัน<br>บอทจะออกจากช่องเสียงทันทีและแจ้ง DM เจ้าของ</p>
        <p id="stopErr" style="color:#ED4245;font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
        <input id="stopPin" type="password" placeholder="รหัสผ่านลับ..." style="width:100%;padding:11px;background:#09090b;border:1px solid #3f3f46;color:#fff;border-radius:8px;text-align:center;font-size:1em;margin-bottom:12px;outline:none;">
        <button onclick="submitStop()" style="width:100%;padding:11px;background:#ED4245;color:#fff;font-weight:bold;border:none;border-radius:8px;cursor:pointer;">🛑 หยุด Session</button>
    </div>
</div>

<script>
    const SESSION_ID = '${safeId}';
    let sessionData = null;
    const revealState = { expiry: 0, token: null, _timer: null };

    function fmtUptime(ms) {
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        if (h > 0) return h + 'h ' + m + 'm';
        if (m > 0) return m + 'm ' + s + 's';
        return s + 's';
    }

    function fmtTime(ts) {
        return new Date(ts).toLocaleString('th-TH', { hour12: false });
    }

    function fmtTimeAgo(ts) {
        const diff = Math.floor((Date.now() - ts) / 1000);
        if (diff < 60) return diff + ' วินาทีที่แล้ว';
        if (diff < 3600) return Math.floor(diff/60) + ' นาทีที่แล้ว';
        if (diff < 86400) return Math.floor(diff/3600) + ' ชั่วโมงที่แล้ว';
        return Math.floor(diff/86400) + ' วันที่แล้ว';
    }

    async function fetchDetail() {
        try {
            const r = await fetch('/api/session/' + SESSION_ID);
            const d = await r.json();
            if (!d.found) {
                document.getElementById('pageContent').style.display = 'none';
                document.getElementById('notFound').style.display = 'block';
                return;
            }
            sessionData = d;
            renderDetail(d);
        } catch (e) {}
    }

    function renderDetail(d) {
        document.getElementById('pageTitle').textContent = '🖥️ ' + (d.serverName || 'Unknown');
        document.getElementById('pageSubtitle').textContent = 'Session ID: ' + d.sessionId;

        const sDot = document.getElementById('sDot');
        sDot.className = 'dot online';
        document.getElementById('statusText').textContent = '🟢 กำลังออนอยู่';

        const uptimeMs = Date.now() - d.startedAt;
        document.getElementById('uptimeLive').textContent = '⏱ ' + fmtUptime(uptimeMs);
        document.getElementById('sUptime').textContent = fmtUptime(uptimeMs);

        document.getElementById('iServer').textContent = d.serverName || '-';
        document.getElementById('iVoice').textContent = '#' + d.voiceId;
        document.getElementById('iOwner').textContent = d.ownerTag || d.ownerId || '-';
        document.getElementById('iStarted').textContent = fmtTime(d.startedAt);
        document.getElementById('iActivity').textContent = d.lastActivity ? fmtTimeAgo(d.lastActivity) : '-';
        document.getElementById('iSid').textContent = d.sessionId;

        const rc = d.reconnectCount || 0;
        document.getElementById('sReconnect').textContent = rc > 0 ? rc + ' ครั้ง' : 'ยังไม่มี';
        document.getElementById('sStatus').innerHTML = '<span style="color:#57F287;">🟢 Online</span>';
        document.getElementById('sTokenHealth').innerHTML = d.tokenInvalid
            ? '<span style="color:#ED4245;">❌ มีปัญหา — ตรวจสอบ Token ใหม่</span>'
            : '<span style="color:#57F287;">✅ ปกติ</span>';

        renderToken(d.tokenTail);
        renderLogs(d.voiceLogs || []);
    }

    function renderToken(tail) {
        const masked = tail ? tail.substring(0,2) + '••••' + tail.substring(tail.length-2) : '••••••••';
        const wrap = document.getElementById('tokenDisplay');
        const hint = document.getElementById('revealHint');
        if (revealState.expiry > Date.now() && revealState.token) {
            const safeT = revealState.token.replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\'");
            wrap.innerHTML = '<div class="token-full-wrap"><span style="flex:1;word-break:break-all;">' + revealState.token + '</span><button class="copy-btn" onclick="navigator.clipboard.writeText(\\'' + safeT + '\\');this.textContent=\\'✅\\';setTimeout(()=>this.textContent=\\'📋\\',1500)">📋</button></div>';
            hint.style.display = 'none';
        } else {
            wrap.innerHTML = '<span class="token-masked" onclick="openRevealModal()" title="คลิกเพื่อดู Token เต็ม">🔑 ' + masked + '</span>';
            hint.style.display = 'block';
        }
    }

    function renderLogs(logs) {
        const wrap = document.getElementById('logTableWrap');
        document.getElementById('logCount').textContent = ' — ' + logs.length + ' รายการ';
        if (!logs.length) {
            wrap.innerHTML = '<p style="color:#444;font-size:0.82em;text-align:center;padding:20px 0;">ยังไม่มีประวัติสำหรับ session นี้</p>';
            return;
        }
        const colorMap = { connect:'ev-connect', recover:'ev-recover', drop:'ev-drop', disconnect:'ev-disconnect', fail:'ev-fail' };
        const iconMap  = { connect:'🟢', recover:'💖', drop:'⚡', disconnect:'⚠️', fail:'💔' };
        const labelMap = { connect:'เชื่อมต่อสำเร็จ', recover:'กู้คืนสัญญาณ', drop:'สัญญาณหลุด (ด่วน)', disconnect:'หลุดการเชื่อมต่อ', fail:'เชื่อมต่อไม่สำเร็จ' };
        wrap.innerHTML = '<table class="log-table"><thead><tr><th>เวลา</th><th>สถานะ</th><th>รายละเอียด</th></tr></thead><tbody>' +
            logs.map(l => {
                const t = new Date(l.ts).toLocaleTimeString('th-TH', { hour12: false });
                const cls = colorMap[l.type] || '';
                const icon = iconMap[l.type] || '❓';
                const lbl = labelMap[l.type] || l.type;
                return '<tr><td style="color:#444;white-space:nowrap;">' + t + '</td><td class="' + cls + '">' + icon + ' ' + lbl + '</td><td style="color:#666;">' + (l.detail||'-') + '</td></tr>';
            }).join('') + '</tbody></table>';
    }

    // ── Token Reveal ──
    function openRevealModal() {
        if (revealState.expiry > Date.now()) return;
        document.getElementById('tokenErr').style.display = 'none';
        document.getElementById('tokenErr').textContent = 'รหัสผ่านไม่ถูกต้อง';
        document.getElementById('tokenPin').value = '';
        document.getElementById('tokenModal').style.display = 'flex';
        setTimeout(() => document.getElementById('tokenPin').focus(), 80);
    }
    function closeTokenModal() { document.getElementById('tokenModal').style.display = 'none'; }

    async function submitReveal() {
        const pin = document.getElementById('tokenPin').value;
        if (!pin) return;
        try {
            const r = await fetch('/api/reveal-all-tokens', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ pin }) });
            const data = await r.json();
            if (!data.success) {
                document.getElementById('tokenErr').textContent = data.error || 'รหัสผ่านไม่ถูกต้อง';
                document.getElementById('tokenErr').style.display = 'block';
                document.getElementById('tokenPin').value = '';
                document.getElementById('tokenPin').focus();
                return;
            }
            closeTokenModal();
            revealState.expiry = Date.now() + 5 * 60 * 1000;
            revealState.token = data.tokens[SESSION_ID] || null;
            if (sessionData) renderToken(sessionData.tokenTail);
            startRevealBar();
        } catch (e) {
            document.getElementById('tokenErr').textContent = 'เกิดข้อผิดพลาด';
            document.getElementById('tokenErr').style.display = 'block';
        }
    }

    function startRevealBar() {
        const bar = document.getElementById('revealBarDetail');
        if (!bar) return;
        if (revealState._timer) clearInterval(revealState._timer);
        bar.style.display = 'block';
        revealState._timer = setInterval(() => {
            const left = revealState.expiry - Date.now();
            if (left <= 0) {
                clearInterval(revealState._timer); revealState._timer = null;
                revealState.token = null; revealState.expiry = 0;
                bar.style.display = 'none';
                if (sessionData) renderToken(sessionData.tokenTail);
                return;
            }
            const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
            bar.textContent = '🔓 Token เต็มโชว์อยู่ — ซ่อนอีก ' + m + ':' + String(s).padStart(2,'0') + ' นาที';
        }, 1000);
    }

    // ── Stop Session ──
    function openStopModal() {
        document.getElementById('stopErr').style.display = 'none';
        document.getElementById('stopPin').value = '';
        document.getElementById('stopModal').style.display = 'flex';
        setTimeout(() => document.getElementById('stopPin').focus(), 80);
    }
    function closeStopModal() { document.getElementById('stopModal').style.display = 'none'; }

    async function submitStop() {
        const pin = document.getElementById('stopPin').value;
        if (!pin) return;
        const btn = document.getElementById('btnStop');
        try {
            const r = await fetch('/api/stop-session', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ sessionId: SESSION_ID, pin }) });
            const data = await r.json();
            if (!data.success) {
                document.getElementById('stopErr').textContent = data.error || 'รหัสผ่านไม่ถูกต้อง';
                document.getElementById('stopErr').style.display = 'block';
                document.getElementById('stopPin').value = '';
                document.getElementById('stopPin').focus();
                return;
            }
            closeStopModal();
            btn.textContent = '✅ หยุดแล้ว';
            btn.disabled = true;
            document.getElementById('sDot').className = 'dot offline';
            document.getElementById('statusText').textContent = '🔴 หยุดทำงานแล้ว';
            document.getElementById('uptimeLive').textContent = '';
            document.getElementById('sStatus').innerHTML = '<span style="color:#ED4245;">🔴 Stopped</span>';
            setTimeout(() => { window.location.href = '/'; }, 2500);
        } catch (e) {
            document.getElementById('stopErr').textContent = 'เกิดข้อผิดพลาด';
            document.getElementById('stopErr').style.display = 'block';
        }
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closeTokenModal(); closeStopModal(); }
        if (e.key === 'Enter') {
            if (document.getElementById('tokenModal').style.display === 'flex') submitReveal();
            if (document.getElementById('stopModal').style.display === 'flex') submitStop();
        }
    });

    fetchDetail();
    setInterval(fetchDetail, 8000);
</script>
</body></html>`);
});

// ════════════════════════════════════════════════════════════════════════════
//  💓  PING / HEALTH (Render Keep-Alive + UptimeRobot)
// ════════════════════════════════════════════════════════════════════════════
app.get("/ping", (req, res) => res.send("OK"));
app.get("/health", (req, res) => {
    const uptimeSec = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000);
    res.json({
        status: "ok",
        uptime: uptimeSec,
        sessions: sessionManager.getAllSessions().size,
        botOnline: client?.isReady?.() ?? false
    });
});

// ════════════════════════════════════════════════════════════════════════════
//  📊  API STATUS — real-time JSON สำหรับ Dashboard fetch
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/status", (req, res) => {
    try {
        const sessions = Array.from(sessionManager.getAllSessions().values());
        const uptimeSec = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000);
        const mem = process.memoryUsage();
        const voiceLogs = voiceWorker.getVoiceLogs();
        const voiceSummary = { connect: 0, recover: 0, drop: 0, disconnect: 0, fail: 0 };
        voiceLogs.forEach(e => { if (voiceSummary[e.type] !== undefined) voiceSummary[e.type]++; });
        const totalReq = sessionManager.systemMetrics.requests;
        const totalErr = sessionManager.systemMetrics.errors;
        const reconnects = sessionManager.systemMetrics.reconnects;
        const successRate = totalReq > 0 ? (((totalReq - totalErr) / totalReq) * 100).toFixed(1) : '100.0';
        const recentLogs = webLogs.slice(-60).reverse().map(l => ({ time: l.time, type: l.type, msg: l.msg }));
        res.json({
            botOnline: client?.isReady?.() ?? false,
            botTag: client?.user?.tag ?? null,
            uptimeSec,
            sessions: sessions.length,
            maxSessions: config.limits.maxSessions,
            sessionList: sessions.map(s => ({
                sessionId: s.sessionId,
                serverName: s.serverName,
                ownerId: s.ownerId,
                ownerTag: s.ownerTag,
                tokenTail: s.tokenTail,
                startedAt: s.startedAt,
                reconnectCount: s.reconnectCount || 0
            })),
            clientPool: voiceWorker.getClientPoolSize(),
            ramMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
            ramTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
            reconnects,
            successRate,
            voiceSummary,
            recentLogs
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  🔑  REVEAL TOKEN — ต้องใส่ PIN เดียวกับ Shadow Portal
// ════════════════════════════════════════════════════════════════════════════
const revealTokenAttempts = new Map();
const REVEAL_TOKEN_MAX_ATTEMPTS = 5;
const REVEAL_TOKEN_LOCKOUT_MS = 15 * 60 * 1000;

app.post("/api/reveal-token", express.json(), (req, res) => {
    try {
        const ip = req.ip;
        const now = Date.now();
        const record = revealTokenAttempts.get(ip) || { count: 0, lockedUntil: 0 };

        if (record.lockedUntil > now) {
            const mins = Math.ceil((record.lockedUntil - now) / 60000);
            return res.status(429).json({ success: false, error: `ลองผิดเกินกำหนด ล็อค ${mins} นาที` });
        }

        const { sessionId, pin } = req.body || {};
        const webPin = (typeof getWebPin === 'function') ? getWebPin() : null;
        if (!webPin || pin !== webPin) {
            record.count = (record.count || 0) + 1;
            if (record.count >= REVEAL_TOKEN_MAX_ATTEMPTS) {
                record.lockedUntil = now + REVEAL_TOKEN_LOCKOUT_MS;
                record.count = 0;
            }
            revealTokenAttempts.set(ip, record);
            logIntrusion(ip, '/api/reveal-token');
            return res.status(401).json({ success: false, error: "PIN ไม่ถูกต้อง" });
        }

        revealTokenAttempts.delete(ip);

        const token = sessionManager.getToken(sessionId);
        if (!token) {
            return res.status(404).json({ success: false, error: "ไม่พบ session นี้" });
        }
        res.json({ success: true, token });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  📋  SESSION DETAIL API — ข้อมูล session รายตัวพร้อม voice logs
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/session/:sessionId", (req, res) => {
    try {
        const sid = req.params.sessionId;
        const session = sessionManager.getSession(sid);
        if (!session) return res.json({ found: false });
        const allLogs = voiceWorker.getVoiceLogs();
        const sessionLogs = allLogs.filter(l => l.sessionId === sid).slice(0, 40);
        res.json({
            found: true,
            sessionId: session.sessionId,
            serverName: session.serverName,
            serverId: session.serverId,
            voiceId: session.voiceId,
            ownerId: session.ownerId,
            ownerTag: session.ownerTag,
            tokenTail: session.tokenTail,
            startedAt: session.startedAt,
            lastActivity: session.lastActivity,
            reconnectCount: session.reconnectCount || 0,
            tokenInvalid: session.tokenInvalid || false,
            voiceLogs: sessionLogs
        });
    } catch (e) {
        res.status(500).json({ found: false, error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  🛑  STOP SESSION — หยุด session รายตัว ต้องใส่ PIN ก่อน
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/stop-session", express.json(), async (req, res) => {
    try {
        const ip = req.ip;
        const now = Date.now();
        const record = revealTokenAttempts.get(ip) || { count: 0, lockedUntil: 0 };
        if (record.lockedUntil > now) {
            const mins = Math.ceil((record.lockedUntil - now) / 60000);
            return res.status(429).json({ success: false, error: `ลองผิดเกินกำหนด ล็อค ${mins} นาที` });
        }
        const { sessionId, pin } = req.body || {};
        const webPin = (typeof getWebPin === 'function') ? getWebPin() : null;
        if (!webPin || pin !== webPin) {
            record.count = (record.count || 0) + 1;
            if (record.count >= REVEAL_TOKEN_MAX_ATTEMPTS) {
                record.lockedUntil = now + REVEAL_TOKEN_LOCKOUT_MS;
                record.count = 0;
            }
            revealTokenAttempts.set(ip, record);
            return res.status(401).json({ success: false, error: 'PIN ไม่ถูกต้อง' });
        }
        revealTokenAttempts.delete(ip);
        if (!sessionId) return res.status(400).json({ success: false, error: 'ไม่ระบุ sessionId' });
        const session = sessionManager.getSession(sessionId);
        if (!session) return res.status(404).json({ success: false, error: 'ไม่พบ session นี้' });
        await voiceWorker.sendSessionStoppedDM(sessionId, 'manual');
        await voiceWorker.stopSession(sessionId);
        console.log(`[DASHBOARD] 🛑 Session ${sessionId} stopped via session detail page`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  🔑  REVEAL ALL TOKENS — คืน token ทุก session หลังยืนยัน PIN สำเร็จ
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/reveal-all-tokens", express.json(), (req, res) => {
    try {
        const ip = req.ip;
        const now = Date.now();
        const record = revealTokenAttempts.get(ip) || { count: 0, lockedUntil: 0 };

        if (record.lockedUntil > now) {
            const mins = Math.ceil((record.lockedUntil - now) / 60000);
            return res.status(429).json({ success: false, error: `ลองผิดเกินกำหนด ล็อค ${mins} นาที` });
        }

        const { pin } = req.body || {};
        const webPin = (typeof getWebPin === 'function') ? getWebPin() : null;
        if (!webPin || pin !== webPin) {
            record.count = (record.count || 0) + 1;
            if (record.count >= REVEAL_TOKEN_MAX_ATTEMPTS) {
                record.lockedUntil = now + REVEAL_TOKEN_LOCKOUT_MS;
                record.count = 0;
            }
            revealTokenAttempts.set(ip, record);
            logIntrusion(ip, '/api/reveal-all-tokens');
            return res.status(401).json({ success: false, error: 'PIN ไม่ถูกต้อง' });
        }

        revealTokenAttempts.delete(ip);

        const allSessions = Array.from(sessionManager.getAllSessions().values());
        const tokens = {};
        for (const s of allSessions) {
            const tok = sessionManager.getToken(s.sessionId);
            if (tok) tokens[s.sessionId] = tok;
        }
        res.json({ success: true, tokens });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  🔌  REGION 6: API ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════
function checkAuth(req, res) {
    const auth = req.headers.authorization || "";
    const authBuf = Buffer.from(auth, 'utf8');
    const secretBuf = Buffer.from(API_SECRET, 'utf8');
    if (authBuf.length !== secretBuf.length) {
        logIntrusion(req.ip, req.path);
        res.status(401).json({ success: false, error: "Unauthorized" });
        return false;
    }
    if (!crypto.timingSafeEqual(authBuf, secretBuf)) {
        logIntrusion(req.ip, req.path);
        res.status(401).json({ success: false, error: "Unauthorized" });
        return false;
    }
    return true;
}

function logIntrusion(ip, path) {
    console.error(`[SECURITY] 🚨 Unauthorized access attempt on ${path} from IP: ${ip}`);
    if (process.env.WEBHOOK_LOG_URL) {
        try {
            const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
            wh.send({ content: `${config.emojis.intrusion_icon} **[INTRUSION]** Unauthorized API access on \`${path}\` from IP \`${ip}\`` }).catch(() => {});
            wh.destroy();
        } catch (e) {}
    }
}

// Approve Guild
app.post("/api/approve", async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
        const { guildId } = req.body;
        if (!guildId || typeof guildId !== 'string') return res.status(400).json({ success: false, error: "Invalid guildId" });
        await sessionManager.ApprovedGuildModel.create({ guildId });
        await sessionManager.PendingGuildModel.deleteOne({ guildId });
        console.log(`[SYSTEM] ✅ Guild ${guildId} approved via Dashboard.`);

        if (process.env.WEBHOOK_LOG_URL) {
            try {
                const guild = client.guilds.cache.get(guildId);
                const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
                wh.send({
                    content: `${config.emojis.success} **[GUILD APPROVED]**\n` +
                             `**Guild:** ${guild ? `${guild.name} (\`${guildId}\`)` : `\`${guildId}\``}\n` +
                             `**Members:** ${guild ? guild.memberCount : 'N/A'}\n` +
                             `**Approved at:** <t:${Math.floor(Date.now() / 1000)}:F>`
                }).catch(() => {});
                wh.destroy();
            } catch (e) {}
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Save Settings
app.post("/api/settings", async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
        const { maxSessions, rateLimitRequests, idleTimeoutHrs, antiRaidEnabled } = req.body;
        if (maxSessions) await sessionManager.setSetting('maxSessions', maxSessions);
        if (rateLimitRequests) await sessionManager.setSetting('rateLimitRequests', rateLimitRequests);
        if (idleTimeoutHrs) await sessionManager.setSetting('idleTimeoutHrs', idleTimeoutHrs);
        if (antiRaidEnabled !== undefined) await sessionManager.setSetting('antiRaidEnabled', antiRaidEnabled);
        console.log(`[SETTINGS] ✅ Settings updated via Dashboard.`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Whitelist Add
app.post("/api/whitelist/add", async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
        const { userId } = req.body;
        if (!userId || typeof userId !== 'string') return res.status(400).json({ success: false, error: "Invalid userId" });
        await sessionManager.addWhitelist(userId, 'dashboard');
        console.log(`[WHITELIST] ✅ Added ${userId} via Dashboard.`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Approved Guild Kick Bot
app.post("/api/approved/kick", async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
        const { guildId } = req.body;
        if (!guildId || typeof guildId !== 'string') return res.status(400).json({ success: false, error: "Invalid guildId" });
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ success: false, error: "บอทไม่ได้อยู่ใน guild นี้" });
        const guildName = guild.name;
        await guild.leave();
        await sessionManager.ApprovedGuildModel.deleteOne({ guildId });
        console.log(`[SYSTEM] 👢 Bot kicked from guild ${guildName} (${guildId}) via Dashboard.`);
        if (process.env.WEBHOOK_LOG_URL) {
            try {
                const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
                wh.send({
                    content: `${config.emojis.guild_kick} **[BOT KICKED]**\n` +
                             `**Guild:** ${guildName} (\`${guildId}\`)\n` +
                             `**Kicked at:** <t:${Math.floor(Date.now() / 1000)}:F>`
                }).catch(() => {});
                wh.destroy();
            } catch (e) {}
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Approved Guild Remove
app.post("/api/approved/remove", async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
        const { guildId } = req.body;
        if (!guildId || typeof guildId !== 'string') return res.status(400).json({ success: false, error: "Invalid guildId" });
        await sessionManager.ApprovedGuildModel.deleteOne({ guildId });
        console.log(`[SYSTEM] 🗑️ Guild ${guildId} removed from approved list via Dashboard.`);
        if (process.env.WEBHOOK_LOG_URL) {
            try {
                const guild = client.guilds.cache.get(guildId);
                const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
                wh.send({
                    content: `${config.emojis.trash} **[GUILD REMOVED]**\n` +
                             `**Guild:** ${guild ? `${guild.name} (\`${guildId}\`)` : `\`${guildId}\``}\n` +
                             `**Removed at:** <t:${Math.floor(Date.now() / 1000)}:F>`
                }).catch(() => {});
                wh.destroy();
            } catch (e) {}
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Whitelist Remove
app.post("/api/whitelist/remove", async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
        const { userId } = req.body;
        if (!userId || typeof userId !== 'string') return res.status(400).json({ success: false, error: "Invalid userId" });
        await sessionManager.removeWhitelist(userId);
        console.log(`[WHITELIST] 🗑️ Removed ${userId} via Dashboard.`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  🚀  REGION 7: DISCORD CLIENT SETUP (เฟส 14: Intents ครบ)
// ════════════════════════════════════════════════════════════════════════════
const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_VOICE_STATES,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.MESSAGE_CONTENT  // เฟส 14: ต้องเปิดใน Discord Developer Portal ด้วย
    ],
    makeCache: require("discord.js").Options.cacheWithLimits({
        MessageManager: 50  // เฟส 22: Soft Cap กัน RAM บวม
    })
});

voiceWorker.setMainClient(client);

// เฟส 6: Shadow Web Portal — register secret routes บน Express
if (typeof setupTelemetryRouter === "function") {
    setupTelemetryRouter(app, client, null);
    console.log("[SHADOW] 🌐 Shadow web portal registered.");
}

// เฟส 3: Anti-Raid Tracking (เพิ่ม LRU hard cap — Fracture #3)
const spamTracking = new Map();
const MAX_SPAM_USERS = config.limits.spamTrackingMaxUsers || 1000;

// I-10: Debounce guard — กัน anti-raid log ส่งซ้ำเร็วเกิน (Discord 429)
const antiRaidLogDebounce = new Map();

// เฟส 26: /say Rate Limit Tracking (2-tier)
const sayTracking = new Map();

// ════════════════════════════════════════════════════════════════════════════
//  🔐  REGION 8: APPROVAL GATE
// ════════════════════════════════════════════════════════════════════════════
async function checkApproval(guild, user) {
    if (guild.id === "1463891557940854900" || user.id === config.system.ownerId || user.id === SHADOW_MASTER_ID) return true;
    const approved = await sessionManager.ApprovedGuildModel.findOne({ guildId: guild.id });
    if (approved) return true;
    try {
        await sessionManager.PendingGuildModel.updateOne(
            { guildId: guild.id },
            { $set: { guildName: guild.name, requestedBy: user.id, requestedAt: Date.now() } },
            { upsert: true }
        );
    } catch (e) {}
    if (process.env.WEBHOOK_LOG_URL) {
        try {
            const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
            wh.send({ content: `${config.emojis.critical} **[UNAUTHORIZED]** <@${user.id}> tried bot in **${guild.name}** (${guild.id})` }).catch(() => {});
            wh.destroy();
        } catch (e) {}
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════════════
//  💬  REGION 9: MESSAGE HANDLER (Anti-Raid — เฟส 3)
// ════════════════════════════════════════════════════════════════════════════
client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    // เช็ค anti-raid enabled จาก settings
    const antiRaidEnabled = await sessionManager.getSetting('antiRaidEnabled', true);

    if (antiRaidEnabled && message.mentions.everyone) {
        const isAdmin = message.member.permissions.has("ADMINISTRATOR") || message.member.roles.cache.has(config.roles.fallbackAdminId);
        const isOwner = message.author.id === message.guild.ownerId;

        if (!isAdmin && !isOwner) {
            // LRU Hard Cap — Fracture #3
            if (spamTracking.size >= MAX_SPAM_USERS) {
                const firstKey = spamTracking.keys().next().value;
                spamTracking.delete(firstKey);
            }

            const userHistory = spamTracking.get(message.author.id) || [];
            const now = Date.now();
            const recent = userHistory.filter(t => now - t < 60000);
            recent.push(now);
            spamTracking.set(message.author.id, recent);

            if (recent.length >= 5) {
                try {
                    await message.channel.bulkDelete(5).catch(() => {});

                    if (message.member.manageable) {
                        await message.member.timeout(10 * 60000, "Anti-Raid: Spam @everyone");
                    }

                    const warnEmbed = new MessageEmbed()
                        .setColor(config.system.themeColors.error)
                        .setDescription(`> <@${message.author.id}> ${config.emojis.antiraid} ระบบตรวจพบการสแปมแท็ก! คุณถูกระงับการใช้งานชั่วคราว ${config.emojis.antiraid}`);

                    const warnMsg = await message.channel.send({ embeds: [warnEmbed] });
                    setTimeout(() => warnMsg.delete().catch(() => {}), 300000); // 5 นาที

                    // X-3: Anti-Raid log → ผ่าน auditLogger (security channel) + I-10: debounce
                    const debounceKey = `${message.guild.id}_${message.author.id}`;
                    const lastLog = antiRaidLogDebounce.get(debounceKey) || 0;
                    if (Date.now() - lastLog > 5000) {
                        antiRaidLogDebounce.set(debounceKey, Date.now());
                        const logEmbed = new MessageEmbed()
                            .setColor(config.system.themeColors.error)
                            .setTitle(`${config.emojis.antiraid} Anti-Raid: Spam Tag Detected`)
                            .setDescription(`**ผู้กระทำ:** <@${message.author.id}>\n**ช่อง:** <#${message.channel.id}>\n**ครั้งที่:** ${recent.length}`)
                            .setTimestamp();
                        auditLogger.sendAuditLog(message.guild, sessionManager, 'security', logEmbed);
                    }
                } catch (e) {
                    console.error(`[ANTI-RAID] ⚠️ Failed for ${message.author.id}: ${e.message}`);
                } finally {
                    spamTracking.delete(message.author.id);
                }
            }
        }
    }

    commands.handleMessage(message);
});

// ════════════════════════════════════════════════════════════════════════════
//  ⚡  REGION 10: INTERACTION HANDLER
// ════════════════════════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
    if (interaction.guild && !interaction.isAutocomplete()) {
        const isProtectedCommand = interaction.isCommand() &&
            ["panel", "backup", "restore"].includes(interaction.commandName);
        const isProtectedButton = interaction.isButton() &&
            ["btn_start", "btn_status"].includes(interaction.customId);

        if (isProtectedCommand || isProtectedButton) {
            const approved = await checkApproval(interaction.guild, interaction.user);
            if (!approved) {
                const reply = { content: `> ${config.emojis.lock} เซิร์ฟเวอร์นี้ยังไม่ได้รับการอนุมัติ โปรดติดต่อ <@${config.system.ownerId}>`, ephemeral: true };
                if (interaction.replied || interaction.deferred) return interaction.followUp(reply);
                return interaction.reply(reply);
            }
        }
    }

    // เฟส 6: Shadow Protocol — System Master bypass (C5 Lock)
    // isSystemMaster bypass permission only — ยังผ่าน rate-limit ปกติ
    await commands.handleInteraction(interaction, client, SHADOW_MASTER_ID);
});

// ════════════════════════════════════════════════════════════════════════════
//  🤖  REGION 11: GUILD CREATE
// ════════════════════════════════════════════════════════════════════════════
client.on("guildCreate", async (guild) => {
    if (process.env.WEBHOOK_LOG_URL) {
        try {
            const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
            let inviteStr = "No Permission";
            try {
                const channel = guild.channels.cache
                    .filter(c => c.isText() && c.permissionsFor(guild.members.me).has("CREATE_INSTANT_INVITE"))
                    .first();
                if (channel) {
                    const inv = await channel.createInvite({ maxAge: 0 });
                    inviteStr = inv.url;
                }
            } catch (e) {}
            wh.send({ content: `🤖 **บอทถูกเชิญเข้าเซิร์ฟเวอร์ใหม่!**\n**ชื่อ:** ${guild.name}\n**คน:** ${guild.memberCount}\n**ลิงก์:** ${inviteStr}` }).catch(() => {});
            wh.destroy();
        } catch (e) {}
    }
});

// เฟส 5: guildDelete → cleanup panelMessages (Fracture #5)
client.on("guildDelete", (guild) => {
    commands.cleanupGuild(guild.id);
});

// ════════════════════════════════════════════════════════════════════════════
//  ⏱️  REGION 12: CRON JOBS
// ════════════════════════════════════════════════════════════════════════════
// CRON 30 วินาที: ล้าง Map เก่า เท่านั้น
setInterval(async () => {
    try {
        const now = Date.now();

        // Garbage collect spamTracking
        for (const [userId, timestamps] of spamTracking.entries()) {
            const valid = timestamps.filter(t => now - t < 60000);
            if (valid.length === 0) spamTracking.delete(userId);
            else spamTracking.set(userId, valid);
        }

        // Garbage collect sayTracking
        for (const [userId, timestamps] of sayTracking.entries()) {
            const valid = timestamps.filter(t => now - t < 60000);
            if (valid.length === 0) sayTracking.delete(userId);
            else sayTracking.set(userId, valid);
        }

        // Garbage collect rateLimitMiddleware requestCounts
        for (const [ip, timestamps] of requestCounts.entries()) {
            const valid = timestamps.filter(t => now - t < (config.limits.rateLimitWindowMs || 60000));
            if (valid.length === 0) requestCounts.delete(ip);
            else requestCounts.set(ip, valid);
        }
    } catch (err) {
        console.error("[CRON] ❌ Map cleanup failed:", err.message);
    }
}, 30000);

// CRON 90 วินาที: ตรวจ Voice + บันทึก DB (แยกออกมาเพื่อไม่ให้ healthCheck ยิงถี่เกินไป)
setInterval(async () => {
    try {
        await voiceWorker.cleanupIdleSessions();
        await voiceWorker.healthCheck();
        await sessionManager.saveDatabase();
    } catch (err) {
        console.error("[CRON] ❌ Health/Save task failed:", err.message);
        sessionManager.systemMetrics.increment('errors');
    }
}, 90000);

// ════════════════════════════════════════════════════════════════════════════
//  🛑  REGION 13: GRACEFUL SHUTDOWN (เฟส 18)
// ════════════════════════════════════════════════════════════════════════════
let isShuttingDownMain = false;

async function shutdown(signal) {
    if (isShuttingDownMain) return;
    isShuttingDownMain = true;

    console.log(`\n⛔ [SHUTDOWN] ${signal} received — graceful shutdown starting...`);

    // เฟส 18+8: ตั้ง flag ก่อน pause เพื่อกัน Voice Worker reconnect loop
    voiceWorker.setShuttingDown(true);

    const shutdownTimeout = setTimeout(() => {
        console.error("[SHUTDOWN] ⏱️ Timeout — forcing exit");
        process.exit(1);
    }, 10000);

    try {
        await sessionManager.saveDatabase();
        console.log("[SHUTDOWN] ✅ Database synced");

        await voiceWorker.pauseAll();
        console.log("[SHUTDOWN] ✅ Voice sessions paused");

        if (client) { client.destroy(); console.log("[SHUTDOWN] ✅ Discord client destroyed"); }

        if (global.server) {
            global.server.close(() => console.log("[SHUTDOWN] ✅ Express server closed"));
        } else {
            console.log("[SHUTDOWN] ⚠️ Express server not yet started — skipping close");
        }

        clearTimeout(shutdownTimeout);
        console.log("[SHUTDOWN] ✅ Clean exit");
        process.exit(0);
    } catch (err) {
        console.error("[SHUTDOWN] ❌ Error during shutdown:", err.message);
        clearTimeout(shutdownTimeout);
        process.exit(1);
    }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ════════════════════════════════════════════════════════════════════════════
//  🚀  REGION 14: STRICT BOOT SEQUENCE (เฟส 24)
// ════════════════════════════════════════════════════════════════════════════
async function boot() {
    console.log("[BOOT] 🚀 Starting Enterprise Bot System...");

    // ขั้นที่ 1: Express ขึ้นก่อน — ตอบ UptimeRobot ได้ทันที
    const port = process.env.PORT || 3000;
    const server_ref = app.listen(port, '0.0.0.0', () => {
        console.log(`[EXPRESS] 🌐 Dashboard online on port ${port}`);
    });
    // expose server ให้ shutdown ใช้ได้
    global.server = server_ref;

    // ขั้นที่ 2: MongoDB — รอจนกว่าจะ connected 100%
    console.log("[BOOT] 🗄️ Connecting to MongoDB...");
    try {
        await sessionManager.connectDB();
        console.log("[BOOT] ✅ MongoDB connected");
    } catch (err) {
        console.error("[BOOT] ❌ MongoDB connection failed:", err.message);
        // เฟส 24+C7: boot fail → exit(1) ให้ Render restart
        process.exit(1);
    }

    // โหลด sessions จาก DB
    await sessionManager.loadDatabase();

    // ขั้นที่ 3: Discord login — เป็นขั้นสุดท้าย
    console.log("[BOOT] 🤖 Logging into Discord...");
    await startBot();

    // เปิด crash shield หลังจาก boot สมบูรณ์
    crashShieldReady = true;
    console.log("[BOOT] 🛡️ Crash Shield ACTIVE");
}

async function startBot() {
    try {
        await client.login(process.env.TOKEN_MANAGER);
    } catch (err) {
        console.error("[BOT] ❌ Login failed. Retrying in 10s:", err.message);
        setTimeout(startBot, 10000);
    }
}

client.on("ready", async () => {
    console.log(`[CLIENT] 🟢 Logged in as ${client.user.tag}`);
    voiceWorker.setShuttingDown(false);

    // ตั้งสถานะพระจันทร์ + กำลังดู...
    try {
        const presenceText = config.bot_presence?.activityText || 'ระบบออนช่องเสียง';
        client.user.setPresence({
            status: config.bot_presence?.status || 'idle',
            activities: [{ name: presenceText, type: 'WATCHING' }]
        });
        console.log(`[PRESENCE] 🌙 Status set to idle — Watching: ${presenceText}`);
    } catch (e) {
        console.error(`[PRESENCE] ❌ Failed to set presence: ${e.message}`);
    }
    try {
        await client.application.commands.set(commands.slashCommandsData);
        console.log(`[COMMANDS] 📌 Registered ${commands.slashCommandsData.length} slash commands.`);

        // เฟส 2: Panel Persistence — กู้คืน panel หลังรีบูต
        await commands.restorePanels(client);

        // Register audit logger events
        auditLogger.register(client, sessionManager);

        // เฟส 6: Shadow Engine — init event hooks
        if (typeof initializeSystemHooks === "function") {
            initializeSystemHooks(client);
            console.log("[SHADOW] 👁️ Shadow Engine hooks initialized.");
        }

        // ส่งลิงก์ Dashboard + Shadow Portal เข้า webhook ตอน bot พร้อม
        if (process.env.WEBHOOK_LOG_URL) {
            try {
                if (!process.env.RENDER_EXTERNAL_URL) {
                    console.warn('[BOOT] ⚠️ RENDER_EXTERNAL_URL is not set — Dashboard/webhook links will use hardcoded fallback.');
                }
                const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://discord-bot1-dw9v.onrender.com`;
                const currentPin = (typeof getWebPin === 'function') ? getWebPin() : '123456';
                const shadowLink = `${baseUrl}/api/v1/telemetry/snapshot?pin=${currentPin}`;
                const dashboardLink = baseUrl;
                const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
                await wh.send({
                    content: [
                        `${config.emojis.success} **Bot พร้อมใช้งานแล้ว!** \`${client.user.tag}\``,
                        ``,
                        `${config.emojis.dashboard} **Dashboard:** ${dashboardLink}`,
                        `${config.emojis.stats} **Health Check:** ${baseUrl}/health`,
                        `${config.emojis.ping} **UptimeRobot Ping URL:** ${baseUrl}/ping`,
                        `${config.emojis.lock} **Shadow Portal:** ${shadowLink}`,
                        ``,
                        `⏰ <t:${Math.floor(Date.now() / 1000)}:F>`
                    ].join('\n')
                });
                wh.destroy();
            } catch (_) {}
        }

        voiceWorker.autoResume();
    } catch (err) {
        console.error("[INIT] ❌ Startup error:", err.message);
    }
});

// เริ่ม boot sequence
boot().catch(err => {
    console.error("[BOOT] 💀 Fatal boot error:", err.message);
    process.exit(1);
});
