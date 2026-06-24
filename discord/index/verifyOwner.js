const auth = require('./auth');

function getInternalSecret(API_SECRET) {
    return process.env.INTERNAL_API_SECRET || API_SECRET || process.env.API_SECRET || '';
}

function getDashboardUrl() {
    return String(
        process.env.PUBLIC_DASHBOARD_URL ||
        process.env.DASHBOARD_URL ||
        ''
    ).replace(/\/$/, '');
}

async function callDashboardInternal(path, options = {}, API_SECRET) {
    const base = getDashboardUrl();
    const internalSecret = getInternalSecret(API_SECRET);
    const headers = options.headers ?? {};

    if (!base) {
        throw new Error('PUBLIC_DASHBOARD_URL/DASHBOARD_URL is not configured on Service 1');
    }

    if (!internalSecret) {
        throw new Error('INTERNAL_API_SECRET/API_SECRET is not configured');
    }

    const res = await fetch(`${base}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': internalSecret,
            ...headers
        }
    });

    const text = await res.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        data = {
            success: false,
            error: text || `HTTP ${res.status}`
        };
    }

    if (!res.ok) {
        throw new Error(data.error || `Dashboard internal API failed: ${res.status}`);
    }

    return data;
}

function sameHost(req, dashboardUrl) {
    try {
        const target = new URL(dashboardUrl);
        return String(req.headers.host || '').toLowerCase() === target.host.toLowerCase();
    } catch {
        return false;
    }
}

function pageVerifyOwner() {
    return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Owner Verification Dashboard</title>
<style>
:root{
  --card:rgba(20,15,40,.86);
  --border:rgba(120,80,255,.2);
  --border2:rgba(168,85,247,.36);
  --text:#ede9fe;
  --muted:#a78bfa;
  --muted2:#7c3aed88;
  --accent:#7c3aed;
  --green:#4ade80;
  --red:#f87171;
  --yellow:#fbbf24;
  --blue:#818cf8;
  --bg:#07050f;
  --bg2:#0f0b1e;
}

*{
  box-sizing:border-box;
  margin:0;
  padding:0;
}

body{
  background:radial-gradient(circle at 20% 20%,rgba(124,58,237,.16),transparent 45%),#07050f;
  color:var(--text);
  font-family:'Segoe UI','Noto Sans Thai',system-ui,sans-serif;
  min-height:100vh;
  padding:18px;
}

.container{
  max-width:1180px;
  margin:auto;
}

.nav{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  margin-bottom:18px;
}

.nav a,
.tab-btn{
  background:#0f0b1e;
  color:#a78bfa;
  text-decoration:none;
  border:1px solid var(--border);
  padding:8px 14px;
  border-radius:10px;
  font-size:.82rem;
  cursor:pointer;
  font-weight:800;
}

.nav a:hover,
.tab-btn:hover,
.tab-btn.active{
  background:var(--accent);
  color:white;
}

.title{
  text-align:center;
  font-size:1.65rem;
  font-weight:900;
  background:linear-gradient(135deg,#a855f7,#d8b4fe,#818cf8);
  -webkit-background-clip:text;
  -webkit-text-fill-color:transparent;
}

.sub{
  text-align:center;
  color:var(--muted2);
  font-size:.82rem;
  margin:6px 0 20px;
}

.grid{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:10px;
  margin-bottom:16px;
}

@media(max-width:880px){
  .grid{
    grid-template-columns:repeat(2,1fr);
  }
}

.stat,
.card{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:16px;
  box-shadow:0 8px 32px rgba(124,58,237,.12);
  backdrop-filter:blur(12px);
}

.stat{
  padding:14px;
  text-align:center;
}

.val{
  font-size:1.45rem;
  font-weight:900;
  line-height:1.1;
}

.lbl{
  font-size:.68rem;
  color:var(--muted2);
  margin-top:4px;
  text-transform:uppercase;
  letter-spacing:.4px;
}

.card{
  padding:0;
  overflow:hidden;
  margin-bottom:16px;
}

.card-head{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px;
  padding:12px 14px;
  border-bottom:1px solid var(--border);
  flex-wrap:wrap;
}

.card-title{
  font-size:.82rem;
  color:var(--muted);
  font-weight:900;
  text-transform:uppercase;
  letter-spacing:.6px;
}

table{
  width:100%;
  border-collapse:collapse;
  min-width:980px;
}

th{
  color:var(--muted2);
  font-size:.72rem;
  text-transform:uppercase;
  text-align:left;
  padding:11px;
  border-bottom:1px solid var(--border);
}

td{
  padding:11px;
  border-bottom:1px solid rgba(120,80,255,.08);
  font-size:.84rem;
  vertical-align:top;
}

tbody tr:hover td{
  background:rgba(124,58,237,.05);
}

.scroll{
  overflow:auto;
}

.mono{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  word-break:break-all;
}

.small{
  font-size:.72rem;
  color:var(--muted2);
  margin-top:3px;
}

.badge{
  display:inline-block;
  border-radius:999px;
  padding:2px 9px;
  font-size:.7rem;
  font-weight:900;
  border:1px solid transparent;
  margin:2px 2px 2px 0;
}

.pending{
  background:rgba(251,191,36,.12);
  border-color:rgba(251,191,36,.35);
  color:var(--yellow);
}

.enabled{
  background:rgba(74,222,128,.1);
  border-color:rgba(74,222,128,.32);
  color:var(--green);
}

.disabled{
  background:rgba(248,113,113,.1);
  border-color:rgba(248,113,113,.32);
  color:var(--red);
}

.info{
  background:rgba(129,140,248,.1);
  border-color:rgba(129,140,248,.32);
  color:var(--blue);
}

.warn{
  background:rgba(251,191,36,.1);
  border-color:rgba(251,191,36,.32);
  color:var(--yellow);
}

.btn{
  border:0;
  border-radius:9px;
  padding:7px 12px;
  font-weight:900;
  cursor:pointer;
  font-size:.78rem;
  margin:2px;
}

.ok{
  background:linear-gradient(135deg,#166534,#4ade80);
  color:#02130a;
}

.bad{
  background:linear-gradient(135deg,#7f1d1d,#f87171);
  color:white;
}

.soft{
  background:#0f0b1e;
  color:#a78bfa;
  border:1px solid var(--border);
}

.ipbox,
.detailbox{
  margin-top:6px;
  padding:7px 9px;
  background:rgba(5,3,18,.8);
  border:1px solid rgba(74,222,128,.25);
  border-radius:8px;
  color:var(--green);
  display:none;
}

.detailbox{
  display:block;
  color:var(--text);
  border-color:var(--border);
  max-height:260px;
  overflow:auto;
  white-space:pre-wrap;
}

.toast{
  position:fixed;
  right:18px;
  bottom:18px;
  padding:12px 18px;
  border-radius:12px;
  display:none;
  z-index:9;
}

.toast.ok{
  background:rgba(20,83,45,.92);
  color:var(--green);
  border:1px solid rgba(74,222,128,.35);
}

.toast.err{
  background:rgba(127,29,29,.92);
  color:var(--red);
  border:1px solid rgba(248,113,113,.35);
}

.empty{
  text-align:center;
  color:var(--muted2);
  padding:28px!important;
}

.tabs{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  margin-bottom:14px;
}

.hidden{
  display:none;
}
</style>
</head>
<body>
<div class="container">
  <div class="nav">
    <a href="/">← Home</a>
    <a href="/status">Status</a>
    <a href="/settings">Settings</a>
    <a href="/auth/logout">Logout</a>
  </div>

  <h1 class="title">🔐 Owner Verification Dashboard</h1>
  <div class="sub">ดูภาพรวมระบบยืนยัน / Panel Revision / อนุมัติสิทธิ์ดูข้อมูลอ่อนไหว — เฉพาะเจ้าของบอท</div>

  <div class="grid">
    <div class="stat"><div class="val" id="sGuilds">—</div><div class="lbl">Guilds</div></div>
    <div class="stat"><div class="val" id="sEnabled">—</div><div class="lbl">Enabled</div></div>
    <div class="stat"><div class="val" id="sVerify">—</div><div class="lbl">Verify Logs</div></div>
    <div class="stat"><div class="val" id="sPending">—</div><div class="lbl">IP Pending</div></div>
    <div class="stat"><div class="val" id="sDash">${getDashboardUrl() ? 'OK' : 'NO'}</div><div class="lbl">Dashboard URL</div></div>
  </div>

  <div class="tabs">
    <button class="tab-btn active" id="tabOverview" onclick="showTab('overview')">Overview</button>
    <button class="tab-btn" id="tabReveal" onclick="showTab('reveal')">IP Reveal</button>
    <button class="tab-btn soft" onclick="loadAll()">↻ Refresh All</button>
  </div>

  <section id="viewOverview">
    <div class="card">
      <div class="card-head">
        <div class="card-title">🧩 Verification Overview / Panel Revision</div>
        <div class="small">ใช้เช็กว่าแผงล่าสุดคือ revision ไหน และระบบแต่ละเซิร์ฟอยู่สถานะอะไร</div>
      </div>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Guild</th>
              <th>Status</th>
              <th>Panel Revision</th>
              <th>Panel Target</th>
              <th>Stats</th>
              <th>Sensitive Access</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="overviewBody">
            <tr><td colspan="7" class="empty">กำลังโหลด...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <section id="viewReveal" class="hidden">
    <div class="card">
      <div class="card-head">
        <div class="card-title">🕵️ Owner IP Reveal Approval</div>
        <div class="small">อนุมัติ/ปฏิเสธคำขอดู IP จริงจาก Dashboard 3</div>
      </div>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Guild / User</th>
              <th>Reason</th>
              <th>Requested By</th>
              <th>Created</th>
              <th>Action</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody id="revealBody">
            <tr><td colspan="6" class="empty">กำลังโหลด...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</div>

<div class="toast" id="toast"></div>

<script>
let overviewRows = [];
let revealRows = [];
let activeTab = 'overview';

function esc(v){
  return String(v ?? '').replace(/[&<>"']/g, function(m){
    return {
      '&':'&amp;',
      '<':'&lt;',
      '>':'&gt;',
      '"':'&quot;',
      "'":'&#39;'
    }[m];
  });
}

function escJsString(v){
  return esc(String(v ?? '')
    .replace(/\\/g,'\\\\')
    .replace(/'/g,"\\'")
    .replace(/\r/g,'\\r')
    .replace(/\n/g,'\\n')
    .replace(/\u2028/g,'\\u2028')
    .replace(/\u2029/g,'\\u2029'));
}

function fmt(ts){
  return ts ? new Date(ts).toLocaleString('th-TH',{hour12:false}) : '—';
}

function short(v,n){
  const s=String(v || '');
  if(!s) return '—';
  return s.length>n ? s.slice(0,n)+'…' : s;
}

function toast(msg,type){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.className='toast '+(type || 'ok');
  t.style.display='block';
  clearTimeout(t._t);
  t._t=setTimeout(function(){
    t.style.display='none';
  },3500);
}

async function api(path, body){
  const opt={headers:{}};

  if(body !== undefined){
    opt.method='POST';
    opt.headers['Content-Type']='application/json';
    opt.headers['x-csrf-token']=readCookie('__da_csrf');
    opt.body=JSON.stringify(body);
  }

  const r=await fetch(path,opt);
  const d=await r.json().catch(function(){
    return {
      success:false,
      error:'Invalid JSON'
    };
  });

  if(!r.ok || d.success === false){
    throw new Error(d.error || 'Request failed');
  }

  return d;
}

function readCookie(name){
  const parts=document.cookie ? document.cookie.split(';') : [];
  for(const part of parts){
    const idx=part.indexOf('=');
    if(idx<0) continue;
    let key='';
    try{
      key=decodeURIComponent(part.slice(0,idx).trim());
    }catch(e){
      continue;
    }
    if(key===name){
      try{
        return decodeURIComponent(part.slice(idx+1).trim());
      }catch(e){
        return '';
      }
    }
  }
  return '';
}

function showTab(name){
  activeTab=name;

  document.getElementById('viewOverview').classList.toggle('hidden',name!=='overview');
  document.getElementById('viewReveal').classList.toggle('hidden',name!=='reveal');

  document.getElementById('tabOverview').classList.toggle('active',name==='overview');
  document.getElementById('tabReveal').classList.toggle('active',name==='reveal');
}

function renderStats(){
  const enabled = overviewRows.filter(function(g){
    return g.verification && g.verification.enabled !== false;
  }).length;

  const totalLogs = overviewRows.reduce(function(sum,g){
    return sum + Number(g.stats && g.stats.total || 0);
  },0);

  document.getElementById('sGuilds').textContent=overviewRows.length;
  document.getElementById('sEnabled').textContent=enabled;
  document.getElementById('sVerify').textContent=totalLogs;
  document.getElementById('sPending').textContent=revealRows.length;
}

function renderOverview(){
  const b=document.getElementById('overviewBody');

  if(!overviewRows.length){
    b.innerHTML='<tr><td colspan="7" class="empty">ไม่พบข้อมูล guild จาก internal overview</td></tr>';
    return;
  }

  b.innerHTML=overviewRows.map(function(g){
    const v=g.verification || {};
    const p=v.panel || {};
    const s=g.stats || {};
    const enabled=v.enabled !== false;
    const rev=v.panelRevision || 'ยังไม่มี revision';
    const revClass=v.panelRevision ? 'info' : 'warn';
    const access=(g.security && g.security.sensitiveDataAccess) || {};
    const accessExpired=access.expiresAt && access.expiresAt <= Date.now();
    const accessOn=access.enabled === true && !accessExpired;
    const accessText=accessOn
      ? 'approved '+fmt(access.approvedAt)+' / expires '+fmt(access.expiresAt)
      : (accessExpired ? 'expired '+fmt(access.expiresAt) : (access.revokedAt ? 'revoked '+fmt(access.revokedAt) : 'not approved'));
    const accessAudit=access.accessedAt
      ? 'last access '+fmt(access.accessedAt)+' by '+(access.accessedBy || '—')
      : '';

    return '<tr>'+
      '<td>'+
        '<b>'+esc(g.guildName || 'Unknown')+'</b>'+
        '<div class="mono small">'+esc(g.guildId)+'</div>'+
      '</td>'+
      '<td>'+
        '<span class="badge '+(enabled?'enabled':'disabled')+'">'+(enabled?'enabled':'disabled')+'</span>'+
        '<span class="badge info">'+esc(v.verifyType || v.oauthMode || p.verifyType || 'oauth')+'</span>'+
      '</td>'+
      '<td>'+
        '<span class="badge '+revClass+' mono" title="'+esc(rev)+'">'+esc(short(rev,28))+'</span>'+
        '<div class="small">updated: '+fmt(v.panelRevisionUpdatedAt || v.updatedAt || g.updatedAt)+'</div>'+
      '</td>'+
      '<td>'+
        '<div class="mono small">Role: '+esc(v.roleId || '—')+'</div>'+
        '<div class="mono small">Channel: '+esc(v.channelId || '—')+'</div>'+
        '<div class="mono small">Message: '+esc(v.messageId || '—')+'</div>'+
      '</td>'+
      '<td>'+
        '<span class="badge info">Total '+esc(s.total || 0)+'</span>'+
        '<span class="badge enabled">OK '+esc(s.success || 0)+'</span>'+
        '<span class="badge disabled">Blocked '+esc(s.blocked || 0)+'</span>'+
        '<span class="badge warn">Risk '+esc(s.highRisk || 0)+'</span>'+
        '<span class="badge warn">Old Panel '+esc(s.panelRevisionMismatch || 0)+'</span>'+
      '</td>'+
      '<td>'+
        '<span class="badge '+(accessOn?'enabled':'disabled')+'">'+(accessOn?'allowed':'blocked')+'</span>'+
        '<div class="small">'+esc(accessText)+'</div>'+
        '<div class="small">'+esc(accessAudit)+'</div>'+
        '<div class="small">'+esc(access.ownerNote || '')+'</div>'+
        '<button class="btn ok" onclick="approveSensitive(\\''+escJsString(g.guildId)+'\\',\\''+escJsString(g.guildName || '')+'\\')">Allow</button>'+
        '<button class="btn bad" onclick="revokeSensitive(\\''+escJsString(g.guildId)+'\\')">Revoke</button>'+
      '</td>'+
      '<td>'+
        '<button class="btn soft" onclick="loadGuildDetail(\\''+escJsString(g.guildId)+'\\')">Details</button>'+
        '<div class="detailbox" id="detail-'+esc(g.guildId)+'" style="display:none"></div>'+
      '</td>'+
    '</tr>';
  }).join('');
}

function renderReveal(){
  const b=document.getElementById('revealBody');

  if(!revealRows.length){
    b.innerHTML='<tr><td colspan="6" class="empty">ไม่มีคำขอ pending</td></tr>';
    return;
  }

  b.innerHTML=revealRows.map(function(r){
    const requestId = r.id || r._id;

    return '<tr>'+
      '<td>'+
        '<div class="mono">Guild: '+esc(r.guildId)+'</div>'+
        '<div class="small">'+esc(r.guildName || '')+'</div>'+
        '<div class="mono">User: '+esc(r.targetUserId)+'</div>'+
        '<span class="badge pending">'+esc(r.status)+'</span>'+
      '</td>'+
      '<td>'+esc(r.reason || '—')+'</td>'+
      '<td class="mono">'+esc(r.requestedBy)+'</td>'+
      '<td>'+fmt(r.createdAt)+'</td>'+
      '<td>'+
        '<button class="btn ok" onclick="approve(\\''+esc(requestId)+'\\')">Approve</button>'+
        '<button class="btn bad" onclick="rejectReq(\\''+esc(requestId)+'\\')">Reject</button>'+
      '</td>'+
      '<td>'+
        '<div class="ipbox" id="ip-'+esc(requestId)+'"></div>'+
      '</td>'+
    '</tr>';
  }).join('');
}

async function loadOverview(){
  const d=await api('/api/verify-owner/overview');
  overviewRows=d.guilds || [];
  renderOverview();
  renderStats();
}

async function loadReveal(){
  const d=await api('/api/verify-owner/ip-reveal/requests');
  revealRows=d.requests || [];
  renderReveal();
  renderStats();
}

async function loadAll(){
  try{
    await Promise.all([loadOverview(),loadReveal()]);
    toast('โหลดข้อมูลแล้ว','ok');
  }catch(e){
    toast(e.message,'err');

    if(!overviewRows.length){
      document.getElementById('overviewBody').innerHTML='<tr><td colspan="6" class="empty">'+esc(e.message)+'</td></tr>';
    }

    if(!revealRows.length){
      document.getElementById('revealBody').innerHTML='<tr><td colspan="6" class="empty">'+esc(e.message)+'</td></tr>';
    }
  }
}

async function loadGuildDetail(guildId){
  const box=document.getElementById('detail-'+guildId);
  if(!box) return;

  if(box.style.display==='block'){
    box.style.display='none';
    return;
  }

  box.style.display='block';
  box.textContent='กำลังโหลด details...';

  try{
    const d=await api('/api/verify-owner/guild/'+encodeURIComponent(guildId)+'/stats');

    const recent=(d.recent || []).map(function(x){
      return '['+fmt(x.verifiedAt || x.createdAt)+'] '+
        (x.result || '-')+
        ' / '+(x.reason || '-')+
        ' / user '+(x.userId || '-')+
        ' / request '+(x.requestId || '-')+
        ' / stateRev '+(x.statePanelRevision || '-')+
        ' / latestRev '+(x.latestPanelRevision || '-');
    }).join('\\n');

    const panelRevision =
      d.config &&
      d.config.verification &&
      d.config.verification.panelRevision
        ? d.config.verification.panelRevision
        : '—';

    box.textContent =
      'Stats:\\n'+JSON.stringify(d.stats || {},null,2)+
      '\\n\\nConfig Panel Revision:\\n'+panelRevision+
      '\\n\\nRecent logs:\\n'+(recent || '—');
  }catch(e){
    box.textContent=e.message;
  }
}

async function approveSensitive(guildId,guildName){
  const note=prompt('เหตุผล/หมายเหตุการอนุญาตให้ guild admin เห็น raw IP, email, connections, mutual guilds','approved by owner dashboard');
  if(note===null) return;

  try{
    await api('/api/verify-owner/guild/'+encodeURIComponent(guildId)+'/sensitive-access/approve',{
      ownerNote:note,
      guildName:guildName || ''
    });
    toast('อนุญาต sensitive data access แล้ว','ok');
    await loadOverview();
  }catch(e){
    toast(e.message,'err');
  }
}

async function revokeSensitive(guildId){
  const note=prompt('เหตุผล/หมายเหตุการยกเลิกสิทธิ์','revoked by owner dashboard');
  if(note===null) return;

  try{
    await api('/api/verify-owner/guild/'+encodeURIComponent(guildId)+'/sensitive-access/revoke',{
      ownerNote:note
    });
    toast('ยกเลิก sensitive data access แล้ว','ok');
    await loadOverview();
  }catch(e){
    toast(e.message,'err');
  }
}

async function approve(id){
  const note=prompt('Owner note (optional)','approved by owner dashboard');
  if(note===null) return;

  try{
    const d=await api('/api/verify-owner/ip-reveal/'+id+'/approve',{
      ownerNote:note
    });

    const box=document.getElementById('ip-'+id);

    if(box){
      box.style.display='block';
      box.innerHTML=
        '<b>Raw IP:</b> <span class="mono">'+esc(d.rawIp || 'null')+'</span><br>'+
        '<small>'+
          esc((d.ipInfo && d.ipInfo.country) || '')+' '+
          esc((d.ipInfo && d.ipInfo.city) || '')+' / '+
          esc((d.ipInfo && d.ipInfo.isp) || '')+
        '</small>';
    }

    toast('อนุมัติแล้ว แสดง IP เฉพาะหน้านี้','ok');

    revealRows=revealRows.filter(function(x){
      return String(x.id || x._id) !== String(id);
    });

    setTimeout(loadReveal,1500);
  }catch(e){
    toast(e.message,'err');
  }
}

async function rejectReq(id){
  const note=prompt('เหตุผลที่ปฏิเสธ','rejected by owner');
  if(note===null) return;

  try{
    await api('/api/verify-owner/ip-reveal/'+id+'/reject',{
      ownerNote:note
    });

    toast('ปฏิเสธแล้ว','ok');

    revealRows=revealRows.filter(function(x){
      return String(x.id || x._id) !== String(id);
    });

    renderReveal();
    renderStats();
  }catch(e){
    toast(e.message,'err');
  }
}

showTab('overview');
loadAll();
setInterval(loadAll,30000);
</script>
</body>
</html>`;
}

function registerVerifyOwnerRoutes({ app, express, API_SECRET }) {
    app.get('/verify', (req, res) => {
        const dashboardUrl = getDashboardUrl();

        if (!dashboardUrl) {
            return res.status(503).send('PUBLIC_DASHBOARD_URL/DASHBOARD_URL is not configured on Service 1');
        }

        if (sameHost(req, dashboardUrl)) {
            return res.status(500).send('PUBLIC_DASHBOARD_URL points to this same service. Fix it to Dashboard 3 / Service 2 URL.');
        }

        const query = req.originalUrl.startsWith('/verify')
            ? req.originalUrl.slice('/verify'.length)
            : '';

        return res.redirect(302, `${dashboardUrl}/verify${query}`);
    });

    app.get('/verify-owner', auth.requirePin, (req, res) => {
        res.send(pageVerifyOwner());
    });

    app.get('/api/verify-owner/overview', auth.requirePin, async (req, res) => {
        try {
            const data = await callDashboardInternal('/internal/overview?enabled=all', {}, API_SECRET);

            res.json(data);
        } catch (err) {
            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    });

    app.get('/api/verify-owner/guild/:guildId/stats', auth.requirePin, async (req, res) => {
        try {
            const data = await callDashboardInternal(
                `/internal/guild/${encodeURIComponent(req.params.guildId)}/stats`,
                {},
                API_SECRET
            );

            res.json(data);
        } catch (err) {
            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    });

    app.post('/api/verify-owner/guild/:guildId/sensitive-access/approve', auth.requirePin, auth.requireCsrf, express.json(), async (req, res) => {
        try {
            const data = await callDashboardInternal(
                `/internal/guild/${encodeURIComponent(req.params.guildId)}/sensitive-access/approve`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        approvedBy: 'owner-dashboard',
                        ownerNote: req.body?.ownerNote || '',
                        guildName: req.body?.guildName || ''
                    })
                },
                API_SECRET
            );

            res.json(data);
        } catch (err) {
            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    });

    app.post('/api/verify-owner/guild/:guildId/sensitive-access/revoke', auth.requirePin, auth.requireCsrf, express.json(), async (req, res) => {
        try {
            const data = await callDashboardInternal(
                `/internal/guild/${encodeURIComponent(req.params.guildId)}/sensitive-access/revoke`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        revokedBy: 'owner-dashboard',
                        ownerNote: req.body?.ownerNote || ''
                    })
                },
                API_SECRET
            );

            res.json(data);
        } catch (err) {
            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    });

    app.get('/api/verify-owner/ip-reveal/requests', auth.requirePin, async (req, res) => {
        try {
            const data = await callDashboardInternal('/internal/ip-reveal/requests', {}, API_SECRET);

            res.json(data);
        } catch (err) {
            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    });

    app.post('/api/verify-owner/ip-reveal/:requestId/approve', auth.requirePin, auth.requireCsrf, express.json(), async (req, res) => {
        try {
            const data = await callDashboardInternal(
                `/internal/ip-reveal/${encodeURIComponent(req.params.requestId)}/approve`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        approvedBy: 'owner-dashboard',
                        ownerNote: req.body?.ownerNote || ''
                    })
                },
                API_SECRET
            );

            res.json(data);
        } catch (err) {
            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    });

    app.post('/api/verify-owner/ip-reveal/:requestId/reject', auth.requirePin, auth.requireCsrf, express.json(), async (req, res) => {
        try {
            const data = await callDashboardInternal(
                `/internal/ip-reveal/${encodeURIComponent(req.params.requestId)}/reject`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        rejectedBy: 'owner-dashboard',
                        ownerNote: req.body?.ownerNote || ''
                    })
                },
                API_SECRET
            );

            res.json(data);
        } catch (err) {
            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    });
}

module.exports = {
    registerVerifyOwnerRoutes
};
