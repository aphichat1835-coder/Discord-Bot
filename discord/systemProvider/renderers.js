const { escapeHtml, hiddenInput, htmlTag } = require("./htmlUtils");
const { isDiscordSnowflake } = require("../core/snowflakes");
const { requirePublicBaseUrl } = require("../core/publicUrl");

function safeDiscordId(value) {
    const text = String(value ?? "").trim();
    return isDiscordSnowflake(text) ? text : "unknown";
}

function safePortalBaseUrl(value) {
    try {
        const configured = value || requirePublicBaseUrl(process.env, { developmentFallback: "http://localhost:3000" });
        const url = new URL(String(configured));
        if (String(process.env.NODE_ENV || "").toLowerCase() === "production" && url.protocol !== "https:") return "";
        if (!["http:", "https:"].includes(url.protocol)) return "";
        return url.origin;
    } catch {
        return "";
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
            <button type="submit" class="btn btn-sm btn-danger" aria-label="ลบผู้มีสิทธิ์ ${escapeHtml(vipId)}">ลบ</button>
        </form>`
    ]);
}

function buildShadowGuildRows(mainClient, context) {
    if (!mainClient) return '<tr><td colspan="4" role="status" style="text-align:center;color:var(--text3);">บอทออฟไลน์ จึงโหลดเซิร์ฟเวอร์ไม่ได้</td></tr>';
    return [...mainClient.guilds.cache.values()].map(g => {
        const guildId = safeDiscordId(g.id);
        const arm = context.armedGuilds.get(guildId);
        const armed = Boolean(arm && Number(arm.expiresAt) > Date.now());
        const expiryText = armed ? `<div style="font-size:0.68em;color:var(--text3);margin-top:3px;">หมดอายุ <t:${Math.floor(Number(arm.expiresAt) / 1000)}:R></div>` : "";
        return `<tr>
            <td>${escapeHtml(g.name)} <span style="color:var(--text3);font-size:0.75em;">(${escapeHtml(guildId)})</span></td>
            <td style="text-align:center;">${escapeHtml(g.memberCount)}</td>
            <td style="text-align:center;">
                <span class="badge ${armed ? 'badge-armed' : 'badge-safe'}">${armed ? '🔴 ARMED' : '🟢 SAFE'}</span>${expiryText}
            </td>
            <td style="text-align:center;">
                <form method="POST" style="display:inline;margin:0;">
                    ${hiddenInput("action", armed ? "disarm_guild" : "arm_guild")}
                    ${hiddenInput("guild_id", guildId)}
                    <button type="submit" class="btn btn-sm ${armed ? 'btn-success' : 'btn-danger'}" aria-label="${armed ? 'ยกเลิกสถานะเป้าหมายของ' : 'กำหนดเป็นเป้าหมาย'} ${escapeHtml(g.name)}">${armed ? '🔓 ยกเลิกเป้าหมาย' : '🎯 กำหนดเป้าหมาย'}</button>
                </form>
            </td>
        </tr>`;
    }).join('');
}

function buildShadowVipRows(context) {
    return [...context.globalAdminCache].map(id => renderVipRow(id)).join('')
        || '<div role="status" style="color:var(--text3);font-size:0.82em;text-align:center;padding:12px 0;">ยังไม่มีผู้ใช้ที่ได้รับสิทธิ์เพิ่มเติม</div>';
}

function buildShadowSessionRows(mainClient, context) {
    try {
        const sessions = Array.from(context.sessionManager.getAllSessions().values());
        if (!sessions.length) {
            return '<tr><td colspan="4" role="status" style="text-align:center;color:var(--text3);">ไม่มี Session ที่กำลังทำงาน</td></tr>';
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
                        <button type="submit" class="btn btn-sm ${isProtected ? 'btn-warn' : 'btn-purple'}" aria-pressed="${isProtected}">${isProtected ? '🛡️ ป้องกันอยู่' : '🔓 เปิดการป้องกัน'}</button>
                    </form>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        context.logSuppressedError("render voice session rows", e);
        return '<tr><td colspan="4" role="alert" style="text-align:center;color:var(--text3);">โหลด Session ไม่สำเร็จ</td></tr>';
    }
}

function shadowCommandManual() {
    return [
        { name: "Diagnostics", desc: "ข้อมูลวินิจฉัยที่เปิดใช้งานตาม Capability", tag: "normal", new: false },
        { name: "High-impact controls", desc: "ปิดเป็นค่าเริ่มต้นและต้องผ่าน Owner step-up, TTL และ Audit", tag: "armed", new: false }
    ];
}

function buildShadowCommandRows() {
    return shadowCommandManual().map(item => `
        <div class="cmd-card">
            <div class="cmd-name">${escapeHtml(item.name)}</div>
            <div class="cmd-desc">${escapeHtml(item.desc)}</div>
        </div>`).join("");
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
                <button type="submit" class="badge ${val ? 'badge-on' : 'badge-off'}" aria-pressed="${val}" style="cursor:pointer;border:none;padding:7px 12px;min-height:36px;">${val ? '✅ เปิด' : '❌ ปิด'}</button>
            </form>
        </div>`;
    }).join('');
}

function buildShadowPortalViewData(mainClient, context) {
    return {
        portalBaseUrl: escapeHtml(safePortalBaseUrl()),
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
        cmdRows: buildShadowCommandRows(),
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
