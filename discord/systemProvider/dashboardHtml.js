const { escapeHtml, hiddenInput, safeStyleContent } = require("./htmlUtils");

const SHADOW_UI_CSS = `
:focus-visible{outline:3px solid rgba(251,191,36,.92);outline-offset:3px}
.skip-link{position:fixed;top:10px;left:10px;z-index:100000;padding:10px 14px;border-radius:10px;background:var(--red);color:#fff;transform:translateY(-160%);transition:transform .18s ease}
.skip-link:focus{transform:translateY(0)}
.tabs{position:sticky;top:8px;z-index:80;padding:8px;background:rgba(7,5,15,.82);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 10px 30px rgba(0,0,0,.28)}
.tab-btn{min-height:44px;font-family:inherit}
.section.active{animation:shadow-page-in .28s cubic-bezier(.22,.8,.24,1) both}
@keyframes shadow-page-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
.copy-surface{width:100%;display:block;text-align:left;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--yellow);font-family:monospace;font-size:.76em;overflow-wrap:anywhere;cursor:pointer}
.copy-surface:hover{border-color:var(--yellow)}
button[aria-busy="true"]{opacity:.68;cursor:wait}
.toast{transition:opacity .18s ease,transform .18s ease}
@media(max-width:700px){.tabs{overflow-x:auto;flex-wrap:nowrap;justify-content:flex-start;-webkit-overflow-scrolling:touch}.tab-btn{flex:0 0 auto}.shadow-header{padding-top:18px}.grid2 form,.grid2 .btn{width:100%}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`;

function renderShadowDashboardPage(viewData = {}, state = {}) {
    const {
        SHADOW_CSS = "",
        tracePolicyRows = "",
        traceMetricRows = "",
        toggleRows = "",
        guildRows = "",
        vipRows = "",
        sessionRows = "",
        botStats = null
    } = viewData;

    const {
        ghostModeEnabled = false,
        protectedSessionCount = 0,
        armedGuildCount = 0,
        globalAdminCount = 0,
        traceKillSwitchEnabled = false,
        traceDryRunEnabled = false,
        tracePolicyDefault = "approval",
        protectedChannelCount = 0,
        traceRateLimitMax = 0,
        traceRateLimitWindowSeconds = 0
    } = state;

    return `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="theme-color" content="#07050f"><meta name="color-scheme" content="dark">
<title>Dashboard ควบคุมบอท</title>
<style>${safeStyleContent(SHADOW_CSS)}${SHADOW_UI_CSS}</style>
</head><body>
<a class="skip-link" href="#shadow-main">ข้ามไปเนื้อหาหลัก</a>
<main id="shadow-main" class="container" tabindex="-1">

<div class="shadow-header">
    <div class="shadow-title">🛡️ DASHBOARD CONTROL</div>
    <div class="shadow-sub">พื้นที่ควบคุมบอทสำหรับเจ้าของระบบ</div>
    <div style="margin-top:8px;display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;">
        <span class="badge ${ghostModeEnabled ? 'badge-armed' : 'badge-on'}">${ghostModeEnabled ? '👻 GHOST MODE ON' : '⭕ Ghost Mode Off'}</span>
        <span class="badge" style="background:rgba(99,102,241,.15);color:#818cf8;border:1px solid rgba(99,102,241,.3);">🛡️ Protected: ${escapeHtml(protectedSessionCount)} sessions</span>
        <a href="/" style="background:var(--bg2);color:var(--text2);padding:4px 12px;border-radius:8px;text-decoration:none;font-size:0.75em;border:1px solid var(--border);">→ Main Dashboard</a>
    </div>
</div>

<!-- Navigation Tabs -->
<nav class="tabs" role="tablist" aria-label="หมวด Dashboard ควบคุมบอท">
    <button id="shadow-tab-overview" type="button" role="tab" aria-selected="true" aria-controls="tab-overview" class="tab-btn active" data-shadow-tab="overview">📊 ภาพรวม</button>
    <button id="shadow-tab-toggles" type="button" role="tab" aria-selected="false" aria-controls="tab-toggles" class="tab-btn" data-shadow-tab="toggles">🎛️ สวิตช์ระบบ</button>
    <button id="shadow-tab-targets" type="button" role="tab" aria-selected="false" aria-controls="tab-targets" class="tab-btn" data-shadow-tab="targets">🎯 เซิร์ฟเวอร์เป้าหมาย</button>
    <button id="shadow-tab-sessions" type="button" role="tab" aria-selected="false" aria-controls="tab-sessions" class="tab-btn" data-shadow-tab="sessions">📡 Session</button>
    <button id="shadow-tab-vip" type="button" role="tab" aria-selected="false" aria-controls="tab-vip" class="tab-btn" data-shadow-tab="vip">👥 ผู้มีสิทธิ์</button>
    <button id="shadow-tab-manual" type="button" role="tab" aria-selected="false" aria-controls="tab-manual" class="tab-btn" data-shadow-tab="manual">📖 นโยบาย</button>
    <button id="shadow-tab-settings" type="button" role="tab" aria-selected="false" aria-controls="tab-settings" class="tab-btn" data-shadow-tab="settings">⚙️ ตั้งค่า</button>
</nav>

<!-- ── TAB: Overview ── -->
<section class="section active" id="tab-overview" role="tabpanel" aria-labelledby="shadow-tab-overview" tabindex="0">
    ${botStats ? `
    <div class="grid3" style="margin-bottom:14px;">
        <div class="stat-box"><div class="stat-val" style="color:var(--red2);">${escapeHtml(botStats.guilds)}</div><div class="stat-lbl">🌐 เซิร์ฟเวอร์</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--yellow);">${escapeHtml(botStats.ping)}ms</div><div class="stat-lbl">🏓 Ping</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--purple);">${escapeHtml(botStats.ram)} MB</div><div class="stat-lbl">🧠 RAM</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--green);">${escapeHtml(botStats.uptime)}m</div><div class="stat-lbl">⏱️ เวลาทำงาน</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--red2);">${escapeHtml(armedGuildCount)}</div><div class="stat-lbl">⚠️ Armed</div></div>
        <div class="stat-box"><div class="stat-val" style="color:#f97316;">${escapeHtml(globalAdminCount)}</div><div class="stat-lbl">👥 VIPs</div></div>
    </div>
    <div class="card">
        <h3>🤖 สถานะบอท</h3>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <span style="color:var(--green);font-weight:700;">🟢 ${escapeHtml(botStats.tag)}</span>
            <span style="color:var(--text3);font-size:0.82em;">Ping: ${escapeHtml(botStats.ping)}ms | Uptime: ${escapeHtml(botStats.uptime)}m | RAM: ${escapeHtml(botStats.ram)}MB</span>
        </div>
    </div>` : '<div class="card"><h3>🤖 สถานะบอท</h3><p style="color:var(--red2);">🔴 บอทออฟไลน์</p></div>'}

    <div class="card">
        <h3>⚡ ทางลัด</h3>
        <div class="grid2">
            <form method="POST">
                ${hiddenInput("action", "ghost_toggle")}
                <button type="submit" class="btn ${ghostModeEnabled ? 'btn-success' : 'btn-danger'}">${ghostModeEnabled ? '⭕ ปิด Ghost Mode' : '👻 เปิด Ghost Mode'}</button>
            </form>
            <a href="/" class="btn btn-purple" style="text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center;">🌐 Main Dashboard</a>
        </div>
    </div>

    <div class="card">
        <h3>🕐 กิจกรรมล่าสุด</h3>
        <p style="color:var(--text3);font-size:0.82em;text-align:center;padding:12px 0;">Log จะแสดงใน Webhook ลับของคุณ — เปิด WEBHOOK_LOG_URL เพื่อดู</p>
    </div>
</section>

<!-- ── TAB: Switches ── -->
<section class="section" id="tab-toggles" role="tabpanel" aria-labelledby="shadow-tab-toggles" tabindex="0" hidden>
    <div class="card">
        <h3>🎛️ เปิด–ปิดฟีเจอร์ระบบ</h3>
        <p style="color:var(--text3);font-size:0.78em;margin-bottom:14px;">ปิด/เปิดฟีเจอร์แต่ละอย่างได้อิสระ — มีผลทันที</p>
        ${toggleRows}
    </div>
    <div class="card">
        <h3>🧹 Trace Eraser Guard</h3>
        <p style="color:var(--text3);font-size:0.78em;margin-bottom:12px;">Guard ชั้นนี้ควบคุม policy, dry-run, kill switch, protected channel และ rate limit</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-bottom:12px;">
            <div class="status-card">
                <span>Default Policy</span>
                <strong>${escapeHtml(tracePolicyDefault)}</strong>
            </div>
            <div class="status-card">
                <span>Protected Channel IDs</span>
                <strong>${escapeHtml(protectedChannelCount)}</strong>
            </div>
            <div class="status-card">
                <span>Rate Limit</span>
                <strong>${escapeHtml(traceRateLimitMax)}/${escapeHtml(traceRateLimitWindowSeconds)}s</strong>
            </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
            <form method="POST" style="margin:0;">
                ${hiddenInput("action", "trace_kill_toggle")}
                <button type="submit" class="btn ${traceKillSwitchEnabled ? 'btn-success' : 'btn-danger'} btn-sm" style="width:auto;">${traceKillSwitchEnabled ? 'เปิด Trace Eraser' : 'Kill Switch'}</button>
            </form>
            <form method="POST" style="margin:0;">
                ${hiddenInput("action", "trace_dry_run_toggle")}
                <button type="submit" class="btn ${traceDryRunEnabled ? 'btn-success' : 'btn-purple'} btn-sm" style="width:auto;">Dry-run: ${traceDryRunEnabled ? 'ON' : 'OFF'}</button>
            </form>
        </div>
        <h4 style="margin:12px 0 6px;color:var(--text2);">Guild Policy</h4>
        ${tracePolicyRows}
        <h4 style="margin:14px 0 6px;color:var(--text2);">Metrics</h4>
        ${traceMetricRows}
    </div>
</section>

<!-- ── TAB: Target Lock ── -->
<section class="section" id="tab-targets" role="tabpanel" aria-labelledby="shadow-tab-targets" tabindex="0" hidden>
    <div class="card">
        <h3>🎯 Target Lock — ARM/DISARM Guilds</h3>
        <p style="color:var(--red2);font-size:0.78em;margin-bottom:14px;">⚠️ การดำเนินการความเสี่ยงสูงต้องยืนยันสิทธิ์และเปิด ARM ชั่วคราวก่อนใช้งาน</p>
        <table>
            <thead><tr>
                <th>เซิร์ฟเวอร์</th>
                <th style="text-align:center;">สมาชิก</th>
                <th style="text-align:center;">สถานะ</th>
                <th style="text-align:center;">คำสั่ง</th>
            </tr></thead>
            <tbody>${guildRows}</tbody>
        </table>
    </div>
</section>

<!-- ── TAB: Sessions ── -->
<section class="section" id="tab-sessions" role="tabpanel" aria-labelledby="shadow-tab-sessions" tabindex="0" hidden>
    <div class="card">
        <h3>📡 Session เสียงที่กำลังทำงาน</h3>
        <p style="color:var(--text3);font-size:0.78em;margin-bottom:14px;">🛡️ Protected session ไม่สามารถหยุดได้จาก Dashboard ปกติ</p>
        <table>
            <thead><tr>
                <th>Session ID</th>
                <th>เซิร์ฟเวอร์</th>
                <th style="text-align:center;">Uptime</th>
                <th style="text-align:center;">จัดการ</th>
            </tr></thead>
            <tbody>${sessionRows}</tbody>
        </table>
    </div>
</section>

<!-- ── TAB: VIP ── -->
<section class="section" id="tab-vip" role="tabpanel" aria-labelledby="shadow-tab-vip" tabindex="0" hidden>
    <div class="card">
        <h3>👥 ผู้ใช้ที่ได้รับสิทธิ์เพิ่มเติม</h3>
        <form method="POST" style="display:flex;gap:8px;margin-bottom:16px;">
            ${hiddenInput("action", "add_vip")}
            <input type="text" name="vip_id" placeholder="Discord User ID..." style="flex:1;margin-top:0;">
            <button type="submit" class="btn btn-success btn-sm" style="width:auto;">➕ เพิ่ม VIP</button>
        </form>
        <div>${vipRows}</div>
    </div>
    <div class="card">
        <h3>🛡️ ขอบเขตสิทธิ์</h3>
        <p style="color:var(--text3);font-size:0.82em;">ผู้ปฏิบัติงานใช้ได้เฉพาะข้อมูลวินิจฉัยที่อนุญาต การเปิดข้อมูลลับ การ ARM และการเปลี่ยนค่าความปลอดภัยสงวนไว้สำหรับเจ้าของและมี Audit ทุกครั้ง</p>
    </div>
</section>

<!-- ── TAB: Policy ── -->
<section class="section" id="tab-manual" role="tabpanel" aria-labelledby="shadow-tab-manual" tabindex="0" hidden>
    <div class="card">
        <h3>📖 นโยบายความปลอดภัย</h3>
        <p style="color:var(--text3);font-size:0.82em;line-height:1.7;">Dashboard นี้เป็นพื้นที่ส่วนตัวของเจ้าของ ปุ่มต่าง ๆ ทำงานทันทีหลังล็อกอิน โดยระบบยังเก็บสถานะการทำงานไว้เบื้องหลังเท่าที่ทำได้</p>
    </div>
</section>

<!-- ── TAB: Settings ── -->
<section class="section" id="tab-settings" role="tabpanel" aria-labelledby="shadow-tab-settings" tabindex="0" hidden>
    <div class="grid2">
        <div class="card">
            <h3>🔑 เปลี่ยนรหัสผ่าน Portal</h3>
            <form method="POST">
                ${hiddenInput("action", "change_pin")}
                <label>รหัส PIN ใหม่</label>
                <input type="password" name="new_pin" placeholder="กรอกรหัสใหม่..." autocomplete="new-password">
                <button type="submit" class="btn btn-warn">🔑 บันทึกรหัสใหม่</button>
            </form>
            <p style="color:var(--text3);font-size:0.72em;margin-top:8px;">* บอทจะยิง Webhook แจ้งเตือนทันทีเมื่อเปลี่ยน</p>
        </div>
        <div class="card">
            <h3>🔐 Session</h3>
            <p style="color:var(--text3);font-size:0.8em;margin-bottom:10px;">การเปลี่ยน PIN หรือ Logout all จะยกเลิก Session เดิมทันที</p>
            <button id="shadowLogout" type="button" class="btn btn-danger">ออกจากระบบ</button>
        </div>
    </div>
    <div class="card">
        <h3>⚠️ การตั้งค่าที่มีความเสี่ยง</h3>
        <div class="grid2">
            <form method="POST">
                ${hiddenInput("action", "ghost_toggle")}
                <button type="submit" class="btn ${ghostModeEnabled ? 'btn-success' : 'btn-danger'}">${ghostModeEnabled ? '⭕ ปิด Ghost Mode' : '👻 เปิด Ghost Mode'}</button>
            </form>
            <a href="/" class="btn btn-purple" style="display:flex;align-items:center;justify-content:center;text-decoration:none;">🌐 กลับ Main Dashboard</a>
        </div>
    </div>
</section>

</main><!-- end container -->

<div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>

<script>
// Tab switching
function showTab(id, el) {
    document.querySelectorAll('.section').forEach(s => {
        const selected=s.id==='tab-'+id;
        s.classList.toggle('active',selected);
        s.hidden=!selected;
    });
    document.querySelectorAll('.tab-btn').forEach(b => {
        const selected=b.dataset.shadowTab===id;
        b.classList.toggle('active',selected);
        b.setAttribute('aria-selected',String(selected));
        b.tabIndex=selected?0:-1;
    });
    if(el) el.focus();
}

// Toast
function showToast(msg, type='ok') {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast '+type;
    t.style.display = 'block';
    clearTimeout(t.__t);
    t.__t = setTimeout(() => t.style.display='none', 3500);
}

// Restore tab from hash
window.addEventListener('DOMContentLoaded', () => {
    const hash = window.location.hash.replace('#','');
    const btn = [...document.querySelectorAll('.tab-btn')].find(tab => tab.dataset.shadowTab === hash);
    if(btn) showTab(hash, btn);
});

// Save tab state
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab=btn.dataset.shadowTab;
        showTab(tab,btn);
        window.location.hash=tab;
    });
    btn.addEventListener('keydown',event => {
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        const tabs=[...document.querySelectorAll('.tab-btn')];
        let index=tabs.indexOf(btn);
        if(event.key==='Home') index=0;
        else if(event.key==='End') index=tabs.length-1;
        else index=(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
        tabs[index].click();
    });
});

function readCookie(name){
    for(const part of String(document.cookie||'').split(';')){
        const idx=part.indexOf('='); if(idx<0) continue;
        if(part.slice(0,idx).trim()!==name) continue;
        try{return decodeURIComponent(part.slice(idx+1).trim());}catch{return '';}
    }
    return '';
}


document.querySelectorAll('form[method="POST"]').forEach(form => {
    form.addEventListener('submit',async event => {
        event.preventDefault();
        const button=form.querySelector('button[type="submit"]');
        const data=new URLSearchParams(new FormData(form));
        const action=String(data.get('action')||'');
        data.set('request_id',globalThis.crypto?.randomUUID?.()||String(Date.now()));
        if(button){button.disabled=true;button.setAttribute('aria-busy','true');}
        const response=await fetch('/api/v1/telemetry/snapshot/actions',{
            method:'POST',
            credentials:'same-origin',
            headers:{'content-type':'application/x-www-form-urlencoded','x-csrf-token':readCookie('__da_csrf')},
            body:data.toString()
        }).catch(()=>null);
        const result=await response?.json?.().catch(()=>null);
        if(response?.ok && result?.success){
            showToast('✅ บันทึกการเปลี่ยนแปลงแล้ว','ok');
            setTimeout(()=>window.location.reload(),250);
            return;
        }
        if(button){button.disabled=false;button.removeAttribute('aria-busy');}
        showToast('❌ '+String(result?.code||'ดำเนินการไม่สำเร็จ'),'err');
    });
});

document.getElementById('shadowLogout')?.addEventListener('click',async event=>{
    const button=event.currentTarget;
    if(button.disabled)return;
    button.disabled=true;
    button.setAttribute('aria-busy','true');
    try{
        const response=await fetch('/api/v1/telemetry/snapshot/logout',{
            method:'POST',credentials:'same-origin',
            headers:{'content-type':'application/x-www-form-urlencoded','x-csrf-token':readCookie('__da_csrf')},
            body:''
        });
        const result=await response.json().catch(()=>null);
        if(response.ok && result?.success){
            window.location.replace('/');
            return;
        }
    }catch{}
    button.disabled=false;
    button.removeAttribute('aria-busy');
    showToast('❌ ออกจากระบบไม่สำเร็จ ลองใหม่อีกครั้ง','err');
});
</script>

</body></html>`;
}

module.exports = {
    renderShadowDashboardPage,
    _test: {
        escapeHtml,
        hiddenInput
    }
};
