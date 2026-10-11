const { createViewHelpers } = require("./viewHelpers");
const { BASE_CSS } = require("./viewStyles");

const {
    navBar,
    shell,
    toastScript
} = createViewHelpers(BASE_CSS);

function buildJoinCampaignPage() {
    return shell("ติดตามสถานะการดึงสมาชิก", `
<link rel="stylesheet" href="/verification-assets/css/dashboard.css">
<link rel="stylesheet" href="/verification-assets/css/workspace.css">
<script>document.body.classList.add('verification-campaign-host')</script>
<div class="verification-campaign-page">
<div class="container">
<p class="eyebrow">VERIFICATION OPERATIONS</p>
<h1 class="page-title gradient-text">แผงติดตามสถานะการดึงสมาชิก</h1>
<p class="page-sub">ระบบติดตามและประวัติการดึงสมาชิกเข้าสู่เซิร์ฟเวอร์แบบเรียลไทม์ (ควบคุมผ่านคำสั่ง <code>/join-panel</code> ใน Discord)</p>
${navBar("/join-campaign")}

<div class="card" style="border-left: 4px solid var(--accent, #5865f2); margin-bottom: 20px;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div>
            <h3 style="margin:0 0 6px 0;">แผงควบคุมหลักบน Discord</h3>
            <p style="margin:0;color:var(--text3);font-size:0.9em;">
                ระบบดึงสมาชิกถูกควบคุมผ่าน Discord ด้วยคำสั่ง <code>/join-panel</code> เพื่อความปลอดภัยและสิทธิ์เฉพาะเจ้าของบอท
            </p>
        </div>
        <div style="font-size:0.85em;background:rgba(88,101,242,0.12);padding:6px 14px;border-radius:16px;color:var(--accent,#5865f2);font-weight:600;">
            READ-ONLY MONITORING
        </div>
    </div>
</div>

<div class="grid" style="margin-bottom: 24px;">
    <div class="stat"><div class="val" id="totalJobs">0</div><div class="lbl">งานทั้งหมด</div></div>
    <div class="stat"><div class="val" id="totalJoined">0</div><div class="lbl">ดึงเข้าสำเร็จรวม</div></div>
    <div class="stat"><div class="val" id="successRate">0%</div><div class="lbl">อัตราความสำเร็จ</div></div>
    <div class="stat"><div class="val" id="activeStatusBadge">-</div><div class="lbl">สถานะระบบปัจจุบัน</div></div>
</div>

<div class="card" style="margin-bottom: 24px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <h3 style="margin:0;">งานที่กำลังดำเนินการ / งานล่าสุด</h3>
        <p id="campaignFreshness" role="status" aria-live="polite" style="color:var(--text3);font-size:0.82em;margin:0;">กำลังโหลดสถานะ...</p>
    </div>
    
    <div class="mini-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:16px;">
        <div class="mini-stat"><span>สถานะ</span><b id="campaignStatus" role="status" aria-live="polite">ยังไม่มีงาน</b></div>
        <div class="mini-stat"><span>โหมด</span><b id="jobMode">-</b></div>
        <div class="mini-stat"><span>เซิร์ฟเวอร์ปลายทาง</span><b id="targetGuildName">-</b></div>
        <div class="mini-stat"><span>เซิร์ฟเวอร์ต้นทาง</span><b id="sourceGuildName">-</b></div>
        <div class="mini-stat"><span>เป้าหมายที่ต้องการ</span><b id="requestedAmount">0</b></div>
        <div class="mini-stat"><span>ดึงเข้าสำเร็จ</span><b id="joinedUsers">0</b></div>
        <div class="mini-stat"><span>อยู่แล้ว</span><b id="alreadyUsers">0</b></div>
        <div class="mini-stat"><span>ไม่สำเร็จ</span><b id="failedUsers">0</b></div>
        <div class="mini-stat"><span>ตรวจเช็กแล้ว</span><b id="processedUsers">0</b></div>
        <div class="mini-stat"><span>ลองใหม่ (Retry)</span><b id="retryCount">0</b></div>
        <div class="mini-stat"><span>Concurrency</span><b id="currentConcurrency">8</b></div>
        <div class="mini-stat"><span>Throughput (เฉลี่ย)</span><b id="currentThroughput">0 /วิ</b></div>
    </div>

    <div id="liveProgressBarContainer" style="margin: 14px 0; display: none;">
        <div style="display:flex;justify-content:space-between;font-size:0.86em;margin-bottom:6px;">
            <span>ความคืบหน้า</span>
            <span id="progressBarPercent">0%</span>
        </div>
        <div style="width:100%;height:10px;background:rgba(255,255,255,0.08);border-radius:5px;overflow:hidden;">
            <div id="liveProgressBar" style="width:0%;height:100%;background:linear-gradient(90deg,#5865f2,#57f287);transition:width 0.3s ease;"></div>
        </div>
    </div>

    <div class="terminal" id="campaignLog" style="height:180px;margin-top:14px;"></div>
</div>

<div class="card">
    <h3 style="margin-bottom: 14px;">ประวัติการดึงสมาชิกล่าสุด</h3>
    <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.88em;text-align:left;">
            <thead>
                <tr style="border-bottom:1px solid rgba(255,255,255,0.1);color:var(--text3);">
                    <th style="padding:10px 8px;">รหัสงาน</th>
                    <th style="padding:10px 8px;">โหมด</th>
                    <th style="padding:10px 8px;">ปลายทาง</th>
                    <th style="padding:10px 8px;">ผลลัพธ์ (สำเร็จ/เป้าหมาย)</th>
                    <th style="padding:10px 8px;">สถานะ</th>
                    <th style="padding:10px 8px;">เวลาเริ่ม</th>
                    <th style="padding:10px 8px;">เวลาเสร็จ</th>
                    <th style="padding:10px 8px;">ระยะเวลา</th>
                </tr>
            </thead>
            <tbody id="historyTableBody">
                <tr><td colspan="8" style="padding:16px;text-align:center;color:var(--text3);">กำลังโหลดประวัติ...</td></tr>
            </tbody>
        </table>
    </div>
</div>

</div>
</div>

${toastScript()}
<script>
function esc(v){
    return String(v==null?'':v)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
}
async function api(path, options){
    const res=await fetch(path, options||{});
    const data=await res.json().catch(()=>({success:false,error:'Invalid JSON'}));
    if(!res.ok || data.success===false){
        throw new Error(data.error || ('HTTP '+res.status));
    }
    return data;
}
function setText(id,value){
    const el=document.getElementById(id);
    if(el) el.textContent=String(value ?? 0);
}
function setFreshness(message, isError){
    const el=document.getElementById('campaignFreshness');
    if(!el) return;
    el.textContent=message;
    el.style.color=isError?'var(--yellow2)':'var(--text3)';
}
const statusLabels={
    idle:'พร้อมใช้งาน',
    pending:'กำลังเริ่ม',
    stage:'กำลังเตรียมงาน',
    running:'กำลังทำงาน',
    completed:'เสร็จสิ้นสมบูรณ์',
    partial:'สำเร็จบางส่วน',
    server_full:'เซิร์ฟเวอร์เต็ม (Guild Full)',
    interrupted:'หยุดชั่วคราว (รอเริ่มต่อ)',
    stopping:'กำลังหยุด',
    stopped:'หยุดแล้ว',
    failed:'เกิดข้อผิดพลาด'
};
function renderSummary(summary){
    if(!summary){
        setText('campaignStatus','ยังไม่มีงาน');
        setText('activeStatusBadge','พร้อมใช้งาน');
        return;
    }
    const rawStatus = String(summary.status || '').toLowerCase();
    const statusText = statusLabels[rawStatus] || summary.status || '-';
    setText('campaignStatus', statusText);
    setText('activeStatusBadge', statusText);
    setText('jobMode', summary.mode || summary.mode_name || '-');
    setText('targetGuildName', summary.target_guild_name || summary.targetGuildName || summary.target_guild_id || summary.targetGuildId || '-');
    setText('sourceGuildName', summary.source_guild_name || summary.sourceGuildName || summary.source_guild_id || summary.sourceGuildId || '-');
    setText('requestedAmount', summary.requested_amount || summary.maxUsers || 0);
    setText('joinedUsers', summary.joined_count || summary.joined || 0);
    setText('alreadyUsers', summary.already_member_count || summary.alreadyMember || 0);
    setText('failedUsers', summary.failed_count || summary.failed || 0);
    setText('processedUsers', summary.processed_count || summary.processedCount || 0);
    setText('retryCount', summary.retry_count || summary.retryCount || 0);
    setText('currentConcurrency', summary.current_concurrency || summary.currentConcurrency || 8);
    const tp = summary.current_throughput ?? summary.currentThroughput ?? 0;
    setText('currentThroughput', Number(tp).toFixed(1) + ' /วิ');

    const requested = Number(summary.requested_amount || summary.maxUsers || 0);
    const joined = Number(summary.joined_count || summary.joined || 0);
    const percent = requested > 0 ? Math.min(100, Math.round((joined / requested) * 100)) : 0;

    const progressContainer = document.getElementById('liveProgressBarContainer');
    const progressBar = document.getElementById('liveProgressBar');
    const progressPercent = document.getElementById('progressBarPercent');
    if (progressContainer && summary.status === 'running') {
        progressContainer.style.display = 'block';
        if (progressBar) progressBar.style.width = percent + '%';
        if (progressPercent) progressPercent.textContent = percent + '% (' + joined + ' / ' + requested + ')';
    } else if (progressContainer) {
        progressContainer.style.display = 'none';
    }

    const lines=[
        'รหัสงาน: '+(summary.id || summary.campaignId || '-'),
        'สถานะ: '+statusText,
        'โหมด: '+(summary.mode || '-'),
        'ปลายทาง: '+(summary.target_guild_name || summary.target_guild_id || '-'),
        'ต้นทาง: '+(summary.source_guild_name || summary.source_guild_id || 'ทุกเซิร์ฟเวอร์ในระบบ'),
        'เป้าหมาย: '+joined+' / '+requested+' คน',
        'อยู่แล้ว: '+(summary.already_member_count || summary.alreadyMember || 0)+' คน',
        'ไม่สำเร็จ: '+(summary.failed_count || summary.failed || 0)+' คน',
        'ตรวจเช็กแล้ว: '+(summary.processed_count || summary.processedCount || 0)+' คน',
        'ลองใหม่ (Retry): '+(summary.retry_count || summary.retryCount || 0)+' ครั้ง',
        'Concurrency: '+(summary.current_concurrency || summary.currentConcurrency || 8),
        'Throughput (เฉลี่ย): '+Number(tp).toFixed(1)+' คน/วินาที'
    ];
    if(summary.error_summary || summary.lastError || summary.last_error){
        lines.push('', 'ข้อความบันทึก: '+(summary.error_summary || summary.lastError || summary.last_error));
    }
    const logEl = document.getElementById('campaignLog');
    if (logEl) logEl.innerHTML=lines.map(esc).join('<br>');
}

function fmtDuration(ms){
    if(!ms || ms <= 0) return '-';
    const s = Math.floor(ms / 1000);
    if(s < 60) return s + ' วินาที';
    const m = Math.floor(s / 60);
    const remS = s % 60;
    return m + ' นาที' + (remS > 0 ? ' ' + remS + ' วินาที' : '');
}

function renderHistory(history){
    const tbody = document.getElementById('historyTableBody');
    if(!tbody) return;
    if(!Array.isArray(history) || history.length === 0){
        tbody.innerHTML = '<tr><td colspan="8" style="padding:16px;text-align:center;color:var(--text3);">ยังไม่มีประวัติการทำงาน</td></tr>';
        return;
    }
    tbody.innerHTML = history.map(item => {
        const start = item.started_at ? new Date(item.started_at).toLocaleTimeString('th-TH') : '-';
        const finish = item.completed_at ? new Date(item.completed_at).toLocaleTimeString('th-TH') : '-';
        const statusColors = {
            completed: '#57f287',
            partial: '#fee75c',
            server_full: '#fee75c',
            interrupted: '#f0b232',
            stopping: '#fee75c',
            failed: '#ed4245',
            running: '#5865f2',
            stage: '#5865f2',
            stopped: '#fee75c'
        };
        const rawStatus = String(item.status || '').toLowerCase();
        const color = statusColors[rawStatus] || 'var(--text3)';
        const label = statusLabels[rawStatus] || item.status || '-';
        const durationText = fmtDuration(item.duration_ms || item.durationMs);
        return '<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">' +
            '<td style="padding:8px;font-family:monospace;">' + esc(String(item.id || '').slice(0, 16)) + '</td>' +
            '<td style="padding:8px;">' + esc(item.mode || '-') + '</td>' +
            '<td style="padding:8px;">' + esc(item.target_guild_name || item.target_guild_id || '-') + '</td>' +
            '<td style="padding:8px;font-weight:600;">' + esc(item.joined_count || 0) + ' / ' + esc(item.requested_amount || 0) + '</td>' +
            '<td style="padding:8px;"><span style="color:' + color + ';font-weight:600;">' + esc(label) + '</span></td>' +
            '<td style="padding:8px;color:var(--text3);">' + esc(start) + '</td>' +
            '<td style="padding:8px;color:var(--text3);">' + esc(finish) + '</td>' +
            '<td style="padding:8px;color:var(--text3);">' + esc(durationText) + '</td>' +
        '</tr>';
    }).join('');
}

async function refreshStatus(){
    try{
        const data = await api('/api/join-campaign/status');
        const status = data.status || {};
        renderSummary(status.active || status.last);

        api('/api/join-campaign/history?limit=15')
            .then(h => { if(h && h.success && Array.isArray(h.history)) renderHistory(h.history); })
            .catch(() => {});
        api('/api/join-campaign/metrics')
            .then(m => {
                if(m && m.success && m.metrics) {
                    setText('totalJobs', m.metrics.totalJobs || 0);
                    setText('totalJoined', m.metrics.totalJoined || 0);
                    setText('successRate', (m.metrics.successRatePercent || 0) + '%');
                }
            })
            .catch(() => {});

        setFreshness('อัปเดตล่าสุด: '+new Date().toLocaleTimeString('th-TH'), false);
    }catch(e){
        setFreshness('⚠️ โหลดสถานะไม่ได้ — ข้อมูลด้านล่างอาจเก่า', true);
    }
}

refreshStatus();
dashboardInterval(refreshStatus, 3000);
</script>`);
}

module.exports = {
    buildJoinCampaignPage
};
