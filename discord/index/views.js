/*
================================================================================
  ENTERPRISE DASHBOARD — Views Layer
  ธีม: Dark Purple Glassmorphism
  หน้าทั้งหมด: /, /status, /settings, /commands, /whitelist, /approved,
               /logs, /logs/voice, /session/:id, /docs
================================================================================
*/

const auth = require("./auth");

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

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: var(--bg2); }
::-webkit-scrollbar-thumb { background: var(--accent); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--accent2); }

.container    { max-width: 740px;  margin: 0 auto; }
.container-lg { max-width: 1000px; margin: 0 auto; }

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
  display: flex;
  align-items: center;
  gap: 6px;
}

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

.nav {
  display: flex;
  gap: 6px;
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
.nav a:hover  {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent2);
  box-shadow: 0 0 10px rgba(124,58,237,.4);
}
.nav a.active {
  background: linear-gradient(135deg,var(--accent),var(--accent2));
  color:#fff;
  border-color: transparent;
  box-shadow: 0 0 14px rgba(124,58,237,.5);
}

.grid {
  display: grid;
  grid-template-columns: repeat(3,1fr);
  gap: 10px;
  margin-bottom: 16px;
}
@media(max-width:520px) {
  .grid { grid-template-columns: repeat(2,1fr); }
}

.stat {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px 10px;
  text-align: center;
  transition: all .2s;
  cursor: default;
}
.stat:hover {
  border-color: var(--border2);
  transform: translateY(-2px);
  box-shadow: var(--shadow);
}
.stat .val {
  font-size: 1.7em;
  font-weight: 900;
  line-height: 1.1;
  margin-top: 4px;
}
.stat .lbl {
  font-size: 0.63em;
  color: var(--text3);
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: .6px;
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 14px;
  backdrop-filter: blur(12px);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: all .3s;
}
.dot.online  {
  background: var(--green2);
  box-shadow: 0 0 8px var(--green2), 0 0 16px rgba(74,222,128,.3);
  animation: pulse-green 2s infinite;
}
.dot.offline { background: var(--red2); box-shadow: 0 0 8px var(--red2); }
.dot.purple  { background: var(--accent2); box-shadow: 0 0 8px var(--accent2); }
.dot.yellow  { background: var(--yellow2); box-shadow: 0 0 8px var(--yellow2); }

@keyframes pulse-green {
  0%, 100% { box-shadow: 0 0 8px var(--green2), 0 0 16px rgba(74,222,128,.3); }
  50%      { box-shadow: 0 0 12px var(--green2), 0 0 24px rgba(74,222,128,.5); }
}

.progress-bg {
  background: var(--bg3);
  border-radius: 8px;
  height: 8px;
  overflow: hidden;
}
.progress-fill {
  height: 8px;
  border-radius: 8px;
  transition: width .6s ease, background .3s;
}

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
.log-line { margin-bottom: 2px; word-break: break-all; }
.log-line.info  { color: var(--green2); }
.log-line.error { color: var(--red2); }
.log-line.warn  { color: var(--yellow2); }

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
label {
  color: var(--text2);
  font-size: 0.8em;
  display: block;
  margin-top: 14px;
  font-weight: 500;
}

.btn {
  border: none;
  padding: 10px 20px;
  border-radius: 10px;
  font-weight: 700;
  cursor: pointer;
  width: 100%;
  margin-top: 14px;
  font-size: 0.88em;
  transition: all .18s;
  letter-spacing: .2px;
}
.btn-primary { background: linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; }
.btn-primary:hover { box-shadow: 0 0 18px rgba(124,58,237,.5); transform: translateY(-1px); }
.btn-success { background: linear-gradient(135deg,#166534,var(--green2)); color:#000; }
.btn-success:hover { box-shadow: 0 0 18px rgba(74,222,128,.4); transform: translateY(-1px); }
.btn-danger { background: linear-gradient(135deg,#7f1d1d,var(--red2)); color:#fff; }
.btn-danger:hover { box-shadow: 0 0 18px rgba(248,113,113,.4); transform: translateY(-1px); }
.btn-warning { background: linear-gradient(135deg,#713f12,var(--yellow2)); color:#000; }
.btn-warning:hover { box-shadow: 0 0 18px rgba(251,191,36,.4); transform: translateY(-1px); }
.btn-info { background: linear-gradient(135deg,#1e1b4b,var(--blue2)); color:#fff; }
.btn-info:hover { box-shadow: 0 0 18px rgba(129,140,248,.4); transform: translateY(-1px); }
.btn:disabled {
  background: var(--bg3);
  color: var(--text3);
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}
.btn-sm {
  padding: 5px 12px;
  border-radius: 7px;
  font-size: 0.78em;
  width: auto;
  margin-top: 0;
}

.modal {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(5,3,18,.88);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  justify-content: center;
  align-items: center;
  z-index: 9999;
}
.modal-box {
  background: linear-gradient(135deg,var(--bg2),var(--bg3));
  border: 1px solid var(--border2);
  border-radius: 20px;
  padding: 32px 28px;
  width: 100%;
  max-width: 340px;
  text-align: center;
  position: relative;
  box-shadow: 0 16px 48px rgba(124,58,237,.3), var(--shadow);
  animation: modal-in .2s ease;
}
@keyframes modal-in {
  from { opacity:0; transform:scale(.9); }
  to   { opacity:1; transform:scale(1); }
}
.modal-close {
  position: absolute;
  top: 12px;
  right: 14px;
  background: none;
  border: none;
  color: var(--text3);
  font-size: 1.1em;
  cursor: pointer;
  transition: color .15s;
}
.modal-close:hover { color: var(--text); }
.badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 0.72em;
  font-weight: 700;
}
.badge-on {
  background: rgba(34,197,94,.12);
  color: var(--green2);
  border: 1px solid rgba(34,197,94,.3);
}
.badge-off {
  background: rgba(239,68,68,.12);
  color: var(--red2);
  border: 1px solid rgba(239,68,68,.3);
}

.toggle {
  position: relative;
  display: inline-block;
  width: 46px;
  height: 26px;
  flex-shrink: 0;
}
.toggle input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: var(--bg3);
  border-radius: 26px;
  transition: .25s;
  border: 1px solid var(--border);
}
.slider::before {
  position: absolute;
  content: '';
  height: 20px;
  width: 20px;
  left: 2px;
  bottom: 2px;
  background: var(--text3);
  border-radius: 50%;
  transition: .25s;
}
input:checked + .slider {
  background: var(--accent);
  border-color: var(--accent2);
}
input:checked + .slider::before {
  transform: translateX(20px);
  background: #fff;
  box-shadow: 0 0 6px rgba(168,85,247,.5);
}
.toggle.loading .slider { opacity: .5; cursor: wait; }

table {
  width: 100%;
  border-collapse: collapse;
}
th {
  text-align: left;
  padding: 10px 10px;
  color: var(--text3);
  border-bottom: 1px solid var(--border);
  font-size: 0.75em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .6px;
}
td {
  padding: 10px 10px;
  border-bottom: 1px solid rgba(120,80,255,.06);
  font-size: 0.84em;
  vertical-align: middle;
}
tr:last-child td { border-bottom: none; }
tbody tr { transition: background .12s; }
tbody tr:hover td { background: rgba(124,58,237,.05); }

.session-item {
  background: rgba(15,11,30,.7);
  border-left: 3px solid var(--accent);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 9px;
  font-size: 0.82em;
  transition: all .15s;
}
.session-item:hover {
  border-left-color: var(--accent2);
  background: rgba(20,15,40,.9);
}
.sv {
  color: var(--accent3);
  font-weight: 700;
  text-decoration: none;
}
.sv:hover { color: #fff; }

.session-head {
  display: flex;
  gap: 10px;
  align-items: center;
}
.session-avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  object-fit: cover;
  background: linear-gradient(135deg,var(--accent),var(--accent2));
  border: 1px solid var(--border2);
  flex-shrink: 0;
}
.session-meta {
  flex: 1;
  min-width: 0;
}
.session-account {
  color: var(--text);
  font-weight: 800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-sub {
  color: var(--text3);
  font-size: 0.78em;
  margin-top: 2px;
  word-break: break-word;
}
.session-actions {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 9px;
}
.session-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: rgba(124,58,237,.10);
  border: 1px solid var(--border);
  color: var(--text2);
  border-radius: 999px;
  padding: 4px 9px;
  font-size: 0.76em;
  text-decoration: none;
}
.session-chip:hover {
  border-color: var(--accent2);
  color: #fff;
}
.token-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid rgba(251,191,36,.25);
  background: rgba(113,63,18,.18);
  color: var(--yellow2);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 0.76em;
  cursor: pointer;
}
.token-action:hover {
  border-color: var(--yellow2);
  background: rgba(113,63,18,.30);
}
.voice-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.voice-box {
  flex: 1;
  min-width: 85px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 8px;
  text-align: center;
  transition: all .2s;
}
.voice-box:hover {
  border-color: var(--border2);
  transform: translateY(-2px);
}
.vval {
  font-size: 1.5em;
  font-weight: 900;
}
.vlbl {
  font-size: 0.6em;
  color: var(--text3);
  margin-top: 3px;
  text-transform: uppercase;
  letter-spacing: .5px;
}

.token-masked {
  color: var(--text3);
  font-size: 0.82em;
  cursor: pointer;
  font-family: monospace;
  letter-spacing: .5px;
  transition: color .2s;
  user-select: none;
  padding: 7px 12px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  display: inline-block;
}
.token-masked:hover {
  color: var(--yellow2);
  border-color: rgba(251,191,36,.4);
}
.token-full-wrap {
  font-family: monospace;
  font-size: 0.78em;
  color: var(--yellow2);
  word-break: break-all;
  background: rgba(13,9,0,.8);
  border: 1px solid rgba(251,191,36,.25);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.copy-btn {
  background: var(--bg3);
  border: none;
  color: var(--text2);
  font-size: 0.72em;
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 5px;
  flex-shrink: 0;
  transition: all .15s;
}
.copy-btn:hover {
  background: var(--accent);
  color: #fff;
}
.reveal-bar {
  background: rgba(13,9,0,.8);
  border: 1px solid rgba(251,191,36,.2);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 0.74em;
  color: var(--yellow2);
  text-align: center;
  margin-top: 8px;
  display: none;
}

.toast {
  position: fixed;
  bottom: 24px;
  right: 20px;
  border-radius: 12px;
  padding: 12px 18px;
  font-size: 0.85em;
  display: none;
  z-index: 99999;
  max-width: 300px;
  box-shadow: 0 8px 24px rgba(0,0,0,.4);
  animation: toast-in .2s ease;
  backdrop-filter: blur(12px);
}
@keyframes toast-in {
  from { opacity:0; transform:translateX(20px); }
  to   { opacity:1; transform:translateX(0); }
}
.toast.ok   { background:rgba(20,83,45,.9); border:1px solid rgba(34,197,94,.4); color:var(--green2); }
.toast.err  { background:rgba(127,29,29,.9); border:1px solid rgba(239,68,68,.4); color:var(--red2); }
.toast.warn { background:rgba(113,63,18,.9); border:1px solid rgba(234,179,8,.4); color:var(--yellow2); }
.toast.info { background:rgba(30,27,75,.9); border:1px solid rgba(99,102,241,.4); color:var(--blue2); }

.hero {
  background: linear-gradient(135deg,rgba(30,10,74,.9),rgba(45,16,102,.8),rgba(26,8,64,.9));
  border: 1px solid rgba(124,58,237,.4);
  border-radius: 18px;
  padding: 28px 20px;
  text-align: center;
  margin-bottom: 16px;
  box-shadow: 0 0 40px rgba(124,58,237,.15);
}
.hero-label {
  font-size: 0.72em;
  color: var(--accent3);
  letter-spacing: 2px;
  text-transform: uppercase;
  margin-bottom: 10px;
}
.hero-time {
  font-size: 2.8em;
  font-weight: 900;
  color: var(--accent3);
  line-height: 1;
}
.hero-since {
  font-size: 0.72em;
  color: var(--text3);
  margin-top: 10px;
}
.hero.offline {
  background: linear-gradient(135deg,rgba(45,10,10,.9),rgba(26,5,5,.9));
  border-color: rgba(239,68,68,.3);
  box-shadow: 0 0 30px rgba(239,68,68,.1);
}
.hero.offline .hero-label,
.hero.offline .hero-time,
.hero.offline .hero-since { color: var(--red2); }

.cmd-row {
  display:flex;
  align-items:center;
  gap:10px;
  padding:9px 0;
  border-bottom:1px solid rgba(120,80,255,.06);
}
.cmd-row:last-child { border-bottom:none; }
.cmd-name {
  font-family:monospace;
  font-size:0.88em;
  color:var(--accent3);
  min-width:130px;
}
.cmd-desc {
  font-size:0.76em;
  color:var(--text3);
  flex:1;
  line-height:1.4;
}

.spin {
  display:inline-block;
  width:20px;
  height:20px;
  border:2px solid var(--border);
  border-top-color:var(--accent);
  border-radius:50%;
  animation:spin .8s linear infinite;
}
@keyframes spin { to { transform:rotate(360deg); } }

.info-row {
  display:flex;
  justify-content:space-between;
  align-items:flex-start;
  padding:7px 0;
  border-bottom:1px solid rgba(120,80,255,.06);
  font-size:0.83em;
  gap:8px;
}
.info-row:last-child { border-bottom:none; }
.info-label {
  color:var(--text3);
  flex-shrink:0;
}
.info-value {
  color:var(--text);
  text-align:right;
  word-break:break-all;
}

.docs-section { margin-bottom:32px; }
.docs-section h2 {
  font-size:1em;
  font-weight:700;
  color:var(--accent3);
  margin-bottom:12px;
  display:flex;
  align-items:center;
  gap:8px;
}
.docs-cmd {
  background:var(--bg2);
  border:1px solid var(--border);
  border-radius:10px;
  padding:12px 14px;
  margin-bottom:8px;
  transition:all .15s;
}
.docs-cmd:hover {
  border-color:var(--border2);
  background:var(--bg3);
}
.docs-cmd-name {
  font-family:monospace;
  font-size:0.9em;
  color:var(--accent3);
  font-weight:700;
}
.docs-cmd-desc {
  font-size:0.8em;
  color:var(--text2);
  margin-top:4px;
  line-height:1.5;
}
.docs-cmd-perm {
  font-size:0.72em;
  color:var(--text3);
  margin-top:4px;
}
.docs-tag {
  display:inline-block;
  padding:1px 7px;
  border-radius:6px;
  font-size:0.7em;
  font-weight:700;
  margin-right:4px;
}
.docs-tag.admin { background:rgba(239,68,68,.15); color:var(--red2); border:1px solid rgba(239,68,68,.25); }
.docs-tag.owner { background:rgba(234,179,8,.15); color:var(--yellow2); border:1px solid rgba(234,179,8,.25); }
.docs-tag.mod   { background:rgba(99,102,241,.15); color:var(--blue2); border:1px solid rgba(99,102,241,.25); }
.docs-tag.all   { background:rgba(34,197,94,.15); color:var(--green2); border:1px solid rgba(34,197,94,.25); }

.dc-list {
  background:var(--bg2);
  border-radius:12px;
  overflow:hidden;
  border:1px solid var(--border);
  margin-top:8px;
}
.dc-item {
  display:flex;
  align-items:center;
  gap:14px;
  padding:13px 16px;
  cursor:pointer;
  border-bottom:1px solid var(--border);
  transition:background .12s;
  user-select:none;
}
.dc-item:last-child { border-bottom:none; }
.dc-item:hover,
.dc-item.sel { background:var(--bg3); }
.dc-dot {
  width:18px;
  height:18px;
  border-radius:50%;
  flex-shrink:0;
  display:flex;
  align-items:center;
  justify-content:center;
}
.dc-lbl {
  flex:1;
  font-size:0.88em;
  color:var(--text);
}
.dc-radio {
  width:18px;
  height:18px;
  border-radius:50%;
  border:2px solid var(--border2);
  flex-shrink:0;
  display:flex;
  align-items:center;
  justify-content:center;
  transition:all .15s;
}
.dc-radio.on {
  border-color:var(--accent);
  background:var(--accent);
}
.dc-radio.on::after {
  content:'';
  width:7px;
  height:7px;
  border-radius:50%;
  background:#fff;
}

.act-row {
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  margin-top:8px;
}
.act-btn {
  flex:1;
  min-width:100px;
  padding:9px 8px;
  border-radius:9px;
  border:1px solid var(--border);
  background:var(--bg2);
  color:var(--text2);
  cursor:pointer;
  text-align:center;
  font-size:0.8em;
  transition:all .15s;
}
.act-btn:hover,
.act-btn.active {
  border-color:var(--accent2);
  background:rgba(124,58,237,.2);
  color:#fff;
}

.preview {
  background:var(--bg2);
  border-radius:12px;
  padding:16px;
  display:flex;
  align-items:center;
  gap:14px;
  margin-top:8px;
  border:1px solid var(--border);
}
.av {
  width:52px;
  height:52px;
  border-radius:50%;
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:24px;
  position:relative;
  flex-shrink:0;
}
.av-dot {
  position:absolute;
  bottom:1px;
  right:1px;
  width:14px;
  height:14px;
  border-radius:50%;
  border:2.5px solid var(--bg2);
  transition:background .2s;
}

.ri {
  display:flex;
  align-items:center;
  gap:8px;
  margin-top:8px;
}
.ri input {
  flex:1;
  margin-top:0;
}
.ri-empty {
  color:var(--text3);
  font-size:0.8em;
  text-align:center;
  padding:14px;
  border:1px dashed var(--border);
  border-radius:10px;
  margin-top:8px;
}

.msg-toast {
  padding:10px 14px;
  border-radius:10px;
  margin-bottom:14px;
  display:none;
  font-size:0.86em;
}
`;

// ════════════════════════════════════════════════════════════════════════════
//  🔧  HELPERS
// ════════════════════════════════════════════════════════════════════════════
function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;")
        .replace(/"/g,"&quot;")
        .replace(/'/g,"&#39;");
}

function navBar(active = "") {
    const links = [
        ["/", "🏠 หน้าหลัก"],
        ["/status", "📊 สถานะ"],
        ["/settings", "⚙️ ตั้งค่า"],
        ["/commands", "⚡ คำสั่ง"],
        ["/whitelist", "📋 Whitelist"],
        ["/approved", "✅ Approved"],
        ["/docs", "📖 คู่มือ"],
        ["/logs", "📜 Logs"],
        ["/logs/voice", "🔊 Voice"],
    ];

    return `<nav class="nav">${links.map(([href, label]) =>
        `<a href="${href}"${href === active ? " class=\"active\"" : ""}>${label}</a>`
    ).join("")}</nav>`;
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
function showToast(msg,type){
    type=type||'ok';
    const t=document.getElementById('__toast');
    t.textContent=msg;
    t.className='toast '+type;
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
    return shell("หน้าหลัก", `
<div class="container">
<h1 class="page-title">🚀 Enterprise Control Center</h1>
<p class="page-sub" id="lastUpdate">กำลังโหลด...</p>
${navBar("/")}

<div class="status-bar">
    <div class="dot" id="statusDot"></div>
    <span id="statusText" style="font-weight:700;">กำลังตรวจสอบ...</span>
    <span id="botTag" style="color:var(--text3);font-size:0.8em;margin-left:auto;"></span>
</div>

<div class="hero" id="onlineBanner" style="display:none;">
    <div class="hero-label">🟢 บอทออนต่อเนื่องมาแล้ว</div>
    <div class="hero-time" id="onlineDuration">--</div>
    <div class="hero-since" id="onlineSince">ตั้งแต่ --</div>
</div>

<div class="grid">
    <div class="stat"><div class="val" id="statUptime" style="color:var(--yellow2);">--</div><div class="lbl">⏱ System Uptime</div></div>
    <div class="stat"><div class="val" id="statSessions" style="color:var(--green2);">--</div><div class="lbl">📡 Sessions</div></div>
    <div class="stat"><div class="val" id="statPool" style="color:var(--blue2);">--</div><div class="lbl">🔌 Client Pool</div></div>
    <div class="stat"><div class="val" id="statRam" style="color:#e879f9;">-- MB</div><div class="lbl">🧠 RAM</div></div>
    <div class="stat"><div class="val" id="statReconnect" style="color:var(--orange);">--</div><div class="lbl">🔄 Reconnects</div></div>
    <div class="stat"><div class="val" id="statSuccess" style="color:var(--green2);">--%</div><div class="lbl">✅ Success Rate</div></div>
</div>

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

<div class="voice-row">
    <div class="voice-box"><div class="vval" style="color:var(--green2);" id="vc_connect">0</div><div class="vlbl">🟢 เชื่อมต่อ</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--blue2);" id="vc_recover">0</div><div class="vlbl">💖 กู้คืน</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--yellow2);" id="vc_drop">0</div><div class="vlbl">⚡ หลุด (ด่วน)</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--orange);" id="vc_disconnect">0</div><div class="vlbl">⚠️ หลุด</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--red2);" id="vc_fail">0</div><div class="vlbl">💔 ล้มเหลว</div></div>
</div>

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
function fmtUp(s){
    const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;
    if(d>0)return d+'d '+h+'h';
    if(h>0)return h+'h '+m+'m';
    return m+'m '+ss+'s';
}
function fmtFull(s){
    const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;
    if(d>0)return d+' วัน '+h+' ชม. '+m+' นาที';
    if(h>0)return h+' ชม. '+m+' นาที '+ss+' วิ';
    if(m>0)return m+' นาที '+ss+' วิ';
    return ss+' วินาที';
}
function esc(v){
    return String(v==null?'':v)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
}
function safeId(v){
    return String(v||'').replace(/['"<>&]/g,'');
}
function accountLabel(s){
    return s.accountLabel || s.accountTag || s.accountUsername || s.accountGlobalName || s.accountId || 'ไม่ทราบบัญชี';
}
function voiceLabel(s){
    const name=s.voiceName?'# '+s.voiceName:null;
    const id=s.voiceId?'<span style="font-family:monospace;">'+esc(s.voiceId)+'</span>':null;
    if(name&&id)return esc(name)+' · '+id;
    return name?esc(name):(id||'-');
}
function statusLabel(s){
    const st=s.connectionStatus;
    if(st==='ready')return '🟢 เชื่อมต่ออยู่';
    if(st==='connecting'||st==='signalling')return '🟡 กำลังเชื่อมต่อ';
    if(st==='disconnected')return '🟠 หลุด';
    if(st==='destroyed')return '🔴 หยุดแล้ว';
    return s.hasConnection?'⚪ '+esc(st||'unknown'):'⚫ ไม่มี connection';
}

const revealState={expiry:0,tokens:{},_timer:null};
async function fetchStatus(){
    try{
        const r=await fetch('/api/status');
        if(!r.ok){
            document.getElementById('lastUpdate').textContent='⚠️ API Error '+r.status+' — กรุณารีเฟรชหน้า';
            document.getElementById('statusText').textContent='⚠️ ดึงข้อมูลไม่ได้';
            return;
        }

        const d=await r.json();
        const dot=document.getElementById('statusDot');
        const txt=document.getElementById('statusText');

        if(d.botOnline){
            dot.className='dot online';
            txt.textContent='🟢 บอทออนไลน์';
            txt.style.color='var(--green2)';
        }else{
            dot.className='dot offline';
            txt.textContent='🔴 บอทออฟไลน์';
            txt.style.color='var(--red2)';
        }

        document.getElementById('botTag').textContent=d.botTag?'@'+d.botTag:'';

        const banner=document.getElementById('onlineBanner');
        if(d.botOnline&&d.botOnlineSec!==null){
            banner.style.display='block';
            document.getElementById('onlineDuration').textContent=fmtFull(d.botOnlineSec);
            const sinceDate=new Date(Date.now()-(d.botOnlineSec*1000));
            document.getElementById('onlineSince').textContent='ตั้งแต่ '+sinceDate.toLocaleString('th-TH',{
                day:'2-digit',
                month:'short',
                year:'numeric',
                hour:'2-digit',
                minute:'2-digit'
            });
        }else{
            banner.style.display='none';
        }

        document.getElementById('statUptime').textContent=fmtUp(d.uptimeSec||0);
        document.getElementById('statSessions').textContent=(d.sessions||0)+'/'+(d.maxSessions||0);
        document.getElementById('statPool').textContent=d.clientPool||0;
        document.getElementById('statRam').textContent=(d.ramMB||'0')+' MB';
        document.getElementById('statReconnect').textContent=d.reconnects||0;
        document.getElementById('statSuccess').textContent=(d.successRate||'100.0')+'%';

        const pct=d.maxSessions>0?Math.round((d.sessions/d.maxSessions)*100):0;
        document.getElementById('sessionCount').textContent=(d.sessions||0)+' / '+(d.maxSessions||0);

        const bar=document.getElementById('sessionBar');
        bar.style.width=pct+'%';
        bar.style.background=pct>80
            ?'linear-gradient(90deg,var(--red),var(--red2))'
            :pct>50
                ?'linear-gradient(90deg,var(--yellow),var(--yellow2))'
                :'linear-gradient(90deg,var(--accent),var(--accent2))';

        const sl=document.getElementById('sessionList');

        if(d.sessionList&&d.sessionList.length>0){
            sl.innerHTML=d.sessionList.map(s=>{
                const sid=safeId(s.sessionId);
                const ms=Date.now()-(s.startedAt||Date.now());
                const uh=Math.floor(ms/3600000);
                const um=Math.floor((ms%3600000)/60000);
                const ustr=uh>0?uh+'h '+um+'m':um+'m';
                const rc=s.reconnectCount||0;
                const acc=esc(accountLabel(s));
                const avatar=s.accountAvatar||s.ownerAvatar||'https://cdn.discordapp.com/embed/avatars/0.png';
                const server=esc(s.serverName||s.serverId||'Unknown Server');
                const owner=esc(s.ownerTag||s.ownerId||'-');
                const revealed=revealState.expiry>Date.now()&&revealState.tokens[sid];

                const tokenBlock=revealed
                    ? '<div class="token-full-wrap"><span style="flex:1;">'+esc(revealState.tokens[sid])+'</span><button class="copy-btn" onclick="navigator.clipboard.writeText(\\''+String(revealState.tokens[sid]).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'")+'\\');this.textContent=\\'✅\\';setTimeout(()=>this.textContent=\\'📋\\',1500)">📋</button></div>'
                    : '<button class="token-action" onclick="openRevealModal()" title="ต้องใส่ PIN ก่อนดู Token">🔑 ดู Token</button>';

                return '<div class="session-item">'+
                    '<div class="session-head">'+
                        '<img class="session-avatar" src="'+esc(avatar)+'" alt="avatar" onerror="this.src=\\'https://cdn.discordapp.com/embed/avatars/0.png\\'">'+
                        '<div class="session-meta">'+
                            '<div class="session-account">👤 '+acc+'</div>'+
                            '<div class="session-sub">🖥️ '+server+'</div>'+
                            '<div class="session-sub">🎙️ '+voiceLabel(s)+'</div>'+
                            '<div class="session-sub">📌 '+statusLabel(s)+' · ⏱ '+ustr+(rc>0?' · 🔄 '+rc+' ครั้ง':'')+'</div>'+
                            '<div class="session-sub">ผู้สั่งเริ่ม: '+owner+'</div>'+
                        '</div>'+
                    '</div>'+
                    '<div class="session-actions">'+
                        '<a class="session-chip" href="/session/'+sid+'">ดูรายละเอียด →</a>'+
                        tokenBlock+
                    '</div>'+
                '</div>';
            }).join('');
        }else{
            sl.innerHTML='<div style="color:var(--text3);text-align:center;padding:20px 0;font-size:0.85em;">ยังไม่มี session ออนอยู่</div>';
        }

        const vs=d.voiceSummary||{};
        ['connect','recover','drop','disconnect','fail'].forEach(k=>{
            const el=document.getElementById('vc_'+k);
            if(el) el.textContent=vs[k]||0;
        });

        const logs=d.recentLogs||[];
        document.getElementById('logCount').textContent='('+logs.length+' รายการ)';

        const term=document.getElementById('logTerminal');
        term.innerHTML=logs.map(l=>{
            const cls=l.type==='error'?'error':l.type==='warn'?'warn':'info';
            const time=esc(l.time||'');
            const msg=esc(l.msg||'');
            return '<div class="log-line '+cls+'">['+time+'] '+msg+'</div>';
        }).join('');

        document.getElementById('lastUpdate').textContent='อัปเดตทุก 5 วิ • '+new Date().toLocaleTimeString('th-TH');
    }catch(e){
        document.getElementById('lastUpdate').textContent='⚠️ เชื่อมต่อไม่ได้: '+e.message;
        document.getElementById('statusText').textContent='⚠️ ออฟไลน์';
    }
}

function openRevealModal(){
    if(revealState.expiry>Date.now()) return;
    document.getElementById('tokenErr').style.display='none';
    document.getElementById('tokenPin').value='';
    document.getElementById('tokenModal').style.display='flex';
}

function closeTokenModal(){
    document.getElementById('tokenModal').style.display='none';
}

async function submitRevealToken(){
    const pin=document.getElementById('tokenPin').value;
    const err=document.getElementById('tokenErr');

    try{
        const r=await fetch('/api/reveal-all-tokens',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({pin})
        });
        const d=await r.json();

        if(!d.success){
            err.textContent=d.error||'รหัสผ่านไม่ถูกต้อง';
            err.style.display='block';
            return;
        }

        revealState.tokens=d.tokens||{};
        revealState.expiry=Date.now()+5*60*1000;
        closeTokenModal();
        showRevealBar();
        fetchStatus();

        showToast('✅ ปลดล็อกการดู Token แล้ว 5 นาที','ok');
    }catch(e){
        err.textContent='เชื่อมต่อไม่ได้';
        err.style.display='block';
    }
}

function showRevealBar(){
    const bar=document.getElementById('revealBar');
    if(!bar) return;

    function tick(){
        const remain=Math.max(0,Math.ceil((revealState.expiry-Date.now())/1000));
        if(remain<=0){
            bar.style.display='none';
            revealState.tokens={};
            if(revealState._timer) clearInterval(revealState._timer);
            fetchStatus();
            return;
        }
        bar.style.display='block';
        bar.textContent='🔓 กำลังแสดง Token เต็ม เหลือเวลา '+remain+' วิ';
    }

    if(revealState._timer) clearInterval(revealState._timer);
    tick();
    revealState._timer=setInterval(tick,1000);
}

async function adminLogin(){
    const pin=document.getElementById('adminPin').value;
    const err=document.getElementById('adminErr');

    try{
        const r=await fetch('/auth/pin',{
            method:'POST',
            headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:'pin='+encodeURIComponent(pin)+'&next='+encodeURIComponent('/shadow')
        });

        if(r.redirected){
            location.href=r.url;
            return;
        }

        err.style.display='block';
    }catch(e){
        err.style.display='block';
    }
}

fetchStatus();
setInterval(fetchStatus,5000);
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  📊  หน้า STATUS
// ════════════════════════════════════════════════════════════════════════════
function pageStatus() {
    return shell("สถานะระบบ", `
<div class="container">
<h1 class="page-title">📊 System Status</h1>
<p class="page-sub">ภาพรวมสถานะบอทและระบบแบบเรียลไทม์</p>
${navBar("/status")}

<div class="status-bar">
    <div class="dot" id="statusDot"></div>
    <span id="statusText" style="font-weight:700;">กำลังโหลด...</span>
    <span id="lastUpdate" style="color:var(--text3);font-size:0.8em;margin-left:auto;"></span>
</div>

<div class="grid">
    <div class="stat"><div class="val" id="sSessions" style="color:var(--green2);">--</div><div class="lbl">Sessions</div></div>
    <div class="stat"><div class="val" id="sPool" style="color:var(--blue2);">--</div><div class="lbl">Client Pool</div></div>
    <div class="stat"><div class="val" id="sRam" style="color:#e879f9;">--</div><div class="lbl">RAM</div></div>
    <div class="stat"><div class="val" id="sReconnect" style="color:var(--orange);">--</div><div class="lbl">Reconnect</div></div>
    <div class="stat"><div class="val" id="sSuccess" style="color:var(--green2);">--%</div><div class="lbl">Success</div></div>
    <div class="stat"><div class="val" id="sUptime" style="color:var(--yellow2);">--</div><div class="lbl">Uptime</div></div>
</div>

<div class="card">
    <h3>🧠 รายละเอียดระบบ</h3>
    <div class="info-row"><span class="info-label">Bot Tag</span><span class="info-value" id="botTag">--</span></div>
    <div class="info-row"><span class="info-label">Bot Online</span><span class="info-value" id="botOnline">--</span></div>
    <div class="info-row"><span class="info-label">System Uptime</span><span class="info-value" id="uptimeFull">--</span></div>
    <div class="info-row"><span class="info-label">RAM Total</span><span class="info-value" id="ramTotal">--</span></div>
</div>
</div>

<script>
function fmtUp(s){
    const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;
    if(d>0)return d+'d '+h+'h';
    if(h>0)return h+'h '+m+'m';
    return m+'m '+ss+'s';
}
function fmtFull(s){
    const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;
    if(d>0)return d+' วัน '+h+' ชม. '+m+' นาที';
    if(h>0)return h+' ชม. '+m+' นาที '+ss+' วิ';
    if(m>0)return m+' นาที '+ss+' วิ';
    return ss+' วินาที';
}
async function loadStatus(){
    try{
        const r=await fetch('/api/status');
        const d=await r.json();
        const dot=document.getElementById('statusDot');
        const txt=document.getElementById('statusText');

        if(d.botOnline){
            dot.className='dot online';
            txt.textContent='🟢 บอทออนไลน์';
            txt.style.color='var(--green2)';
        }else{
            dot.className='dot offline';
            txt.textContent='🔴 บอทออฟไลน์';
            txt.style.color='var(--red2)';
        }

        document.getElementById('sSessions').textContent=(d.sessions||0)+'/'+(d.maxSessions||0);
        document.getElementById('sPool').textContent=d.clientPool||0;
        document.getElementById('sRam').textContent=(d.ramMB||'0')+' MB';
        document.getElementById('sReconnect').textContent=d.reconnects||0;
        document.getElementById('sSuccess').textContent=(d.successRate||'100.0')+'%';
        document.getElementById('sUptime').textContent=fmtUp(d.uptimeSec||0);

        document.getElementById('botTag').textContent=d.botTag||'-';
        document.getElementById('botOnline').textContent=d.botOnline?'ออนไลน์':'ออฟไลน์';
        document.getElementById('uptimeFull').textContent=fmtFull(d.uptimeSec||0);
        document.getElementById('ramTotal').textContent=(d.ramTotalMB||'0')+' MB';
        document.getElementById('lastUpdate').textContent=new Date().toLocaleTimeString('th-TH');
    }catch(e){
        document.getElementById('statusText').textContent='⚠️ โหลดไม่ได้';
    }
}
loadStatus();
setInterval(loadStatus,5000);
</script>`);
}
// ════════════════════════════════════════════════════════════════════════════
//  ⚡  หน้า COMMANDS
// ════════════════════════════════════════════════════════════════════════════
function pageCommands(commands, disabledCommands, commandAuditLog, API_SECRET) {
    const list = commands.slashCommandsData || [];

    const rows = list.map(cmd => {
        const enabled = !disabledCommands.has(cmd.name);

        return `
<div class="cmd-row">
    <div class="cmd-name">/${escapeHtml(cmd.name)}</div>
    <div class="cmd-desc">${escapeHtml(cmd.description || "")}</div>
    <label class="toggle ${enabled ? "" : ""}" title="${enabled ? "เปิดอยู่" : "ปิดอยู่"}">
        <input type="checkbox" ${enabled ? "checked" : ""} onchange="toggleCmd('${escapeHtml(cmd.name)}', this)">
        <span class="slider"></span>
    </label>
</div>`;
    }).join("");

    const audits = (commandAuditLog || []).slice().reverse().slice(0, 40).map(a => {
        const color = a.action === "enabled" ? "var(--green2)" : "var(--red2)";
        const label = a.action === "enabled" ? "เปิด" : "ปิด";

        return `<div class="log-line info">
            <span style="color:${color};font-weight:700;">${label}</span>
            /${escapeHtml(a.commandName || "-")}
            <span style="color:var(--text3);">โดย ${escapeHtml(a.ip || "-")} • ${new Date(a.timestamp || Date.now()).toLocaleString("th-TH")}</span>
        </div>`;
    }).join("");

    return shell("จัดการคำสั่ง", `
<div class="container">
<h1 class="page-title">⚡ Commands Control</h1>
<p class="page-sub">เปิด/ปิด Slash Commands แบบ realtime</p>
${navBar("/commands")}
${toastScript()}

<div class="card">
    <h3>⚡ Slash Commands</h3>
    ${rows || `<div style="text-align:center;color:var(--text3);padding:26px;">ยังไม่มีคำสั่ง</div>`}
</div>

<div class="card">
    <h3>🧾 Audit Log <span style="font-weight:normal;text-transform:none;color:var(--text3);font-size:0.9em;">ล่าสุด ${Math.min((commandAuditLog || []).length, 40)} รายการ</span></h3>
    <div class="terminal" style="height:260px;">${audits || `<div style="color:var(--text3);text-align:center;padding:30px;">ยังไม่มีประวัติ</div>`}</div>
</div>
</div>

<script>
const SECRET=${JSON.stringify(API_SECRET)};

async function toggleCmd(commandName, el){
    const wrap=el.closest('.toggle');
    wrap.classList.add('loading');

    try{
        const r=await fetch('/api/commands/toggle',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':SECRET
            },
            body:JSON.stringify({commandName})
        });

        const d=await r.json();

        if(d.success){
            showToast((d.enabled?'✅ เปิด ':'❌ ปิด ')+'/'+commandName,'ok');
            setTimeout(()=>location.reload(),700);
        }else{
            el.checked=!el.checked;
            showToast('❌ '+(d.error||'Unknown'),'err');
        }
    }catch(e){
        el.checked=!el.checked;
        showToast('❌ เชื่อมต่อไม่ได้','err');
    }finally{
        wrap.classList.remove('loading');
    }
}
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  📋  หน้า WHITELIST
// ════════════════════════════════════════════════════════════════════════════
function pageWhitelist(list, API_SECRET) {
    const rows = (list || []).map(w => `
<tr>
    <td style="font-family:monospace;color:var(--accent3);">${escapeHtml(w.userId || "-")}</td>
    <td>${escapeHtml(w.scope || "say")}</td>
    <td style="color:var(--text3);">${escapeHtml(w.addedBy || "-")}</td>
    <td style="color:var(--text3);">${new Date(w.addedAt || Date.now()).toLocaleString("th-TH")}</td>
    <td><button class="btn btn-danger btn-sm" onclick="removeUser('${escapeHtml(w.userId || "")}')">ลบ</button></td>
</tr>`).join("");

    return shell("Whitelist", `
<div class="container-lg">
<h1 class="page-title">📋 Whitelist</h1>
<p class="page-sub">จัดการคนที่ใช้คำสั่งพิเศษ เช่น /say</p>
${navBar("/whitelist")}
${toastScript()}

<div class="card">
    <h3>➕ เพิ่ม Whitelist</h3>
    <label>Discord User ID</label>
    <input id="userId" placeholder="เช่น 123456789012345678">
    <button class="btn btn-success" onclick="addUser()">➕ เพิ่มผู้ใช้</button>
</div>

<div class="card" style="padding:0;overflow:hidden;">
    <table>
        <thead>
            <tr>
                <th>User ID</th>
                <th>Scope</th>
                <th>Added By</th>
                <th>Added At</th>
                <th>Action</th>
            </tr>
        </thead>
        <tbody>
            ${rows || `<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:34px;">ยังไม่มี whitelist</td></tr>`}
        </tbody>
    </table>
</div>
</div>

<script>
const SECRET=${JSON.stringify(API_SECRET)};

async function addUser(){
    const userId=document.getElementById('userId').value.trim();

    if(!/^\\d{17,20}$/.test(userId)){
        return showToast('❌ User ID ไม่ถูกต้อง','err');
    }

    try{
        const r=await fetch('/api/whitelist/add',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':SECRET
            },
            body:JSON.stringify({userId})
        });

        const d=await r.json();

        if(d.success){
            showToast('✅ เพิ่มเรียบร้อย','ok');
            setTimeout(()=>location.reload(),800);
        }else{
            showToast('❌ '+(d.error||'Unknown'),'err');
        }
    }catch(e){
        showToast('❌ เชื่อมต่อไม่ได้','err');
    }
}

async function removeUser(userId){
    if(!confirm('ลบ '+userId+' ออกจาก whitelist?')) return;

    try{
        const r=await fetch('/api/whitelist/remove',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':SECRET
            },
            body:JSON.stringify({userId})
        });

        const d=await r.json();

        if(d.success){
            showToast('✅ ลบเรียบร้อย','ok');
            setTimeout(()=>location.reload(),800);
        }else{
            showToast('❌ '+(d.error||'Unknown'),'err');
        }
    }catch(e){
        showToast('❌ เชื่อมต่อไม่ได้','err');
    }
}
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  ✅  หน้า APPROVED GUILDS
// ════════════════════════════════════════════════════════════════════════════
function pageApproved(approvedList, client, API_SECRET) {
    const rows = (approvedList || []).map(g => {
        const guild = client.guilds.cache.get(g.guildId);
        const name = guild?.name || g.guildName || "ไม่พบชื่อเซิร์ฟเวอร์";
        const members = guild?.memberCount || "-";

        return `
<tr>
    <td>
        <div style="font-weight:700;color:var(--text);">${escapeHtml(name)}</div>
        <div style="font-family:monospace;color:var(--text3);font-size:0.75em;">${escapeHtml(g.guildId || "-")}</div>
    </td>
    <td style="color:var(--text3);">${members}</td>
    <td style="color:var(--text3);">${new Date(g.approvedAt || Date.now()).toLocaleString("th-TH")}</td>
    <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-danger btn-sm" onclick="removeGuild('${escapeHtml(g.guildId || "")}')">ลบ</button>
            <button class="btn btn-warning btn-sm" onclick="kickGuild('${escapeHtml(g.guildId || "")}')">เตะบอท</button>
        </div>
    </td>
</tr>`;
    }).join("");

    return shell("Approved Guilds", `
<div class="container-lg">
<h1 class="page-title">✅ Approved Guilds</h1>
<p class="page-sub">จัดการเซิร์ฟเวอร์ที่อนุมัติให้ใช้ระบบ</p>
${navBar("/approved")}
${toastScript()}

<div class="card" style="padding:0;overflow:hidden;">
    <table>
        <thead>
            <tr>
                <th>เซิร์ฟเวอร์</th>
                <th>สมาชิก</th>
                <th>อนุมัติเมื่อ</th>
                <th>Action</th>
            </tr>
        </thead>
        <tbody>
            ${rows || `<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:40px;font-size:0.85em;">ยังไม่มีเซิร์ฟเวอร์</td></tr>`}
        </tbody>
    </table>
</div>
</div>

<script>
const SECRET=${JSON.stringify(API_SECRET)};

async function removeGuild(guildId){
    if(!confirm('ลบ '+guildId+' ออกจาก Approved?')) return;

    try{
        const r=await fetch('/api/approved/remove',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':SECRET
            },
            body:JSON.stringify({guildId})
        });

        const d=await r.json();

        if(d.success){
            showToast('✅ ลบออกแล้ว','ok');
            setTimeout(()=>location.reload(),900);
        }else{
            showToast('❌ '+(d.error||'Unknown'),'err');
        }
    }catch(e){
        showToast('❌ เชื่อมต่อไม่ได้','err');
    }
}

async function kickGuild(guildId){
    if(!confirm('เตะบอทออกจาก '+guildId+'?')) return;

    try{
        const r=await fetch('/api/approved/kick',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':SECRET
            },
            body:JSON.stringify({guildId})
        });

        const d=await r.json();

        if(d.partialSuccess){
            showToast('⚠️ '+(d.warning||'เตะบอทออกแล้ว แต่มีบาง session หยุดไม่สำเร็จ'),'warn');
            setTimeout(()=>location.reload(),1200);
        }else if(d.success){
            showToast('✅ เตะบอทออกแล้ว','ok');
            setTimeout(()=>location.reload(),1000);
        }else{
            showToast('❌ '+(d.error||'Unknown'),'err');
        }
    }catch(e){
        showToast('❌ เชื่อมต่อไม่ได้','err');
    }
}
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  📜  หน้า LOGS
// ════════════════════════════════════════════════════════════════════════════
function pageLogs(webLogs, MAX_LOGS) {
    const logsHtml = webLogs.slice().reverse().map(l => {
        const cls = l.type === "error" ? "error" : l.type === "warn" ? "warn" : "info";
        return `<div class="log-line ${cls}">[${escapeHtml(l.time || "")}] ${escapeHtml(l.msg || "")}</div>`;
    }).join("");

    return shell("System Logs", `
<div class="container-lg">
<h1 class="page-title">📜 System Logs</h1>
<p class="page-sub">${webLogs.length} / ${MAX_LOGS} รายการ — <span style="color:var(--green2);">● info</span> <span style="color:var(--yellow2);">● warn</span> <span style="color:var(--red2);">● error</span></p>
${navBar("/logs")}
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
    const colorMap = {
        connect:"var(--green2)",
        recover:"var(--blue2)",
        drop:"var(--yellow2)",
        disconnect:"var(--orange)",
        fail:"var(--red2)"
    };

    const iconMap = {
        connect:"🟢",
        recover:"💖",
        drop:"⚡",
        disconnect:"⚠️",
        fail:"💔"
    };

    const labelMap = {
        connect:"เชื่อมต่อ",
        recover:"กู้คืน",
        drop:"หลุด (ด่วน)",
        disconnect:"หลุด",
        fail:"ล้มเหลว"
    };

    const summary = {
        connect:0,
        recover:0,
        drop:0,
        disconnect:0,
        fail:0
    };

    (logs || []).forEach(e => {
        if (summary[e.type] !== undefined) summary[e.type]++;
    });

    const rows = !logs || logs.length === 0
        ? `<tr><td colspan="6" style="text-align:center;padding:28px;color:var(--text3);">ยังไม่มี Event — บอทยังไม่ได้เชื่อมต่อ Voice</td></tr>`
        : logs.map(e => `<tr>
            <td style="color:var(--text3);white-space:nowrap;font-size:0.8em;">${new Date(e.ts || Date.now()).toLocaleTimeString("th-TH",{hour12:false})}</td>
            <td style="color:${colorMap[e.type] || "var(--text2)"};font-weight:700;">${iconMap[e.type] || "❓"} ${labelMap[e.type] || escapeHtml(e.type || "-")}</td>
            <td style="color:var(--text2);font-size:0.8em;">${escapeHtml(e.account || "-")}</td>
            <td style="color:var(--text2);font-size:0.8em;">${escapeHtml(e.guild || "-")}</td>
            <td style="color:var(--text2);font-size:0.8em;">${escapeHtml(e.voice || "-")}</td>
            <td style="color:var(--text3);font-size:0.8em;">${escapeHtml(e.detail || "-")}</td>
        </tr>`).join("");

    return shell("Voice Log", `
<div class="container-lg">
<h1 class="page-title">🔊 Voice Connection Log</h1>
<p class="page-sub">อัปเดตทุก 15 วิ — เก็บ ${(logs || []).length}/200 events ล่าสุด</p>
${navBar("/logs/voice")}

<div class="voice-row" style="margin-bottom:18px;">
    <div class="voice-box"><div class="vval" style="color:var(--green2);">${summary.connect}</div><div class="vlbl">🟢 เชื่อมต่อ</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--blue2);">${summary.recover}</div><div class="vlbl">💖 กู้คืน</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--yellow2);">${summary.drop}</div><div class="vlbl">⚡ หลุด (ด่วน)</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--orange);">${summary.disconnect}</div><div class="vlbl">⚠️ หลุด</div></div>
    <div class="voice-box"><div class="vval" style="color:var(--red2);">${summary.fail}</div><div class="vlbl">💔 ล้มเหลว</div></div>
</div>

<div class="card" style="padding:0;overflow:hidden;">
    <table>
        <thead>
            <tr>
                <th>เวลา</th>
                <th>สถานะ</th>
                <th>บัญชี</th>
                <th>เซิร์ฟเวอร์</th>
                <th>ช่องเสียง</th>
                <th>รายละเอียด</th>
            </tr>
        </thead>
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
    return shell("Session Detail", `
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
            <h3>👤 บัญชีที่ออน</h3>
            <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
                <img id="iAccountAvatar" src="https://cdn.discordapp.com/embed/avatars/0.png" style="width:54px;height:54px;border-radius:50%;border:1px solid var(--border2);object-fit:cover;" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
                <div style="min-width:0;">
                    <div id="iAccountName" style="font-weight:900;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">--</div>
                    <div id="iAccountId" style="font-family:monospace;color:var(--text3);font-size:0.78em;margin-top:3px;">--</div>
                </div>
            </div>
            <div class="info-row"><span class="info-label">ผู้สั่งเริ่ม</span><span class="info-value" id="iOwner">--</span></div>
        </div>

        <div class="card">
            <h3>📋 ข้อมูล Session</h3>
            <div class="info-row"><span class="info-label">เซิร์ฟเวอร์</span><span class="info-value" id="iServer">--</span></div>
            <div class="info-row"><span class="info-label">ช่องเสียง</span><span class="info-value" id="iVoice">--</span></div>
            <div class="info-row"><span class="info-label">เริ่มออนเมื่อ</span><span class="info-value" id="iStarted">--</span></div>
            <div class="info-row"><span class="info-label">ใช้งานล่าสุด</span><span class="info-value" id="iActivity">--</span></div>
            <div class="info-row"><span class="info-label">Session ID</span><span class="info-value" id="iSid" style="font-family:monospace;font-size:0.72em;color:var(--text3);">--</span></div>
        </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
        <div class="card">
            <h3>📊 สถิติ</h3>
            <div style="text-align:center;padding:12px 0;">
                <div id="sUptime" style="font-size:2em;font-weight:900;color:var(--yellow2);">--</div>
                <div style="font-size:0.65em;color:var(--text3);margin-top:4px;text-transform:uppercase;letter-spacing:.5px;">⏱ เวลาออนทั้งหมด</div>
            </div>
            <div style="border-top:1px solid var(--border);margin:10px 0;"></div>
            <div class="info-row"><span class="info-label">🔄 Reconnect</span><span class="info-value" id="sReconnect" style="color:var(--orange);">--</span></div>
            <div class="info-row"><span class="info-label">สถานะ</span><span class="info-value" id="sStatus">--</span></div>
            <div class="info-row"><span class="info-label">🔑 Token Health</span><span class="info-value" id="sTokenHealth">--</span></div>
        </div>

        <div class="card">
            <h3>🔑 Token</h3>
            <div id="tokenDisplay">
                <button class="btn btn-warning" onclick="openTokenModal()">🔑 ดู Token เต็มด้วย PIN</button>
            </div>
            <div id="revealHint" style="font-size:0.72em;color:var(--text3);margin-top:8px;line-height:1.5;">
                ระบบจะไม่โชว์ท้าย Token บนหน้าเว็บแล้ว เพื่อไม่ให้ข้อมูลสำคัญโผล่ใน Dashboard โดยไม่จำเป็น
            </div>
            <div class="reveal-bar" id="revealBarDetail"></div>
        </div>
    </div>

    <div class="card">
        <h3>📡 ประวัติการเชื่อมต่อ <span id="logCount" style="font-weight:normal;text-transform:none;letter-spacing:0;color:var(--text3);font-size:0.9em;"></span></h3>
        <div id="logTableWrap"><p style="color:var(--text3);font-size:0.82em;text-align:center;padding:20px 0;">ยังไม่มีประวัติ</p></div>
    </div>

    <div style="background:rgba(127,29,29,.15);border:1px solid rgba(239,68,68,.25);border-radius:16px;padding:20px;text-align:center;margin-bottom:20px;">
        <h3 style="color:var(--red2);margin-bottom:8px;">🛑 หยุด Session นี้</h3>
        <p style="color:var(--text3);font-size:0.8em;margin-bottom:14px;line-height:1.6;">เมื่อหยุดแล้ว บัญชีจะออกจากช่องเสียงทันที<br>เจ้าของจะได้รับแจ้งเตือนทาง DM</p>
        <button class="btn btn-danger" id="btnStop" onclick="openStopModal()" style="width:auto;padding:11px 28px;">🛑 หยุด Session นี้</button>
    </div>
</div>
</div>

<div class="modal" id="tokenModal" onclick="if(event.target===this)closeTokenModal()">
<div class="modal-box">
    <button class="modal-close" onclick="closeTokenModal()">✕</button>
    <div style="font-size:1.8em;margin-bottom:8px;">🔑</div>
    <h3 style="color:var(--yellow2);margin-bottom:6px;font-size:1em;">ดู Token เต็ม</h3>
    <p style="color:var(--text3);font-size:0.78em;margin-bottom:16px;">กรอกรหัสผ่านเพื่อแสดง Token ของ session นี้</p>
    <p id="tokenErr" style="color:var(--red2);font-size:0.82em;margin-bottom:8px;display:none;">รหัสผ่านไม่ถูกต้อง</p>
    <input id="tokenPin" type="password" placeholder="รหัสผ่านลับ..." style="text-align:center;margin-bottom:12px;">
    <button onclick="submitRevealToken()" class="btn btn-warning">🔑 เปิดดู Token</button>
</div>
</div>

<div class="modal" id="stopModal" onclick="if(event.target===this)closeStopModal()">
<div class="modal-box">
    <button class="modal-close" onclick="closeStopModal()">✕</button>
    <div style="font-size:1.8em;margin-bottom:8px;">🛑</div>
    <h3 style="color:var(--red2);margin-bottom:6px;font-size:1em;">ยืนยันการหยุด Session</h3>
    <p style="color:var(--text3);font-size:0.78em;margin-bottom:16px;">การหยุดนี้จะทำให้บัญชีออกจากช่องเสียงทันที</p>
    <button onclick="stopSession()" class="btn btn-danger" id="confirmStopBtn">ยืนยันหยุด</button>
</div>
</div>

${toastScript()}
<script>
const SESSION_ID=${JSON.stringify(safeId)};
let sessionData=null;
let revealedToken=null;
let revealExpiry=0;
let revealTimer=null;

function esc(v){
    return String(v==null?'':v)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
}
function fmtUp(ms){
    const s=Math.max(0,Math.floor(ms/1000));
    const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;
    if(d>0)return d+' วัน '+h+' ชม.';
    if(h>0)return h+' ชม. '+m+' นาที';
    if(m>0)return m+' นาที '+ss+' วิ';
    return ss+' วิ';
}
function accountLabel(s){
    return s.accountLabel || s.accountTag || s.accountUsername || s.accountGlobalName || s.accountId || 'ไม่ทราบบัญชี';
}
function voiceLabel(s){
    const name=s.voiceName?'# '+s.voiceName:null;
    const id=s.voiceId?String(s.voiceId):null;
    if(name&&id)return name+' / '+id;
    return name||id||'-';
}
function statusLabel(s){
    const st=s.connectionStatus;
    if(st==='ready')return '🟢 เชื่อมต่ออยู่';
    if(st==='connecting'||st==='signalling')return '🟡 กำลังเชื่อมต่อ';
    if(st==='disconnected')return '🟠 หลุด';
    if(st==='destroyed')return '🔴 หยุดแล้ว';
    return s.hasConnection?'⚪ '+(st||'unknown'):'⚫ ไม่มี connection';
}
function updateUptime(){
    if(!sessionData||!sessionData.startedAt)return;
    const up=fmtUp(Date.now()-sessionData.startedAt);
    document.getElementById('uptimeLive').textContent='ออนมา '+up;
    document.getElementById('sUptime').textContent=up;
}
function showTokenBlock(token){
    const box=document.getElementById('tokenDisplay');
    const safe=esc(token);
    box.innerHTML='<div class="token-full-wrap"><span style="flex:1;">'+safe+'</span><button class="copy-btn" onclick="navigator.clipboard.writeText(\\''+String(token).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'")+'\\');this.textContent=\\'✅\\';setTimeout(()=>this.textContent=\\'📋\\',1500)">📋</button></div>';
}
function hideTokenBlock(){
    document.getElementById('tokenDisplay').innerHTML='<button class="btn btn-warning" onclick="openTokenModal()">🔑 ดู Token เต็มด้วย PIN</button>';
}
function updateRevealTimer(){
    const bar=document.getElementById('revealBarDetail');
    const remain=Math.max(0,Math.ceil((revealExpiry-Date.now())/1000));
    if(remain<=0){
        bar.style.display='none';
        revealedToken=null;
        hideTokenBlock();
        if(revealTimer) clearInterval(revealTimer);
        return;
    }
    bar.style.display='block';
    bar.textContent='🔓 กำลังแสดง Token เต็ม เหลือเวลา '+remain+' วิ';
}
async function loadSession(){
    try{
        const r=await fetch('/api/session/'+encodeURIComponent(SESSION_ID));
        const d=await r.json();

        if(!d.found){
            document.getElementById('notFound').style.display='block';
            document.getElementById('pageContent').style.display='none';
            return;
        }

        const s=d.session || d;
        sessionData=s;

        document.getElementById('pageTitle').textContent='🖥️ '+(s.serverName||s.serverId||'Session Detail');
        document.getElementById('pageSubtitle').textContent='Session: '+(s.shortId||s.sessionId||SESSION_ID);

        const dot=document.getElementById('sDot');
        const txt=document.getElementById('sTxt');

        if(s.connectionStatus==='ready'){
            dot.className='dot online';
            txt.textContent='🟢 กำลังออนช่องเสียง';
            txt.style.color='var(--green2)';
        }else if(s.connectionStatus==='disconnected'||s.connectionStatus==='destroyed'){
            dot.className='dot offline';
            txt.textContent=statusLabel(s);
            txt.style.color='var(--red2)';
        }else{
            dot.className='dot yellow';
            txt.textContent=statusLabel(s);
            txt.style.color='var(--yellow2)';
        }

        document.getElementById('iAccountAvatar').src=s.accountAvatar||s.ownerAvatar||'https://cdn.discordapp.com/embed/avatars/0.png';
        document.getElementById('iAccountName').textContent=accountLabel(s);
        document.getElementById('iAccountId').textContent=s.accountId||'-';

        document.getElementById('iServer').textContent=s.serverName||s.serverId||'-';
        document.getElementById('iVoice').textContent=voiceLabel(s);
        document.getElementById('iOwner').textContent=s.ownerTag||s.ownerId||'-';
        document.getElementById('iStarted').textContent=s.startedAt?new Date(s.startedAt).toLocaleString('th-TH'):'-';
        document.getElementById('iActivity').textContent=s.lastActivity?new Date(s.lastActivity).toLocaleString('th-TH'):'-';
        document.getElementById('iSid').textContent=s.sessionId||SESSION_ID;

        document.getElementById('sReconnect').textContent=(s.reconnectCount||0)+' ครั้ง';
        document.getElementById('sStatus').textContent=statusLabel(s);
        document.getElementById('sTokenHealth').textContent=s.tokenInvalid?'🚫 Token ใช้งานไม่ได้':'✅ ปกติ';

        updateUptime();

        const logs=d.voiceLogs||[];
        document.getElementById('logCount').textContent='('+logs.length+' รายการ)';

        const wrap=document.getElementById('logTableWrap');
        if(logs.length){
            wrap.innerHTML='<table><thead><tr><th>เวลา</th><th>สถานะ</th><th>รายละเอียด</th></tr></thead><tbody>'+
                logs.map(l=>{
                    const cls=l.type==='fail'?'var(--red2)':l.type==='drop'?'var(--yellow2)':l.type==='recover'?'var(--blue2)':'var(--green2)';
                    return '<tr>'+
                        '<td style="color:var(--text3);white-space:nowrap;">'+new Date(l.ts||Date.now()).toLocaleTimeString('th-TH',{hour12:false})+'</td>'+
                        '<td style="font-weight:700;color:'+cls+';">'+esc(l.type||'-')+'</td>'+
                        '<td style="color:var(--text2);">'+esc(l.detail||'-')+'</td>'+
                    '</tr>';
                }).join('')+
            '</tbody></table>';
        }else{
            wrap.innerHTML='<p style="color:var(--text3);font-size:0.82em;text-align:center;padding:20px 0;">ยังไม่มีประวัติ</p>';
        }
    }catch(e){
        showToast('❌ โหลด session ไม่ได้: '+e.message,'err');
    }
}

function openTokenModal(){
    document.getElementById('tokenErr').style.display='none';
    document.getElementById('tokenPin').value='';
    document.getElementById('tokenModal').style.display='flex';
}
function closeTokenModal(){
    document.getElementById('tokenModal').style.display='none';
}
async function submitRevealToken(){
    const pin=document.getElementById('tokenPin').value;
    const err=document.getElementById('tokenErr');

    try{
        const r=await fetch('/api/reveal-token',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({pin,sessionId:SESSION_ID})
        });

        const d=await r.json();

        if(!d.success){
            err.textContent=d.error||'รหัสผ่านไม่ถูกต้อง';
            err.style.display='block';
            return;
        }

        revealedToken=d.token;
        revealExpiry=Date.now()+5*60*1000;
        closeTokenModal();
        showTokenBlock(revealedToken);
        updateRevealTimer();
        if(revealTimer) clearInterval(revealTimer);
        revealTimer=setInterval(updateRevealTimer,1000);
        showToast('✅ แสดง Token แล้ว 5 นาที','ok');
    }catch(e){
        err.textContent='เชื่อมต่อไม่ได้';
        err.style.display='block';
    }
}
function openStopModal(){
    document.getElementById('stopModal').style.display='flex';
}
function closeStopModal(){
    document.getElementById('stopModal').style.display='none';
}
async function stopSession(){
    const btn=document.getElementById('confirmStopBtn');
    btn.disabled=true;
    btn.textContent='⏳ กำลังหยุด...';

    try{
        const r=await fetch('/api/stop-session',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':''
            },
            body:JSON.stringify({sessionId:SESSION_ID})
        });

        const d=await r.json();

        if(d.success){
            showToast('✅ หยุด session แล้ว','ok');
            setTimeout(()=>location.href='/',900);
        }else{
            showToast('❌ '+(d.error||'Unknown'),'err');
            btn.disabled=false;
            btn.textContent='ยืนยันหยุด';
        }
    }catch(e){
        showToast('❌ เชื่อมต่อไม่ได้','err');
        btn.disabled=false;
        btn.textContent='ยืนยันหยุด';
    }
}

loadSession();
setInterval(updateUptime,1000);
setInterval(loadSession,10000);
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  📖  DOCS PAGE
// ════════════════════════════════════════════════════════════════════════════
function pageDocs() {
    const sections = [
        {
            id:"voice",
            icon:"🔊",
            title:"Voice System",
            desc:"ระบบออนช่องเสียงหลายบัญชี หลายเซิร์ฟเวอร์ พร้อมระบบกู้คืน",
            items:[
                ["🎧 Multi-session", "1 token สามารถออนได้หลายเซิร์ฟเวอร์พร้อมกัน และหลาย token สามารถอยู่เซิร์ฟเวอร์/ช่องเดียวกันได้โดยไม่ชนกัน"],
                ["👤 Account Metadata", "Dashboard แสดงชื่อบัญชีที่ออน, User ID, avatar, server, voice channel"],
                ["🧠 Client Pool", "ใช้ tokenHash เป็น key เพื่อ reuse client เดิมโดยไม่ล็อก token ไว้กับ guild เดียว"],
                ["💖 Auto Recovery", "ตรวจ connection ที่หลุดและกู้คืนตาม cooldown/urgent recovery"],
                ["🎭 Natural Blink", "เปิด/ปิดไมค์และหูชั่วคราวตามกำหนด ไม่มีระบบ leave/rejoin รายชั่วโมง"],
                ["🔇 Auto Deaf", "เปิดหูชั่วคราวแล้วปิดกลับ ตั้งค่าได้จาก Dashboard"],
                ["🔑 Token Privacy", "ไม่โชว์ท้าย Token บน list/status แล้ว ต้องกดดู Token และใส่ PIN เท่านั้น"]
            ]
        },
        {
            id:"dashboard",
            icon:"🖥️",
            title:"Dashboard",
            desc:"หน้าควบคุมระบบผ่านเว็บ",
            items:[
                ["🏠 หน้าหลัก", "สถิติ real-time, session list, voice summary, live logs"],
                ["📊 /status", "ภาพรวมสถานะบอท, uptime, RAM, success rate"],
                ["⚙️ /settings", "ตั้งค่า presence, rotate, natural, auto deaf, general config"],
                ["⚡ /commands", "เปิด/ปิด slash commands แบบ realtime"],
                ["📋 /whitelist", "จัดการ whitelist สำหรับคำสั่งเฉพาะ"],
                ["✅ /approved", "จัดการเซิร์ฟเวอร์ที่อนุมัติ"],
                ["🔊 /logs/voice", "ประวัติ voice event"],
                ["🖥️ /session/:id", "ดูรายละเอียด session, ดู Token แบบ PIN protected, สั่งหยุดได้"]
            ]
        },
        {
            id:"security",
            icon:"🛡️",
            title:"Security / Privacy",
            desc:"แนวทางความปลอดภัยของระบบ",
            items:[
                ["🔐 PIN Protected", "การดู Token ต้องผ่าน PIN และมี lockout"],
                ["🚫 No tokenTail in UI", "หน้า list/status/detail ไม่โชว์ท้าย Token โดย default"],
                ["📡 Alert Webhook", "แจ้งเตือน intrusion / session abnormal ผ่าน webhook"],
                ["⛔ Rate Limit", "จำกัดคำขอ API เพื่อลด abuse"],
                ["🧹 Cleanup", "ลบ session idle อัตโนมัติและเคลียร์ state เมื่อหยุด"]
            ]
        },
        {
            id:"faq",
            icon:"❓",
            title:"FAQ",
            desc:"คำถามที่พบบ่อย",
            items:[
                ["บอทไม่เข้าห้องเสียง", "ตรวจ token, guild id, voice id, สิทธิ์เข้าห้องเสียง และบอทอยู่ในเซิร์ฟเวอร์นั้นไหม"],
                ["ขึ้นว่าบัญชีนี้ออนในเซิร์ฟเวอร์นี้แล้ว", "token เดิมมี session อยู่ใน guild เดิม ให้หยุด session เดิมก่อนย้ายช่อง"],
                ["หยุดแล้วแต่ยังขึ้น active", "ตรวจ session state ใน Dashboard และ restart worker ถ้า state ค้าง"],
                ["Token ปลอดภัยไหม", "ระบบไม่โชว์ใน UI ปกติ ต้องใช้ PIN เพื่อดู Token เต็ม"]
            ]
        }
    ];

    const sectionsHtml = sections.map(sec => `
<div class="docs-section" id="sec-${sec.id}">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <span style="font-size:1.4em;">${sec.icon}</span>
        <div>
            <div style="font-size:0.95em;font-weight:700;color:var(--accent3);">${sec.title}</div>
            <div style="font-size:0.75em;color:var(--text3);">${sec.desc}</div>
        </div>
    </div>
    <div style="display:grid;gap:8px;">
        ${sec.items.map(([title, desc]) => `
        <div class="docs-cmd">
            <div class="docs-cmd-name">${escapeHtml(title)}</div>
            <div class="docs-cmd-desc">${escapeHtml(desc)}</div>
        </div>`).join("")}
    </div>
</div>
<div style="border-bottom:1px solid var(--border);margin-bottom:24px;"></div>`).join("");

    return shell("คู่มือการใช้งาน", `
<div class="container">
<h1 class="page-title">📖 คู่มือการใช้งาน</h1>
<p class="page-sub">Phomueangtai Enterprise — อธิบายระบบหลักและจุดที่ควรรู้</p>
${navBar("/docs")}

<div class="card" style="margin-bottom:16px;">
    <h3>🗂️ หมวดหมู่</h3>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${sections.map(s => `<a href="#sec-${s.id}" style="background:var(--bg2);color:var(--text2);padding:6px 12px;border-radius:8px;text-decoration:none;font-size:0.78em;border:1px solid var(--border);">${s.icon} ${s.title}</a>`).join("")}
    </div>
</div>

${sectionsHtml}
</div>`);
}
// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  หน้า SETTINGS
// ════════════════════════════════════════════════════════════════════════════
function pageSettings(settings, config, client, API_SECRET) {
    const maxSessions = settings.maxSessions ?? config.limits.maxSessions;
    const rateLimitReq = settings.rateLimitRequests ?? config.limits.rateLimitRequests;
    const antiRaid = settings.antiRaidEnabled ?? true;
    const idleHrs = settings.idleTimeoutHrs ?? 24;

    const botStatus = settings.botStatus ?? config.bot_presence?.status ?? "idle";
    const botActivity = escapeHtml(settings.botActivity ?? config.bot_presence?.activityText ?? "ระบบออนช่องเสียง");
    const botNote = escapeHtml(settings.botNote ?? "");
    const actType = settings.botActivityType || "WATCHING";

    const rotateEn = settings.rotateEnabled ?? false;
    const rotateInt = settings.rotateInterval ?? 5;
    const rotateMsgs = Array.isArray(settings.rotateMessages) ? settings.rotateMessages : [];

    const botName = escapeHtml(client?.user?.username || "Bot");
    const statusColors = {
        online: "#4ade80",
        idle: "#fbbf24",
        dnd: "#f87171",
        invisible: "transparent"
    };

    return shell("ตั้งค่าระบบ", `
<div class="container">
<h1 class="page-title">⚙️ ตั้งค่าระบบ</h1>
<p class="page-sub">จัดการการตั้งค่าทั้งหมดจากหน้าเว็บ — มีผลทันทีโดยไม่ต้อง restart</p>
${navBar("/settings")}

<div id="__msg" class="msg-toast"></div>

<div class="card">
    <h3>🎛️ General Config</h3>

    <label>Max Sessions — ผู้ใช้พร้อมกันสูงสุด</label>
    <input type="number" id="maxSessions" value="${maxSessions}" min="1" max="100">

    <label>Rate Limit — รับคำขอ API สูงสุด / นาที</label>
    <input type="number" id="rateLimitRequests" value="${rateLimitReq}" min="1" max="60">

    <label>Idle Timeout — หยุดอัตโนมัติหลังไม่ active กี่ชั่วโมง</label>
    <input type="number" id="idleTimeoutHrs" value="${idleHrs}" min="1" max="168">

    <label>ระบบ Anti-Raid Tag</label>
    <select id="antiRaidEnabled">
        <option value="true" ${antiRaid ? "selected" : ""}>✅ เปิดใช้งาน</option>
        <option value="false" ${!antiRaid ? "selected" : ""}>❌ ปิดใช้งาน</option>
    </select>

    <button class="btn btn-primary" onclick="saveSettings()">💾 บันทึก General</button>
</div>

<div class="card">
    <h3>🖼️ ตัวอย่างโปรไฟล์บอท</h3>

    <div class="preview">
        <div class="av">
            🤖
            <div class="av-dot" id="previewDot" style="background:${statusColors[botStatus] || statusColors.idle};"></div>
        </div>
        <div>
            <div style="font-weight:900;color:var(--text);">${botName}</div>
            <div id="previewActivity" style="font-size:0.8em;color:var(--text2);margin-top:3px;">${botActivity}</div>
            <div id="previewNote" style="font-size:0.72em;color:var(--text3);margin-top:3px;">${botNote || "ไม่มี note"}</div>
        </div>
    </div>
</div>

<div class="card">
    <h3>🟢 Bot Presence</h3>

    <label>สถานะบอท</label>
    <select id="botStatus" onchange="updatePresencePreview()">
        <option value="online" ${botStatus === "online" ? "selected" : ""}>🟢 Online</option>
        <option value="idle" ${botStatus === "idle" ? "selected" : ""}>🌙 Idle</option>
        <option value="dnd" ${botStatus === "dnd" ? "selected" : ""}>⛔ Do Not Disturb</option>
        <option value="invisible" ${botStatus === "invisible" ? "selected" : ""}>⚫ Invisible</option>
    </select>

    <label>ประเภทกิจกรรม</label>
    <select id="botActivityType">
        <option value="WATCHING" ${actType === "WATCHING" ? "selected" : ""}>👁️ กำลังดู</option>
        <option value="LISTENING" ${actType === "LISTENING" ? "selected" : ""}>🎧 กำลังฟัง</option>
        <option value="PLAYING" ${actType === "PLAYING" ? "selected" : ""}>🎮 กำลังเล่น</option>
        <option value="COMPETING" ${actType === "COMPETING" ? "selected" : ""}>🏆 กำลังแข่ง</option>
    </select>

    <label>ข้อความกิจกรรม</label>
    <input id="botActivity" value="${botActivity}" maxlength="128" oninput="updatePresencePreview()">

    <label>Note เพิ่มเติม</label>
    <input id="botNote" value="${botNote}" maxlength="128" oninput="updatePresencePreview()">

    <button class="btn btn-primary" onclick="savePresence()">💾 บันทึก Presence</button>
</div>

<div class="card">
    <h3>🔁 Auto-Rotate Presence</h3>

    <label>เปิด/ปิด Auto-Rotate</label>
    <select id="rotateEnabled">
        <option value="true" ${rotateEn ? "selected" : ""}>✅ เปิด</option>
        <option value="false" ${!rotateEn ? "selected" : ""}>❌ ปิด</option>
    </select>

    <label>สลับทุกกี่นาที</label>
    <input type="number" id="rotateInterval" value="${rotateInt}" min="1" max="1440">

    <label>ข้อความที่จะเอาไปหมุน</label>
    <div id="rotate-list">
        ${rotateMsgs.length ? rotateMsgs.map((m, i) => `
        <div class="ri" id="ri-${i}">
            <input value="${escapeHtml(m)}" maxlength="128">
            <button class="btn btn-danger btn-sm" onclick="removeRotate(${i})">ลบ</button>
        </div>`).join("") : `<div class="ri-empty" id="ri-empty">ยังไม่มีข้อความ</div>`}
    </div>

    <button class="btn btn-info" onclick="addRotate()">➕ เพิ่มข้อความ</button>
    <button class="btn btn-primary" onclick="saveRotate()">💾 บันทึก Auto-Rotate</button>
</div>

<div class="card">
    <h3>🎭 Natural Blink</h3>

    <div class="status-bar" style="margin-bottom:12px;">
        <div class="dot" id="natDot"></div>
        <span id="natTxt" style="font-weight:700;">กำลังโหลด...</span>
        <span id="natBadge" style="color:var(--text3);font-size:0.78em;margin-left:auto;">-- sessions</span>
    </div>

    <label>เปิด/ปิด Natural Blink</label>
    <select id="naturalEnabled">
        <option value="true">✅ เปิด</option>
        <option value="false">❌ ปิด</option>
    </select>

    <label>Interval หน่วย ms เช่น 3600000 = 1 ชั่วโมง</label>
    <input type="number" id="naturalInterval" min="60000" step="1000">

    <label>Duration หน่วย ms เช่น 30000 = 30 วินาที</label>
    <input type="number" id="naturalDuration" min="5000" max="120000" step="1000">

    <div id="natMsg" class="msg-toast"></div>
    <button class="btn btn-primary" onclick="saveNatural()">💾 บันทึก Natural Blink</button>
</div>

<div class="card">
    <h3>🔇 Auto Deaf</h3>

    <div class="status-bar" style="margin-bottom:12px;">
        <div class="dot" id="adDot"></div>
        <span id="adTxt" style="font-weight:700;">กำลังโหลด...</span>
        <span id="adBadge" style="color:var(--text3);font-size:0.78em;margin-left:auto;">-- sessions</span>
    </div>

    <label>เปิด/ปิด Auto Deaf</label>
    <select id="autoDeafEnabled">
        <option value="true">✅ เปิด</option>
        <option value="false">❌ ปิด</option>
    </select>

    <label>Interval หน่วย ms เช่น 3600000 = 1 ชั่วโมง</label>
    <input type="number" id="autoDeafInterval" min="60000" step="1000">

    <label>เปิดหูนานเท่าไร หน่วย ms เช่น 60000 = 1 นาที</label>
    <input type="number" id="autoDeafOpenDuration" min="5000" max="600000" step="1000">

    <div id="adMsg" class="msg-toast"></div>
    <button class="btn btn-primary" onclick="saveAutoDeaf()">💾 บันทึก Auto Deaf</button>
</div>
</div>

<script>
const SECRET=${JSON.stringify(API_SECRET)};
let rotateCount=${rotateMsgs.length};

function showMsg(msg, ok){
    const el=document.getElementById('__msg');
    el.style.display='block';
    el.style.background=ok?'rgba(20,83,45,.28)':'rgba(127,29,29,.28)';
    el.style.border=ok?'1px solid rgba(34,197,94,.35)':'1px solid rgba(239,68,68,.35)';
    el.style.color=ok?'var(--green2)':'var(--red2)';
    el.textContent=msg;
    clearTimeout(el.__t);
    el.__t=setTimeout(()=>el.style.display='none',4500);
}

function updatePresencePreview(){
    const status=document.getElementById('botStatus').value;
    const activity=document.getElementById('botActivity').value.trim()||'ระบบออนช่องเสียง';
    const note=document.getElementById('botNote').value.trim();

    const colors={
        online:'#4ade80',
        idle:'#fbbf24',
        dnd:'#f87171',
        invisible:'transparent'
    };

    const dot=document.getElementById('previewDot');
    dot.style.background=colors[status]||colors.idle;
    document.getElementById('previewActivity').textContent=activity;
    document.getElementById('previewNote').textContent=note||'ไม่มี note';
}

async function saveSettings(){
    const maxSessions=parseInt(document.getElementById('maxSessions').value)||1;
    const rateLimitRequests=parseInt(document.getElementById('rateLimitRequests').value)||5;
    const idleTimeoutHrs=parseInt(document.getElementById('idleTimeoutHrs').value)||24;
    const antiRaidEnabled=document.getElementById('antiRaidEnabled').value==='true';

    try{
        const r=await fetch('/api/settings',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':SECRET
            },
            body:JSON.stringify({maxSessions,rateLimitRequests,idleTimeoutHrs,antiRaidEnabled})
        });

        const d=await r.json();
        showMsg(d.success?'✅ บันทึก General แล้ว':'❌ '+(d.error||'Unknown'),d.success);
    }catch(e){
        showMsg('❌ เชื่อมต่อไม่ได้',false);
    }
}

async function savePresence(){
    const botStatus=document.getElementById('botStatus').value;
    const botActivityType=document.getElementById('botActivityType').value;
    const botActivity=document.getElementById('botActivity').value.trim();
    const botNote=document.getElementById('botNote').value.trim();

    if(!botActivity){
        return showMsg('❌ กรุณากรอกข้อความกิจกรรม',false);
    }

    try{
        const r=await fetch('/api/presence',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':SECRET
            },
            body:JSON.stringify({botStatus,botActivityType,botActivity,botNote})
        });

        const d=await r.json();
        showMsg(d.success?'✅ บันทึก Presence แล้ว':'❌ '+(d.error||'Unknown'),d.success);
    }catch(e){
        showMsg('❌ เชื่อมต่อไม่ได้',false);
    }
}

function addRotate(){
    const list=document.getElementById('rotate-list');
    const empty=document.getElementById('ri-empty');
    if(empty) empty.remove();

    const idx=rotateCount++;
    const div=document.createElement('div');
    div.className='ri';
    div.id='ri-'+idx;
    div.innerHTML='<input maxlength="128" placeholder="ข้อความกิจกรรม..."><button class="btn btn-danger btn-sm" onclick="removeRotate('+idx+')">ลบ</button>';
    list.appendChild(div);
}

function removeRotate(idx){
    const el=document.getElementById('ri-'+idx);
    if(el) el.remove();

    if(!document.querySelectorAll('.ri').length){
        document.getElementById('rotate-list').innerHTML='<div class="ri-empty" id="ri-empty">ยังไม่มีข้อความ</div>';
    }
}

async function saveRotate(){
    const rotateEnabled=document.getElementById('rotateEnabled').value==='true';
    const rotateInterval=parseInt(document.getElementById('rotateInterval').value)||5;
    const msgs=[...document.querySelectorAll('.ri input')]
        .map(i=>i.value.trim())
        .filter(Boolean);

    if(rotateEnabled&&!msgs.length){
        return showMsg('❌ กรุณาเพิ่มข้อความอย่างน้อย 1 ข้อความ',false);
    }

    try{
        const r=await fetch('/api/presence/rotate',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':SECRET
            },
            body:JSON.stringify({rotateEnabled,rotateInterval,rotateMessages:msgs})
        });

        const d=await r.json();

        showMsg(
            d.success
                ? (rotateEnabled?'✅ Auto-Rotate เปิดแล้ว! สลับทุก '+rotateInterval+' นาที':'✅ ปิด Auto-Rotate แล้ว')
                : '❌ '+(d.error||'Unknown'),
            d.success
        );
    }catch(e){
        showMsg('❌ เชื่อมต่อไม่ได้',false);
    }
}

async function loadNatural(){
    try{
        const r=await fetch('/api/settings/natural');
        if(!r.ok) return;

        const d=await r.json();
        if(!d.success) return;

        const s=d.settings || {};

        document.getElementById('naturalEnabled').value=String(!!s.enabled);
        document.getElementById('naturalInterval').value=String(s.intervalMs || 3600000);
        document.getElementById('naturalDuration').value=String(s.durationMs || 30000);

        const dot=document.getElementById('natDot');
        const txt=document.getElementById('natTxt');
        const badge=document.getElementById('natBadge');

        if(s.enabled){
            dot.className='dot online';
            txt.textContent='🟢 Natural Blink เปิดอยู่';
            txt.style.color='var(--green2)';
        }else{
            dot.className='dot';
            dot.style.background='var(--text3)';
            dot.style.boxShadow='none';
            txt.textContent='⭕ ปิดอยู่';
            txt.style.color='var(--text3)';
        }

        badge.textContent=(s.activeTimers || 0)+' sessions';
    }catch(e){}
}

async function saveNatural(){
    const enabled=document.getElementById('naturalEnabled').value==='true';
    const intervalMs=parseInt(document.getElementById('naturalInterval').value)||3600000;
    const durationMs=parseInt(document.getElementById('naturalDuration').value)||30000;
    const msgEl=document.getElementById('natMsg');

    msgEl.style.display='block';
    msgEl.style.color='var(--text2)';
    msgEl.textContent='⏳ กำลังบันทึก...';

    try{
        const r=await fetch('/api/settings/natural',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':SECRET
            },
            body:JSON.stringify({enabled,intervalMs,durationMs})
        });

        const d=await r.json();

        if(d.success){
            msgEl.style.color='var(--green2)';
            msgEl.textContent=enabled
                ? '✅ เปิดแล้ว! Blink ทุก '+Math.round(intervalMs/60000)+' นาที ค้าง '+Math.round(durationMs/1000)+' วิ'
                : '✅ ปิด Natural Blink แล้ว';
            await loadNatural();
        }else{
            msgEl.style.color='var(--red2)';
            msgEl.textContent='❌ '+(d.error||'Unknown');
        }
    }catch(e){
        msgEl.style.color='var(--red2)';
        msgEl.textContent='❌ เชื่อมต่อไม่ได้';
    }
}

async function loadAutoDeaf(){
    try{
        const r=await fetch('/api/settings/auto-deaf');
        if(!r.ok) return;

        const d=await r.json();
        if(!d.success) return;

        const s=d.settings || {};

        document.getElementById('autoDeafEnabled').value=String(!!s.enabled);
        document.getElementById('autoDeafInterval').value=String(s.intervalMs || 3600000);
        document.getElementById('autoDeafOpenDuration').value=String(s.openDurationMs || 60000);

        const dot=document.getElementById('adDot');
        const txt=document.getElementById('adTxt');
        const badge=document.getElementById('adBadge');

        if(s.enabled){
            dot.className='dot online';
            txt.textContent='🟢 Auto Deaf เปิดอยู่';
            txt.style.color='var(--green2)';
        }else{
            dot.className='dot';
            dot.style.background='var(--text3)';
            dot.style.boxShadow='none';
            txt.textContent='⭕ ปิดอยู่';
            txt.style.color='var(--text3)';
        }

        badge.textContent=(s.activeTimers || 0)+' sessions';
    }catch(e){}
}

async function saveAutoDeaf(){
    const enabled=document.getElementById('autoDeafEnabled').value==='true';
    const intervalMs=parseInt(document.getElementById('autoDeafInterval').value)||3600000;
    const openDurationMs=parseInt(document.getElementById('autoDeafOpenDuration').value)||60000;
    const msgEl=document.getElementById('adMsg');

    msgEl.style.display='block';
    msgEl.style.color='var(--text2)';
    msgEl.textContent='⏳ กำลังบันทึก...';

    try{
        const r=await fetch('/api/settings/auto-deaf',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':SECRET
            },
            body:JSON.stringify({enabled,intervalMs,openDurationMs})
        });

        const d=await r.json();

        if(d.success){
            const intMin=Math.round(intervalMs/60000);
            const durText=openDurationMs>=60000
                ? Math.round(openDurationMs/60000)+' นาที'
                : Math.round(openDurationMs/1000)+' วิ';

            msgEl.style.color='var(--green2)';
            msgEl.textContent=enabled
                ? '✅ เปิดแล้ว! เปิดหูทุก '+intMin+' นาที ค้าง '+durText
                : '✅ ปิด Auto Deaf แล้ว';

            await loadAutoDeaf();
        }else{
            msgEl.style.color='var(--red2)';
            msgEl.textContent='❌ '+(d.error||'Unknown');
        }
    }catch(e){
        msgEl.style.color='var(--red2)';
        msgEl.textContent='❌ เชื่อมต่อไม่ได้';
    }
}

loadNatural();
loadAutoDeaf();
</script>`);
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  REGISTER ROUTES (เรียกจาก index.js)
// ════════════════════════════════════════════════════════════════════════════
function registerViewRoutes({
    app,
    sessionManager,
    voiceWorker,
    commands,
    webLogs,
    MAX_LOGS,
    client,
    API_SECRET,
    disabledCommands,
    commandAuditLog,
    config
}) {
    app.get("/", auth.requirePin, (req, res) => {
        res.send(pageHome(API_SECRET));
    });

    app.get("/status", auth.requirePin, (req, res) => {
        res.send(pageStatus());
    });

    app.get("/settings", auth.requirePin, async (req, res) => {
        const settings = await sessionManager.getAllSettings();
        res.send(pageSettings(settings, config, client, API_SECRET));
    });

    app.get("/commands", auth.requirePin, (req, res) => {
        res.send(pageCommands(commands, disabledCommands, commandAuditLog, API_SECRET));
    });

    app.get("/whitelist", auth.requirePin, async (req, res) => {
        const list = await sessionManager.getAllWhitelist();
        res.send(pageWhitelist(list, API_SECRET));
    });

    app.get("/approved", auth.requirePin, async (req, res) => {
        if (!client.isReady()) {
            return res.send(shell("Loading", `
<div class="container">
<h1 class="page-title">⏳ Loading</h1>
<p class="page-sub">บอทยังไม่พร้อม กรุณารอสักครู่</p>
${navBar("/approved")}
</div>`));
        }

        const approvedList = await sessionManager.ApprovedGuildModel.find({}).catch(() => []);
        res.send(pageApproved(approvedList, client, API_SECRET));
    });

    app.get("/logs", auth.requirePin, (req, res) => {
        res.send(pageLogs(webLogs, MAX_LOGS));
    });

    app.get("/logs/voice", auth.requirePin, (req, res) => {
        res.send(pageVoiceLogs(voiceWorker.getVoiceLogs()));
    });

    app.get("/docs", auth.requirePin, (req, res) => {
        res.send(pageDocs());
    });

    app.get("/session/:sessionId", auth.requirePin, (req, res) => {
        const safeId = escapeHtml(req.params.sessionId);

        // Inject API_SECRET into the detail page stop-session request
        // without exposing it anywhere except the already PIN-protected dashboard page.
        const html = pageSessionDetail(safeId).replace(
            "'Authorization':''",
            "'Authorization':" + JSON.stringify(API_SECRET)
        );

        res.send(html);
    });
}

module.exports = {
    registerViewRoutes,
    escapeHtml,
    BASE_CSS
};
