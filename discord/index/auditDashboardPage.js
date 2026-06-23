function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildAuditDashboardPage({ title = "Audit Logs" } = {}) {
    return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#11091f;color:#f6edff;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1180px;margin:0 auto;padding:24px}.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:18px;margin:14px 0}.row{display:flex;gap:10px;flex-wrap:wrap}.row input,.row select{background:#1d1230;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:10px}button{background:#a855f7;color:#fff;border:0;border-radius:10px;padding:10px 14px;cursor:pointer}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:10px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left}th{color:#d8b4fe}.muted{color:#b7a8ce}.danger{color:#fb7185}.warning{color:#facc15}.success{color:#86efac}.pill{display:inline-flex;align-items:center;gap:6px;padding:8px 10px;background:#1d1230;border-radius:999px;border:1px solid rgba(255,255,255,.12)}</style>
</head>
<body>
<div class="wrap">
<h1>🧾 Audit Logs</h1>
<p class="muted">ค้นหา กรอง และ export audit records จากระบบ logging v4</p>
<div class="card">
<div class="row">
<input id="guildId" placeholder="Guild ID">
<select id="category"><option value="">ทุกหมวด</option><option>message</option><option>member</option><option>voice</option><option>server</option><option>security</option><option>moderation</option></select>
<input id="actionType" placeholder="Action type">
<input id="actorId" placeholder="Actor ID">
<input id="targetId" placeholder="Target ID">
<button onclick="loadLogs()">โหลด</button>
<button onclick="exportLogs('csv')">CSV</button>
<button onclick="exportLogs('markdown')">Markdown</button>
<button onclick="loadHealth()">Health</button>
<button onclick="loadDeadLetters()">Failed Sends</button>
</div>
</div>
<div class="card">
<h3>⚙️ Audit Settings</h3>
<div class="row">
<label class="pill"><input id="messageCreateEnabled" type="checkbox"> message create</label>
<label class="pill"><input id="reconcilerEnabled" type="checkbox"> reconciler opt-in</label>
<input id="retentionDays" placeholder="retention days" value="90">
<input id="reconcilerLimit" placeholder="limit" value="10">
<button onclick="loadSettings()">โหลด settings</button>
<button onclick="saveSettings()">บันทึก settings</button>
</div>
<div id="settingsStatus" class="muted" style="margin-top:10px">settings ยังไม่ได้โหลด</div>
</div>
<div class="card"><div id="status" class="muted">ยังไม่ได้โหลด</div><div style="overflow:auto"><table><thead><tr><th>Time</th><th>Category</th><th>Severity</th><th>Action</th><th>Actor</th><th>Target</th><th>Summary</th></tr></thead><tbody id="rows"></tbody></table></div></div>
</div>
<script>
function q(){const p=new URLSearchParams();for(const id of ['guildId','category','actionType','actorId','targetId']){const v=document.getElementById(id).value.trim();if(v)p.set(id,v)}return p}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function guild(){return document.getElementById('guildId').value.trim()}
function renderRows(records){document.getElementById('rows').innerHTML=(records||[]).map(x=>'<tr><td>'+esc(new Date(x.createdAt||0).toLocaleString())+'</td><td>'+esc(x.category)+'</td><td class="'+esc(x.severity||'warning')+'">'+esc(x.severity||x.reason||'-')+'</td><td>'+esc(x.actionType||'-')+'</td><td>'+esc(x.actorId||'-')+'</td><td>'+esc(x.targetId||'-')+'</td><td>'+esc(x.summary||x.reason||'-')+'</td></tr>').join('')}
async function loadLogs(){const r=await fetch('/api/audit/logs?'+q().toString());const j=await r.json();document.getElementById('status').textContent=j.success?'โหลด '+j.records.length+' รายการ':j.error;renderRows(j.records)}
function exportLogs(fmt){const p=q();p.set('format',fmt);location.href='/api/audit/export?'+p.toString()}
async function loadHealth(){const p=q();const r=await fetch('/api/audit/health?'+p.toString());const j=await r.json();document.getElementById('status').textContent=j.success?'health: '+JSON.stringify(j.health):j.error}
async function loadDeadLetters(){const p=q();const r=await fetch('/api/audit/dead-letters?'+p.toString());const j=await r.json();document.getElementById('status').textContent=j.success?'failed sends '+j.records.length+' รายการ':j.error;renderRows(j.records)}
async function loadSettings(){const p=new URLSearchParams();if(guild())p.set('guildId',guild());const r=await fetch('/api/audit/settings?'+p.toString());const j=await r.json();if(!j.success){document.getElementById('settingsStatus').textContent=j.error;return}const s=j.settings||{};document.getElementById('messageCreateEnabled').checked=!!s.messageCreateEnabled;document.getElementById('reconcilerEnabled').checked=!!s.reconcilerEnabled;document.getElementById('retentionDays').value=s.retentionDays??90;document.getElementById('reconcilerLimit').value=s.reconcilerLimit??10;document.getElementById('settingsStatus').textContent='loaded'}
async function saveSettings(){const body={guildId:guild(),messageCreateEnabled:document.getElementById('messageCreateEnabled').checked,reconcilerEnabled:document.getElementById('reconcilerEnabled').checked,retentionDays:Number(document.getElementById('retentionDays').value||90),reconcilerLimit:Number(document.getElementById('reconcilerLimit').value||10)};const r=await fetch('/api/audit/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();document.getElementById('settingsStatus').textContent=j.success?'saved':j.error}
</script>
</body>
</html>`;
}

module.exports = {
    escapeHtml,
    buildAuditDashboardPage
};
