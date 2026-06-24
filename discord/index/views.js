/* eslint-disable complexity -- Owner dashboard view generation is legacy-compatible; refactor separately. */
/*
================================================================================
  ENTERPRISE DASHBOARD — Views Layer
  ธีม: Dark Purple Glassmorphism
  หน้าทั้งหมด: /, /status, /settings, /commands, /whitelist, /approved,
               /logs, /logs/voice, /session/:id, /docs
================================================================================
*/

const auth = require("./auth");
const { createViewHelpers } = require("./viewHelpers");
const { buildJoinCampaignPage } = require("./joinCampaignPage");

// ════════════════════════════════════════════════════════════════════════════
//  🎨  SHARED CSS — ใช้ทุกหน้า
// ════════════════════════════════════════════════════════════════════════════
const { BASE_CSS } = require("./viewStyles");

// ════════════════════════════════════════════════════════════════════════════
//  🔧  HELPERS
// ════════════════════════════════════════════════════════════════════════════
const {
    escapeHtml,
    navBar,
    shell,
    toastScript
} = createViewHelpers(BASE_CSS);

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
    <h3>🧭 Voice Worker Diagnostics</h3>
    <div class="mini-grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));">
        <div class="mini-stat"><span>Client Pool</span><b id="diagClientPool">0</b></div>
        <div class="mini-stat"><span>Login Queue</span><b id="diagLoginQueue">0</b></div>
        <div class="mini-stat"><span>Recovery Queue</span><b id="diagRecoveryQueue">0</b></div>
        <div class="mini-stat"><span>Natural Timers</span><b id="diagNaturalTimers">0</b></div>
        <div class="mini-stat"><span>Auto Deaf Timers</span><b id="diagAutoDeafTimers">0</b></div>
        <div class="mini-stat"><span>Cooldowns</span><b id="diagCooldowns">0</b></div>
    </div>
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

        const diag=d.workerDiagnostics||{};
        document.getElementById('diagClientPool').textContent=diag.clientPool??d.clientPoolSize??d.clientPool??0;
        document.getElementById('diagLoginQueue').textContent=(diag.loginQueue??d.loginQueue??0)+' / '+(diag.loginQueueRunning??0);
        document.getElementById('diagRecoveryQueue').textContent=(diag.recoveryQueue??d.recoveryQueue??0)+' / '+(diag.recoveryQueueRunning??0);
        document.getElementById('diagNaturalTimers').textContent=diag.naturalTimers??d.naturalTimers??0;
        document.getElementById('diagAutoDeafTimers').textContent=diag.autoDeafTimers??d.autoDeafTimers??0;
        document.getElementById('diagCooldowns').textContent=diag.tokenLoginCooldowns??0;

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
                const badges=[];
                if(s.state&&s.state!=='active') badges.push(s.state);
                if(s.staleSuspected) badges.push('stale');
                if(s.ghostSuspected) badges.push('ghost suspected');
                const badgeHtml=badges.length
                    ? '<div class="session-sub">'+badges.map(b=>'<span class="session-chip" style="display:inline-block;margin:2px 4px 2px 0;padding:4px 8px;color:var(--yellow2);">'+esc(b)+'</span>').join('')+'</div>'
                    : '';

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
                            badgeHtml+
                            '<div class="session-sub">ผู้สั่งเริ่ม: '+owner+'</div>'+
                        '</div>'+
                    '</div>'+
                    '<div class="session-actions">'+
                        '<a class="session-chip" href="/session/'+sid+'">ดูรายละเอียด →</a>'+
                        '<button class="session-chip session-stop" onclick="stopSessionFromHome(\\''+sid+'\\',this)">หยุด</button>'+
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

async function stopSessionFromHome(sessionId, btn){
    if(!sessionId) return;
    if(!confirm('หยุด session นี้?')) return;
    const oldText=btn?btn.textContent:'';
    if(btn){
        btn.disabled=true;
        btn.textContent='กำลังหยุด...';
    }

    try{
        const r=await fetch('/api/stop-session',{
            method:'POST',
            headers:{
                'Content-Type':'application/json',
                'Authorization':''
            },
            body:JSON.stringify({sessionId})
        });
        const d=await r.json();
        if(d.success){
            showToast('✅ หยุด session แล้ว','ok');
            await fetchStatus();
            return;
        }
        showToast('❌ '+(d.error||'หยุดไม่สำเร็จ'),'err');
    }catch(e){
        showToast('❌ เชื่อมต่อไม่ได้','err');
    }finally{
        if(btn){
            btn.disabled=false;
            btn.textContent=oldText||'หยุด';
        }
    }
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
const SECRET='';

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
    <div class="table-scroll">
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
</div>

<script>
const SECRET='';

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
    <div class="table-scroll">
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
</div>

<script>
const SECRET='';

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
    <div class="table-scroll">
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
</div>
<script>setTimeout(()=>location.reload(),15000);</script>`);
}
// ════════════════════════════════════════════════════════════════════════════
//  🖥️  SESSION DETAIL PAGE
// ════════════════════════════════════════════════════════════════════════════
function pageSessionDetail() {
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

    <div class="detail-grid">
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

    <div class="detail-grid">
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
const rawSessionId=decodeURIComponent(location.pathname.split('/').pop()||'');
const SESSION_ID=/^vc_[A-Za-z0-9_-]{1,80}$/.test(rawSessionId)?rawSessionId:'';
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
    if(!SESSION_ID){
        document.getElementById('notFound').style.display='block';
        document.getElementById('pageContent').style.display='none';
        return;
    }

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
            wrap.innerHTML='<div class="table-scroll"><table><thead><tr><th>เวลา</th><th>สถานะ</th><th>รายละเอียด</th></tr></thead><tbody>'+
                logs.map(l=>{
                    const cls=l.type==='fail'?'var(--red2)':l.type==='drop'?'var(--yellow2)':l.type==='recover'?'var(--blue2)':'var(--green2)';
                    return '<tr>'+
                        '<td style="color:var(--text3);white-space:nowrap;">'+new Date(l.ts||Date.now()).toLocaleTimeString('th-TH',{hour12:false})+'</td>'+
                        '<td style="font-weight:700;color:'+cls+';">'+esc(l.type||'-')+'</td>'+
                        '<td style="color:var(--text2);">'+esc(l.detail||'-')+'</td>'+
                    '</tr>';
                }).join('')+
            '</tbody></table></div>';
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
const SECRET='';
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

        const approvedList = await sessionManager.getApprovedGuildDocs().catch(() => []);
        res.send(pageApproved(approvedList, client, API_SECRET));
    });

    app.get("/join-campaign", auth.requirePin, (req, res) => {
        res.send(buildJoinCampaignPage());
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
        res.send(pageSessionDetail());
    });
}

module.exports = {
    registerViewRoutes,
    escapeHtml,
    BASE_CSS
};
