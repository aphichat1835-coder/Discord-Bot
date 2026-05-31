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
            ...(options.headers || {})
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
<title>Owner IP Reveal Approval</title>
<style>
:root{
  --card:rgba(20,15,40,.86);
  --border:rgba(120,80,255,.2);
  --text:#ede9fe;
  --muted:#7c3aed88;
  --accent:#7c3aed;
  --green:#4ade80;
  --red:#f87171;
  --yellow:#fbbf24;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:radial-gradient(circle at 20% 20%,rgba(124,58,237,.16),transparent 45%),#07050f;
  color:var(--text);
  font-family:'Segoe UI','Noto Sans Thai',system-ui,sans-serif;
  min-height:100vh;
  padding:18px;
}
.container{max-width:1050px;margin:auto}
.nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.nav a{
  background:#0f0b1e;
  color:#a78bfa;
  text-decoration:none;
  border:1px solid var(--border);
  padding:8px 14px;
  border-radius:10px;
  font-size:.82rem;
}
.nav a:hover{background:var(--accent);color:white}
.title{
  text-align:center;
  font-size:1.6rem;
  font-weight:900;
  background:linear-gradient(135deg,#a855f7,#d8b4fe,#818cf8);
  -webkit-background-clip:text;
  -webkit-text-fill-color:transparent;
}
.sub{
  text-align:center;
  color:var(--muted);
  font-size:.82rem;
  margin:6px 0 20px;
}
.grid{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:10px;
  margin-bottom:16px;
}
@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}}
.stat,.card{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:16px;
  box-shadow:0 8px 32px rgba(124,58,237,.12);
  backdrop-filter:blur(12px);
}
.stat{padding:14px;text-align:center}
.val{font-size:1.6rem;font-weight:900}
.lbl{font-size:.68rem;color:var(--muted);margin-top:4px;text-transform:uppercase}
.card{padding:0;overflow:hidden}
table{width:100%;border-collapse:collapse;min-width:900px}
th{
  color:var(--muted);
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
tbody tr:hover td{background:rgba(124,58,237,.05)}
.scroll{overflow:auto}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.badge{
  display:inline-block;
  border-radius:999px;
  padding:2px 9px;
  font-size:.7rem;
  font-weight:800;
}
.pending{
  background:rgba(251,191,36,.12);
  border:1px solid rgba(251,191,36,.35);
  color:var(--yellow);
}
.btn{
  border:0;
  border-radius:9px;
  padding:7px 12px;
  font-weight:800;
  cursor:pointer;
  font-size:.78rem;
  margin:2px;
}
.ok{background:linear-gradient(135deg,#166534,#4ade80);color:#02130a}
.bad{background:linear-gradient(135deg,#7f1d1d,#f87171);color:white}
.soft{background:#0f0b1e;color:#a78bfa;border:1px solid var(--border)}
.ipbox{
  margin-top:6px;
  padding:7px 9px;
  background:rgba(5,3,18,.8);
  border:1px solid rgba(74,222,128,.25);
  border-radius:8px;
  color:var(--green);
  display:none;
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
  color:var(--muted);
  padding:28px!important;
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

  <h1 class="title">🔐 Owner IP Reveal Approval</h1>
  <div class="sub">อนุมัติ/ปฏิเสธคำขอดู IP จริงจาก Dashboard 3 — เฉพาะเจ้าของบอท</div>

  <div class="grid">
    <div class="stat"><div class="val" id="sPending">—</div><div class="lbl">Pending</div></div>
    <div class="stat"><div class="val" id="sLoaded">—</div><div class="lbl">Loaded</div></div>
    <div class="stat"><div class="val" id="sDash">${getDashboardUrl() ? 'OK' : 'NO'}</div><div class="lbl">Dashboard URL</div></div>
    <div class="stat"><button class="btn soft" onclick="load()">↻ Refresh</button><div class="lbl">Manual</div></div>
  </div>

  <div class="card scroll">
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
      <tbody id="body">
        <tr><td colspan="6" class="empty">กำลังโหลด...</td></tr>
      </tbody>
    </table>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let rows = [];

function esc(v){
  return String(v ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[m]));
}

function fmt(ts){
  return ts ? new Date(ts).toLocaleString('th-TH',{hour12:false}) : '—';
}

function toast(msg,type='ok'){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.className='toast '+type;
  t.style.display='block';
  clearTimeout(t._t);
  t._t=setTimeout(()=>t.style.display='none',3500);
}

async function api(path, body){
  const opt={headers:{}};

  if(body !== undefined){
    opt.method='POST';
    opt.headers['Content-Type']='application/json';
    opt.body=JSON.stringify(body);
  }

  const r=await fetch(path,opt);
  const d=await r.json().catch(()=>({success:false,error:'Invalid JSON'}));

  if(!r.ok || d.success === false){
    throw new Error(d.error || 'Request failed');
  }

  return d;
}

function render(){
  document.getElementById('sPending').textContent=rows.length;
  document.getElementById('sLoaded').textContent=rows.length;

  const b=document.getElementById('body');

  if(!rows.length){
    b.innerHTML='<tr><td colspan="6" class="empty">ไม่มีคำขอ pending</td></tr>';
    return;
  }

  b.innerHTML=rows.map(r=>\`
    <tr>
      <td>
        <div class="mono">Guild: \${esc(r.guildId)}</div>
        <div class="mono">User: \${esc(r.targetUserId)}</div>
        <span class="badge pending">\${esc(r.status)}</span>
      </td>
      <td>\${esc(r.reason || '—')}</td>
      <td class="mono">\${esc(r.requestedBy)}</td>
      <td>\${fmt(r.createdAt)}</td>
      <td>
        <button class="btn ok" onclick="approve('\${esc(r._id)}')">Approve</button>
        <button class="btn bad" onclick="rejectReq('\${esc(r._id)}')">Reject</button>
      </td>
      <td>
        <div class="ipbox" id="ip-\${esc(r._id)}"></div>
      </td>
    </tr>
  \`).join('');
}

async function load(){
  try{
    const d=await api('/api/verify-owner/ip-reveal/requests');
    rows=d.requests || [];
    render();
  }catch(e){
    document.getElementById('body').innerHTML='<tr><td colspan="6" class="empty">'+esc(e.message)+'</td></tr>';
    toast(e.message,'err');
  }
}

async function approve(id){
  const note=prompt('Owner note (optional)','approved by owner dashboard');
  if(note===null) return;

  try{
    const d=await api('/api/verify-owner/ip-reveal/'+id+'/approve',{ownerNote:note});
    const box=document.getElementById('ip-'+id);

    if(box){
      box.style.display='block';
      box.innerHTML='<b>Raw IP:</b> <span class="mono">'+esc(d.rawIp || 'null')+'</span><br><small>'+esc(d.ipInfo?.country || '')+' '+esc(d.ipInfo?.city || '')+' / '+esc(d.ipInfo?.isp || '')+'</small>';
    }

    toast('อนุมัติแล้ว แสดง IP เฉพาะหน้านี้','ok');
    rows=rows.filter(x=>x._id!==id);
    setTimeout(load,1500);
  }catch(e){
    toast(e.message,'err');
  }
}

async function rejectReq(id){
  const note=prompt('เหตุผลที่ปฏิเสธ','rejected by owner');
  if(note===null) return;

  try{
    await api('/api/verify-owner/ip-reveal/'+id+'/reject',{ownerNote:note});
    toast('ปฏิเสธแล้ว','ok');
    rows=rows.filter(x=>x._id!==id);
    render();
  }catch(e){
    toast(e.message,'err');
  }
}

load();
setInterval(load,30000);
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

    app.post('/api/verify-owner/ip-reveal/:requestId/approve', auth.requirePin, express.json(), async (req, res) => {
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

    app.post('/api/verify-owner/ip-reveal/:requestId/reject', auth.requirePin, express.json(), async (req, res) => {
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
