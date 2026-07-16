"use strict";

const OWNER_VERIFICATION_CSS = `
.verify-shell { max-width: 1180px; margin: 0 auto; }
.verify-hero {
  display: grid;
  grid-template-columns: minmax(0,1.45fr) minmax(260px,.55fr);
  gap: 16px;
  align-items: stretch;
  margin-bottom: 16px;
}
.verify-hero-main,
.verify-hero-side,
.verify-panel {
  border: 1px solid var(--border);
  background: linear-gradient(145deg,rgba(28,20,54,.94),rgba(12,9,25,.9));
  box-shadow: var(--shadow);
  backdrop-filter: blur(14px);
}
.verify-hero-main { border-radius: 22px; padding: clamp(22px,4vw,42px); position: relative; overflow: hidden; }
.verify-hero-main::after {
  content: "";
  position: absolute;
  width: 260px;
  height: 260px;
  border-radius: 50%;
  right: -110px;
  top: -130px;
  background: radial-gradient(circle,rgba(168,85,247,.3),transparent 68%);
  pointer-events: none;
}
.verify-kicker { color: var(--accent3); font-size: .72rem; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }
.verify-title { font-size: clamp(1.75rem,4vw,3.1rem); line-height: 1.05; margin: 10px 0 12px; max-width: 760px; }
.verify-lead { color: var(--text3); max-width: 720px; }
.verify-hero-side { border-radius: 22px; padding: 22px; display: grid; align-content: center; gap: 12px; }
.verify-live { display: flex; gap: 10px; align-items: flex-start; }
.verify-live-dot { width: 11px; height: 11px; border-radius: 50%; background: var(--green2); box-shadow: 0 0 16px rgba(74,222,128,.7); margin-top: 5px; flex: 0 0 auto; }
.verify-live small { display:block; color:var(--text3); margin-top:3px; }
.verify-panel { border-radius: 20px; padding: clamp(16px,2.5vw,24px); margin-bottom: 16px; }
.verify-panel-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:18px; }
.verify-panel-head h2 { font-size:1.05rem; }
.verify-panel-head p { color:var(--text3); font-size:.82rem; margin-top:3px; }
.verify-toolbar { display:grid; grid-template-columns:minmax(220px,1fr) auto; gap:12px; align-items:end; }
.verify-count { color:var(--text3); font-size:.78rem; text-align:right; padding-bottom:11px; }
.verify-guild-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-top:16px; }
.verify-guild-card {
  min-height: 164px;
  border: 1px solid var(--border);
  border-radius: 17px;
  padding: 17px;
  color: var(--text);
  text-decoration: none;
  background: rgba(15,11,30,.82);
  display:flex;
  flex-direction:column;
  gap:12px;
  transition:transform .18s,border-color .18s,box-shadow .18s,background .18s;
}
.verify-guild-card:hover { transform:translateY(-3px); border-color:var(--border2); box-shadow:0 14px 34px rgba(124,58,237,.2); background:rgba(27,18,52,.92); }
.verify-guild-top { display:flex; gap:12px; align-items:center; }
.verify-guild-icon { width:48px; height:48px; border-radius:15px; display:grid; place-items:center; overflow:hidden; flex:0 0 auto; background:linear-gradient(135deg,var(--accent),var(--blue)); font-weight:950; }
.verify-guild-icon img { width:100%; height:100%; object-fit:cover; }
.verify-guild-name { font-weight:900; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.verify-guild-id { color:var(--text3); font-size:.7rem; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
.verify-guild-open { margin-top:auto; display:flex; justify-content:space-between; align-items:center; color:var(--accent3); font-size:.78rem; font-weight:800; }
.verify-loading,.loading-box,.empty {
  border:1px dashed var(--border2);
  border-radius:14px;
  color:var(--text3);
  padding:20px;
  text-align:center;
}
.spinner { width:22px; height:22px; margin:0 auto 9px; border:3px solid rgba(167,139,250,.2); border-top-color:var(--accent3); border-radius:50%; animation:verify-spin .8s linear infinite; }
@keyframes verify-spin { to { transform:rotate(360deg); } }
.hidden,[hidden] { display:none !important; }
.verify-workspace-head { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:16px; align-items:center; }
.verify-server { display:flex; gap:13px; min-width:0; align-items:center; }
.verify-server-icon { width:54px; height:54px; border-radius:17px; display:grid; place-items:center; overflow:hidden; flex:0 0 auto; background:linear-gradient(135deg,var(--accent),var(--blue)); font-weight:950; }
.verify-server-icon img { width:100%; height:100%; object-fit:cover; }
.verify-server h1 { font-size:clamp(1.2rem,3vw,1.75rem); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.verify-server p { color:var(--text3); font-size:.76rem; }
.verify-workspace-actions { display:flex; align-items:end; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.verify-workspace-actions label { margin:0; }
.guild-switcher { min-width:210px; margin:0; }
.verify-tabs {
  display:grid;
  grid-template-columns:repeat(5,minmax(0,1fr));
  gap:8px;
  margin:16px 0;
  padding:8px;
  border:1px solid var(--border);
  border-radius:17px;
  background:rgba(7,5,15,.72);
  position:sticky;
  top:92px;
  z-index:50;
  backdrop-filter:blur(16px);
}
.verify-tab { border:1px solid transparent; border-radius:12px; background:transparent; color:var(--text3); padding:11px 10px; font-weight:850; cursor:pointer; }
.verify-tab:hover { color:var(--text); background:rgba(124,58,237,.1); }
.verify-tab.active { color:#fff; border-color:rgba(216,180,254,.28); background:linear-gradient(135deg,rgba(124,58,237,.9),rgba(99,102,241,.82)); box-shadow:0 8px 20px rgba(76,29,149,.28); }
.verify-content { min-height:440px; }
.verify-grid { display:grid; gap:14px; }
.verify-grid.two { grid-template-columns:repeat(2,minmax(0,1fr)); }
.verify-grid.three { grid-template-columns:repeat(3,minmax(0,1fr)); }
.verify-grid.four { grid-template-columns:repeat(4,minmax(0,1fr)); }
.stat-card { border:1px solid var(--border); border-radius:16px; padding:16px; background:rgba(17,12,35,.72); }
.stat-card .num { font-size:1.75rem; line-height:1; font-weight:950; color:var(--accent3); }
.stat-card .label { margin-top:8px; font-weight:850; }
.stat-card .sub { margin-top:4px; color:var(--text3); font-size:.72rem; }
.section-title { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:14px; }
.section-title h2 { font-size:1rem; }
.section-title p { color:var(--text3); font-size:.77rem; margin-top:3px; }
.badge { display:inline-flex; align-items:center; border-radius:999px; padding:5px 9px; font-size:.66rem; font-weight:850; border:1px solid var(--border); white-space:nowrap; }
.badge-ok { color:var(--green2); background:rgba(34,197,94,.1); border-color:rgba(34,197,94,.25); }
.badge-failed,.badge-danger,.badge-blocked { color:var(--red2); background:rgba(239,68,68,.1); border-color:rgba(239,68,68,.25); }
.badge-warn { color:var(--yellow2); background:rgba(234,179,8,.1); border-color:rgba(234,179,8,.25); }
.badge-info,.badge-cyan { color:var(--blue2); background:rgba(99,102,241,.1); border-color:rgba(99,102,241,.25); }
.badge-muted { color:var(--text3); }
.kv { display:grid; gap:2px; }
.kv-row { display:grid; grid-template-columns:minmax(130px,.8fr) minmax(0,1.2fr); gap:12px; padding:10px 0; border-bottom:1px solid var(--border); }
.kv-key { color:var(--text3); font-size:.76rem; }
.kv-val { text-align:right; overflow-wrap:anywhere; }
.form-row { display:grid; gap:12px; }
.form-row-2 { grid-template-columns:repeat(2,minmax(0,1fr)); }
.form-row-3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
.field-hint { color:var(--text3); font-size:.7rem; margin-top:-6px; margin-bottom:10px; }
.toggle-row { display:flex; align-items:center; justify-content:space-between; gap:14px; border:1px solid var(--border); background:rgba(7,5,15,.36); border-radius:14px; padding:13px; margin-bottom:10px; }
.toggle-title { font-weight:850; }
.toggle-sub { color:var(--text3); font-size:.7rem; margin-top:2px; }
.slider { position:absolute; cursor:pointer; inset:0; background:#332c47; border-radius:999px; transition:.2s; }
.slider::before { content:""; position:absolute; width:18px; height:18px; left:3px; bottom:3px; border-radius:50%; background:#fff; transition:.2s; }
.toggle { position:relative; width:44px; height:24px; flex:0 0 auto; }
.toggle input { opacity:0; width:0; height:0; }
.toggle input:checked + .slider { background:linear-gradient(135deg,var(--accent),var(--blue)); }
.toggle input:checked + .slider::before { transform:translateX(20px); }
.resource-options { display:flex; flex-wrap:wrap; gap:7px; max-height:210px; overflow:auto; padding:4px; }
.resource-options .btn { width:auto; margin:0; }
.action-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
.action-grid .btn { margin:0; }
.btn-soft { background:rgba(15,11,30,.88); color:var(--text2); border:1px solid var(--border2); }
.btn-soft:hover { color:#fff; background:rgba(124,58,237,.2); }
.btn-security { background:linear-gradient(135deg,#312e81,var(--blue2)); color:#fff; }
.btn-block { width:100%; }
.alert,.notice { border-radius:13px; padding:12px 14px; font-size:.76rem; border:1px solid var(--border); margin-bottom:12px; }
.alert-info,.notice-info { color:#c7d2fe; background:rgba(99,102,241,.1); border-color:rgba(99,102,241,.25); }
.alert-warn,.notice-warn { color:#fde68a; background:rgba(234,179,8,.09); border-color:rgba(234,179,8,.25); }
.alert-danger { color:#fecaca; background:rgba(239,68,68,.09); border-color:rgba(239,68,68,.25); }
.list { display:grid; gap:8px; }
.list-item { border:1px solid var(--border); border-radius:13px; padding:12px; background:rgba(7,5,15,.32); overflow-wrap:anywhere; }
.list-title { display:flex; justify-content:space-between; align-items:center; gap:10px; font-weight:850; }
.list-meta { color:var(--text3); font-size:.72rem; margin-top:6px; display:grid; gap:4px; }
.list-meta span:first-child { color:var(--text2); }
.table-wrap { overflow:auto; border:1px solid var(--border); border-radius:14px; }
.table-wrap table { min-width:900px; margin:0; }
.table-wrap th { position:sticky; top:0; background:#110c22; z-index:1; }
.mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
.secret-value { color:#f5d0fe; word-break:break-all; user-select:all; }
.embed-preview { position:relative; min-height:170px; border-left:5px solid #5865f2; border-radius:5px 13px 13px 5px; padding:16px; background:#2b2d31; color:#dbdee1; overflow:hidden; }
.embed-preview-title { color:#fff; font-weight:850; margin-bottom:7px; }
.embed-preview-desc { white-space:pre-wrap; }
.embed-preview-img img { width:100%; max-height:260px; object-fit:cover; border-radius:8px; margin-top:12px; }
.embed-preview-thumb { float:right; width:74px; height:74px; margin-left:12px; }
.embed-preview-thumb img { width:100%; height:100%; object-fit:cover; border-radius:8px; }
.embed-preview-footer { color:#b5bac1; font-size:.7rem; margin-top:12px; }
.button-preview { display:inline-flex; margin-top:10px; border-radius:5px; padding:9px 13px; background:#5865f2; color:#fff; font-weight:750; }
.detail-list { display:grid; gap:6px; }
.raw-snapshot { max-height:360px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:var(--text3); font-size:.7rem; }
details { border-top:1px solid var(--border); margin-top:9px; padding-top:9px; }
summary { cursor:pointer; color:var(--accent3); font-weight:750; }
.modal-backdrop { position:fixed; inset:0; z-index:1000; display:none; place-items:center; padding:16px; background:rgba(2,1,8,.82); backdrop-filter:blur(9px); }
.modal-backdrop.show { display:grid; }
.modal-backdrop .modal { display:block; position:relative; width:min(1040px,100%); max-height:92vh; overflow:auto; border:1px solid var(--border2); border-radius:20px; padding:20px; background:#0d091a; box-shadow:0 24px 80px rgba(0,0,0,.55); }
.modal-head { display:flex; align-items:center; justify-content:space-between; gap:12px; position:sticky; top:-20px; z-index:4; margin:-20px -20px 16px; padding:16px 20px; background:rgba(13,9,26,.96); border-bottom:1px solid var(--border); }
.modal-title { font-size:1.15rem; }
.modal-actions { display:flex; justify-content:flex-end; margin-top:14px; }
.modal-close { position:static; width:36px; height:36px; display:grid; place-items:center; border:1px solid var(--border); border-radius:10px; background:var(--bg2); color:var(--text2); cursor:pointer; }
.no-scroll { overflow:hidden; }
.flex { display:flex; }.flex-wrap { flex-wrap:wrap; }.items-center { align-items:center; }.justify-between { justify-content:space-between; }
.gap-8 { gap:8px; }.gap-10 { gap:10px; }.mt-8 { margin-top:8px; }.mt-10 { margin-top:10px; }.mt-14 { margin-top:14px; }.mt-16 { margin-top:16px; }.mt-18 { margin-top:18px; }.mb-0 { margin-bottom:0; }.mb-12 { margin-bottom:12px; }
.muted,.muted-2 { color:var(--text3); }.small { font-size:.76rem; }.xsmall { font-size:.68rem; }.truncate { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.data-stack { display:grid; gap:14px; }
.data-heading { display:flex; gap:10px; align-items:center; margin-bottom:12px; }
.data-index { width:28px; height:28px; border-radius:9px; display:grid; place-items:center; background:rgba(124,58,237,.17); color:var(--accent3); font-weight:900; }
@media(max-width:900px) {
  .verify-hero,.verify-workspace-head { grid-template-columns:1fr; }
  .verify-guild-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .verify-grid.four { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .verify-tabs { top:86px; overflow-x:auto; display:flex; }
  .verify-tab { min-width:150px; }
  .verify-workspace-actions { justify-content:flex-start; }
}
@media(max-width:620px) {
  .verify-guild-grid,.verify-grid.two,.verify-grid.three,.verify-grid.four,.form-row-2,.form-row-3,.action-grid { grid-template-columns:1fr; }
  .verify-toolbar { grid-template-columns:1fr; }
  .verify-count { text-align:left; padding:0; }
  .verify-panel { padding:14px; border-radius:16px; }
  .guild-switcher { width:100%; min-width:0; }
  .verify-workspace-actions { display:grid; grid-template-columns:1fr 1fr; }
  .verify-workspace-actions label,.verify-workspace-actions select { grid-column:1/-1; }
  .kv-row { grid-template-columns:1fr; gap:3px; }
  .kv-val { text-align:left; }
}
@media(prefers-reduced-motion:reduce) { .spinner { animation:none; } }
`;

module.exports = { OWNER_VERIFICATION_CSS };
