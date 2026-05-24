/*
================================================================================
  ENTERPRISE DASHBOARD — Views Layer
  ธีม: Dark Purple Glassmorphism
  หน้าทั้งหมด: /, /status, /settings, /commands, /whitelist, /approved,
               /logs, /logs/voice, /session/:id, /docs
================================================================================
*/

// ════════════════════════════════════════════════════════════════════════════
//  🎨  SHARED CSS — ใช้ทุกหน้า
// ════════════════════════════════════════════════════════════════════════════
const BASE_CSS = `
:root {
  --bg:        #07050f;
  --bg2:       #0f0b1e;
  --bg3:       #181228;
  --card:      rgba(20,15,40,0.85);
  --border:    rgba(120,80,255,0.18);
  --border2:   rgba(160,100,255,0.35);
  --accent:    #7c3aed;
  --accent2:   #a855f7;
  --accent3:   #d8b4fe;
  --green:     #22c55e;
  --green2:    #4ade80;
  --red:       #ef4444;
  --red2:      #f87171;
  --yellow:    #eab308;
  --yellow2:   #fbbf24;
  --blue:      #6366f1;
  --blue2:     #818cf8;
  --orange:    #f97316;
  --text:      #ede9fe;
  --text2:     #a78bfa;
  --text3:     #7c3aed88;
  --shadow:    0 8px 32px rgba(124,58,237,0.15);
  --shadow2:   0 2px 8px rgba(0,0,0,0.4);
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html { scroll-behavior: smooth; }

body {
  background: var(--bg);
  background-image:
    radial-gradient(ellipse at 20% 20%, rgba(124,58,237,0.12) 0%, transparent 50%),
    radial-gradient(ellipse at 80% 80%, rgba(168,85,247,0.08) 0%, transparent 50%),
    radial-gradient(ellipse at 50% 50%, rgba(99,102,241,0.05) 0%, transparent 70%);
  background-attachment: fixed;
  color: var(--text);
  font-family: 'Segoe UI', 'Noto Sans Thai', system-ui, sans-serif;
  min-height: 100vh;
  padding: 16px;
  font-size: 15px;
  line-height: 1.5;
}

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: var(--bg2); }
::-webkit-scrollbar-thumb { background: var(--accent); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--accent2); }

/* ── Container ── */
.container    { max-width: 740px;  margin: 0 auto; }
.container-lg { max-width: 1000px; margin: 0 auto; }

/* ── Glass Card ── */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  transition: border-color .2s;
}
.card:hover { border-color: var(--border2); }
.card h3 {
  font-size: 0.78em;
  color: var(--text2);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 6px;
}

/* ── Page Header ── */
.page-title {
  font-size: 1.5em;
  font-weight: 900;
  text-align: center;
  margin-bottom: 4px;
  background: linear-gradient(135deg, #a855f7, #d8b4fe, #818cf8);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.page-sub {
  text-align: center;
  color: var(--text3);
  font-size: 0.8em;
  margin-bottom: 18px;
}

/* ── Navigation ── */
.nav {
  display: flex; gap: 6px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.nav a {
  background: var(--bg2);
  color: var(--text2);
  padding: 7px 14px;
  border-radius: 10px;
  text-decoration: none;
  font-size: 0.78em;
  border: 1px solid var(--border);
  transition: all .15s;
  white-space: nowrap;
}
.nav a:hover  { background: var(--accent); color: #fff; border-color: var(--accent2); box-shadow: 0 0 10px rgba(124,58,237,.4); }
.nav a.active { background: linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; border-color: transparent; box-shadow: 0 0 14px rgba(124,58,237,.5); }

/* ── Stat Grid ── */
.grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; margin-bottom: 16px; }
@media(max-width:520px) { .grid { grid-template-columns: repeat(2,1fr); } }

.stat {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px 10px;
  text-align: center;
  transition: all .2s;
  cursor: default;
}
.stat:hover { border-color: var(--border2); transform: translateY(-2px); box-shadow: var(--shadow); }
.stat .val { font-size: 1.7em; font-weight: 900; line-height: 1.1; margin-top: 4px; }
.stat .lbl { font-size: 0.63em; color: var(--text3); margin-top: 4px; text-transform: uppercase; letter-spacing: .6px; }

/* ── Status Bar ── */
.status-bar {
  display: flex; align-items: center; gap: 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 14px;
  backdrop-filter: blur(12px);
}
.dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; transition: all .3s; }
.dot.online  { background: var(--green2); box-shadow: 0 0 8px var(--green2), 0 0 16px rgba(74,222,128,.3); animation: pulse-green 2s infinite; }
.dot.offline { background: var(--red2);   box-shadow: 0 0 8px var(--red2); }
.dot.purple  { background: var(--accent2); box-shadow: 0 0 8px var(--accent2); }
.dot.yellow  { background: var(--yellow2); box-shadow: 0 0 8px var(--yellow2); }
@keyframes pulse-green {
  0%, 100% { box-shadow: 0 0 8px var(--green2), 0 0 16px rgba(74,222,128,.3); }
  50%       { box-shadow: 0 0 12px var(--green2), 0 0 24px rgba(74,222,128,.5); }
}

/* ── Progress Bar ── */
.progress-bg   { background: var(--bg3); border-radius: 8px; height: 8px; overflow: hidden; }
.progress-fill { height: 8px; border-radius: 8px; transition: width .6s ease, background .3s; }

/* ── Terminal / Log ── */
.terminal {
  background: #020108;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 11.5px;
  overflow-y: auto;
  line-height: 1.6;
}
.log-line           { margin-bottom: 2px; word-break: break-all; }
.log-line.info      { color: var(--green2); }          /* ✅ เขียวสำหรับ info */
.log-line.error     { color: var(--red2); }             /* ✅ แดงสำหรับ error */
.log-line.warn      { color: var(--yellow2); }          /* ✅ เหลืองสำหรับ warn */

/* ── Input / Select ── */
input, select, textarea {
  background: var(--bg2);
  color: var(--text);
  border: 1px solid var(--border);
  padding: 10px 13px;
  border-radius: 10px;
  width: 100%;
  margin-top: 6px;
  font-size: 0.88em;
  outline: none;
  transition: border-color .15s, box-shadow .15s;
  font-family: inherit;
}
input:focus, select:focus, textarea:focus {
  border-color: var(--accent2);
  box-shadow: 0 0 0 3px rgba(168,85,247,.15);
}
textarea { resize: vertical; min-height: 70px; }
label { color: var(--text2); font-size: 0.8em; display: block; margin-top: 14px; font-weight: 500; }

/* ── Buttons (สีต่างกันตามประเภท) ── */
.btn { border: none; padding: 10px 20px; border-radius: 10px; font-weight: 700; cursor: pointer; width: 100%; margin-top: 14px; font-size: 0.88em; transition: all .18s; letter-spacing: .2px; }

/* Primary - ม่วง (save/confirm) */
.btn-primary { background: linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; }
.btn-primary:hover { box-shadow: 0 0 18px rgba(124,58,237,.5); transform: translateY(-1px); }

/* Success - เขียว (เปิดใช้งาน/เพิ่ม) */
.btn-success { background: linear-gradient(135deg,#166534,var(--green2)); color:#000; }
.btn-success:hover { box-shadow: 0 0 18px rgba(74,222,128,.4); transform: translateY(-1px); }

/* Danger - แดง (ลบ/หยุด/ปิด) */
.btn-danger { background: linear-gradient(135deg,#7f1d1d,var(--red2)); color:#fff; }
.btn-danger:hover { box-shadow: 0 0 18px rgba(248,113,113,.4); transform: translateY(-1px); }

/* Warning - เหลือง (เตือน/เตะ) */
.btn-warning { background: linear-gradient(135deg,#713f12,var(--yellow2)); color:#000; }
.btn-warning:hover { box-shadow: 0 0 18px rgba(251,191,36,.4); transform: translateY(-1px); }

/* Info - น้ำเงิน */
.btn-info { background: linear-gradient(135deg,#1e1b4b,var(--blue2)); color:#fff; }
.btn-info:hover { box-shadow: 0 0 18px rgba(129,140,248,.4); transform: translateY(-1px); }

.btn:disabled { background: var(--bg3); color: var(--text3); cursor: not-allowed; transform: none; box-shadow: none; }

/* ── Inline Button (เล็ก) ── */
.btn-sm { padding: 5px 12px; border-radius: 7px; font-size: 0.78em; width: auto; margin-top: 0; }

/* ── Modal ── */
.modal {
  display: none; position: fixed; inset: 0;
  background: rgba(5,3,18,.88);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  justify-content: center; align-items: center; z-index: 9999;
}
.modal-box {
  background: linear-gradient(135deg,var(--bg2),var(--bg3));
  border: 1px solid var(--border2);
  border-radius: 20px;
  padding: 32px 28px;
  width: 100%; max-width: 340px;
  text-align: center;
  position: relative;
  box-shadow: 0 16px 48px rgba(124,58,237,.3), var(--shadow);
  animation: modal-in .2s ease;
}
@keyframes modal-in { from { opacity:0; transform:scale(.9); } to { opacity:1; transform:scale(1); } }
.modal-close {
  position: absolute; top: 12px; right: 14px;
  background: none; border: none; color: var(--text3);
  font-size: 1.1em; cursor: pointer;
  transition: color .15s;
}
.modal-close:hover { color: var(--text); }

/* ── Badge ── */
.badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 0.72em; font-weight: 700; }
.badge-on  { background: rgba(34,197,94,.12); color: var(--green2); border: 1px solid rgba(34,197,94,.3); }
.badge-off { background: rgba(239,68,68,.12); color: var(--red2);   border: 1px solid rgba(239,68,68,.3); }

/* ── Toggle Switch ── */
.toggle { position: relative; display: inline-block; width: 46px; height: 26px; flex-shrink: 0; }
.toggle input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; cursor: pointer; inset: 0; background: var(--bg3); border-radius: 26px; transition: .25s; border: 1px solid var(--border); }
.slider::before { position: absolute; content: ''; height: 20px; width: 20px; left: 2px; bottom: 2px; background: var(--text3); border-radius: 50%; transition: .25s; }
input:checked + .slider { background: var(--accent); border-color: var(--accent2); }
input:checked + .slider::before { transform: translateX(20px); background: #fff; box-shadow: 0 0 6px rgba(168,85,247,.5); }
.toggle.loading .slider { opacity: .5; cursor: wait; }

/* ── Table ── */
table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: 10px 10px; color: var(--text3); border-bottom: 1px solid var(--border); font-size: 0.75em; font-weight: 600; text-transform: uppercase; letter-spacing: .6px; }
td { padding: 10px 10px; border-bottom: 1px solid rgba(120,80,255,.06); font-size: 0.84em; vertical-align: middle; }
tr:last-child td { border-bottom: none; }
tbody tr { transition: background .12s; }
tbody tr:hover td { background: rgba(124,58,237,.05); }

/* ── Session Item ── */
.session-item {
  background: rgba(15,11,30,.7);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  padding: 10px 14px;
  margin-bottom: 8px;
  font-size: 0.82em;
  transition: all .15s;
}
.session-item:hover { border-left-color: var(--accent2); background: rgba(20,15,40,.9); }
.sv { color: var(--accent3); font-weight: 700; text-decoration: none; }
.sv:hover { color: #fff; }

/* ── Voice Stats Row ── */
.voice-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.voice-box {
  flex: 1; min-width: 85px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 8px;
  text-align: center;
  transition: all .2s;
}
.voice-box:hover { border-color: var(--border2); transform: translateY(-2px); }
.vval { font-size: 1.5em; font-weight: 900; }
.vlbl { font-size: 0.6em; color: var(--text3); margin-top: 3px; text-transform: uppercase; letter-spacing: .5px; }

/* ── Token Display ── */
.token-masked {
  color: var(--text3); font-size: 0.82em; cursor: pointer;
  font-family: monospace; letter-spacing: .5px;
  transition: color .2s; user-select: none;
  padding: 7px 12px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px; display: inline-block;
}
.token-masked:hover { color: var(--yellow2); border-color: rgba(251,191,36,.4); }
.token-full-wrap {
  font-family: monospace; font-size: 0.78em; color: var(--yellow2);
  word-break: break-all;
  background: rgba(13,9,0,.8);
  border: 1px solid rgba(251,191,36,.25);
  border-radius: 8px; padding: 8px 12px;
  display: flex; align-items: flex-start; gap: 8px;
}
.copy-btn {
  background: var(--bg3); border: none; color: var(--text2);
  font-size: 0.72em; cursor: pointer; padding: 3px 8px;
  border-radius: 5px; flex-shrink: 0; transition: all .15s;
}
.copy-btn:hover { background: var(--accent); color: #fff; }
.reveal-bar {
  background: rgba(13,9,0,.8);
  border: 1px solid rgba(251,191,36,.2);
  border-radius: 8px; padding: 6px 12px;
  font-size: 0.74em; color: var(--yellow2);
  text-align: center; margin-top: 8px; display: none;
}

/* ── Toast Notification ── */
.toast {
  position: fixed; bottom: 24px; right: 20px;
  border-radius: 12px; padding: 12px 18px;
  font-size: 0.85em; display: none; z-index: 99999;
  max-width: 300px;
  box-shadow: 0 8px 24px rgba(0,0,0,.4);
  animation: toast-in .2s ease;
  backdrop-filter: blur(12px);
}
@keyframes toast-in { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:translateX(0); } }
.toast.ok   { background:rgba(20,83,45,.9); border:1px solid rgba(34,197,94,.4); color:var(--green2); }
.toast.err  { background:rgba(127,29,29,.9); border:1px solid rgba(239,68,68,.4); color:var(--red2); }
.toast.warn { background:rgba(113,63,18,.9); border:1px solid rgba(234,179,8,.4); color:var(--yellow2); }
.toast.info { background:rgba(30,27,75,.9); border:1px solid rgba(99,102,241,.4); color:var(--blue2); }

/* ── Hero Box ── */
.hero {
  background: linear-gradient(135deg,rgba(30,10,74,.9),rgba(45,16,102,.8),rgba(26,8,64,.9));
  border: 1px solid rgba(124,58,237,.4);
  border-radius: 18px; padding: 28px 20px;
  text-align: center; margin-bottom: 16px;
  box-shadow: 0 0 40px rgba(124,58,237,.15);
}
.hero-label { font-size: 0.72em; color: var(--accent3); letter-spacing: 2px; text-transform: uppercase; margin-bottom: 10px; }
.hero-time  { font-size: 2.8em; font-weight: 900; color: var(--accent3); line-height: 1; }
.hero-since { font-size: 0.72em; color: var(--text3); margin-top: 10px; }
.hero.offline { background: linear-gradient(135deg,rgba(45,10,10,.9),rgba(26,5,5,.9)); border-color: rgba(239,68,68,.3); box-shadow: 0 0 30px rgba(239,68,68,.1); }
.hero.offline .hero-label,.hero.offline .hero-time,.hero.offline .hero-since { color: var(--red2); }

/* ── Command Row ── */
.cmd-row { display:flex; align-items:center; gap:10px; padding:9px 0; border-bottom:1px solid rgba(120,80,255,.06); }
.cmd-row:last-child { border-bottom:none; }
.cmd-name { font-family:monospace; font-size:0.88em; color:var(--accent3); min-width:130px; }
.cmd-desc { font-size:0.76em; color:var(--text3); flex:1; line-height:1.4; }

/* ── Spin ── */
.spin { display:inline-block; width:20px; height:20px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

/* ── Info Row ── */
.info-row { display:flex; justify-content:space-between; align-items:flex-start; padding:7px 0; border-bottom:1px solid rgba(120,80,255,.06); font-size:0.83em; gap:8px; }
.info-row:last-child { border-bottom:none; }
.info-label { color:var(--text3); flex-shrink:0; }
.info-value { color:var(--text); text-align:right; word-break:break-all; }

/* ── Docs ── */
.docs-section { margin-bottom:32px; }
.docs-section h2 { font-size:1em; font-weight:700; color:var(--accent3); margin-bottom:12px; display:flex; align-items:center; gap:8px; }
.docs-cmd { background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:8px; transition:all .15s; }
.docs-cmd:hover { border-color:var(--border2); background:var(--bg3); }
.docs-cmd-name { font-family:monospace; font-size:0.9em; color:var(--accent3); font-weight:700; }
.docs-cmd-desc { font-size:0.8em; color:var(--text2); margin-top:4px; line-height:1.5; }
.docs-cmd-perm { font-size:0.72em; color:var(--text3); margin-top:4px; }
.docs-tag { display:inline-block; padding:1px 7px; border-radius:6px; font-size:0.7em; font-weight:700; margin-right:4px; }
.docs-tag.admin { background:rgba(239,68,68,.15); color:var(--red2); border:1px solid rgba(239,68,68,.25); }
.docs-tag.owner { background:rgba(234,179,8,.15); color:var(--yellow2); border:1px solid rgba(234,179,8,.25); }
.docs-tag.mod   { background:rgba(99,102,241,.15); color:var(--blue2); border:1px solid rgba(99,102,241,.25); }
.docs-tag.all   { background:rgba(34,197,94,.15); color:var(--green2); border:1px solid rgba(34,197,94,.25); }

/* ── Settings Cards ── */
.dc-list { background:var(--bg2); border-radius:12px; overflow:hidden; border:1px solid var(--border); margin-top:8px; }
.dc-item { display:flex; align-items:center; gap:14px; padding:13px 16px; cursor:pointer; border-bottom:1px solid var(--border); transition:background .12s; user-select:none; }
.dc-item:last-child { border-bottom:none; }
.dc-item:hover,.dc-item.sel { background:var(--bg3); }
.dc-dot { width:18px; height:18px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
.dc-lbl { flex:1; font-size:0.88em; color:var(--text); }
.dc-radio { width:18px; height:18px; border-radius:50%; border:2px solid var(--border2); flex-shrink:0; display:flex; align-items:center; justify-content:center; transition:all .15s; }
.dc-radio.on { border-color:var(--accent); background:var(--accent); }
.dc-radio.on::after { content:''; width:7px; height:7px; border-radius:50%; background:#fff; }

.act-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
.act-btn { flex:1; min-width:100px; padding:9px 8px; border-radius:9px; border:1px solid var(--border); background:var(--bg2); color:var(--text2); cursor:pointer; text-align:center; font-size:0.8em; transition:all .15s; }
.act-btn:hover,.act-btn.active { border-color:var(--accent2); background:rgba(124,58,237,.2); color:#fff; }

.preview { background:var(--bg2); border-radius:12px; padding:16px; display:flex; align-items:center; gap:14px; margin-top:8px; border:1px solid var(--border); }
.av { width:52px; height:52px; border-radius:50%; background:linear-gradient(135deg,var(--accent),var(--accent2)); display:flex; align-items:center; justify-content:center; font-size:24px; position:relative; flex-shrink:0; }
.av-dot { position:absolute; bottom:1px; right:1px; width:14px; height:14px; border-radius:50%; border:2.5px solid var(--bg2); transition:background .2s; }

.ri { display:flex; align-items:center; gap:8px; margin-top:8px; }
.ri input { flex:1; margin-top:0; }
.ri-empty { color:var(--text3); font-size:0.8em; text-align:center; padding:14px; border:1px dashed var(--border); border-radius:10px; margin-top:8px; }

.msg-toast { padding:10px 14px; border-radius:10px; margin-bottom:14px; display:none; font-size:0.86em; }
`;

// ════════════════════════════════════════════════════════════════════════════
//  🔧  HELPERS
// ════════════════════════════════════════════════════════════════════════════
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
        ['/approved', '✅ Approved'],
        ['/docs', '📖 คู่มือ'],
        ['/logs', '📜 Logs'],
        ['/logs/voice', '🔊 Voice'],
    ];
    return `<nav class="nav">${links.map(([href, label]) =>
        `<a href="${href}"${href === active ? ' class="active"' : ''}>${label}</a>`
    ).join('')}</nav>`;
}

function shell(title, body) {
    return `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — Phomueangtai Enterprise</title>
<style>${BASE_CSS}</style>
</head><body>${body}</body></html>`;
}

function toastScript() {
    return `
<div class="toast" id="__toast"></div>
<script>
function showToast(msg,type='ok'){
    const t=document.getElementById('__toast');
    t.textContent=msg; t.className='toast '+type;
    t.style.display='block';
    clearTimeout(t.__t);
    t.__t=setTimeout(()=>t.style.display='none',3800);
}
</script>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  🏠  หน้าหลัก
// ════════════════════════════════════════════════════════════════════════════
function pageHome(API_SECRET) {
    return shell('หน้าหลัก', `
<div class="container">
<h1 class="page-title">🚀 Enterprise Control Center</h1>
<p class="page-sub" id="lastUpdate">กำลังโหลด...</p>
${navBar('/')}

<div class="status-bar">
    <div class="dot" id="statusDot"></div>
    <span id="statusText" style="font-weight:700;">กำลังตรวจสอบ...</span>
    <span id="botTag" style="color:var(--text3);font-size:0.8em;margin-left:auto;"></span>
</div>

<!-- Online Duration Banner -->
<div class="hero" id="onlineBanner" style="display:none;">
    <div class="hero-label">🟢 บอทออนต่อเนื่องมาแล้ว</div>
    <div class="hero-time" id="onlineDuration">--</div>
    <div class="hero-since" id="onlineSince">ตั้งแต่ --</div>
</div>

<!-- Stats -->
<div class="grid">
    <div class="stat"><div class="val" id="statUptime" style="color:var(--yellow2);">--</div><div class="lbl">⏱ System Uptime</div></div>
    <div class="stat"><div class="val" id="statSessions" style="color:var(--green2);">--</div><div class="lbl">📡 Sessions</div></div>
    <div class="stat"><div class="val" id="statPool" style="color:var(--blue2);">--</div><div class="lbl">🔌 Client Pool</div></div>
    <div class="stat"><div class="val" id="statRam" style="color:#e879f9;">-- MB</div><div class="lbl">🧠 RAM</div></div>
    <div class="stat"><div class="val" id="statReconnect" style="color:var(--orange);">--</div><div class="lbl">🔄 Reconnects</div></div>
    <div class="stat"><div class="val" id="statSuccess" style="color:var(--green2);">--%</div><div class="lbl">✅ Success Rate</div></div>
</div>

<!-- Sessions -->
<div class="card">
    <h3>📡 Sessions ที่ออนอยู่</h3>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="font-size:0.82em;color:var(--text2);">ผู้ใช้ที่กำลังออนอยู่ในระบบ</span>
        <span id="sessionCount" style="font-size:0.85em;font-weight:700;color:var(--accent3);">0 / --</span>
    </div>
    <div class="progress-bg" style="margin-bottom:12px;">
        <div class="progress-fill" id="sessionBar" style="width:0%"></div>
    </div>
    <div class="reveal-bar" id="revealBar"></div>
    <div id="sessionList"><div style="color:var(--text3);text-align:center;padding:20px 0;font-size:0.85em;">ยังไม่มี session ออนอยู่</div></div>
</div>

<!-- Voice Stats -->
<div class="voice-row">
    <div class="voice-box"><div class="vval" style="color:var(--green2);" id="vc_connect">0</div><div class="vlbl">🟢 เชื่อมต่อ</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--blue2);" id="vc_recover">0</div><div class="vlbl">💖 กู้คืน</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--yellow2);" id="vc_drop">0</div><div class="vlbl">⚡ หลุด (ด่วน)</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--orange);" id="vc_disconnect">0</div><div class="vlbl">⚠️ หลุด</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--red2);" id="vc_fail">0</div><div class="vlbl">💔 ล้มเหลว</div></div>
</div>

<!-- Live Logs — สีถูกต้องตามประเภท -->
<div class="card">
    <h3>💻 Live Logs <span id="logCount" style="font-weight:normal;text-transform:none;letter-spacing:0;color:var(--text3);font-size:0.9em;"></span></h3>
    <div class="terminal" id="logTerminal" style="height:220px;"></div>
</div>

<div style="text-align:center;margin-bottom:30px;">
    <button onclick="document.getElementById('adminModal').style.display='flex'"
        style="background:var(--bg2);color:var(--text3);border:1px solid var(--border);padding:8px 22px;border-radius:10px;cursor:pointer;font-size:0.8em;transition:all .15s;"
        onmouseover="this.style.borderColor='var(--accent2)';this.style.color='var(--accent3)'"
        onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text3)'">
        ⚙️ Admin Access
    </button>
</div>
</div>

<!-- Token Modal -->
<div class="modal" id="tokenModal" onclick="if(event.target===this)closeTokenModal()">
<div class="modal-box">
    <button class="modal-close" onclick="closeTokenModal()">✕</button>
    <div style="font-size:2em;margin-bottom:8px;">🔑</div>
    <h3 style="color:var(--yellow2);margin-bottom:6px;font-size:1em;">ดู Token เต็ม</h3>
    <p style="color:var(--text3);font-size:0.78em;margin-bottom:16px;">กรอกรหัสผ่านเพื่อแสดง Token ทุกตัว 5 นาที</p>
    <p id="tokenErr" style="color:var(--red2);font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
    <input id="tokenPin" type="password" placeholder="รหัสผ่านลับ..." style="text-align:center;margin-bottom:12px;">
    <button onclick="submitRevealToken()" class="btn btn-warning">🔑 เปิดดู Token</button>
</div>
</div>

<!-- Admin Modal -->
<div class="modal" id="adminModal" onclick="if(event.target===this)this.style.display='none'">
<div class="modal-box">
    <button class="modal-close" onclick="document.getElementById('adminModal').style.display='none'">✕</button>
    <div style="font-size:2em;margin-bottom:8px;">👁️‍🗨️</div>
    <h3 style="color:var(--accent3);margin-bottom:6px;font-size:1em;">Shadow Portal Access</h3>
    <p style="color:var(--text3);font-size:0.78em;margin-bottom:16px;">กรอกรหัสผ่านลับเพื่อเข้า Shadow Dashboard</p>
    <p id="adminErr" style="color:var(--red2);font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
    <input id="adminPin" type="password" placeholder="Shadow PIN..." style="text-align:center;margin-bottom:12px;">
    <button onclick="adminLogin()" class="btn btn-primary">🌑 เข้าสู่ Shadow Portal</button>
</div>
</div>

${toastScript()}
<script>
function fmtUp(s){const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;if(d>0)return d+'d '+h+'h';if(h>0)return h+'h '+m+'m';return m+'m '+ss+'s';}
function fmtFull(s){const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;if(d>0)return d+' วัน '+h+' ชม. '+m+' นาที';if(h>0)return h+' ชม. '+m+' นาที '+ss+' วิ';if(m>0)return m+' นาที '+ss+' วิ';return ss+' วินาที';}

const revealState={expiry:0,tokens:{},_timer:null};

async function fetchStatus(){
    try{
        const r=await fetch('/api/status'); if(!r.ok)return;
        const d=await r.json();
        const dot=document.getElementById('statusDot'),txt=document.getElementById('statusText');
        if(d.botOnline){dot.className='dot online';txt.textContent='🟢 บอทออนไลน์';txt.style.color='var(--green2)';}
        else{dot.className='dot offline';txt.textContent='🔴 บอทออฟไลน์';txt.style.color='var(--red2)';}
        document.getElementById('botTag').textContent=d.botTag?'@'+d.botTag:'';

        const banner=document.getElementById('onlineBanner');
        if(d.botOnline&&d.botOnlineSec!==null){
            banner.style.display='block';
            document.getElementById('onlineDuration').textContent=fmtFull(d.botOnlineSec);
            const sinceDate=new Date(Date.now()-(d.botOnlineSec*1000));
            document.getElementById('onlineSince').textContent='ตั้งแต่ '+sinceDate.toLocaleString('th-TH',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
        } else {banner.style.display='none';}

        document.getElementById('statUptime').textContent=fmtUp(d.uptimeSec);
        document.getElementById('statSessions').textContent=d.sessions+'/'+d.maxSessions;
        document.getElementById('statPool').textContent=d.clientPool;
        document.getElementById('statRam').textContent=d.ramMB+' MB';
        document.getElementById('statReconnect').textContent=d.reconnects;
        document.getElementById('statSuccess').textContent=d.successRate+'%';

        const pct=d.maxSessions>0?Math.round((d.sessions/d.maxSessions)*100):0;
        document.getElementById('sessionCount').textContent=d.sessions+' / '+d.maxSessions;
        const bar=document.getElementById('sessionBar');
        bar.style.width=pct+'%';
        bar.style.background=pct>80?'linear-gradient(90deg,var(--red),var(--red2))':pct>50?'linear-gradient(90deg,var(--yellow),var(--yellow2))':'linear-gradient(90deg,var(--accent),var(--accent2))';

        const sl=document.getElementById('sessionList');
        if(d.sessionList&&d.sessionList.length>0){
            sl.innerHTML=d.sessionList.map(s=>{
                const tail=s.tokenTail?s.tokenTail.substring(0,2)+'••••'+s.tokenTail.substring(s.tokenTail.length-2):'••••••••';
                const sid=s.sessionId.replace(/['"<>&]/g,'');
                const ms=Date.now()-s.startedAt;
                const uh=Math.floor(ms/3600000),um=Math.floor((ms%3600000)/60000);
                const ustr=uh>0?uh+'h '+um+'m':um+'m';
                const rc=s.reconnectCount||0;
                const revealed=revealState.expiry>Date.now()&&revealState.tokens[sid];
                const tokenBlock=revealed
                    ?'<div class="token-full-wrap"><span style="flex:1;">'+revealState.tokens[sid]+'</span><button class="copy-btn" onclick="navigator.clipboard.writeText(\''+revealState.tokens[sid].replace(/'/g,"\\'")+'\');this.textContent=\'✅\';setTimeout(()=>this.textContent=\'📋\',1500)">📋</button></div>'
                    :'<span class="token-masked" onclick="openRevealModal()" title="คลิกดู Token เต็ม">🔑 '+tail+'</span>';
                return '<div class="session-item">'+
                    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">'+
                    '<a class="sv" href="/session/'+sid+'">🖥️ '+(s.serverName||'Unknown')+'</a>'+
                    '<span style="color:var(--text3);font-size:0.75em;">⏱ '+ustr+'</span></div>'+
                    '<div style="margin:5px 0;">'+tokenBlock+'</div>'+
                    '<div style="color:var(--text3);font-size:0.78em;">👤 '+(s.ownerTag||s.ownerId||'?')+(rc>0?' · 🔄 '+rc+' ครั้ง':'')+
                    ' · <a href="/session/'+sid+'" style="color:var(--text3);text-decoration:none;">ดูรายละเอียด →</a></div></div>';
            }).join('');
        } else {
            sl.innerHTML='<div style="color:var(--text3);text-align:center;padding:20px 0;font-size:0.85em;">ยังไม่มี session ออนอยู่</div>';
        }

        const vs=d.voiceSummary||{};
        ['connect','recover','drop','disconnect','fail'].forEach(k=>{ document.getElementById('vc_'+k).textContent=vs[k]||0; });

        const logs=d.recentLogs||[];
        document.getElementById('logCount').textContent='('+logs.length+' รายการ)';
               const term=document.getElementById('logTerminal');
        term.innerHTML=logs.map(l=>{
            // สีถูกต้องตามประเภท: error=แดง, warn=เหลือง, info=เขียว
            const cls=l.type==='error'?'error':l.type==='warn'?'warn':'info';
            return '<div class="log-line '+cls+'">['+l.time+'] '+l.msg.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</div>';
        }).join('');

        document.getElementById('lastUpdate').textContent='อัปเดตทุก 5 วิ • '+new Date().toLocaleTimeString('th-TH');
    } catch(e){ document.getElementById('lastUpdate').textContent='⚠️ ดึงข้อมูลไม่ได้'; }
}

function openRevealModal(){
    if(revealState.expiry>Date.now()) return;
    document.getElementById('tokenErr').style.display='none';
    document.getElementById('tokenPin').value='';
    document.getElementById('tokenModal').style.display='flex';
    setTimeout(()=>document.getElementById('tokenPin').focus(),80);
}
function closeTokenModal(){ document.getElementById('tokenModal').style.display='none'; }

async function submitRevealToken(){
    const pin=document.getElementById('tokenPin').value; if(!pin) return;
    try{
        const r=await fetch('/api/reveal-all-tokens',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
        const d=await r.json();
        if(!d.success){ document.getElementById('tokenErr').textContent=d.error||'รหัสผ่านไม่ถูกต้อง'; document.getElementById('tokenErr').style.display='block'; document.getElementById('tokenPin').value=''; return; }
        closeTokenModal();
        revealState.expiry=Date.now()+5*60*1000; revealState.tokens=d.tokens||{};
        fetchStatus(); startRevealBar();
    } catch(e){ document.getElementById('tokenErr').textContent='เกิดข้อผิดพลาด'; document.getElementById('tokenErr').style.display='block'; }
}

function startRevealBar(){
    const bar=document.getElementById('revealBar'); if(!bar) return;
    if(revealState._timer) clearInterval(revealState._timer);
    bar.style.display='block';
    revealState._timer=setInterval(()=>{
        const left=revealState.expiry-Date.now();
        if(left<=0){ clearInterval(revealState._timer); revealState._timer=null; revealState.tokens={}; revealState.expiry=0; bar.style.display='none'; fetchStatus(); return; }
        const m=Math.floor(left/60000),s=Math.floor((left%60000)/1000);
        bar.textContent='🔓 Token โชว์อยู่ — ซ่อนอีก '+m+':'+String(s).padStart(2,'0');
    },1000);
}

function adminLogin(){
    const pin=document.getElementById('adminPin').value; if(!pin) return;
    fetch('/api/v1/telemetry/snapshot?pin='+encodeURIComponent(pin))
    .then(r=>r.text()).then(html=>{
        if(html.includes('CONTROL PORTAL')||html.includes('กรอกรหัสผ่านลับ')){ document.getElementById('adminErr').style.display='block'; document.getElementById('adminPin').value=''; }
        else window.location.href='/api/v1/telemetry/snapshot?pin='+encodeURIComponent(pin);
    }).catch(()=>{ window.location.href='/api/v1/telemetry/snapshot?pin='+encodeURIComponent(pin); });
}

document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){ closeTokenModal(); document.getElementById('adminModal').style.display='none'; }
    if(e.key==='Enter'){
        if(document.getElementById('tokenModal').style.display==='flex') submitRevealToken();
        if(document.getElementById('adminModal').style.display==='flex') adminLogin();
    }
});
fetchStatus(); setInterval(fetchStatus,5000);
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  📊  หน้า STATUS
// ════════════════════════════════════════════════════════════════════════════
function pageStatus() {
    return shell('สถานะระบบ', `
<div class="container">
<h1 class="page-title">📊 สถานะระบบ</h1>
<p class="page-sub" id="lastUp">กำลังโหลด...</p>
${navBar('/status')}

<div style="text-align:center;padding:30px 0;" id="loadingBox">
    <div class="spin"></div>
    <div style="color:var(--text3);font-size:0.82em;margin-top:12px;">กำลังดึงข้อมูล...</div>
</div>

<div class="hero" id="heroBox" style="display:none;">
    <div class="hero-label" id="heroLabel">🟢 บอทออนต่อเนื่องมาแล้ว</div>
    <div class="hero-time" id="heroTime">--</div>
    <div class="hero-since" id="heroSince">ตั้งแต่ --</div>
</div>

<div id="statusRows" style="display:none;">
    <div class="status-bar" style="margin-bottom:10px;">
        <div class="dot" id="dotBot"></div>
        <span class="info-label">🤖 Discord Bot</span>
        <span id="valBot" style="margin-left:auto;font-size:0.85em;font-weight:700;">--</span>
    </div>
    <div class="status-bar" style="margin-bottom:10px;">
        <div class="dot purple"></div>
        <span class="info-label">🍃 MongoDB Atlas</span>
        <span id="valDB" style="margin-left:auto;font-size:0.85em;font-weight:700;color:var(--blue2);">กำลังตรวจ...</span>
    </div>
    <div class="status-bar" style="margin-bottom:16px;">
        <div class="dot yellow"></div>
        <span class="info-label">⏱️ System Uptime (process)</span>
        <span id="valUptime" style="margin-left:auto;font-size:0.85em;font-weight:700;color:var(--yellow2);">--</span>
    </div>
    <div class="grid">
        <div class="stat"><div class="val" id="cvSessions" style="color:var(--green2);">--</div><div class="lbl">📡 Sessions</div></div>
        <div class="stat"><div class="val" id="cvRam" style="color:#e879f9;">-- MB</div><div class="lbl">🧠 RAM</div></div>
        <div class="stat"><div class="val" id="cvReconn" style="color:var(--orange);">--</div><div class="lbl">🔄 Reconnects</div></div>
        <div class="stat"><div class="val" id="cvSuccess" style="color:var(--green2);">--%</div><div class="lbl">✅ Success Rate</div></div>
    </div>
</div>
</div>
<script>
function fmtFull(s){const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;if(d>0)return d+' วัน '+h+' ชม. '+m+' นาที';if(h>0)return h+' ชม. '+m+' นาที '+ss+' วิ';if(m>0)return m+' นาที '+ss+' วิ';return ss+' วินาที';}
function fmtShort(s){const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);if(d>0)return d+'d '+h+'h '+m+'m';if(h>0)return h+'h '+m+'m';return m+'m '+Math.floor(s%60)+'s';}
let _on=null,_sys=null,_tick=null;
function tick(){ if(_on!==null){_on++;document.getElementById('heroTime').textContent=fmtFull(_on);} if(_sys!==null){_sys++;document.getElementById('valUptime').textContent=fmtShort(_sys);} }
async function load(){
    try{
        const r=await fetch('/api/status'); if(!r.ok)throw new Error();
        const d=await r.json();
        document.getElementById('loadingBox').style.display='none';
        document.getElementById('heroBox').style.display='block';
        document.getElementById('statusRows').style.display='block';
        document.getElementById('lastUp').textContent='อัปเดต: '+new Date().toLocaleTimeString('th-TH');
        const hero=document.getElementById('heroBox');
        if(d.botOnline&&d.botOnlineSec!==null){
            hero.className='hero'; _on=d.botOnlineSec;
            document.getElementById('heroLabel').textContent='🟢 บอทออนต่อเนื่องมาแล้ว';
            document.getElementById('heroTime').textContent=fmtFull(_on);
            document.getElementById('heroSince').textContent='ตั้งแต่ '+new Date(Date.now()-(_on*1000)).toLocaleString('th-TH',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
        }else{ hero.className='hero offline'; document.getElementById('heroLabel').textContent='🔴 บอทออฟไลน์'; document.getElementById('heroTime').textContent='ไม่มีการเชื่อมต่อ'; document.getElementById('heroSince').textContent=''; _on=null; }
        const db=document.getElementById('dotBot'),vb=document.getElementById('valBot');
        if(d.botOnline){db.className='dot online';vb.textContent='🟢 Online — '+(d.botTag||'');vb.style.color='var(--green2)';}
        else{db.className='dot offline';vb.textContent='🔴 Offline';vb.style.color='var(--red2)';}
        try{ const hp=await fetch('/health');const hd=await hp.json(); document.getElementById('valDB').textContent=hd.status==='ok'?'🟢 เชื่อมต่อแล้ว':'🔴 ผิดพลาด'; document.getElementById('valDB').style.color=hd.status==='ok'?'var(--blue2)':'var(--red2)'; }catch{ document.getElementById('valDB').textContent='⚠️ ตรวจไม่ได้'; }
        _sys=d.uptimeSec;
        document.getElementById('cvSessions').textContent=d.sessions+'/'+d.maxSessions;
        document.getElementById('cvRam').textContent=d.ramMB+' MB';
        document.getElementById('cvReconn').textContent=d.reconnects;
        document.getElementById('cvSuccess').textContent=d.successRate+'%';
        if(_tick) clearInterval(_tick); _tick=setInterval(tick,1000);
    }catch(e){ document.getElementById('loadingBox').innerHTML='<div style="color:var(--red2);">⚠️ ดึงข้อมูลไม่ได้</div>'; }
}
load(); setInterval(load,30000);
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚡  หน้า COMMANDS DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
function pageCommands(commands, disabledCommands, commandAuditLog, API_SECRET) {
    const allCmds = commands.slashCommandsData || [];
    const total   = allCmds.length;
    const disabled = [...disabledCommands].filter(n => allCmds.find(c => c.name === n)).length;
    const enabled  = total - disabled;

    const CATEGORIES = [
        { label:'🔊 Voice System', color:'var(--accent3)', names:['panel'] },
        { label:'📊 ข้อมูล',       color:'var(--blue2)',   names:['ping','stats','serverinfo','userinfo','help'] },
        { label:'🛡️ จัดการ',       color:'var(--red2)',    names:['ban','kick','timeout','clear','voicekickall'] },
        { label:'🔧 ยูทิลิตี้',    color:'var(--green2)',  names:['say','announce','steal','backup','restore','setup-log','whitelist'] }
    ];

    const categoryHtml = CATEGORIES.map(cat => {
        const rows = cat.names.map(name => {
            const cmd = allCmds.find(c => c.name === name);
            if (!cmd) return '';
            const on = !disabledCommands.has(name);
            return `<div class="cmd-row">
                <span class="cmd-name" style="color:${cat.color};">/${escapeHtml(name)}</span>
                <span class="cmd-desc">${escapeHtml(cmd.description || '')}</span>
                <span class="badge ${on ? 'badge-on' : 'badge-off'}" id="badge-${name}">${on ? 'เปิด' : 'ปิด'}</span>
                <label class="toggle" id="tw-${name}">
                    <input type="checkbox" ${on ? 'checked' : ''} onchange="toggleCmd('${name}',this.checked)" id="tog-${name}">
                    <span class="slider"></span>
                </label>
            </div>`;
        }).join('');
        if (!rows.trim()) return '';
        return `<div class="card"><h3 style="color:${cat.color};">${cat.label}</h3>${rows}</div>`;
    }).join('');

    return shell('Commands Dashboard', `
<div class="container">
<h1 class="page-title">⚡ Commands Dashboard</h1>
<p class="page-sub">เปิด/ปิดคำสั่ง Slash Commands — มีผลทันที ไม่ต้อง restart</p>
${navBar('/commands')}

<div class="grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px;">
    <div class="stat"><div class="val" id="stTotal" style="color:var(--accent3);">${total}</div><div class="lbl">คำสั่งทั้งหมด</div></div>
    <div class="stat"><div class="val" id="stEnabled" style="color:var(--green2);">${enabled}</div><div class="lbl">กำลังเปิดใช้</div></div>
    <div class="stat"><div class="val" id="stDisabled" style="color:var(--red2);">${disabled}</div><div class="lbl">ปิดใช้งาน</div></div>
</div>

${categoryHtml}

<div class="card">
    <h3>📋 Audit Log — ประวัติการเปิด/ปิด <span id="auditCount" style="font-weight:normal;text-transform:none;letter-spacing:0;color:var(--text3);font-size:0.9em;"></span></h3>
    <div id="auditBody" style="font-size:0.82em;color:var(--text3);text-align:center;padding:18px 0;">กำลังโหลด...</div>
</div>
</div>
${toastScript()}
<script>
const SECRET='${API_SECRET}';
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
    const wrap=document.getElementById('tw-'+name);
    if(wrap) wrap.classList.add('loading');
    try{
        const r=await fetch('/api/commands/toggle',{method:'POST',headers:{'Content-Type':'application/json','Authorization':SECRET},body:JSON.stringify({commandName:name})});
        const d=await r.json();
        if(d.success){
            const on=d.enabled;
            if(inp) inp.checked=on;
            if(badge){badge.textContent=on?'เปิด':'ปิด'; badge.className='badge '+(on?'badge-on':'badge-off');}
            updateStats();
            showToast((on?'✅ เปิด':'❌ ปิด')+' /'+name+' แล้ว', on?'ok':'err');
            fetchAudit();
        }else{
            if(inp) inp.checked=!want;
            showToast('❌ '+(d.error||'เกิดข้อผิดพลาด'),'err');
        }
    }catch(e){ if(inp) inp.checked=!want; showToast('❌ เชื่อมต่อไม่ได้','err'); }
    if(wrap) wrap.classList.remove('loading');
}
function fmtTime(ts){const d=new Date(ts),p=n=>String(n).padStart(2,'0');return p(d.getDate())+'/'+p(d.getMonth()+1)+'/'+d.getFullYear()+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());}
async function fetchAudit(){
    try{
        const r=await fetch('/api/commands-audit'); const d=await r.json();
        const body=document.getElementById('auditBody'), cnt=document.getElementById('auditCount');
        if(!d.success||!d.log.length){ body.innerHTML='<span>ยังไม่มีประวัติ — กด toggle คำสั่งใดก็ได้</span>'; cnt.textContent=''; return; }
        cnt.textContent='('+d.log.length+' รายการ)';
        body.innerHTML='<table><thead><tr><th>เวลา</th><th>คำสั่ง</th><th style="text-align:center;">การกระทำ</th><th>IP</th></tr></thead><tbody>'+
            d.log.slice(0,30).map(e=>'<tr><td style="color:var(--text3);white-space:nowrap;">'+fmtTime(e.timestamp)+'</td>'+
                '<td style="font-family:monospace;color:var(--accent3);">/'+e.commandName+'</td>'+
                '<td style="text-align:center;">'+(e.action==='enabled'?'<span class="badge badge-on">เปิด ✅</span>':'<span class="badge badge-off">ปิด ❌</span>')+'</td>'+
                '<td style="color:var(--text3);font-family:monospace;font-size:0.82em;">'+e.ip+'</td></tr>').join('')+
            '</tbody></table>';
    }catch(e){ document.getElementById('auditBody').textContent='⚠️ ดึงข้อมูลไม่ได้'; }
}
fetchAudit(); setInterval(fetchAudit,15000);
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  📋  หน้า WHITELIST
// ════════════════════════════════════════════════════════════════════════════
function pageWhitelist(list, API_SECRET) {
    const rows = list.map(w => {
        const safeId = escapeHtml(w.userId);
        const safeBy = escapeHtml(w.addedBy || '-');
        return `<tr>
            <td><code style="color:var(--accent3);">${safeId}</code></td>
            <td style="color:var(--text2);">${safeBy}</td>
            <td><button onclick="removeUser('${safeId}')" class="btn btn-danger btn-sm">ลบ</button></td>
        </tr>`;
    }).join('');

    return shell('Whitelist', `
<div class="container">
<h1 class="page-title">📋 /say Whitelist</h1>
<p class="page-sub">ผู้ใช้ในรายการนี้ใช้ /say ได้บ่อยกว่าคนทั่วไป (สูงสุด 10 ครั้ง/นาที)</p>
${navBar('/whitelist')}

<div class="card">
    <h3>➕ เพิ่มผู้ใช้</h3>
    <div style="display:flex;gap:8px;margin-top:0;">
        <input type="text" id="newUserId" placeholder="Discord User ID เช่น 661415152146710558" style="flex:1;margin-top:0;">
        <button onclick="addUser()" class="btn btn-success btn-sm" style="width:auto;margin-top:0;">➕ เพิ่ม</button>
    </div>
</div>

<div class="card">
    <h3>👥 รายชื่อ Whitelist (${list.length} คน)</h3>
    ${list.length > 0 ? `
    <table>
        <thead><tr><th>User ID</th><th>เพิ่มโดย</th><th style="text-align:center;">จัดการ</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>` : `<div style="text-align:center;color:var(--text3);padding:28px 0;font-size:0.85em;">ยังไม่มีรายชื่อ</div>`}
</div>
</div>
${toastScript()}
<script>
async function addUser(){
    const userId=document.getElementById('newUserId').value.trim();
    if(!userId) return showToast('กรุณากรอก User ID','warn');
    const r=await fetch('/api/whitelist/add',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify({userId})});
    const d=await r.json();
    if(d.success){showToast('✅ เพิ่ม '+userId+' แล้ว','ok'); setTimeout(()=>location.reload(),1000);}
    else showToast('❌ '+(d.error||'Unknown'),'err');
}
async function removeUser(userId){
    if(!confirm('ลบ '+userId+' ออกจาก whitelist?')) return;
    const r=await fetch('/api/whitelist/remove',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify({userId})});
    const d=await r.json();
    if(d.success) location.reload(); else showToast('❌ '+(d.error||'Unknown'),'err');
}
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  ✅  หน้า APPROVED GUILDS
// ════════════════════════════════════════════════════════════════════════════
function pageApproved(approvedList, client, API_SECRET) {
    const rows = approvedList.map(a => {
        const guild   = client.guilds.cache.get(a.guildId);
        const name    = guild ? escapeHtml(guild.name) : 'ไม่พบในบอท';
        const members = guild ? guild.memberCount.toLocaleString() : '-';
        const at      = a.approvedAt
            ? new Date(a.approvedAt).toLocaleString('th-TH',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})
            : '-';
        return `<tr>
            <td><code style="color:var(--text3);font-size:0.82em;">${a.guildId}</code></td>
            <td style="font-weight:600;">${name}</td>
            <td style="text-align:center;color:var(--text2);">${members}</td>
            <td style="color:var(--text3);font-size:0.8em;">${at}</td>
            <td>
                <div style="display:flex;gap:6px;justify-content:center;">
                    <button onclick="removeGuild('${a.guildId}')" class="btn btn-danger btn-sm">ลบ</button>
                    <button onclick="kickGuild('${a.guildId}')"   class="btn btn-warning btn-sm">เตะบอท</button>
                </div>
            </td>
        </tr>`;
    }).join('');

    return shell('Approved Guilds', `
<div class="container-lg">
<h1 class="page-title">✅ Approved Guilds</h1>
<p class="page-sub">${approvedList.length} เซิร์ฟเวอร์ที่ได้รับการอนุมัติ</p>
${navBar('/approved')}
<div class="card" style="padding:0;overflow:hidden;">
    ${approvedList.length > 0 ? `
    <table>
        <thead><tr>
            <th>Guild ID</th><th>ชื่อเซิร์ฟเวอร์</th>
            <th style="text-align:center;">สมาชิก</th>
            <th>อนุมัติเมื่อ</th>
            <th style="text-align:center;">จัดการ</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>` : `<div style="text-align:center;color:var(--text3);padding:40px;font-size:0.85em;">ยังไม่มีเซิร์ฟเวอร์</div>`}
</div>
</div>
${toastScript()}
<script>
async function removeGuild(guildId){
    if(!confirm('ลบ '+guildId+' ออกจาก Approved?')) return;
    const r=await fetch('/api/approved/remove',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify({guildId})});
    const d=await r.json();
    if(d.success) location.reload(); else showToast('❌ '+(d.error||'Unknown'),'err');
}
async function kickGuild(guildId){
    if(!confirm('เตะบอทออกจาก '+guildId+'?')) return;
    const r=await fetch('/api/approved/kick',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'${API_SECRET}'},body:JSON.stringify({guildId})});
    const d=await r.json();
    if(d.success){showToast('✅ เตะบอทออกแล้ว','ok');setTimeout(()=>location.reload(),1000);}
    else showToast('❌ '+(d.error||'Unknown'),'err');
}
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  📜  หน้า LOGS
// ════════════════════════════════════════════════════════════════════════════
function pageLogs(webLogs, MAX_LOGS) {
    const logsHtml = webLogs.slice().reverse().map(l => {
        const cls = l.type === 'error' ? 'error' : l.type === 'warn' ? 'warn' : 'info';
        return `<div class="log-line ${cls}">[${l.time}] ${l.msg.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;
    }).join('');

    return shell('System Logs', `
<div class="container-lg">
<h1 class="page-title">📜 System Logs</h1>
<p class="page-sub">${webLogs.length} / ${MAX_LOGS} รายการ — <span style="color:var(--green2);">● info</span> <span style="color:var(--yellow2);">● warn</span> <span style="color:var(--red2);">● error</span></p>
${navBar('/logs')}
<div class="terminal" id="term" style="height:72vh;">${logsHtml}</div>
</div>
<script>
document.getElementById('term').scrollTop=document.getElementById('term').scrollHeight;
setTimeout(()=>location.reload(),10000);
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  🔊  หน้า VOICE LOG
// ════════════════════════════════════════════════════════════════════════════
function pageVoiceLogs(logs) {
    const colorMap = {connect:'var(--green2)',recover:'var(--blue2)',drop:'var(--yellow2)',disconnect:'var(--orange)',fail:'var(--red2)'};
    const iconMap  = {connect:'🟢',recover:'💖',drop:'⚡',disconnect:'⚠️',fail:'💔'};
    const labelMap = {connect:'เชื่อมต่อ',recover:'กู้คืน',drop:'หลุด (ด่วน)',disconnect:'หลุด',fail:'ล้มเหลว'};
    const summary  = {connect:0,recover:0,drop:0,disconnect:0,fail:0};
    logs.forEach(e => { if (summary[e.type] !== undefined) summary[e.type]++; });

    const rows = logs.length === 0
        ? `<tr><td colspan="4" style="text-align:center;padding:28px;color:var(--text3);">ยังไม่มี Event — บอทยังไม่ได้เชื่อมต่อ Voice</td></tr>`
        : logs.map(e => `<tr>
            <td style="color:var(--text3);white-space:nowrap;font-size:0.8em;">${new Date(e.ts).toLocaleTimeString('th-TH',{hour12:false})}</td>
            <td style="color:${colorMap[e.type]||'var(--text2)'};font-weight:700;">${iconMap[e.type]||'❓'} ${labelMap[e.type]||e.type}</td>
            <td style="font-family:monospace;font-size:0.78em;color:var(--text2);">${e.sessionId}</td>
            <td style="color:var(--text3);font-size:0.8em;">${e.detail||'-'}</td>
        </tr>`).join('');

    return shell('Voice Log', `
<div class="container-lg">
<h1 class="page-title">🔊 Voice Connection Log</h1>
<p class="page-sub">อัปเดตทุก 15 วิ — เก็บ ${logs.length}/200 events ล่าสุด</p>
${navBar('/logs/voice')}
<div class="voice-row" style="margin-bottom:18px;">
    <div class="voice-box"><div class="vval" style="color:var(--green2);">${summary.connect}</div><div class="vlbl">🟢 เชื่อมต่อ</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--blue2);">${summary.recover}</div><div class="vlbl">💖 กู้คืน</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--yellow2);">${summary.drop}</div><div class="vlbl">⚡ หลุด (ด่วน)</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--orange);">${summary.disconnect}</div><div class="vlbl">⚠️ หลุด</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--red2);">${summary.fail}</div><div class="vlbl">💔 ล้มเหลว</div></div>
</div>
<div class="card" style="padding:0;overflow:hidden;">
    <table>
        <thead><tr><th>เวลา</th><th>สถานะ</th><th>Session ID</th><th>รายละเอียด</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>
</div>
</div>
<script>setTimeout(()=>location.reload(),15000);</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  🖥️  SESSION DETAIL PAGE
// ════════════════════════════════════════════════════════════════════════════
function pageSessionDetail(safeId) {
    return shell('Session Detail', `
<div class="container">
<div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;">
    <a href="/" style="background:var(--bg2);color:var(--accent3);padding:7px 14px;border-radius:10px;text-decoration:none;font-size:0.8em;border:1px solid var(--border);">← หน้าหลัก</a>
    <span style="color:var(--text3);font-size:0.8em;">Session Detail</span>
</div>

<div id="notFound" style="display:none;text-align:center;padding:60px 20px;">
    <div style="font-size:3em;margin-bottom:12px;">❌</div>
    <h2 style="color:var(--red2);margin-bottom:8px;">ไม่พบ Session นี้</h2>
    <p style="color:var(--text3);font-size:0.85em;margin-bottom:16px;">Session อาจหยุดทำงานแล้ว หรือ ID ไม่ถูกต้อง</p>
    <a href="/" style="color:var(--accent3);">← กลับหน้าหลัก</a>
</div>

<div id="pageContent">
    <h1 id="pageTitle" class="page-title" style="text-align:left;font-size:1.2em;">⏳ กำลังโหลด...</h1>
    <p id="pageSubtitle" class="page-sub" style="text-align:left;"></p>

    <div class="status-bar">
        <div class="dot" id="sDot"></div>
        <span id="sTxt" style="font-weight:700;">กำลังตรวจสอบ...</span>
        <span id="uptimeLive" style="color:var(--yellow2);font-size:0.82em;margin-left:auto;"></span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
        <div class="card">
            <h3>📋 ข้อมูล Session</h3>
            <div class="info-row"><span class="info-label">เซิร์ฟเวอร์</span><span class="info-value" id="iServer">--</span></div>
            <div class="info-row"><span class="info-label">ช่องเสียง</span><span class="info-value" id="iVoice">--</span></div>
            <div class="info-row"><span class="info-label">เจ้าของ</span><span class="info-value" id="iOwner">--</span></div>
            <div class="info-row"><span class="info-label">เริ่มออนเมื่อ</span><span class="info-value" id="iStarted">--</span></div>
            <div class="info-row"><span class="info-label">ใช้งานล่าสุด</span><span class="info-value" id="iActivity">--</span></div>
            <div class="info-row"><span class="info-label">Session ID</span><span class="info-value" id="iSid" style="font-family:monospace;font-size:0.72em;color:var(--text3);">--</span></div>
        </div>
        <div class="card">
            <h3>📊 สถิติ</h3>
            <div style="text-align:center;padding:12px 0;">
                <div id="sUptime" style="font-size:2em;font-weight:900;color:var(--yellow2);">--</div>
                <div style="font-size:0.65em;color:var(--text3);margin-top:4px;text-transform:uppercase;letter-spacing:.5px;">⏱ เวลาออนทั้งหมด</div>
            </div>
            <div style="border-top:1px solid var(--border);margin:10px 0;"></div>
            <div class="info-row"><span class="info-label">🔄 Reconnect</span><span class="info-value" id="sReconnect" style="color:var(--orange);">--</span></div>
            <div class="info-row"><span class="info-label">สถานะ</span><span class="info-value" id="sStatus">--</span></div>
            <div class="info-row"><span class="info-label">🔑 Token</span><span class="info-value" id="sTokenHealth">--</span></div>
        </div>
    </div>

    <div class="card">
        <h3>🔑 Token</h3>
        <div id="tokenDisplay"></div>
        <div id="revealHint" style="font-size:0.72em;color:var(--text3);margin-top:6px;">คลิกที่ Token เพื่อดูแบบเต็ม (ต้องใช้รหัสผ่าน)</div>
        <div class="reveal-bar" id="revealBarDetail"></div>
    </div>

    <div class="card">
        <h3>📡 ประวัติการเชื่อมต่อ <span id="logCount" style="font-weight:normal;text-transform:none;letter-spacing:0;color:var(--text3);font-size:0.9em;"></span></h3>
        <div id="logTableWrap"><p style="color:var(--text3);font-size:0.82em;text-align:center;padding:20px 0;">ยังไม่มีประวัติ</p></div>
    </div>

    <div style="background:rgba(127,29,29,.15);border:1px solid rgba(239,68,68,.25);border-radius:16px;padding:20px;text-align:center;margin-bottom:20px;">
        <h3 style="color:var(--red2);margin-bottom:8px;">🛑 หยุด Session นี้</h3>
        <p style="color:var(--text3);font-size:0.8em;margin-bottom:14px;line-height:1.6;">เมื่อหยุดแล้ว บอทจะออกจากช่องเสียงทันที<br>เจ้าของจะได้รับแจ้งเตือนทาง DM</p>
        <button class="btn btn-danger" id="btnStop" onclick="openStopModal()" style="width:auto;padding:11px 28px;">🛑 หยุด Session นี้</button>
    </div>
</div>
</div>

<!-- Token Modal -->
<div class="modal" id="tokenModal" onclick="if(event.target===this)closeTokenModal()">
<div class="modal-box">
    <button class="modal-close" onclick="closeTokenModal()">✕</button>
    <div style="font-size:1.8em;margin-bottom:8px;">🔑</div>
    <h3 style="color:var(--yellow2);margin-bottom:6px;font-size:1em;">ดู Token เต็ม</h3>
    <p style="color:var(--text3);font-size:0.78em;margin-bottom:16px;">กรอกรหัสผ่านเพื่อดู Token 5 นาที</p>
    <p id="tokenErr" style="color:var(--red2);font-size:0.82em;margin-bottom:8px;display:none;"></p>
    <input id="tokenPin" type="password" placeholder="รหัสผ่านลับ..." style="text-align:center;margin-bottom:12px;">
    <button onclick="submitReveal()" class="btn btn-warning">🔑 เปิดดู Token</button>
</div>
</div>

<!-- Stop Modal -->
<div class="modal" id="stopModal" onclick="if(event.target===this)closeStopModal()">
<div class="modal-box">
    <button class="modal-close" onclick="closeStopModal()">✕</button>
    <div style="font-size:1.8em;margin-bottom:8px;">🛑</div>
    <h3 style="color:var(--red2);margin-bottom:6px;font-size:1em;">ยืนยันการหยุด Session</h3>
    <p style="color:var(--text3);font-size:0.78em;margin-bottom:16px;">กรอกรหัสผ่านเพื่อยืนยัน<br>บอทจะออกจากช่องเสียงทันที</p>
    <p id="stopErr" style="color:var(--red2);font-size:0.82em;margin-bottom:8px;display:none;"></p>
    <input id="stopPin" type="password" placeholder="รหัสผ่านลับ..." style="text-align:center;margin-bottom:12px;">
    <button onclick="submitStop()" class="btn btn-danger">🛑 ยืนยันหยุด Session</button>
</div>
</div>

${toastScript()}
<script>
const SESSION_ID='${safeId}';
let sessionData=null;
const rv={expiry:0,token:null,_timer:null};

function fmtMs(ms){const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000);if(h>0)return h+'h '+m+'m';if(m>0)return m+'m '+s+'s';return s+'s';}
function fmtTime(ts){return new Date(ts).toLocaleString('th-TH',{hour12:false});}
function fmtAgo(ts){const d=Math.floor((Date.now()-ts)/1000);if(d<60)return d+'วิที่แล้ว';if(d<3600)return Math.floor(d/60)+'นาทีที่แล้ว';if(d<86400)return Math.floor(d/3600)+'ชม.ที่แล้ว';return Math.floor(d/86400)+'วันที่แล้ว';}

async function fetchDetail(){
    try{
        const r=await fetch('/api/session/'+SESSION_ID);
        const d=await r.json();
        if(!d.found){document.getElementById('pageContent').style.display='none';document.getElementById('notFound').style.display='block';return;}
        sessionData=d; renderDetail(d);
    }catch(e){}
}

function renderDetail(d){
    document.getElementById('pageTitle').textContent='🖥️ '+(d.serverName||'Unknown');
    document.getElementById('pageSubtitle').textContent='Session ID: '+d.sessionId;
    document.getElementById('sDot').className='dot online';
    document.getElementById('sTxt').textContent='🟢 กำลังออนอยู่';
    document.getElementById('sTxt').style.color='var(--green2)';
    const ms=Date.now()-d.startedAt;
    document.getElementById('uptimeLive').textContent='⏱ '+fmtMs(ms);
    document.getElementById('sUptime').textContent=fmtMs(ms);
    document.getElementById('iServer').textContent=d.serverName||'-';
    document.getElementById('iVoice').textContent='#'+d.voiceId;
    document.getElementById('iOwner').textContent=d.ownerTag||d.ownerId||'-';
    document.getElementById('iStarted').textContent=fmtTime(d.startedAt);
    document.getElementById('iActivity').textContent=d.lastActivity?fmtAgo(d.lastActivity):'-';
    document.getElementById('iSid').textContent=d.sessionId;
    const rc=d.reconnectCount||0;
    document.getElementById('sReconnect').textContent=rc>0?rc+' ครั้ง':'ยังไม่มี';
    document.getElementById('sStatus').innerHTML='<span style="color:var(--green2);">🟢 Online</span>';
    document.getElementById('sTokenHealth').innerHTML=d.tokenInvalid?'<span style="color:var(--red2);">❌ มีปัญหา</span>':'<span style="color:var(--green2);">✅ ปกติ</span>';
    renderToken(d.tokenTail); renderLogs(d.voiceLogs||[]);
}

function renderToken(tail){
    const masked=tail?tail.substring(0,2)+'••••'+tail.substring(tail.length-2):'••••••••';
    const wrap=document.getElementById('tokenDisplay'),hint=document.getElementById('revealHint');
    if(rv.expiry>Date.now()&&rv.token){
        wrap.innerHTML='<div class="token-full-wrap"><span style="flex:1;">'+rv.token+'</span><button class="copy-btn" onclick="navigator.clipboard.writeText(\''+rv.token.replace(/'/g,"\\'")+'\');this.textContent=\'✅\';setTimeout(()=>this.textContent=\'📋\',1500)">📋</button></div>';
        hint.style.display='none';
    }else{
        wrap.innerHTML='<span class="token-masked" onclick="openRevealModal()" title="คลิกดู Token เต็ม">🔑 '+masked+'</span>';
        hint.style.display='block';
    }
}

function renderLogs(logs){
    const wrap=document.getElementById('logTableWrap');
    document.getElementById('logCount').textContent=' — '+logs.length+' รายการ';
    if(!logs.length){wrap.innerHTML='<p style="color:var(--text3);font-size:0.82em;text-align:center;padding:20px 0;">ยังไม่มีประวัติ</p>';return;}
    const colorCls={connect:'color:var(--green2)',recover:'color:var(--blue2)',drop:'color:var(--yellow2)',disconnect:'color:var(--orange)',fail:'color:var(--red2)'};
    const icon={connect:'🟢',recover:'💖',drop:'⚡',disconnect:'⚠️',fail:'💔'};
    const label={connect:'เชื่อมต่อสำเร็จ',recover:'กู้คืนสัญญาณ',drop:'สัญญาณหลุด (ด่วน)',disconnect:'หลุดการเชื่อมต่อ',fail:'เชื่อมต่อไม่สำเร็จ'};
    wrap.innerHTML='<table style="font-size:0.8em;"><thead><tr><th>เวลา</th><th>สถานะ</th><th>รายละเอียด</th></tr></thead><tbody>'+
        logs.map(l=>'<tr><td style="color:var(--text3);white-space:nowrap;">'+new Date(l.ts).toLocaleTimeString('th-TH',{hour12:false})+'</td>'+
            '<td style="'+(colorCls[l.type]||'color:var(--text2)')+'">'+( icon[l.type]||'❓')+' '+(label[l.type]||l.type)+'</td>'+
            '<td style="color:var(--text3);">'+(l.detail||'-')+'</td></tr>').join('')+
        '</tbody></table>';
}

function openRevealModal(){
    if(rv.expiry>Date.now()) return;
    document.getElementById('tokenErr').style.display='none'; document.getElementById('tokenPin').value='';
    document.getElementById('tokenModal').style.display='flex';
    setTimeout(()=>document.getElementById('tokenPin').focus(),80);
}
function closeTokenModal(){ document.getElementById('tokenModal').style.display='none'; }

async function submitReveal(){
    const pin=document.getElementById('tokenPin').value; if(!pin) return;
    try{
        const r=await fetch('/api/reveal-all-tokens',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
        const d=await r.json();
        if(!d.success){ document.getElementById('tokenErr').textContent=d.error||'รหัสผ่านไม่ถูกต้อง'; document.getElementById('tokenErr').style.display='block'; document.getElementById('tokenPin').value=''; return; }
        closeTokenModal();
        rv.expiry=Date.now()+5*60*1000; rv.token=d.tokens[SESSION_ID]||null;
        if(sessionData) renderToken(sessionData.tokenTail);
        const bar=document.getElementById('revealBarDetail');
        if(bar){ bar.style.display='block'; rv._timer=setInterval(()=>{ const left=rv.expiry-Date.now(); if(left<=0){clearInterval(rv._timer);rv.token=null;rv.expiry=0;bar.style.display='none';if(sessionData)renderToken(sessionData.tokenTail);return;} const m=Math.floor(left/60000),s=Math.floor((left%60000)/1000); bar.textContent='🔓 Token โชว์อยู่ — ซ่อนอีก '+m+':'+String(s).padStart(2,'0'); },1000); }
    } catch(e){ document.getElementById('tokenErr').textContent='เกิดข้อผิดพลาด'; document.getElementById('tokenErr').style.display='block'; }
}

function openStopModal(){ document.getElementById('stopErr').style.display='none'; document.getElementById('stopPin').value=''; document.getElementById('stopModal').style.display='flex'; setTimeout(()=>document.getElementById('stopPin').focus(),80); }
function closeStopModal(){ document.getElementById('stopModal').style.display='none'; }

async function submitStop(){
    const pin=document.getElementById('stopPin').value; if(!pin) return;
    const btn=document.getElementById('btnStop');
    try{
        const r=await fetch('/api/stop-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:SESSION_ID,pin})});
        const d=await r.json();
        if(!d.success){ document.getElementById('stopErr').textContent=d.error||'รหัสผ่านไม่ถูกต้อง'; document.getElementById('stopErr').style.display='block'; document.getElementById('stopPin').value=''; return; }
        closeStopModal();
        btn.textContent='✅ หยุดแล้ว'; btn.disabled=true;
        document.getElementById('sDot').className='dot offline';
        document.getElementById('sTxt').textContent='🔴 หยุดทำงานแล้ว'; document.getElementById('sTxt').style.color='var(--red2)';
        document.getElementById('sStatus').innerHTML='<span style="color:var(--red2);">🔴 Stopped</span>';
        setTimeout(()=>window.location.href='/',2500);
    }catch(e){ document.getElementById('stopErr').textContent='เกิดข้อผิดพลาด'; document.getElementById('stopErr').style.display='block'; }
}

document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){closeTokenModal();closeStopModal();}
    if(e.key==='Enter'){
        if(document.getElementById('tokenModal').style.display==='flex') submitReveal();
        if(document.getElementById('stopModal').style.display==='flex') submitStop();
    }
});
fetchDetail(); setInterval(fetchDetail,8000);
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  📖  หน้า DOCS — คู่มือบอทครบทุกคำสั่ง
// ════════════════════════════════════════════════════════════════════════════
function pageDocs() {
    const sections = [
        {
            id:'voice', icon:'🔊', title:'ระบบออนช่องเสียง',
            desc:'ระบบหลักของบอท — จัดการผู้ใช้ที่ออนในช่องเสียงแบบ Self-Bot',
            cmds:[
                {name:'panel', perm:'admin', tag:'admin', desc:'เรียกแผงควบคุมระบบออนช่องเสียง มีปุ่มเริ่ม/หยุด/ดูสถานะ', usage:'/panel', note:'ต้องอนุมัติเซิร์ฟเวอร์ก่อนใช้งาน'},
            ],
            extra:`<div style="background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.3);border-radius:10px;padding:14px;margin-top:12px;font-size:0.82em;color:var(--text2);line-height:1.7;">
                <strong style="color:var(--accent3);">🔑 วิธีใช้งาน:</strong><br>
                1. กด <code>/panel</code> → กด <strong>เริ่มการทำงาน</strong><br>
                2. กรอก <strong>Token บัญชี</strong> + <strong>ไอดีเซิร์ฟเวอร์</strong> + <strong>ไอดีช่องเสียง</strong><br>
                3. บอทจะเข้าช่องเสียงทันที — ระบบ Auto-Recovery จะกู้คืนหากหลุด (สูงสุด 7 ครั้ง)<br>
                4. Token ถูกเข้ารหัส AES-256 ก่อนเก็บใน DB — ปลอดภัย 100%
            </div>`
        },
        {
            id:'info', icon:'📊', title:'คำสั่งข้อมูล (Information)',
            desc:'ดึงข้อมูลเชิงลึกของสมาชิก เซิร์ฟเวอร์ และสถานะระบบ',
            cmds:[
                {name:'ping',      perm:'ทุกคน', tag:'all',   desc:'ตรวจสอบ Latency, WebSocket Ping, RAM, Uptime, จำนวนเซิร์ฟและสมาชิก', usage:'/ping'},
                {name:'stats',     perm:'ทุกคน', tag:'all',   desc:'สถิติการทำงานของบอท — Uptime, RAM, Sessions, Success Rate, AES Status', usage:'/stats'},
                {name:'serverinfo',perm:'ทุกคน', tag:'all',   desc:'ข้อมูลเชิงลึกของเซิร์ฟเวอร์ — คน/บอท แยกชัด, จำนวนห้อง, Boost Level, เจ้าของ', usage:'/serverinfo'},
                {name:'userinfo',  perm:'ทุกคน', tag:'all',   desc:'สแกนข้อมูลสมาชิก — Risk Level (บัญชีใหม่<7วัน=HIGH RISK), Badges, Webhook Permission, สี Hex, ยศทั้งหมด', usage:'/userinfo [@สมาชิก]'},
                {name:'help',      perm:'ทุกคน', tag:'all',   desc:'คู่มือย่อในดิสคอร์ด — แอดมินจะเห็นหมวด Admin ด้วย (OpSec Hide)', usage:'/help'},
            ]
        },
        {
            id:'mod', icon:'🛡️', title:'คำสั่งผู้ดูแล (Moderation)',
            desc:'ลงโทษสมาชิก พร้อมส่ง DM แจ้งเตือนโปร่งใส บันทึก Log อัตโนมัติ',
            cmds:[
                {name:'ban',         perm:'MODERATE_MEMBERS', tag:'mod', desc:'แบนสมาชิกถาวร — ส่ง DM แจ้งเหตุผลก่อนแบน, บันทึกลง #log-สมาชิก', usage:'/ban @เป้าหมาย [เหตุผล]'},
                {name:'kick',        perm:'MODERATE_MEMBERS', tag:'mod', desc:'เตะสมาชิกออก — ส่ง DM แจ้งเหตุผล, บันทึก Log', usage:'/kick @เป้าหมาย [เหตุผล]'},
                {name:'timeout',     perm:'MODERATE_MEMBERS', tag:'mod', desc:'ระงับชั่วคราว 1-40000 นาที — ส่ง DM แจ้ง, บันทึก Log', usage:'/timeout @เป้าหมาย นาที [เหตุผล]'},
                {name:'clear',       perm:'MANAGE_MESSAGES',  tag:'mod', desc:'ลบข้อความ 1-100 ข้อความ — รองรับ Error code เฉพาะ (เก่าเกิน14วัน, ไม่มีสิทธิ์)', usage:'/clear จำนวน'},
                {name:'voicekickall',perm:'ADMINISTRATOR',    tag:'admin',desc:'เตะทุกคนออกจากห้องเสียง (ยกเว้น Admin) — Event Loop Yielding กัน UptimeRobot timeout', usage:'/voicekickall'},
            ]
        },
        {
            id:'util', icon:'🔧', title:'คำสั่งยูทิลิตี้ (Utility)',
            desc:'เครื่องมือจัดการเซิร์ฟเวอร์ ส่งข้อความ สำรองข้อมูล',
            cmds:[
                {name:'say',      perm:'MANAGE_MESSAGES', tag:'mod',   desc:'ส่งข้อความในนามบอท — ครั้งแรกต้องมีสิทธิ์, ครั้งที่ 2+ ต้องอยู่ใน Whitelist (สูงสุด 10 ครั้ง/นาที)', usage:'/say ข้อความ'},
                {name:'announce', perm:'MANAGE_MESSAGES', tag:'mod',   desc:'ประกาศแบบ Embed สวย — มี field "content" สำหรับ @everyone นอก Embed', usage:'/announce หัวข้อ เนื้อหา [@everyone]'},
                {name:'steal',    perm:'MANAGE_EMOJIS',   tag:'mod',   desc:'ดึงอิโมจิเข้าเซิร์ฟ (สูงสุด 50 ตัว) — ตรวจโควตาก่อน, delay 1 วิ/ตัว กัน rate limit, แสดง progress', usage:'/steal [อิโมจิ...]'},
                {name:'whitelist',perm:'ADMINISTRATOR',   tag:'admin', desc:'จัดการ Whitelist /say — add/remove/list', usage:'/whitelist add/remove/list [user_id]'},
                {name:'backup',   perm:'เจ้าของเซิร์ฟ',  tag:'owner', desc:'สำรองโครงสร้างเซิร์ฟ (ยศ+ห้อง) — ทำได้ 1 ครั้ง/24ชม.', usage:'/backup'},
                {name:'restore',  perm:'เจ้าของเซิร์ฟ',  tag:'owner', desc:'กู้คืนโครงสร้าง — ตรวจ 2 กุญแจ (เจ้าของเซิร์ฟ + ผู้บันทึก), มี confirm ก่อนทำ', usage:'/restore server_id'},
                {name:'setup-log',perm:'ADMINISTRATOR',   tag:'admin', desc:'ติดตั้ง Audit Log อัตโนมัติ — สร้าง Category + 5 ห้อง (ข้อความ/สมาชิก/เสียง/เซิร์ฟ/ความปลอดภัย)', usage:'/setup-log'},
            ]
        },
        {
            id:'auditlog', icon:'📋', title:'ระบบ Audit Log',
            desc:'บันทึกเหตุการณ์ในเซิร์ฟเวอร์อัตโนมัติ — ใช้คำสั่ง /setup-log เพื่อติดตั้ง',
            cmds:[],
            extra:`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px;">
                ${[
                    ['📝 #log-ข้อความ','ลบข้อความ, แก้ไขข้อความ (ก่อน-หลัง), Bulk Delete — กัน Ghost Ping ด้วย filter'],
                    ['👥 #log-สมาชิก','เข้า/ออก เซิร์ฟ, เปลี่ยนยศ, แจ้งเตือนบัญชีใหม่<7วัน'],
                    ['🔊 #log-ช่องเสียง','เข้า/ออก/ย้ายห้อง, ถูก Server Mute/Deafen'],
                    ['⚙️ #log-เซิร์ฟเวอร์','สร้าง/ลบห้อง, สร้าง/ลบยศ, เพิ่มอิโมจิ'],
                    ['🚨 #log-ความปลอดภัย','Anti-Raid Trigger, บอทไม่ verified ถูกเชิญ, Webhook เปลี่ยนแปลง'],
                ].map(([title, desc]) => `
                    <div class="docs-cmd">
                        <div class="docs-cmd-name">${title}</div>
                        <div class="docs-cmd-desc">${desc}</div>
                    </div>`).join('')}
            </div>`
        },
        {
            id:'security', icon:'🛡️', title:'ระบบความปลอดภัย',
            desc:'ระบบป้องกันหลายชั้นที่ทำงานอัตโนมัติ',
            cmds:[],
            extra:`<div style="display:grid;gap:8px;margin-top:4px;">
                ${[
                    ['🚨 Anti-Raid Tag','ตรวจจับ @everyone สแปม — หากใครพิมพ์ 5 ครั้งใน 1 นาที → ลบข้อความ + Timeout 10 นาที + แจ้ง log-ความปลอดภัย'],
                                       ['🔐 Token Encryption','Token ทุกตัวถูกเข้ารหัส AES-256-CBC ก่อนเก็บใน MongoDB — ไม่มีใครอ่าน Token ได้โดยตรง แม้ DB รั่ว'],
                    ['⏱️ Command Cooldown','ทุกคำสั่งมี cooldown กัน spam — ban/kick/timeout: 5s, clear/steal: 10s, backup/restore: 30s'],
                    ['🛑 Rate Limiter','Dashboard API รับสูงสุด 5 req/นาที/IP — เกินถูก block + แจ้ง Webhook'],
                    ['🔑 Token Reveal PIN','ดู Token เต็มต้องกรอก Shadow PIN — ผิด 5 ครั้ง → ล็อค 15 นาที'],
                    ['✅ Approval Gate','เซิร์ฟเวอร์ต้องรับการอนุมัติจากแอดมินก่อนใช้งาน /panel, /backup, /restore'],
                    ['🔒 Timing-Safe Auth','API Secret เปรียบเทียบแบบ timingSafeEqual กัน Timing Attack'],
                    ['🛡️ XSS Protection','ทุก user input ผ่าน escapeHtml() ก่อน render ลง HTML'],
                ].map(([title, desc]) => `
                    <div class="docs-cmd">
                        <div class="docs-cmd-name">${title}</div>
                        <div class="docs-cmd-desc">${desc}</div>
                    </div>`).join('')}
            </div>`
        },
        {
            id:'voice-engine', icon:'🎙️', title:'Voice Engine & Auto-Recovery',
            desc:'ระบบจัดการช่องเสียงระดับ Enterprise ที่ฟื้นคืนตัวเองได้',
            cmds:[],
            extra:`<div style="display:grid;gap:8px;margin-top:4px;">
                ${[
                    ['🔄 Auto-Recovery','หากหลุดจากช่องเสียง → Exponential Backoff (1s→2s→4s…) → สูงสุด 7 ครั้ง → ส่ง DM แจ้ง'],
                    ['⚡ Urgent Recovery','passive reconnect timeout → ตั้ง urgentRecovery flag → healthCheck ข้าม cooldown → กู้คืนทันที'],
                    ['💖 Health Check','ทุก 90 วินาที ตรวจทุก session — ถ้า Destroyed/Disconnected → reconnect อัตโนมัติ'],
                    ['🎭 Natural Blink','เปิด/ปิดไมค์ชั่วคราวตามกำหนด — ทำให้ดูเป็นธรรมชาติ ตั้งค่าได้จาก Dashboard'],
                    ['🚦 OperationQueue','Login พร้อมกันสูงสุด 2 ตัว — กัน IP โดน Discord ban'],
                    ['📨 DM Notification','แจ้งเจ้าของ Token ทาง DM เมื่อหยุด (maxRetries/idle/manual) + แจ้งเมื่อกลับมาออน'],
                    ['🔑 Token Hashing','ใช้ SHA-256 hash เป็น key ของ clientPool — กันชนกัน 100%'],
                    ['🧹 Idle Cleanup','session ที่ inactive เกิน 24ชม. ถูกหยุดอัตโนมัติ + ส่ง DM แจ้ง'],
                ].map(([title, desc]) => `
                    <div class="docs-cmd">
                        <div class="docs-cmd-name">${title}</div>
                        <div class="docs-cmd-desc">${desc}</div>
                    </div>`).join('')}
            </div>`
        },
        {
            id:'dashboard', icon:'🖥️', title:'Web Dashboard',
            desc:'ระบบควบคุมผ่านเว็บ — ไม่ต้องแก้โค้ด ตั้งค่าได้ทุกอย่าง',
            cmds:[],
            extra:`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px;">
                ${[
                    ['🏠 หน้าหลัก','Real-time stats, Session list, Voice summary, Live Logs'],
                    ['📊 /status','Bot uptime สะสม, MongoDB status, System metrics'],
                    ['⚙️ /settings','Bot Presence, Auto-Rotate, Natural Blink, General config'],
                    ['⚡ /commands','เปิด/ปิด Slash Commands แบบ realtime พร้อม Audit Log'],
                    ['📋 /whitelist','จัดการ /say whitelist — เพิ่ม/ลบ User ID'],
                    ['✅ /approved','จัดการเซิร์ฟที่อนุมัติ — ลบ/เตะบอทออกได้'],
                    ['📖 /docs','คู่มือนี้ — อธิบายทุกฟีเจอร์ครบ'],
                    ['📜 /logs','System log real-time — เขียว=info, เหลือง=warn, แดง=error'],
                    ['🔊 /logs/voice','Voice connection history — ดู event ทุกตัว'],
                    ['🖥️ /session/:id','รายละเอียด session — ดู Token (PIN protected), หยุดได้'],
                ].map(([title, desc]) => `
                    <div class="docs-cmd">
                        <div class="docs-cmd-name">${title}</div>
                        <div class="docs-cmd-desc">${desc}</div>
                    </div>`).join('')}
            </div>`
        },
        {
            id:'faq', icon:'❓', title:'FAQ & Troubleshooting',
            desc:'คำถามที่พบบ่อย',
            cmds:[],
            extra:`<div style="display:grid;gap:8px;margin-top:4px;">
                ${[
                    ['❓ บอทไม่เข้าช่องเสียง','ตรวจ: Token ถูกต้องไหม, บอทมีสิทธิ์เข้าห้องนั้นไหม, ไอดีช่องเสียงถูกไหม (17-19 หลัก)'],
                    ['❓ Token ปลอดภัยไหม','ปลอดภัย — เข้ารหัส AES-256-CBC ทุกตัว, ดูได้เฉพาะผ่าน Shadow PIN, ไม่เก็บใน Log'],
                    ['❓ เซิร์ฟใช้ไม่ได้ขึ้นว่า "ไม่อนุมัติ"','เข้าหน้า /approved ใน Dashboard แล้วอนุมัติเซิร์ฟนั้น'],
                    ['❓ /backup ทำงานวันละครั้ง','เจ้าของเซิร์ฟ backup ได้ 1 ครั้ง/24ชม. — แอดมินระบบ (ownerId) ไม่มีขีดจำกัด'],
                    ['❓ Session หลุดบ่อย','ระบบ Auto-Recovery จัดการให้อัตโนมัติ — ดู /logs/voice เพื่อตรวจสอบ pattern'],
                    ['❓ Log error ขึ้นสีผิด','log error=แดง, warn=เหลือง, info=เขียว — ถ้าเห็นสีผิดอาจเป็น version เก่า'],
                    ['❓ MongoDB buffering timed out','ตรวจ MongoDB Atlas Network Access ต้อง Allow 0.0.0.0/0 เพราะ Render เปลี่ยน IP ตลอด'],
                ].map(([q, a]) => `
                    <div class="docs-cmd">
                        <div class="docs-cmd-name">${q}</div>
                        <div class="docs-cmd-desc">${a}</div>
                    </div>`).join('')}
            </div>`
        }
    ];

    const tagColors = { admin:'admin', mod:'mod', owner:'owner', all:'all' };
    const tagLabels = { admin:'🔒 Admin', mod:'🛡️ Moderator', owner:'👑 Owner', all:'🌍 ทุกคน' };

    const sectionsHtml = sections.map(sec => `
        <div class="docs-section" id="sec-${sec.id}">
            <div class="docs-section-header" onclick="toggleSection('${sec.id}')" style="cursor:pointer;display:flex;align-items:center;gap:10px;margin-bottom:12px;">
                <span style="font-size:1.4em;">${sec.icon}</span>
                <div>
                    <div style="font-size:0.95em;font-weight:700;color:var(--accent3);">${sec.title}</div>
                    <div style="font-size:0.75em;color:var(--text3);">${sec.desc}</div>
                </div>
                <span id="arrow-${sec.id}" style="margin-left:auto;color:var(--text3);transition:transform .2s;">▼</span>
            </div>
            <div id="body-${sec.id}">
                ${sec.cmds.map(cmd => `
                    <div class="docs-cmd">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                            <span class="docs-cmd-name">/${escapeHtml(cmd.name)}</span>
                            <span class="docs-tag ${tagColors[cmd.tag]||'all'}">${tagLabels[cmd.tag]||cmd.perm}</span>
                        </div>
                        <div class="docs-cmd-desc">${cmd.desc}</div>
                        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:5px;">
                            <code style="background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:0.75em;color:var(--accent3);">${escapeHtml(cmd.usage)}</code>
                            ${cmd.note ? `<span style="font-size:0.72em;color:var(--yellow2);">⚠️ ${cmd.note}</span>` : ''}
                        </div>
                    </div>`).join('')}
                ${sec.extra || ''}
            </div>
        </div>
        <div style="border-bottom:1px solid var(--border);margin-bottom:24px;"></div>`).join('');

    return shell('คู่มือการใช้งาน', `
<div class="container">
<h1 class="page-title">📖 คู่มือการใช้งาน</h1>
<p class="page-sub">Phomueangtai Enterprise V5.1 — อธิบายทุกฟีเจอร์ ทุกคำสั่ง ทุกระบบ</p>
${navBar('/docs')}

<!-- Quick Nav -->
<div class="card" style="margin-bottom:16px;">
    <h3>🗂️ หมวดหมู่</h3>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${sections.map(s => `<a href="#sec-${s.id}" style="background:var(--bg2);color:var(--text2);padding:6px 12px;border-radius:8px;text-decoration:none;font-size:0.78em;border:1px solid var(--border);transition:all .15s;" onmouseover="this.style.borderColor='var(--accent2)';this.style.color='var(--accent3)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text2)'">${s.icon} ${s.title}</a>`).join('')}
    </div>
</div>

<!-- Sections -->
${sectionsHtml}

</div>
<script>
function toggleSection(id){
    const body=document.getElementById('body-'+id);
    const arrow=document.getElementById('arrow-'+id);
    const hidden=body.style.display==='none';
    body.style.display=hidden?'':'none';
    arrow.style.transform=hidden?'':'rotate(-90deg)';
}
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  หน้า SETTINGS
// ════════════════════════════════════════════════════════════════════════════
function pageSettings(settings, config, client, API_SECRET) {
    const maxSessions = settings.maxSessions   ?? config.limits.maxSessions;
    const rateLimitReq= settings.rateLimitRequests ?? config.limits.rateLimitRequests;
    const antiRaid    = settings.antiRaidEnabled ?? true;
    const idleHrs     = settings.idleTimeoutHrs ?? 24;
    const botStatus   = settings.botStatus      ?? config.bot_presence?.status ?? 'idle';
    const botActivity = escapeHtml(settings.botActivity ?? config.bot_presence?.activityText ?? 'ระบบออนช่องเสียง');
    const botNote     = escapeHtml(settings.botNote ?? '');
    const actType     = settings.botActivityType || 'WATCHING';
    const rotateEn    = settings.rotateEnabled ?? false;
    const rotateInt   = settings.rotateInterval ?? 5;
    const rotateMsgs  = Array.isArray(settings.rotateMessages) ? settings.rotateMessages : [];
    const botName     = escapeHtml(client?.user?.username || 'Bot');
    const statusColors= { online:'#4ade80', idle:'#fbbf24', dnd:'#f87171', invisible:'transparent' };
    const actLabels   = { WATCHING:'กำลังดู', LISTENING:'กำลังฟัง', PLAYING:'กำลังเล่น', COMPETING:'กำลังแข่ง' };
    const actLabelsFull={ WATCHING:'👁️ "กำลังดู..."', LISTENING:'🎧 "กำลังฟัง..."', PLAYING:'🎮 "กำลังเล่น..."', COMPETING:'🏆 "กำลังแข่ง..."' };

    return shell('ตั้งค่าระบบ', `
<div class="container">
<h1 class="page-title">⚙️ ตั้งค่าระบบ</h1>
<p class="page-sub">จัดการการตั้งค่าทั้งหมดจากหน้าเว็บ — มีผลทันทีโดยไม่ต้อง restart</p>
${navBar('/settings')}
<div id="__msg" style="display:none;padding:10px 14px;border-radius:10px;margin-bottom:14px;font-size:0.88em;"></div>

<!-- General -->
<div class="card">
    <h3>🎛️ General Config</h3>
    <label>Max Sessions — ผู้ใช้พร้อมกันสูงสุด</label>
    <input type="number" id="maxSessions" value="${maxSessions}" min="1" max="100">
    <label>Rate Limit — รับคำขอ API สูงสุด (ครั้ง/นาที)</label>
    <input type="number" id="rateLimitRequests" value="${rateLimitReq}" min="1" max="60">
    <label>Idle Timeout — หยุดอัตโนมัติหลัง (ชั่วโมง)</label>
    <input type="number" id="idleTimeoutHrs" value="${idleHrs}" min="1" max="168">
    <label>ระบบ Anti-Raid Tag</label>
    <select id="antiRaidEnabled">
        <option value="true" ${antiRaid?'selected':''}>✅ เปิดใช้งาน</option>
        <option value="false" ${!antiRaid?'selected':''}>❌ ปิดใช้งาน</option>
    </select>
    <button class="btn btn-primary" onclick="saveSettings()">💾 บันทึก General</button>
</div>

<!-- Bot Profile Preview -->
<div class="card">
    <h3>🖼️ ตัวอย่างโปรไฟล์บอท (Live Preview)</h3>
    <div class="preview">
        <div style="position:relative;flex-shrink:0;">
            <div class="av">🤖</div>
            <div id="pp-dot" style="position:absolute;bottom:1px;right:1px;width:14px;height:14px;border-radius:50%;border:2.5px solid var(--bg2);background:${statusColors[botStatus]||'#fbbf24'};transition:background .2s;"></div>
        </div>
        <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:0.95em;color:#fff;margin-bottom:2px;">${botName}</div>
            <div id="pp-act" style="font-size:0.78em;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${actLabels[actType]||'กำลังดู'} ${botActivity}</div>
                       <div id="pp-note" style="font-size:0.74em;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${botNote}</div>
        </div>
    </div>
    <p style="color:var(--text3);font-size:0.73em;margin-top:8px;">* อัปเดต real-time ตามที่พิมพ์ด้านล่าง — ยังไม่ได้บันทึกจริง</p>
</div>

<!-- Bot Presence -->
<div class="card">
    <h3>🌙 Bot Presence — สถานะโปรไฟล์บอท</h3>
    <label style="margin-bottom:8px;">สถานะออนไลน์</label>
    <div class="dc-list">
        ${['online','idle','dnd','invisible'].map(st => {
            const labels = {online:'ออนไลน์',idle:'ไม่อยู่',dnd:'ห้ามรบกวน',invisible:'ไม่ระบุ'};
            const dots   = {
                online:  '<div class="dc-dot" style="background:#4ade80;"></div>',
                idle:    '<div style="font-size:14px;width:18px;text-align:center;">🌙</div>',
                dnd:     '<div class="dc-dot" style="background:#f87171;display:flex;align-items:center;justify-content:center;"><span style="width:9px;height:2.5px;background:#fff;border-radius:2px;display:block;"></span></div>',
                invisible:'<div class="dc-dot" style="background:transparent;box-shadow:inset 0 0 0 2px #6b7280;"></div>'
            };
            return `<div class="dc-item ${botStatus===st?'sel':''}" onclick="selectStatus('${st}')" id="dc-${st}">
                ${dots[st]}
                <span class="dc-lbl">${labels[st]}</span>
                <span class="dc-radio ${botStatus===st?'on':''}" id="dr-${st}"></span>
            </div>`;
        }).join('')}
    </div>
    <input type="hidden" id="botStatus" value="${botStatus}">

    <label>ประเภทกิจกรรม</label>
    <div class="act-row">
        ${['WATCHING','LISTENING','PLAYING','COMPETING'].map(t => {
            const icons = {WATCHING:'👁️',LISTENING:'🎧',PLAYING:'🎮',COMPETING:'🏆'};
            const labels= {WATCHING:'กำลังดู',LISTENING:'กำลังฟัง',PLAYING:'กำลังเล่น',COMPETING:'กำลังแข่ง'};
            return `<div class="act-btn ${actType===t?'active':''}" onclick="selectAct('${t}')" id="at-${t}">${icons[t]} ${labels[t]}</div>`;
        }).join('')}
    </div>
    <input type="hidden" id="botActivityType" value="${actType}">

    <label id="actLabel">${actLabelsFull[actType]||actLabelsFull['WATCHING']}</label>
    <input type="text" id="botActivity" value="${botActivity}" placeholder="เช่น ระบบออนช่องเสียง" maxlength="128" oninput="updatePreview()">

    <label>📝 โน้ต (ข้อความใต้ชื่อบอท)</label>
    <input type="text" id="botNote" value="${botNote}" placeholder="เช่น Developed by Phomueangtai" maxlength="128" oninput="updatePreview()">

    <button class="btn btn-info" onclick="savePresence()" style="margin-top:14px;">✅ บันทึกและใช้งานทันที</button>
</div>

<!-- Auto-Rotate -->
<div class="card">
    <h3>🔄 Auto-Rotate Activity — สลับข้อความอัตโนมัติ</h3>
    <label>สถานะ Auto-Rotate</label>
    <select id="rotateEnabled">
        <option value="false" ${!rotateEn?'selected':''}>❌ ปิด</option>
        <option value="true"  ${rotateEn ?'selected':''}>✅ เปิด</option>
    </select>
    <label>หมุนทุกกี่นาที</label>
    <input type="number" id="rotateInterval" value="${rotateInt}" min="1" max="120">
    <label>ข้อความที่จะสลับกัน</label>
    <div id="rotate-list">
        ${rotateMsgs.length
            ? rotateMsgs.map((m,i)=>`
              <div class="ri" id="ri-${i}">
                  <input type="text" value="${escapeHtml(m)}" placeholder="ข้อความที่ ${i+1}" maxlength="128">
                  <button onclick="removeRotate(${i})" style="background:rgba(127,29,29,.6);color:var(--red2);border:1px solid rgba(239,68,68,.3);padding:8px 12px;border-radius:8px;cursor:pointer;font-size:0.8em;flex-shrink:0;">✕</button>
              </div>`).join('')
            : '<div class="ri-empty" id="ri-empty">ยังไม่มีข้อความ — กด ➕ เพิ่มได้เลย</div>'}
    </div>
    <button onclick="addRotate()" style="background:var(--bg2);border:1px dashed var(--border);color:var(--text3);padding:9px;border-radius:9px;width:100%;cursor:pointer;margin-top:10px;font-size:0.82em;transition:all .15s;" onmouseover="this.style.borderColor='var(--accent2)';this.style.color='var(--accent3)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text3)'">➕ เพิ่มข้อความ</button>
    <button class="btn btn-info" onclick="saveRotate()" style="margin-top:10px;">💾 บันทึก Auto-Rotate</button>
    <p style="color:var(--text3);font-size:0.73em;margin-top:8px;">* เมื่อเปิด จะสลับข้อความตามรายการนี้ โดยใช้สถานะ+ประเภทที่ตั้งไว้ด้านบน</p>
</div>

<!-- Natural Blink -->
<div class="card">
    <h3>🎭 Natural Blink — ความเนียน</h3>
    <p style="color:var(--text2);font-size:0.8em;margin-bottom:14px;">บอทจะเปิดไมค์+หูฟังชั่วคราว เพื่อให้ดูเป็นธรรมชาติ ไม่ตัดออกจากห้อง</p>
    <div style="display:flex;align-items:center;gap:12px;background:var(--bg2);border-radius:10px;padding:10px 14px;margin-bottom:14px;border:1px solid var(--border);">
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
    <div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);border-radius:10px;padding:10px 14px;margin:12px 0;font-size:0.78em;color:var(--green2);line-height:1.7;">
        💡 บอทจะ <strong>เปิดไมค์+หูฟัง</strong> → รอตามเวลา → <strong>ปิดกลับอัตโนมัติ</strong> — ไม่ตัดออกจากห้อง แต่ละ session มี jitter ±5 นาที
    </div>
    <button class="btn btn-info" onclick="saveNatural()">💾 บันทึก Natural Blink</button>
    <p id="natMsg" style="font-size:0.78em;margin-top:8px;display:none;"></p>
</div>
</div>

${toastScript()}
<script>
const SECRET='${API_SECRET}';
const statusColors={online:'#4ade80',idle:'#fbbf24',dnd:'#f87171',invisible:'transparent'};
const actLabelShort={WATCHING:'กำลังดู',LISTENING:'กำลังฟัง',PLAYING:'กำลังเล่น',COMPETING:'กำลังแข่ง'};
const actLabelsFull={WATCHING:'👁️ "กำลังดู..."',LISTENING:'🎧 "กำลังฟัง..."',PLAYING:'🎮 "กำลังเล่น..."',COMPETING:'🏆 "กำลังแข่ง..."'};

function updatePreview(){
    const act=(document.getElementById('botActivity').value||'').trim()||'...';
    const note=(document.getElementById('botNote').value||'').trim();
    const type=document.getElementById('botActivityType').value||'WATCHING';
    const st=document.getElementById('botStatus').value||'idle';
    document.getElementById('pp-act').textContent=(actLabelShort[type]||'กำลังดู')+' '+act;
    document.getElementById('pp-note').textContent=note;
    const dot=document.getElementById('pp-dot');
    if(st==='invisible'){dot.style.background='transparent';dot.style.boxShadow='inset 0 0 0 2px #6b7280';}
    else{dot.style.background=statusColors[st]||'#fbbf24';dot.style.boxShadow='0 0 0 2px '+(statusColors[st]||'#fbbf24')+'55';}
}

window.addEventListener('DOMContentLoaded',()=>{ updatePreview(); loadNatural(); });

function selectStatus(s){
    document.getElementById('botStatus').value=s;
    ['online','idle','dnd','invisible'].forEach(x=>{
        document.getElementById('dc-'+x)?.classList.toggle('sel',x===s);
        const r=document.getElementById('dr-'+x);
        if(r){r.classList.toggle('on',x===s);}
    });
    updatePreview();
}
function selectAct(t){
    document.getElementById('botActivityType').value=t;
    ['WATCHING','LISTENING','PLAYING','COMPETING'].forEach(x=>document.getElementById('at-'+x)?.classList.toggle('active',x===t));
    document.getElementById('actLabel').textContent=actLabelsFull[t]||actLabelsFull['WATCHING'];
    updatePreview();
}

function showMsg(text,ok){
    const m=document.getElementById('__msg');
    m.style.display='block';
    m.style.background=ok?'rgba(34,197,94,.1)':'rgba(239,68,68,.1)';
    m.style.border=ok?'1px solid rgba(34,197,94,.3)':'1px solid rgba(239,68,68,.3)';
    m.style.color=ok?'var(--green2)':'var(--red2)';
    m.textContent=text;
    setTimeout(()=>m.style.display='none',4000);
}

async function saveSettings(){
    const body={maxSessions:parseInt(document.getElementById('maxSessions').value),rateLimitRequests:parseInt(document.getElementById('rateLimitRequests').value),idleTimeoutHrs:parseInt(document.getElementById('idleTimeoutHrs').value),antiRaidEnabled:document.getElementById('antiRaidEnabled').value==='true'};
    try{ const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json','Authorization':SECRET},body:JSON.stringify(body)}); const d=await r.json(); showMsg(d.success?'✅ บันทึก General สำเร็จ':'❌ '+(d.error||'Unknown'),d.success); }
    catch(e){ showMsg('❌ เชื่อมต่อไม่ได้',false); }
}

async function savePresence(){
    const botStatus=document.getElementById('botStatus').value;
    const botActivityType=document.getElementById('botActivityType').value;
    const botActivity=document.getElementById('botActivity').value.trim();
    const botNote=document.getElementById('botNote').value.trim();
    if(!botActivity) return showMsg('❌ กรุณากรอกข้อความกิจกรรม',false);
    try{ const r=await fetch('/api/presence',{method:'POST',headers:{'Content-Type':'application/json','Authorization':SECRET},body:JSON.stringify({botStatus,botActivityType,botActivity,botNote})}); const d=await r.json(); showMsg(d.success?'✅ อัปเดตสถานะบอทแล้ว!':'❌ '+(d.error||'Unknown'),d.success); }
    catch(e){ showMsg('❌ เชื่อมต่อไม่ได้',false); }
}

let rotateCount=${rotateMsgs.length};
function addRotate(){
    const list=document.getElementById('rotate-list');
    const empty=document.getElementById('ri-empty'); if(empty) empty.remove();
    const div=document.createElement('div'); div.className='ri'; div.id='ri-'+rotateCount;
    const idx=rotateCount;
    div.innerHTML='<input type="text" placeholder="ข้อความที่ '+(idx+1)+'" maxlength="128"><button onclick="removeRotate('+idx+')" style="background:rgba(127,29,29,.6);color:var(--red2);border:1px solid rgba(239,68,68,.3);padding:8px 12px;border-radius:8px;cursor:pointer;font-size:0.8em;flex-shrink:0;">✕</button>';
    list.appendChild(div); rotateCount++;
}
function removeRotate(idx){
    const el=document.getElementById('ri-'+idx); if(el) el.remove();
    if(!document.querySelectorAll('.ri').length) document.getElementById('rotate-list').innerHTML='<div class="ri-empty" id="ri-empty">ยังไม่มีข้อความ</div>';
}
async function saveRotate(){
    const rotateEnabled=document.getElementById('rotateEnabled').value==='true';
    const rotateInterval=parseInt(document.getElementById('rotateInterval').value)||5;
    const msgs=[...document.querySelectorAll('.ri input')].map(i=>i.value.trim()).filter(Boolean);
    if(rotateEnabled&&!msgs.length) return showMsg('❌ กรุณาเพิ่มข้อความอย่างน้อย 1 ข้อความ',false);
    try{ const r=await fetch('/api/presence/rotate',{method:'POST',headers:{'Content-Type':'application/json','Authorization':SECRET},body:JSON.stringify({rotateEnabled,rotateInterval,rotateMessages:msgs})}); const d=await r.json(); showMsg(d.success?(rotateEnabled?'✅ Auto-Rotate เปิดแล้ว! สลับทุก '+rotateInterval+' นาที':'✅ ปิด Auto-Rotate แล้ว'):'❌ '+(d.error||'Unknown'),d.success); }
    catch(e){ showMsg('❌ เชื่อมต่อไม่ได้',false); }
}

async function loadNatural(){
    try{
        const r=await fetch('/api/settings/natural'); if(!r.ok) return;
        const d=await r.json(); if(!d.success) return;
        const s=d.settings;
        document.getElementById('naturalEnabled').value=String(s.enabled);
        document.getElementById('naturalInterval').value=String(s.intervalMs);
        document.getElementById('naturalDuration').value=String(s.durationMs);
        const dot=document.getElementById('natDot'),txt=document.getElementById('natTxt'),badge=document.getElementById('natBadge');
        if(s.enabled){dot.className='dot online';txt.textContent='🟢 Natural Blink เปิดอยู่';txt.style.color='var(--green2)';}
        else{dot.className='dot';dot.style.background='var(--text3)';dot.style.boxShadow='none';txt.textContent='⭕ ปิดอยู่';txt.style.color='var(--text3)';}
        badge.textContent=s.activeTimers+' sessions';
    }catch(e){}
}
async function saveNatural(){
    const enabled=document.getElementById('naturalEnabled').value==='true';
    const intervalMs=parseInt(document.getElementById('naturalInterval').value)||3600000;
    const durationMs=parseInt(document.getElementById('naturalDuration').value)||30000;
    const msgEl=document.getElementById('natMsg');
    msgEl.style.display='block'; msgEl.style.color='var(--text2)'; msgEl.textContent='⏳ กำลังบันทึก...';
    try{
        const r=await fetch('/api/settings/natural',{method:'POST',headers:{'Content-Type':'application/json','Authorization':SECRET},body:JSON.stringify({enabled,intervalMs,durationMs})});
        const d=await r.json();
        if(d.success){ msgEl.style.color='var(--green2)'; msgEl.textContent=enabled?'✅ เปิดแล้ว! Blink ทุก '+Math.round(intervalMs/60000)+' นาที ค้าง '+Math.round(durationMs/1000)+' วิ':'✅ ปิด Natural Blink แล้ว'; await loadNatural(); }
        else{ msgEl.style.color='var(--red2)'; msgEl.textContent='❌ '+(d.error||'Unknown'); }
    }catch(e){ msgEl.style.color='var(--red2)'; msgEl.textContent='❌ เชื่อมต่อไม่ได้'; }
}
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  REGISTER ROUTES (เรียกจาก index.js)
// ════════════════════════════════════════════════════════════════════════════
function registerViewRoutes({
    app, sessionManager, voiceWorker, commands,
    webLogs, MAX_LOGS, client, API_SECRET,
    disabledCommands, commandAuditLog, config
}) {
    app.get("/", (req, res) => res.send(pageHome(API_SECRET)));

    app.get("/status", (req, res) => res.send(pageStatus()));

    app.get("/settings", async (req, res) => {
        const settings = await sessionManager.getAllSettings();
        res.send(pageSettings(settings, config, client, API_SECRET));
    });

    app.get("/commands", (req, res) => {
        res.send(pageCommands(commands, disabledCommands, commandAuditLog, API_SECRET));
    });

    app.get("/whitelist", async (req, res) => {
        const list = await sessionManager.getAllWhitelist();
        res.send(pageWhitelist(list, API_SECRET));
    });

    app.get("/approved", async (req, res) => {
        if (!client.isReady()) {
            return res.send(shell('Loading', `<div style="text-align:center;padding:80px 20px;"><div class="spin"></div><h2 style="margin-top:16px;color:var(--accent3);">Bot กำลังเริ่มต้น กรุณารอสักครู่...</h2></div>`));
        }
        const approvedList = await sessionManager.ApprovedGuildModel.find({}).catch(() => []);
        res.send(pageApproved(approvedList, client, API_SECRET));
    });

    app.get("/logs",       (req, res) => res.send(pageLogs(webLogs, MAX_LOGS)));
    app.get("/logs/voice", (req, res) => res.send(pageVoiceLogs(voiceWorker.getVoiceLogs())));
    app.get("/docs",       (req, res) => res.send(pageDocs()));

    app.get("/session/:sessionId", (req, res) => {
        const safeId = escapeHtml(req.params.sessionId);
        res.send(pageSessionDetail(safeId));
    });

}

module.exports = {
    registerViewRoutes,
    escapeHtml,
    BASE_CSS
};