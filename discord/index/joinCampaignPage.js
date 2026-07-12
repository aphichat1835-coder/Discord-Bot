const { createViewHelpers } = require("./viewHelpers");
const { BASE_CSS } = require("./viewStyles");

const {
    navBar,
    shell,
    toastScript
} = createViewHelpers(BASE_CSS);

function buildJoinCampaignPage() {
    return shell("ดึงสมาชิกเข้าเซิร์ฟเวอร์", `
<div class="container">
<h1 class="page-title">📥 Join Authorized Users</h1>
<p class="page-sub">ดึงผู้ใช้ที่เคยอนุญาต OAuth scope <code>guilds.join</code> เข้าเซิร์ฟเวอร์เป้าหมายที่บอทอยู่</p>
${navBar("/join-campaign")}

<div class="card">
    <h3>🎯 เลือกเซิร์ฟเวอร์เป้าหมาย</h3>
    <p style="color:var(--text3);font-size:0.86em;margin-bottom:14px;">
        ระบบจะใช้เฉพาะ token ที่มีสิทธิ์ <code>guilds.join</code>, refresh token ก่อนใช้เมื่อจำเป็น,
        และจะไม่ sync/add role อัตโนมัติ
    </p>
    <select id="targetGuild" style="margin-bottom:12px;"></select>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="dryRun()">🔎 ตรวจจำนวนก่อน</button>
        <button class="btn btn-success" onclick="startCampaign()">▶️ เริ่มดึงอัตโนมัติ</button>
        <button class="btn btn-danger" onclick="stopCampaign()">⏹ หยุดงาน</button>
    </div>
</div>

<div class="grid">
    <div class="stat"><div class="val" id="usableUsers">0</div><div class="lbl">ใช้ได้จริง</div></div>
    <div class="stat"><div class="val" id="joinedUsers">0</div><div class="lbl">ดึงเข้าสำเร็จ</div></div>
    <div class="stat"><div class="val" id="alreadyUsers">0</div><div class="lbl">อยู่แล้ว</div></div>
    <div class="stat"><div class="val" id="failedUsers">0</div><div class="lbl">ไม่สำเร็จ</div></div>
</div>

<div class="card">
    <h3>📊 สถานะงาน</h3>
    <div class="mini-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
        <div class="mini-stat"><span>สถานะ</span><b id="campaignStatus">ยังไม่มีงาน</b></div>
        <div class="mini-stat"><span>Records</span><b id="scannedRecords">0</b></div>
        <div class="mini-stat"><span>Users</span><b id="uniqueUsers">0</b></div>
        <div class="mini-stat"><span>Refresh แล้ว</span><b id="refreshedUsers">0</b></div>
        <div class="mini-stat"><span>ขาด scope</span><b id="missingScope">0</b></div>
        <div class="mini-stat"><span>Rate limit</span><b id="rateLimited">0</b></div>
    </div>
    <div class="terminal" id="campaignLog" style="height:240px;margin-top:14px;"></div>
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
function selectedGuildId(){
    return document.getElementById('targetGuild').value;
}
function setText(id,value){
    const el=document.getElementById(id);
    if(el) el.textContent=String(value ?? 0);
}
function renderSummary(summary){
    if(!summary){
        setText('campaignStatus','ยังไม่มีงาน');
        return;
    }
    setText('campaignStatus',summary.status || '-');
    setText('usableUsers',summary.usableUsers || 0);
    setText('joinedUsers',summary.joined || 0);
    setText('alreadyUsers',summary.alreadyMember || 0);
    setText('failedUsers',summary.failed || 0);
    setText('scannedRecords',summary.scannedRecords || 0);
    setText('uniqueUsers',summary.uniqueUsers || 0);
    setText('refreshedUsers',summary.refreshed || 0);
    setText('missingScope',summary.missingScope || 0);
    setText('rateLimited',summary.rateLimited || 0);

    const lines=[
        'รหัสงาน: '+(summary.campaignId || '-'),
        'เซิร์ฟเวอร์: '+(summary.targetGuildName || summary.targetGuildId || '-'),
        'ตรวจทั้งหมด: '+(summary.scannedRecords || 0)+' records / '+(summary.uniqueUsers || 0)+' users',
        'ใช้ได้จริง: '+(summary.usableUsers || 0),
        'สำเร็จ: '+(summary.joined || 0),
        'อยู่แล้ว: '+(summary.alreadyMember || 0),
        'ไม่สำเร็จ: '+(summary.failed || 0),
        'refresh แล้ว: '+(summary.refreshed || 0),
        'refresh ไม่สำเร็จ: '+(summary.refreshFailed || 0),
        'ขาด guilds.join: '+(summary.missingScope || 0),
        'บอทขาดสิทธิ์: '+(summary.botMissingPermission || 0),
        'token ใช้ไม่ได้: '+(summary.tokenInvalid || 0),
        'rate limit: '+(summary.rateLimited || 0)
    ];
    if(summary.errors && summary.errors.length){
        lines.push('', 'ตัวอย่างไม่สำเร็จ:');
        summary.errors.slice(0,8).forEach(item=>{
            lines.push('- '+(item.userId || '-')+' : '+(item.reason || '-')+(item.detail?' ('+item.detail+')':''));
        });
    }
    document.getElementById('campaignLog').innerHTML=lines.map(esc).join('<br>');
}
async function loadTargets(){
    const data=await api('/api/join-campaign/targets');
    const select=document.getElementById('targetGuild');
    if(!data.enabled){
        select.innerHTML='<option value="">ระบบถูกปิดด้วย JOIN_CAMPAIGN_ENABLED=false</option>';
        return;
    }
    if(!data.targets || !data.targets.length){
        select.innerHTML='<option value="">ไม่พบเซิร์ฟเวอร์ที่บอทอยู่หรืออนุญาต</option>';
        return;
    }
    select.innerHTML=data.targets.map(g=>'<option value="'+esc(g.id)+'">'+esc(g.name)+' ('+esc(g.id)+')</option>').join('');
}
async function refreshStatus(){
    try{
        const data=await api('/api/join-campaign/status');
        const status=data.status || {};
        renderSummary(status.active || status.last);
    }catch(e){}
}
async function dryRun(){
    const guildId=selectedGuildId();
    if(!guildId) return showToast('กรุณาเลือกเซิร์ฟเวอร์','err');
    try{
        showToast('กำลังตรวจจำนวน...');
        const data=await api('/api/join-campaign/dry-run',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({guildId})
        });
        renderSummary(data.summary);
        showToast('ตรวจจำนวนเสร็จแล้ว');
    }catch(e){showToast(e.message,'err');}
}
async function startCampaign(){
    const guildId=selectedGuildId();
    if(!guildId) return showToast('กรุณาเลือกเซิร์ฟเวอร์','err');
    const select=document.getElementById('targetGuild');
    const guildName=select.options[select.selectedIndex]?.textContent || guildId;
    try{
        showToast('กำลังตรวจคนที่ดึงได้...');
        const preview=await api('/api/join-campaign/dry-run',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({guildId})
        });
        renderSummary(preview.summary);
        if(selectedGuildId() !== guildId){
            return showToast('เซิร์ฟเวอร์เปลี่ยนระหว่างการตรวจ กรุณาลองใหม่','err');
        }
        const usable=preview.summary?.usableUsers || 0;
        const confirmed=window.confirm(
            'ยืนยันดึงผู้ใช้เข้าเซิร์ฟเวอร์นี้?\n\n'+
            guildName+'\n'+
            'ผู้ใช้ที่พร้อมดึง: '+usable+' คน\n\n'+
            'กด OK เพื่อเริ่มดึงทันที'
        );
        if(!confirmed) return showToast('ยกเลิกแล้ว');
        if(selectedGuildId() !== guildId){
            return showToast('เซิร์ฟเวอร์เปลี่ยน กรุณาตรวจใหม่','err');
        }
        const data=await api('/api/join-campaign/start',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({guildId})
        });
        renderSummary(data.campaign);
        showToast('เริ่มงานแล้ว ระบบจะดึงอัตโนมัติจนจบ');
    }catch(e){showToast(e.message,'err');}
}
async function stopCampaign(){
    try{
        await api('/api/join-campaign/stop',{method:'POST'});
        showToast('ส่งคำสั่งหยุดแล้ว');
        refreshStatus();
    }catch(e){showToast(e.message,'err');}
}
loadTargets().then(refreshStatus).catch(e=>showToast(e.message,'err'));
setInterval(refreshStatus,3000);
</script>`);
}

module.exports = {
    buildJoinCampaignPage
};
