/*
================================================================================
  Dashboard Public v2 — Guild Dashboard JS
  Theme: Discord + Security Dashboard

  หน้าที่:
  - โหลด overview/config/members/logs/risk ของ guild
  - แสดงข้อมูล verification ให้ละเอียดเป็นหมวด
  - ตั้งค่า verification ผ่านเว็บ
  - preview embed/button
  - validate config
  - send panel ใหม่
  - update/edit panel เดิมใน Discord
  - แสดง raw IP ถ้า backend ส่งมา
================================================================================
*/

(function () {
  "use strict";

  const state = {
    guildId: "",
    currentGuild: null,
    currentConfig: null,
    overviewData: null,
    resources: null,

    logsPage: 0,
    membersPage: 0,

    lastValidation: null,
    saving: false,
    sendingPanel: false,
    updatingPanel: false,

    activeTab: "overview"
  };

  const $ = (id) => document.getElementById(id);

  const SELECTORS = {
    sidebarToggle: "sidebar-toggle",
    sidebarClose: "sidebar-close",
    sidebarBackdrop: "sidebar-backdrop",
    toast: "toast",

    guildTitle: "guild-title",
    guildSubtitle: "guild-subtitle",
    sideName: "side-name",
    sideId: "side-id",
    sidePerm: "side-perm",
    sideIcon: "side-icon",

    statTotal: "stat-total",
    statSuccess: "stat-success",
    statBlocked: "stat-blocked",
    statRisk: "stat-risk",
    statRate: "stat-rate",
    statVpn: "stat-vpn",
    statProxy: "stat-proxy",
    statTor: "stat-tor",
    statPending: "stat-pending",

    overviewEnabled: "overview-enabled",
    overviewRole: "overview-role",
    overviewChannel: "overview-channel",
    overviewMessage: "overview-message",
    overviewMode: "overview-mode",
    overviewUpdated: "overview-updated",
    overviewSource: "overview-source",
    overviewLogs: "overview-logs",
    overviewMembers: "overview-members",

    validationBox: "validation-box",
    validationBody: "validation-body",

    membersBody: "members-body",
    membersPage: "members-page",
    logsBody: "logs-body",
    logsPage: "logs-page",

    riskCountries: "risk-countries",
    riskIsps: "risk-isps",
    riskDevices: "risk-devices",
    riskReasons: "risk-reasons",
    riskRecent: "risk-recent"
  };

  function qs(selector, root = document) {
    return root.querySelector(selector);
  }

  function qsa(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function h(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function compact(value, fallback = "—") {
    if (value === null || value === undefined || value === "") return fallback;
    return String(value);
  }

  function boolText(value) {
    return value ? "ใช่" : "ไม่ใช่";
  }

  function yesNoBadge(value) {
    return value
      ? '<span class="badge badge-ok">ใช่</span>'
      : '<span class="badge badge-muted">ไม่ใช่</span>';
  }

  function normalizeVerifyMode(value) {
    const raw = String(value || "").toLowerCase().trim();

    if (
      raw === "direct" ||
      raw === "direct-role" ||
      raw === "instant" ||
      raw === "button"
    ) {
      return "direct";
    }

    return "oauth";
  }

  function verifyModeLabel(value) {
    const mode = normalizeVerifyMode(value);
    return mode === "direct" ? "กดรับยศทันที" : "OAuth2 Verification";
  }

  function fmtTime(ts) {
    if (!ts) return "—";

    try {
      return new Date(ts).toLocaleString("th-TH", {
        dateStyle: "medium",
        timeStyle: "short"
      });
    } catch {
      return String(ts);
    }
  }

  function fmtDateShort(ts) {
    if (!ts) return "—";

    try {
      return new Date(ts).toLocaleDateString("th-TH", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      });
    } catch {
      return String(ts);
    }
  }

  function fmtNumber(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n.toLocaleString("th-TH") : "0";
  }

  function fmtPercent(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? `${n}%` : "0%";
  }

  function getGuildIdFromPath() {
    const parts = location.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("guild");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];

    return parts[parts.length - 1] || "";
  }

  function iconUrl(guild) {
    if (!guild?.id || !guild?.icon) return "";
    return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=128`;
  }

  function initials(name) {
    const clean = String(name || "S").trim();
    const parts = clean.split(/\s+/).filter(Boolean).slice(0, 2);
    return parts.map((p) => p[0]).join("").toUpperCase() || clean[0]?.toUpperCase() || "S";
  }

  function riskBadge(score) {
    const n = Number(score || 0);

    if (n >= 70) return `<span class="badge badge-danger">${h(n)}</span>`;
    if (n >= 35) return `<span class="badge badge-warn">${h(n)}</span>`;
    return `<span class="badge badge-ok">${h(n)}</span>`;
  }

  function resultBadge(result) {
    const raw = String(result || "failed").toLowerCase();

    if (raw === "success" || raw === "ok") {
      return '<span class="badge badge-ok">success</span>';
    }

    if (raw === "blocked") {
      return '<span class="badge badge-blocked">blocked</span>';
    }

    if (raw === "pending") {
      return '<span class="badge badge-warn">pending</span>';
    }

    return '<span class="badge badge-failed">failed</span>';
  }

  function statusBadge(value, onLabel = "Enabled", offLabel = "Disabled") {
    return value
      ? `<span class="badge badge-ok">${h(onLabel)}</span>`
      : `<span class="badge badge-failed">${h(offLabel)}</span>`;
  }

  function snowflakeOrEmpty(value) {
    const v = String(value || "").trim();
    if (!v) return "";
    return /^\d{17,22}$/.test(v) ? v : null;
  }

  function readBool(id) {
    const el = $(id);
    return !!el?.checked;
  }

  function readText(id) {
    const el = $(id);
    return String(el?.value || "").trim();
  }

  function readValue(id) {
    const el = $(id);
    return el?.value ?? "";
  }

  function setText(id, value, fallback = "—") {
    const el = $(id);
    if (el) el.textContent = compact(value, fallback);
  }

  function setHtml(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  function setInput(id, value) {
    const el = $(id);
    if (el) el.value = value ?? "";
  }

  function setChecked(id, value) {
    const el = $(id);
    if (el) el.checked = !!value;
  }

  function setSelect(id, value, fallback = "") {
    const el = $(id);
    if (!el) return;

    const next = value ?? fallback;
    const values = Array.from(el.options).map((option) => option.value);

    el.value = values.includes(String(next)) ? String(next) : fallback;
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function normalizePolicyAction(value, fallback = "log_only") {
    const actions = ["off", "log_only", "delay", "block"];
    return actions.includes(String(value || "")) ? String(value) : fallback;
  }

  function defaultAntiAltConfig(value = {}) {
    const raw = value && typeof value === "object" ? value : {};

    return {
      enabled: raw.enabled === true,
      ipDuplicateAction: normalizePolicyAction(raw.ipDuplicateAction, "log_only"),
      maxUsersPerIp: clampNumber(raw.maxUsersPerIp, 1, 20, 3),
      deviceDuplicateAction: normalizePolicyAction(raw.deviceDuplicateAction, "log_only"),
      maxUsersPerDevice: clampNumber(raw.maxUsersPerDevice, 1, 20, 2),
      previouslyBlockedIpAction: normalizePolicyAction(raw.previouslyBlockedIpAction, "delay"),
      spoofedHeaderAction: normalizePolicyAction(raw.spoofedHeaderAction, "delay"),
      unknownLookupAction: normalizePolicyAction(raw.unknownLookupAction, "delay"),
      delayMs: clampNumber(raw.delayMs, 0, 10000, 5000)
    };
  }

  function showToast(message, type = "ok") {
    const el = $(SELECTORS.toast);
    if (!el) return;

    el.className = `toast ${type}`;
    el.textContent = message;

    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      el.className = "toast";
      el.textContent = "";
    }, 3600);
  }

  function setButtonLoading(btn, loading, loadingText = "กำลังทำงาน...") {
    if (!btn) return;

    if (loading) {
      btn.dataset.oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = loadingText;
      return;
    }

    btn.disabled = false;
    btn.textContent = btn.dataset.oldText || btn.textContent;
  }

  async function api(path, options = {}) {
    const headers = options.headers ?? {};
    const res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers
      }
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data || data.success === false) {
      throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
    }

    return data;
  }

  async function copyText(value, label = "คัดลอกแล้ว") {
    try {
      await navigator.clipboard.writeText(String(value || ""));
      showToast(label, "ok");
    } catch {
      showToast("คัดลอกไม่ได้", "err");
    }
  }

  function openSidebar() {
    document.body.classList.add("sidebar-open", "no-scroll");
  }

  function closeSidebar() {
    document.body.classList.remove("sidebar-open", "no-scroll");
  }

  function bindSidebar() {
    const toggle = $(SELECTORS.sidebarToggle);
    const close = $(SELECTORS.sidebarClose);
    const backdrop = $(SELECTORS.sidebarBackdrop);

    if (toggle) toggle.addEventListener("click", openSidebar);
    if (close) close.addEventListener("click", closeSidebar);
    if (backdrop) backdrop.addEventListener("click", closeSidebar);

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeSidebar();
    });
  }

  function switchTab(tab) {
    state.activeTab = tab;

    qsa("[data-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });

    qsa("[data-section]").forEach((section) => {
      section.classList.toggle("hidden", section.dataset.section !== tab);
    });

    closeSidebar();

    if (tab === "members") loadMembers(state.membersPage);
    if (tab === "logs") loadLogs(state.logsPage);
    if (tab === "risk") loadRisk();
    if (tab === "verification") renderEmbedPreview();
  }

  function bindTabs() {
    qsa("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
  }

  function getCurrentVerification() {
    const config = state.currentConfig || {};
    return config.verification || {};
  }

  function getCurrentPanel() {
    const verification = getCurrentVerification();
    return verification.panel || {};
  }

  function updateGuildInfo(guild) {
    state.currentGuild = guild || state.currentGuild || {};

    const name = state.currentGuild.name || "Server Dashboard";
    const id = state.currentGuild.id || state.guildId;
    const icon = iconUrl(state.currentGuild);

    setText(SELECTORS.guildTitle, name);
    setText(SELECTORS.guildSubtitle, `Guild ID: ${id}`);
    setText(SELECTORS.sideName, name);
    setText(SELECTORS.sideId, id);
    setText(SELECTORS.sidePerm, state.currentGuild.owner ? "Owner/Admin access" : "Admin access");

    const sideIcon = $(SELECTORS.sideIcon);
    if (sideIcon) {
      if (icon) {
        sideIcon.innerHTML = `<img src="${h(icon)}" alt="">`;
      } else {
        sideIcon.textContent = initials(name);
      }
    }
  }

  function getPanelMode(verification = {}, panel = {}) {
    return normalizeVerifyMode(
      panel.verifyType ||
      verification.oauthMode ||
      verification.verifyType ||
      "oauth"
    );
  }

  function fillVerificationCore(verification = {}) {
    setChecked("v-enabled", verification.enabled !== false);
    setInput("v-roleId", verification.roleId || "");
    setInput("v-channelId", verification.channelId || "");
    setInput("v-messageId", verification.messageId || "");
  }

  function fillPanelConfig(panel = {}, mode = "oauth") {
    setInput("p-content", panel.content || "");
    setInput("p-title", panel.title || "");
    setInput("p-description", panel.description || "");
    setInput("p-color", panel.color || "#5865F2");
    setInput("p-imageUrl", panel.imageUrl || "");
    setInput("p-thumbnailUrl", panel.thumbnailUrl || "");
    setInput("p-footerText", panel.footerText || "");
    setInput("p-titleUrl", panel.titleUrl || "");
    setInput("p-buttonText", panel.buttonText || panel.buttonLabel || "✅ ยืนยันตัวตน ✅");
    setSelect("p-verifyType", mode, "oauth");
    setChecked("p-showTimestamp", !!panel.showTimestamp);
  }

  function fillAntiAltConfig(antiAltConfig = {}) {
    const antiAlt = defaultAntiAltConfig(antiAltConfig);

    setChecked("v-antiAltEnabled", !!antiAlt.enabled);
    setSelect("v-ipDuplicateAction", antiAlt.ipDuplicateAction, "log_only");
    setInput("v-maxUsersPerIp", antiAlt.maxUsersPerIp);
    setSelect("v-deviceDuplicateAction", antiAlt.deviceDuplicateAction, "log_only");
    setInput("v-maxUsersPerDevice", antiAlt.maxUsersPerDevice);
    setSelect("v-previouslyBlockedIpAction", antiAlt.previouslyBlockedIpAction, "delay");
    setSelect("v-spoofedHeaderAction", antiAlt.spoofedHeaderAction, "delay");
    setSelect("v-unknownLookupAction", antiAlt.unknownLookupAction, "delay");
    setInput("v-securityDelayMs", antiAlt.delayMs);
  }

  function fillVerificationPolicy(verification = {}) {
    setChecked("v-blockVPN", verification.blockVPN !== false);
    setChecked("v-blockHosting", !!verification.blockHosting);
    setChecked("v-requireEmail", !!verification.requireEmail);
    setChecked("v-requireEmailVerified", !!verification.requireEmailVerified);
    setChecked("v-requireConnections", !!verification.requireConnections);
    setInput("v-minAge", verification.minAccountAgeDays ?? 7);
    setInput("v-minConnections", verification.minConnections ?? 1);
    setInput("v-allowedCountries", Array.isArray(verification.allowedCountries) ? verification.allowedCountries.join(",") : "");
    setInput("v-blockedCountries", Array.isArray(verification.blockedCountries) ? verification.blockedCountries.join(",") : "");
  }

  function fillConfig(config) {
    state.currentConfig = config || {};
    const verification = state.currentConfig.verification || {};
    const panel = verification.panel || {};
    const mode = getPanelMode(verification, panel);

    fillVerificationCore(verification);
    fillPanelConfig(panel, mode);
    fillAntiAltConfig(verification.antiAlt || {});
    fillVerificationPolicy(verification);

    updateOverviewConfig();
    renderEmbedPreview();
  }

  function updateOverviewConfig() {
    const verification = getCurrentVerification();
    const panel = getCurrentPanel();
    const mode = normalizeVerifyMode(panel.verifyType || verification.oauthMode || verification.verifyType);

    const enabledEl = $(SELECTORS.overviewEnabled);
    if (enabledEl) {
      enabledEl.className = verification.enabled === false ? "badge badge-failed" : "badge badge-ok";
      enabledEl.textContent = verification.enabled === false ? "Disabled" : "Enabled";
    }

    setText(SELECTORS.overviewRole, verification.roleName || verification.roleId || "ยังไม่ได้ตั้งค่า");
    setText(SELECTORS.overviewChannel, verification.channelName || verification.channelId || "ยังไม่ได้ตั้งค่า");
    setText(SELECTORS.overviewMessage, verification.messageId || "ยังไม่มีแผง");
    setText(SELECTORS.overviewMode, verifyModeLabel(mode));
    setText(SELECTORS.overviewUpdated, fmtTime(verification.updatedAt || state.currentConfig?.updatedAt));
    setText(SELECTORS.overviewSource, verification.updatedBy ? `อัปเดตโดย ${verification.updatedBy}` : "ยังไม่มีข้อมูล");
  }

  function renderStats(stats = {}) {
    setText(SELECTORS.statTotal, fmtNumber(stats.total));
    setText(SELECTORS.statSuccess, fmtNumber(stats.success));
    setText(SELECTORS.statBlocked, fmtNumber(stats.blocked));
    setText(SELECTORS.statRisk, fmtNumber(stats.highRisk));
    setText(SELECTORS.statRate, `Success rate ${fmtPercent(stats.successRate)}`);
    setText(SELECTORS.statVpn, fmtNumber(stats.vpn));
    setText(SELECTORS.statProxy, fmtNumber(stats.proxy));
    setText(SELECTORS.statTor, fmtNumber(stats.tor));
    setText(SELECTORS.statPending, fmtNumber(stats.pendingReveal));
  }

    function renderOverviewLogs(logs = []) {
    const box = $(SELECTORS.overviewLogs);
    if (!box) return;

    if (!logs.length) {
      box.innerHTML = '<div class="empty">ยังไม่มีประวัติการยืนยัน</div>';
      return;
    }

    box.innerHTML = logs.slice(0, 8).map((log) => renderCompactVerifyLog(log)).join("");
  }

  function renderOverviewMembers(members = []) {
    const box = $(SELECTORS.overviewMembers);
    if (!box) return;

    if (!members.length) {
      box.innerHTML = '<div class="empty">ยังไม่มีสมาชิกที่ยืนยันสำเร็จ</div>';
      return;
    }

    box.innerHTML = members.slice(0, 8).map((member) => `
      <div class="list-item">
        <div class="list-title">
          <span>${h(member.globalName || member.username || "Unknown")}</span>
          ${riskBadge(member.riskScore)}
        </div>
        <div class="list-meta">
          User ID: <span class="mono">${h(member.userId)}</span><br>
          อายุบัญชี: ${h(member.accountAgeDays ?? "—")} วัน · Connections: ${h(member.connections ?? 0)}<br>
          IP: <span class="mono">${h(member.rawIp || member.ip || "—")}</span><br>
          Network: ${h(member.countryCode || "unknown")} / ${h(member.city || "unknown")} / ${h(member.isp || "unknown")}<br>
          Device: ${h(member.device?.browser || member.browser || "unknown")} / ${h(member.device?.os || member.os || "unknown")}
        </div>
      </div>
    `).join("");
  }

  function renderRiskList(id, items = [], empty = "ไม่มีข้อมูล") {
    const box = $(id);
    if (!box) return;

    if (!items.length) {
      box.innerHTML = `<div class="empty">${h(empty)}</div>`;
      return;
    }

    box.innerHTML = items.map((item) => `
      <div class="list-item">
        <div class="list-title">
          <span>${h(item.label || item.name || "unknown")}</span>
          <span class="badge badge-info">${h(item.count || 0)}</span>
        </div>
        ${item.detail ? `<div class="list-meta">${h(item.detail)}</div>` : ""}
      </div>
    `).join("");
  }

  function renderRisk(risk = {}) {
    renderRiskList(SELECTORS.riskCountries, risk.countries || [], "ไม่มีข้อมูลประเทศ");
    renderRiskList(SELECTORS.riskIsps, risk.isps || [], "ไม่มีข้อมูล ISP");
    renderRiskList(SELECTORS.riskDevices, risk.devices || [], "ไม่มีข้อมูลอุปกรณ์");
    renderRiskList(SELECTORS.riskReasons, risk.reasons || [], "ไม่มีเหตุผล fail/block");

    const recent = risk.recentRiskLogs || [];
    const box = $(SELECTORS.riskRecent);

    if (!box) return;

    if (!recent.length) {
      box.innerHTML = '<div class="empty">ยังไม่มี risk logs</div>';
      return;
    }

    box.innerHTML = recent.map((log) => renderDetailedVerifyLog(log)).join("");
  }

  function renderCompactVerifyLog(log = {}) {
    const username = log.globalName || log.username || log.tag || log.userId || "Unknown";
    const ip = log.rawIp || log.ip || log.ipInfo?.ip || "—";
    const location = [
      log.ipInfo?.countryCode || log.countryCode,
      log.ipInfo?.city || log.city,
      log.ipInfo?.isp || log.isp
    ].filter(Boolean).join(" / ") || "unknown";

    return `
      <div class="list-item">
        <div class="list-title">
          <span>${resultBadge(log.result)} ${h(username)}</span>
          ${riskBadge(log.riskScore)}
        </div>
        <div class="list-meta">
          User ID: <span class="mono">${h(log.userId || "—")}</span><br>
          เหตุผล: ${h(log.reason || "—")}<br>
          IP: <span class="mono">${h(ip)}</span><br>
          พื้นที่/เครือข่าย: ${h(location)}<br>
          เวลา: ${h(fmtTime(log.verifiedAt || log.createdAt))}
        </div>
      </div>
    `;
  }

  function renderSensitiveNotice(log = {}) {
    if (!log.sensitiveRedacted) return "";

    return `<div class="notice notice-warn mb-12">ข้อมูล sensitive ถูกซ่อนอยู่ เพราะยังไม่ได้รับ owner approval หรือ approval หมดอายุ</div>`;
  }

  function renderDiscordDetail(log = {}, user = {}) {
    return `
      <b>บัญชี Discord</b><br>
      User ID: <span class="mono">${h(log.userId || user.id || "—")}</span><br>
      Username: ${h(user.username || log.username || "—")}<br>
      Global name: ${h(user.globalName || log.globalName || "—")}<br>
      Email: ${h(user.email || log.email || "—")} · Verified: ${h(boolText(user.verified ?? log.emailVerified))}<br>
      Locale: ${h(user.locale || log.locale || "—")} · Flags: ${h(user.flags ?? log.flags ?? "—")}<br><br>
    `;
  }

  function renderMemberDetail(log = {}, roles = []) {
    return `
      <b>สมาชิกในเซิร์ฟเวอร์</b><br>
      Nickname: ${h(log.memberNick || log.nickname || "—")}<br>
      Joined at: ${h(fmtTime(log.joinedAt))}<br>
      Roles: ${roles.length ? roles.map(h).join(", ") : "—"}<br><br>
    `;
  }

  function renderNetworkDetail(log = {}, ipInfo = {}) {
    const rawIp = log.rawIp || log.ip || ipInfo.rawIp || ipInfo.ip || "—";

    return `
      <b>Network / IP</b><br>
      Raw IP: <span class="mono">${h(rawIp)}</span><br>
      Country: ${h(ipInfo.country || ipInfo.countryCode || log.countryCode || "—")}
      · City: ${h(ipInfo.city || log.city || "—")}<br>
      ISP: ${h(ipInfo.isp || log.isp || "—")}
      · ASN: ${h(ipInfo.asn || log.asn || "—")}<br>
      VPN: ${h(boolText(ipInfo.isVPN ?? log.isVPN))}
      · Proxy: ${h(boolText(ipInfo.isProxy ?? log.isProxy))}
      · TOR: ${h(boolText(ipInfo.isTOR ?? log.isTOR))}
      · Hosting: ${h(boolText(ipInfo.isHosting ?? log.isHosting))}<br><br>
    `;
  }

  function renderDeviceDetail(log = {}, device = {}) {
    return `
      <b>Device / Browser</b><br>
      Browser: ${h(device.browser || log.browser || "—")}
      · OS: ${h(device.os || log.os || "—")}
      · Platform: ${h(device.platform || log.platform || "—")}<br>
      Timezone: ${h(device.timezone || log.timezone || "—")}
      · Language: ${h(device.language || log.language || "—")}<br>
      Screen: ${h(device.screenSize || log.screenSize || "—")}
      · Viewport: ${h(device.viewportSize || log.viewportSize || "—")}<br><br>
    `;
  }

  function renderConnectionDetail(log = {}, connections = [], guilds = []) {
    const connectionList = connections.length
      ? `Connections list: ${connections.map((c) => h(c.type || c.name || "unknown")).join(", ")}<br>`
      : "";
    const guildList = guilds.length
      ? `Guild sample: ${guilds.slice(0, 12).map((g) => h(g.name || g.id || "unknown")).join(", ")}<br>`
      : "";

    return `
      <b>Connections / Guilds</b><br>
      Connections: ${h(log.connectionsCount ?? connections.length ?? 0)}
      · Guilds: ${h(log.guildsCount ?? guilds.length ?? 0)}<br>
      ${connectionList}
      ${guildList}
    `;
  }

  function renderVerificationResultDetail(log = {}) {
    return `
      <br><b>ผลการยืนยัน</b><br>
      Reason: ${h(log.reason || "—")}<br>
      Policy: ${h(log.policyResult || log.policy || "—")}<br>
      Role result: ${h(log.roleResult || log.roleAssignmentResult || "—")}<br>
      Request ID: <span class="mono">${h(log.requestId || "—")}</span><br>
      Time: ${h(fmtTime(log.verifiedAt || log.createdAt))}
    `;
  }

  function renderDetailedVerifyLog(log = {}) {
    const user = log.user || {};
    const ipInfo = log.ipInfo || {};
    const device = log.device || {};
    const connections = Array.isArray(log.connections) ? log.connections : [];
    const guilds = Array.isArray(log.guilds) ? log.guilds : [];
    const roles = Array.isArray(log.memberRoles) ? log.memberRoles : [];

    return `
      <div class="list-item sensitive">
        ${renderSensitiveNotice(log)}
        <div class="list-title">
          <span>${resultBadge(log.result)} ${h(user.globalName || log.globalName || user.username || log.username || log.userId || "Unknown")}</span>
          ${riskBadge(log.riskScore)}
        </div>

        <div class="list-meta">
          ${renderDiscordDetail(log, user)}
          ${renderMemberDetail(log, roles)}
          ${renderNetworkDetail(log, ipInfo)}
          ${renderDeviceDetail(log, device)}
          ${renderConnectionDetail(log, connections, guilds)}
          ${renderVerificationResultDetail(log)}
        </div>
      </div>
    `;
  }

  function collectSettings() {
    const roleId = snowflakeOrEmpty(readText("v-roleId"));
    const channelId = snowflakeOrEmpty(readText("v-channelId"));
    const messageId = snowflakeOrEmpty(readText("v-messageId"));

    if (roleId === null) throw new Error("Role ID ต้องเป็นตัวเลข 17–22 หลัก");
    if (channelId === null) throw new Error("Channel ID ต้องเป็นตัวเลข 17–22 หลัก หรือปล่อยว่าง");
    if (messageId === null) throw new Error("Message ID ต้องเป็นตัวเลข 17–22 หลัก หรือปล่อยว่าง");

    const mode = normalizeVerifyMode(readValue("p-verifyType"));

    return {
      enabled: readBool("v-enabled"),
      roleId: roleId || null,
      channelId: channelId || null,
      messageId: messageId || null,

      blockVPN: readBool("v-blockVPN"),
      blockHosting: readBool("v-blockHosting"),
      antiAlt: {
        enabled: readBool("v-antiAltEnabled"),
        ipDuplicateAction: normalizePolicyAction(readValue("v-ipDuplicateAction"), "log_only"),
        maxUsersPerIp: clampNumber(readText("v-maxUsersPerIp"), 1, 20, 3),
        deviceDuplicateAction: normalizePolicyAction(readValue("v-deviceDuplicateAction"), "log_only"),
        maxUsersPerDevice: clampNumber(readText("v-maxUsersPerDevice"), 1, 20, 2),
        previouslyBlockedIpAction: normalizePolicyAction(readValue("v-previouslyBlockedIpAction"), "delay"),
        spoofedHeaderAction: normalizePolicyAction(readValue("v-spoofedHeaderAction"), "delay"),
        unknownLookupAction: normalizePolicyAction(readValue("v-unknownLookupAction"), "delay"),
        delayMs: clampNumber(readText("v-securityDelayMs"), 0, 10000, 5000)
      },
      requireEmail: readBool("v-requireEmail"),
      requireEmailVerified: readBool("v-requireEmailVerified"),
      requireConnections: readBool("v-requireConnections"),
      minAccountAgeDays: Math.max(0, Math.min(3650, parseInt(readText("v-minAge"), 10) || 0)),
      minConnections: Math.max(1, Math.min(20, parseInt(readText("v-minConnections"), 10) || 1)),
      allowedCountries: readText("v-allowedCountries"),
      blockedCountries: readText("v-blockedCountries"),

      panel: {
        content: readText("p-content"),
        title: readText("p-title"),
        description: readText("p-description"),
        color: readText("p-color") || "#5865F2",
        imageUrl: readText("p-imageUrl"),
        thumbnailUrl: readText("p-thumbnailUrl"),
        footerText: readText("p-footerText"),
        titleUrl: readText("p-titleUrl"),
        buttonText: readText("p-buttonText") || "✅ ยืนยันตัวตน ✅",
        buttonLabel: readText("p-buttonText") || "✅ ยืนยันตัวตน ✅",
        verifyType: mode,
        showTimestamp: readBool("p-showTimestamp")
      }
    };
  }

  function renderEmbedPreview() {
    const box = $("embed-preview");
    const btnBox = $("button-preview");

    if (!box || !btnBox) return;

    const panel = {
      content: readText("p-content"),
      title: readText("p-title") || "🔐 ยืนยันตัวตนเพื่อเข้าดิส",
      description: readText("p-description") || "กดปุ่มด้านล่างเพื่อยืนยันตัวตนผ่าน Discord OAuth2",
      color: readText("p-color") || "#5865F2",
      imageUrl: readText("p-imageUrl"),
      thumbnailUrl: readText("p-thumbnailUrl"),
      footerText: readText("p-footerText"),
      titleUrl: readText("p-titleUrl"),
      buttonText: readText("p-buttonText") || "✅ ยืนยันตัวตน ✅",
      showTimestamp: readBool("p-showTimestamp")
    };

    const color = /^#[0-9A-Fa-f]{6}$/.test(panel.color) ? panel.color : "#5865F2";

    box.style.borderLeftColor = color;

    box.innerHTML = `
      ${panel.content ? `<div class="alert alert-info mb-0" style="margin-bottom:12px;">${h(panel.content)}</div>` : ""}
      <div class="embed-preview-title">
        ${panel.titleUrl ? `<a href="${h(panel.titleUrl)}" target="_blank" rel="noopener noreferrer">${h(panel.title)}</a>` : h(panel.title)}
      </div>
      <div class="embed-preview-desc">${h(panel.description)}</div>
      ${panel.thumbnailUrl ? `<div class="embed-preview-thumb"><img src="${h(panel.thumbnailUrl)}" alt=""></div>` : ""}
      ${panel.imageUrl ? `<div class="embed-preview-img"><img src="${h(panel.imageUrl)}" alt=""></div>` : ""}
      ${panel.footerText || panel.showTimestamp ? `
        <div class="embed-preview-footer">
          ${h(panel.footerText || "Discord Verification System")}
          ${panel.showTimestamp ? ` · ${h(new Date().toLocaleString("th-TH"))}` : ""}
        </div>
      ` : ""}
    `;

    btnBox.innerHTML = `
      <div class="button-preview">${h(panel.buttonText)}</div>
      <div class="field-hint">ปุ่มจริงใน Discord จะถูกสร้างตามโหมด ${h(verifyModeLabel(readValue("p-verifyType")))}</div>
    `;
  }

  function bindPreviewInputs() {
    [
      "p-content",
      "p-title",
      "p-description",
      "p-color",
      "p-imageUrl",
      "p-thumbnailUrl",
      "p-footerText",
      "p-titleUrl",
      "p-buttonText",
      "p-verifyType",
      "p-showTimestamp"
    ].forEach((id) => {
      const el = $(id);
      if (!el) return;

      el.addEventListener("input", renderEmbedPreview);
      el.addEventListener("change", renderEmbedPreview);
    });
  }

  function renderValidation(result) {
    const box = $(SELECTORS.validationBox);
    const body = $(SELECTORS.validationBody);

    if (!box || !body) return;

    if (!result) {
      box.classList.add("hidden");
      body.innerHTML = "";
      return;
    }

    box.classList.remove("hidden");

    const checks = Array.isArray(result.checks) ? result.checks : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const errors = Array.isArray(result.errors) ? result.errors : [];

    const checkHtml = checks.length ? checks.map((check) => `
      <div class="list-item">
        <div class="list-title">
          <span>${check.ok ? "✅" : "❌"} ${h(check.label || check.name || "Check")}</span>
          ${check.ok ? '<span class="badge badge-ok">ผ่าน</span>' : '<span class="badge badge-failed">ไม่ผ่าน</span>'}
        </div>
        ${check.detail ? `<div class="list-meta">${h(check.detail)}</div>` : ""}
      </div>
    `).join("") : '<div class="empty">ยังไม่มีผลตรวจ</div>';

    body.innerHTML = `
      <div class="grid grid-3">
        <div class="stat-card">
          <div class="num" style="color:var(--green-2);">${checks.filter((c) => c.ok).length}</div>
          <div class="label">ผ่าน</div>
        </div>
        <div class="stat-card">
          <div class="num" style="color:var(--yellow-2);">${warnings.length}</div>
          <div class="label">เตือน</div>
        </div>
        <div class="stat-card">
          <div class="num" style="color:var(--red-2);">${errors.length}</div>
          <div class="label">ผิดพลาด</div>
        </div>
      </div>

      ${warnings.length ? `
        <div class="alert alert-warn mt-14">
          ${warnings.map((w) => `⚠️ ${h(w)}`).join("<br>")}
        </div>
      ` : ""}

      ${errors.length ? `
        <div class="alert alert-danger mt-14">
          ${errors.map((e) => `❌ ${h(e)}`).join("<br>")}
        </div>
      ` : ""}

      <div class="list mt-14">${checkHtml}</div>
    `;
  }

  async function validateSettings() {
    const btn = $("btn-validate-panel");

    try {
      const payload = collectSettings();
      setButtonLoading(btn, true, "กำลังตรวจสอบ...");

      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/verify/validate`, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      state.lastValidation = data.validation || data;
      renderValidation(state.lastValidation);

      if (state.lastValidation.ok === false) {
        showToast("ตรวจพบปัญหา กรุณาดูรายละเอียด", "warn");
      } else {
        showToast("ตรวจสอบผ่าน", "ok");
      }

      return state.lastValidation;
    } catch (err) {
      showToast(err.message, "err");
      return null;
    } finally {
      setButtonLoading(btn, false);
    }
  }

  async function saveSettings() {
    const btn = $("btn-save-settings");

    try {
      const payload = collectSettings();
      setButtonLoading(btn, true, "กำลังบันทึก...");

      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/settings`, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      fillConfig(data.config || payload);
      showToast("บันทึกการตั้งค่าแล้ว", "ok");
      await loadOverview();
    } catch (err) {
      showToast(err.message, "err");
    } finally {
      setButtonLoading(btn, false);
    }
  }

  async function sendPanel() {
    const btn = $("btn-send-panel");

    try {
      const payload = collectSettings();
      setButtonLoading(btn, true, "กำลังส่งแผง...");

      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/verify/panel/send`, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      fillConfig(data.config || state.currentConfig);
      showToast("ส่งแผงยืนยันตัวตนใหม่แล้ว", "ok");
      await loadOverview();
    } catch (err) {
      showToast(err.message, "err");
    } finally {
      setButtonLoading(btn, false);
    }
  }

  async function updatePanel() {
    const btn = $("btn-update-panel");

    try {
      const payload = collectSettings();
      setButtonLoading(btn, true, "กำลังแก้แผงเดิม...");

      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/verify/panel/update`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });

      fillConfig(data.config || state.currentConfig);
      showToast("แก้ไขแผงเดิมใน Discord แล้ว", "ok");
      await loadOverview();
    } catch (err) {
      showToast(err.message, "err");
    } finally {
      setButtonLoading(btn, false);
    }
  }
    async function disableVerification() {
    const btn = $("btn-disable-verification");

    if (!confirm("ปิดระบบยืนยันตัวตนของเซิร์ฟเวอร์นี้? แผงเดิมใน Discord จะไม่ถูกลบ")) {
      return;
    }

    try {
      setButtonLoading(btn, true, "กำลังปิด...");
      const payload = collectSettings();

      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/verify/disable`, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      fillConfig(data.config || state.currentConfig);
      showToast("ปิดระบบยืนยันตัวตนแล้ว", "ok");
      await loadOverview();
    } catch (err) {
      showToast(err.message, "err");
    } finally {
      setButtonLoading(btn, false);
    }
  }

  function bindVerificationActions() {
    const save = $("btn-save-settings");
    const validate = $("btn-validate-panel");
    const send = $("btn-send-panel");
    const update = $("btn-update-panel");
    const disable = $("btn-disable-verification");

    if (save) save.addEventListener("click", saveSettings);
    if (validate) validate.addEventListener("click", validateSettings);
    if (send) send.addEventListener("click", sendPanel);
    if (update) update.addEventListener("click", updatePanel);
    if (disable) disable.addEventListener("click", disableVerification);
  }

  function renderResources(resources = {}) {
    const rolesBox = $("role-options");
    const channelsBox = $("channel-options");

    if (rolesBox) {
      const roles = Array.isArray(resources.roles) ? resources.roles : [];

      if (!roles.length) {
        rolesBox.innerHTML = '<div class="empty">โหลดรายการยศไม่ได้ หรือยังไม่มีข้อมูล</div>';
      } else {
        rolesBox.innerHTML = roles.slice(0, 80).map((role) => `
          <button class="btn btn-soft btn-sm" type="button" data-pick-role="${h(role.id)}">
            ${h(role.name)} <span class="mono muted-2">${h(role.id)}</span>
          </button>
        `).join("");
      }
    }

    if (channelsBox) {
      const channels = Array.isArray(resources.channels) ? resources.channels : [];

      if (!channels.length) {
        channelsBox.innerHTML = '<div class="empty">โหลดรายการห้องไม่ได้ หรือยังไม่มีข้อมูล</div>';
      } else {
        channelsBox.innerHTML = channels.slice(0, 80).map((channel) => `
          <button class="btn btn-soft btn-sm" type="button" data-pick-channel="${h(channel.id)}">
            # ${h(channel.name)} <span class="mono muted-2">${h(channel.id)}</span>
          </button>
        `).join("");
      }
    }

    qsa("[data-pick-role]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setInput("v-roleId", btn.dataset.pickRole || "");
        showToast("ใส่ Role ID แล้ว", "ok");
      });
    });

    qsa("[data-pick-channel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setInput("v-channelId", btn.dataset.pickChannel || "");
        showToast("ใส่ Channel ID แล้ว", "ok");
      });
    });
  }

  async function loadResources() {
    try {
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/verify/resources`);
      state.resources = data;
      renderResources(data);
    } catch (err) {
      const rolesBox = $("role-options");
      const channelsBox = $("channel-options");

      if (rolesBox) rolesBox.innerHTML = `<div class="alert alert-warn">โหลดรายการยศไม่ได้: ${h(err.message)}</div>`;
      if (channelsBox) channelsBox.innerHTML = `<div class="alert alert-warn">โหลดรายการห้องไม่ได้: ${h(err.message)}</div>`;
    }
  }

  async function loadOverview() {
    try {
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/overview`);

      state.overviewData = data;

      updateGuildInfo(data.guild || data.currentGuild || data.guildInfo || {});
      fillConfig(data.config || data.guildConfig || state.currentConfig || {});

      renderStats(data.stats || {});
      renderOverviewLogs(data.recentLogs || []);
      renderOverviewMembers(data.recentMembers || []);

      if (data.riskSummary) renderRisk(data.riskSummary);

      return data;
    } catch (err) {
      showToast(`โหลด overview ไม่สำเร็จ: ${err.message}`, "err");

      setHtml("overview-error", `
        <div class="alert alert-danger">
          โหลดข้อมูล dashboard ไม่สำเร็จ: ${h(err.message)}
        </div>
      `);

      return null;
    }
  }

  function buildMembersQuery(page = 0) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", "25");

    const q = readText("members-search");
    const result = readValue("members-result");
    const risk = readValue("members-risk");

    if (q) params.set("q", q);
    if (result) params.set("result", result);
    if (risk) params.set("risk", risk);

    return params.toString();
  }

  async function loadMembers(page = 0) {
    const body = $(SELECTORS.membersBody);
    if (!body) return;

    state.membersPage = Math.max(0, page);
    body.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="loading-box"><div class="spinner"></div><div>กำลังโหลดสมาชิก...</div></div>
        </td>
      </tr>
    `;

    try {
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/members?${buildMembersQuery(state.membersPage)}`);
      const members = Array.isArray(data.members) ? data.members : [];

      if ($(SELECTORS.membersPage)) {
        $(SELECTORS.membersPage).textContent = `หน้า ${state.membersPage + 1}`;
      }

      if (!members.length) {
        body.innerHTML = `
          <tr><td colspan="8"><div class="empty">ไม่พบข้อมูลสมาชิก</div></td></tr>
        `;
        return;
      }

      body.innerHTML = members.map((member) => {
        const ip = member.rawIp || member.ip || member.ipInfo?.ip || "—";
        const location = [
          member.countryCode || member.ipInfo?.countryCode,
          member.city || member.ipInfo?.city,
          member.isp || member.ipInfo?.isp
        ].filter(Boolean).join(" / ") || "—";

        return `
          <tr>
            <td>
              <div style="font-weight:950;">${h(member.globalName || member.username || member.userId || "Unknown")}</div>
              <div class="mono muted-2 small">${h(member.userId || "—")}</div>
              <div class="muted small">${h(member.email || "—")}</div>
            </td>
            <td>${resultBadge(member.result || "success")}</td>
            <td>${riskBadge(member.riskScore)}</td>
            <td>
              <div class="mono">${h(ip)}</div>
              <div class="muted small">${h(location)}</div>
            </td>
            <td>
              <div>${h(member.device?.browser || member.browser || "—")}</div>
              <div class="muted small">${h(member.device?.os || member.os || "—")}</div>
            </td>
            <td>
              <div>${h(member.connectionsCount ?? member.connections ?? 0)} connections</div>
              <div class="muted small">${h(member.guildsCount ?? member.guilds ?? 0)} guilds</div>
            </td>
            <td>${h(fmtTime(member.verifiedAt || member.createdAt))}</td>
            <td>
              <button class="btn btn-soft btn-sm" type="button" data-member-detail="${h(member.userId || "")}">
                รายละเอียด
              </button>
            </td>
          </tr>
        `;
      }).join("");

      qsa("[data-member-detail]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const userId = btn.dataset.memberDetail;
          const detail = members.find((m) => String(m.userId) === String(userId));
          openDetailModal("รายละเอียดสมาชิก", renderDetailedVerifyLog(detail || {}));
        });
      });
    } catch (err) {
      body.innerHTML = `
        <tr><td colspan="8"><div class="alert alert-danger">โหลดสมาชิกไม่สำเร็จ: ${h(err.message)}</div></td></tr>
      `;
    }
  }

  function buildLogsQuery(page = 0) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", "25");

    const result = readValue("logs-result");
    const risk = readValue("logs-risk");
    const q = readText("logs-search");

    if (result) params.set("result", result);
    if (risk) params.set("risk", risk);
    if (q) params.set("q", q);

    return params.toString();
  }

  async function loadLogs(page = 0) {
    const body = $(SELECTORS.logsBody);
    if (!body) return;

    state.logsPage = Math.max(0, page);
    body.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="loading-box"><div class="spinner"></div><div>กำลังโหลด logs...</div></div>
        </td>
      </tr>
    `;

    try {
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/logs?${buildLogsQuery(state.logsPage)}`);
      const logs = Array.isArray(data.logs) ? data.logs : [];

      if ($(SELECTORS.logsPage)) {
        $(SELECTORS.logsPage).textContent = `หน้า ${state.logsPage + 1}`;
      }

      if (!logs.length) {
        body.innerHTML = `
          <tr><td colspan="8"><div class="empty">ยังไม่มี logs</div></td></tr>
        `;
        return;
      }

      body.innerHTML = logs.map((log) => {
        const ip = log.rawIp || log.ip || log.ipInfo?.ip || "—";
        const user = log.user || {};
        const name = user.globalName || log.globalName || user.username || log.username || log.userId || "Unknown";

        return `
          <tr>
            <td>
              <div style="font-weight:950;">${h(name)}</div>
              <div class="mono muted-2 small">${h(log.userId || user.id || "—")}</div>
            </td>
            <td>${resultBadge(log.result)}</td>
            <td>${riskBadge(log.riskScore)}</td>
            <td>
              <div class="mono">${h(ip)}</div>
              <div class="muted small">
                ${h(log.ipInfo?.countryCode || log.countryCode || "—")}
                / ${h(log.ipInfo?.city || log.city || "—")}
              </div>
            </td>
            <td>${h(log.reason || "—")}</td>
            <td>${h(log.roleResult || log.roleAssignmentResult || "—")}</td>
            <td>${h(fmtTime(log.verifiedAt || log.createdAt))}</td>
            <td>
              <button class="btn btn-soft btn-sm" type="button" data-log-detail="${h(log._id || log.id || log.userId || "")}">
                รายละเอียด
              </button>
            </td>
          </tr>
        `;
      }).join("");

      qsa("[data-log-detail]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.logDetail;
          const detail = logs.find((l) => String(l._id || l.id || l.userId) === String(key));
          openDetailModal("รายละเอียด Verify Log", renderDetailedVerifyLog(detail || {}));
        });
      });
    } catch (err) {
      body.innerHTML = `
        <tr><td colspan="8"><div class="alert alert-danger">โหลด logs ไม่สำเร็จ: ${h(err.message)}</div></td></tr>
      `;
    }
  }

  async function loadRisk() {
    try {
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/risk`);
      renderRisk(data.risk || data);
    } catch (err) {
      const box = $(SELECTORS.riskRecent);
      if (box) {
        box.innerHTML = `<div class="alert alert-danger">โหลด risk ไม่สำเร็จ: ${h(err.message)}</div>`;
      }
    }
  }

  function openDetailModal(title, html) {
    const modal = $("detail-modal");
    const titleEl = $("detail-modal-title");
    const body = $("detail-modal-body");

    if (!modal || !body) return;

    if (titleEl) titleEl.textContent = title || "รายละเอียด";
    body.innerHTML = html || "";
    modal.classList.add("show");
    document.body.classList.add("no-scroll");
  }

  function closeDetailModal() {
    const modal = $("detail-modal");
    if (modal) modal.classList.remove("show");
    document.body.classList.remove("no-scroll");
  }

  function bindModal() {
    qsa("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", closeDetailModal);
    });

    const modal = $("detail-modal");
    if (modal) {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeDetailModal();
      });
    }
  }
  function debounce(fn, delay = 350) {
    let timer = null;

    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function bindMembersControls() {
    const prev = $("btn-members-prev");
    const next = $("btn-members-next");
    const refresh = $("btn-members-refresh");

    if (prev) {
      prev.addEventListener("click", () => {
        loadMembers(Math.max(0, state.membersPage - 1));
      });
    }

    if (next) {
      next.addEventListener("click", () => {
        loadMembers(state.membersPage + 1);
      });
    }

    if (refresh) {
      refresh.addEventListener("click", () => {
        loadMembers(state.membersPage);
      });
    }

    const debouncedReload = debounce(() => {
      state.membersPage = 0;
      loadMembers(0);
    }, 350);

    ["members-search", "members-result", "members-risk"].forEach((id) => {
      const el = $(id);
      if (!el) return;

      el.addEventListener("input", debouncedReload);
      el.addEventListener("change", debouncedReload);
    });
  }

  function bindLogsControls() {
    const prev = $("btn-logs-prev");
    const next = $("btn-logs-next");
    const refresh = $("btn-logs-refresh");

    if (prev) {
      prev.addEventListener("click", () => {
        loadLogs(Math.max(0, state.logsPage - 1));
      });
    }

    if (next) {
      next.addEventListener("click", () => {
        loadLogs(state.logsPage + 1);
      });
    }

    if (refresh) {
      refresh.addEventListener("click", () => {
        loadLogs(state.logsPage);
      });
    }

    const debouncedReload = debounce(() => {
      state.logsPage = 0;
      loadLogs(0);
    }, 350);

    ["logs-search", "logs-result", "logs-risk"].forEach((id) => {
      const el = $(id);
      if (!el) return;

      el.addEventListener("input", debouncedReload);
      el.addEventListener("change", debouncedReload);
    });
  }

  function bindUtilityActions() {
    qsa("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        copyText(btn.dataset.copy || "", "คัดลอกแล้ว");
      });
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeDetailModal();
        closeSidebar();
      }
    });
  }

  function syncTabToHash(tab) {
    if (!tab) return;

    try {
      history.replaceState(null, "", `#${encodeURIComponent(tab)}`);
    } catch {
      // ignore
    }
  }

  function bindHashTabs() {
    qsa("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        syncTabToHash(btn.dataset.tab);
      });
    });

    window.addEventListener("hashchange", () => {
      const tab = decodeURIComponent(location.hash.replace(/^#/, "") || "overview");
      const exists = qsa("[data-section]").some((section) => section.dataset.section === tab);

      if (exists) {
        switchTab(tab);
      }
    });
  }

  function updateMobileTitle() {
    const mobile = $("guild-title-mobile");
    const title = $("guild-title");

    if (mobile && title) {
      mobile.textContent = title.textContent || "Guild Dashboard";
    }
  }

  function patchGuildInfoObserver() {
    const title = $("guild-title");
    if (!title) return;

    const observer = new MutationObserver(updateMobileTitle);
    observer.observe(title, {
      childList: true,
      characterData: true,
      subtree: true
    });

    updateMobileTitle();
  }

  async function bootInitialData() {
    if (!state.guildId) {
      showToast("ไม่พบ Guild ID จาก URL", "err");
      setHtml("overview-error", `
        <div class="alert alert-danger">
          ไม่พบ Guild ID จาก URL กรุณากลับไปเลือกเซิร์ฟเวอร์ใหม่
        </div>
      `);

      return;
    }

    await Promise.allSettled([
      loadOverview(),
      loadResources()
    ]);

    const tabFromHash = decodeURIComponent(location.hash.replace(/^#/, "") || "overview");
    const hasTab = qsa("[data-section]").some((section) => section.dataset.section === tabFromHash);

    switchTab(hasTab ? tabFromHash : "overview");
  }

  function init() {
    state.guildId = getGuildIdFromPath();

    bindSidebar();
    bindTabs();
    bindHashTabs();

    bindPreviewInputs();
    bindVerificationActions();

    bindMembersControls();
    bindLogsControls();

    bindModal();
    bindUtilityActions();
    patchGuildInfoObserver();

    bootInitialData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
