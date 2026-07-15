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
  --text3:     #9b83d2;
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
  overflow-x: hidden;
}

button, a, input, select, textarea {
  touch-action: manipulation;
}

button, a { -webkit-tap-highlight-color: transparent; }

:focus-visible {
  outline: 3px solid rgba(216,180,254,.88);
  outline-offset: 3px;
}

.skip-link {
  position: fixed;
  top: 10px;
  left: 10px;
  z-index: 100000;
  padding: 10px 14px;
  border-radius: 10px;
  color: #fff;
  background: var(--accent);
  transform: translateY(-160%);
  transition: transform .18s ease;
}
.skip-link:focus { transform: translateY(0); }

.ambient-layer {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
}
.ambient-layer span {
  position: absolute;
  width: min(42vw, 520px);
  aspect-ratio: 1;
  border-radius: 50%;
  opacity: .16;
  filter: blur(90px);
  background: var(--accent);
  animation: ambient-float 16s ease-in-out infinite alternate;
}
.ambient-layer span:first-child { top: -20%; left: -12%; }
.ambient-layer span:last-child {
  right: -15%;
  bottom: -25%;
  background: var(--blue2);
  animation-delay: -8s;
}
@keyframes ambient-float {
  to { transform: translate3d(7vw, 5vh, 0) scale(1.12); }
}

#main-content { animation: page-enter .34s cubic-bezier(.22,.8,.24,1) both; }
@keyframes page-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
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
  transition: border-color .2s, transform .2s, box-shadow .2s;
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
  gap: 8px;
  margin-bottom: 18px;
  flex-wrap: wrap;
  position: sticky;
  top: 8px;
  z-index: 80;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: rgba(7,5,15,.78);
  box-shadow: var(--shadow2);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}
.nav-group {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.nav-group + .nav-group {
  padding-left: 8px;
  border-left: 1px solid var(--border);
}
.nav-group-label {
  color: var(--text3);
  font-size: .62em;
  font-weight: 800;
  letter-spacing: .5px;
  text-transform: uppercase;
  white-space: nowrap;
}
.nav-group-links {
  display: flex;
  gap: 5px;
}
.nav a {
  background: var(--bg2);
  color: var(--text2);
  padding: 7px 14px;
  border-radius: 10px;
  text-decoration: none;
  font-size: 0.78em;
  border: 1px solid var(--border);
  transition: color .15s, background .15s, border-color .15s, transform .15s, box-shadow .15s;
  white-space: nowrap;
}
.nav a:hover  {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent2);
  box-shadow: 0 0 10px rgba(124,58,237,.4);
  transform: translateY(-1px);
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
.mini-grid {
  display: grid;
  gap: 8px;
}
.mini-stat {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  background: rgba(15,12,32,.48);
  min-width: 0;
}
.mini-stat span {
  display: block;
  color: var(--text3);
  font-size: .68em;
  text-transform: uppercase;
  letter-spacing: .4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mini-stat b {
  display: block;
  color: var(--text);
  font-size: 1.15em;
  margin-top: 4px;
  overflow-wrap: anywhere;
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
.sr-only {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0,0,0,0) !important;
  white-space: nowrap !important;
  border: 0 !important;
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
  transition: transform .18s, box-shadow .18s, background .18s, opacity .18s;
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
.btn[aria-busy="true"]::before {
  content: '';
  width: 14px;
  height: 14px;
  margin-right: 7px;
  display: inline-block;
  vertical-align: -2px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin .7s linear infinite;
}
.btn-sm {
  padding: 5px 12px;
  border-radius: 7px;
  font-size: 0.78em;
  width: auto;
  margin-top: 0;
}
.btn-inline { width: auto; margin-top: 0; }
.action-row {
  display: flex;
  align-items: stretch;
  gap: 10px;
  flex-wrap: wrap;
}
.action-row .btn { flex: 1 1 170px; margin-top: 0; }

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

.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.table-scroll table {
  min-width: 620px;
}

.session-item {
  background: rgba(15,11,30,.7);
  border-left: 3px solid var(--accent);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 9px;
  font-size: 0.82em;
  transition: all .15s;
}
.session-item:focus-within {
  border-left-color: var(--accent2);
  box-shadow: 0 0 0 2px rgba(168,85,247,.14);
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
  overflow-wrap: anywhere;
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
  cursor: pointer;
}
.session-chip:hover {
  border-color: var(--accent2);
  color: #fff;
}
.session-stop {
  background: rgba(127,29,29,.18);
  border-color: rgba(248,113,113,.28);
  color: var(--red2);
}
.session-stop:hover {
  border-color: var(--red2);
  color: #fff;
}
.session-chip:disabled {
  opacity: .6;
  cursor: wait;
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
  min-width: 0;
}
.token-full-wrap span {
  min-width: 0;
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
  display: block;
  opacity: 0;
  visibility: hidden;
  transform: translateY(10px) scale(.98);
  z-index: 99999;
  max-width: 300px;
  box-shadow: 0 8px 24px rgba(0,0,0,.4);
  transition: opacity .2s ease, transform .2s ease, visibility .2s;
  backdrop-filter: blur(12px);
}
.toast.show {
  opacity: 1;
  visibility: visible;
  transform: none;
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

.detail-grid {
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:12px;
  margin-bottom:14px;
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

@media(max-width:700px) {
  body {
    padding: 10px;
    font-size: 14px;
  }

  .container,
  .container-lg {
    width: 100%;
    max-width: none;
  }

  .card {
    padding: 14px;
    margin-bottom: 12px;
  }

  .page-title {
    font-size: 1.25em;
    line-height: 1.25;
  }

  .nav {
    gap: 8px;
    overflow-x: auto;
    flex-wrap: nowrap;
    top: 6px;
    padding: 7px;
    -webkit-overflow-scrolling: touch;
    scroll-snap-type: x proximity;
  }

  .nav-group {
    flex: 0 0 auto;
    align-items: flex-start;
    flex-direction: column;
    scroll-snap-align: start;
  }

  .nav-group + .nav-group {
    padding-left: 9px;
  }

  .nav-group-links {
    display: flex;
  }

  .nav a {
    flex: 0 0 auto;
    padding: 9px 12px;
    min-height: 40px;
  }

  .status-bar {
    align-items: flex-start;
    flex-wrap: wrap;
    padding: 11px 12px;
  }

  .session-item {
    padding: 13px;
    border-left-width: 0;
    border-top: 3px solid var(--accent);
    font-size: 0.9em;
    border-radius: 10px;
  }

  .session-head {
    align-items: flex-start;
    gap: 9px;
  }

  .session-avatar {
    width: 38px;
    height: 38px;
  }

  .session-account {
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
    line-height: 1.25;
  }

  .session-sub {
    font-size: 0.82em;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .session-actions {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .session-chip,
  .token-action {
    width: 100%;
    min-height: 42px;
    justify-content: center;
    border-radius: 10px;
    font-size: 0.86em;
  }

  .token-full-wrap {
    width: 100%;
    flex-direction: column;
    font-size: 0.74em;
  }

  .copy-btn {
    width: 100%;
    min-height: 36px;
  }

  .voice-box {
    min-width: calc(50% - 8px);
  }

  .detail-grid {
    grid-template-columns: 1fr;
  }

  #btnStop {
    width: 100% !important;
    padding: 12px 14px !important;
  }

  th,
  td {
    white-space: normal;
    min-width: 120px;
  }

  .table-scroll table {
    min-width: 560px;
  }
}

@media (hover:hover) and (pointer:fine) {
  .card:hover {
    transform: translateY(-2px);
    box-shadow: 0 12px 38px rgba(124,58,237,.2);
  }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: .01ms !important;
  }
}
`;

module.exports = {
    BASE_CSS
};
