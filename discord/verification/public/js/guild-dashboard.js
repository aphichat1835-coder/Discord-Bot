/*
================================================================================
  Owner Verification Dashboard
  Theme: Discord + Security Dashboard

  หน้าที่:
  - โหลด overview/config/members/logs/risk ของ guild
  - แสดงข้อมูล verification ให้ละเอียดเป็นหมวด
  - ตั้งค่า verification ผ่านเว็บ
  - preview embed/button
  - validate config
  - send panel ใหม่
  - update/edit panel เดิมใน Discord
  - เปิด raw IP ผ่าน owner action ที่บังคับ reason และ audit
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

  function badgeElement(label, className) {
    const span = document.createElement("span");
    span.className = `badge ${className}`;
    span.textContent = String(label ?? "");
    return span;
  }

  function resultBadgeElement(result) {
    const raw = String(result || "failed").toLowerCase();
    if (raw === "success" || raw === "ok") return badgeElement("success", "badge-ok");
    if (raw === "blocked") return badgeElement("blocked", "badge-blocked");
    if (raw === "pending") return badgeElement("pending", "badge-warn");
    return badgeElement("failed", "badge-failed");
  }

  function riskBadgeElement(score) {
    const n = Number(score || 0);
    if (n >= 70) return badgeElement(n, "badge-danger");
    if (n >= 35) return badgeElement(n, "badge-warn");
    return badgeElement(n, "badge-ok");
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

  function getCsrfToken() {
    const match = document.cookie.split('; ').find((c) => c.startsWith('__da_csrf='));
    return match ? match.split('=')[1] : '';
  }

  async function api(path, options = {}) {
    const headers = options.headers ?? {};
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
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
    setText(SELECTORS.statPending, fmtNumber(stats.lookupFailed));
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

    box.replaceChildren(...recent.map(buildDetailedVerifyLogElement));
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

  function appendDetailRow(parent, label, value, valueClass = "") {
    const row = document.createElement("div");
    const labelNode = document.createElement("span");
    const valueNode = document.createElement("span");
    labelNode.textContent = `${label}: `;
    valueNode.textContent = String(value ?? "—");
    if (valueClass) valueNode.className = valueClass;
    row.append(labelNode, valueNode);
    parent.appendChild(row);
    return row;
  }

  function detailCardElement(title, rows = [], extraNode = null) {
    const card = document.createElement("div");
    const heading = document.createElement("div");
    const meta = document.createElement("div");
    card.className = "list-item sensitive";
    heading.className = "list-title";
    heading.textContent = title;
    meta.className = "list-meta";
    rows.forEach(([label, value, valueClass]) => appendDetailRow(meta, label, value, valueClass));
    if (extraNode) meta.appendChild(extraNode);
    card.append(heading, meta);
    return card;
  }

  function buildVerificationCardElement(detail = {}) {
    const verification = detail.verification || {};
    const token = detail.oauthTokens || {};
    const sensitive = detail.sensitive || {};
    const revealedOAuth = sensitive.oauth || {};
    const revealedAdminOAuth = sensitive.adminOAuth || {};
    return detailCardElement("Verification / OAuth Token", [
      ["Source", [detail.source?.hasVerifyLog ? "VerifyLog" : "", detail.source?.hasOAuthUser ? "OAuthUser" : ""].filter(Boolean).join(" ") || "—"],
      ["Last result", verification.latest?.result || verification.lastVerify?.result || "—"],
      ["Verified at", fmtTime(verification.latest?.verifiedAt || verification.lastVerify?.verifiedAt)],
      ["OAuth scope", token.oauth?.scope || "—"],
      ["Token type", token.oauth?.tokenType || "—"],
      ["Has access token", boolText(token.oauth?.hasAccessToken)],
      ["Has refresh token", boolText(token.oauth?.hasRefreshToken)],
      ["Expires at", fmtTime(token.oauth?.expiresAt)],
      ["Last refresh at", fmtTime(token.oauth?.lastRefreshAt)],
      ["Refresh failures", token.oauth?.refreshFailCount ?? 0],
      ["Revoked at", fmtTime(token.oauth?.revokedAt)],
      ["Admin OAuth access/refresh", `${boolText(token.adminOAuth?.hasAccessToken)} / ${boolText(token.adminOAuth?.hasRefreshToken)}`],
      ["Access Token", revealedOAuth.accessToken || "ไม่มีข้อมูล", "mono secret-value"],
      ["Refresh Token", revealedOAuth.refreshToken || "ไม่มีข้อมูล", "mono secret-value"],
      ["Admin OAuth Access Token", revealedAdminOAuth.accessToken || "ไม่มีข้อมูล", "mono secret-value"],
      ["Admin OAuth Refresh Token", revealedAdminOAuth.refreshToken || "ไม่มีข้อมูล", "mono secret-value"],
      ["Join result", verification.latest?.joinResult?.status || verification.latest?.joinResult || "—"],
      ["Role assignment", verification.latest?.roleAssignResult?.status || verification.latest?.roleAssignResult || "—"],
      ["Request ID", verification.latest?.requestId || "—", "mono"]
    ]);
  }

  function connectionDetailElement(connection = {}) {
    const item = document.createElement("div");
    const metadataKeys = connection.metadata && typeof connection.metadata === "object" && !Array.isArray(connection.metadata)
      ? Object.keys(connection.metadata)
      : [];
    const integrationCount = Array.isArray(connection.integrations) ? connection.integrations.length : 0;
    item.textContent = `• ${connection.type || "unknown"} — ${connection.name || connection.username || connection.id || "—"} | platform account id: ${connection.id || "—"} · verified: ${boolText(connection.verified)} · visibility: ${connection.visibility ?? "—"} · revoked: ${boolText(connection.revoked)} · integrations: ${integrationCount} · metadata keys: ${metadataKeys.join(", ") || "—"}`;
    if (connection.raw) item.append(rawSnapshotDetailsElement("ข้อมูล Connection ทั้งหมด", connection.raw));
    return item;
  }

  function guildDetailElement(guild = {}) {
    const item = document.createElement("div");
    const permissionFlags = Array.isArray(guild.permissionFlags) ? guild.permissionFlags : [];
    item.textContent = `• ${guild.name || guild.id || "unknown"} (${guild.id || "—"}) | icon: ${guild.iconUrl || guild.icon || "—"} · owner: ${boolText(guild.owner || guild.isOwner)} · admin: ${boolText(guild.isAdmin)} · manage guild: ${boolText(guild.canManageGuild)} · manage roles: ${boolText(guild.canManageRoles)} · ban members: ${boolText(guild.canBanMembers)} · permission bitfield: ${guild.permissions || "0"} · permission labels: ${permissionFlags.join(", ") || "—"}`;
    if (guild.raw) item.append(rawSnapshotDetailsElement("ข้อมูล Guild ทั้งหมด", guild.raw));
    return item;
  }

  function rawSnapshotDetailsElement(label, value) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const pre = document.createElement("pre");
    summary.textContent = label;
    pre.className = "mono raw-snapshot";
    try {
      pre.textContent = JSON.stringify(value, null, 2);
    } catch (_err) {
      pre.textContent = "ไม่สามารถแสดง snapshot นี้ได้";
    }
    details.append(summary, pre);
    return details;
  }

  function buildRawSnapshotCards(detail = {}) {
    const raw = detail.rawSnapshots || {};
    return [
      ["Discord Profile Raw Snapshot", raw.profile],
      ["Target Member Raw Snapshot", raw.member]
    ].filter(([, value]) => value).map(([title, value]) => {
      const card = detailCardElement(title, [], rawSnapshotDetailsElement("เปิดดูข้อมูลทั้งหมด", value));
      card.classList.add("mt-14");
      return card;
    });
  }

  function detailListCardElement(title, items, itemBuilder) {
    const list = document.createElement("div");
    list.className = "detail-list";
    if (!items.length) {
      list.textContent = "—";
    } else {
      list.append(...items.map(itemBuilder));
    }
    const card = detailCardElement(`${title} (${items.length})`, [], list);
    card.classList.add("mt-14");
    return card;
  }

  function firstTruthyValue(...values) {
    return values.find(Boolean);
  }

  function firstTruthy(...values) {
    return firstTruthyValue(...values) || "—";
  }

  function firstDefinedValue(...values) {
    return values.find((item) => item !== null && item !== undefined);
  }

  function firstDefined(...values) {
    return firstDefinedValue(...values) ?? "—";
  }

  function firstArray(...values) {
    return values.find(Array.isArray) || [];
  }

  function buildIdentityDetailCard(detail = {}) {
    const identity = detail.identity || {};
    const account = detail.account || {};
    return detailCardElement("Identity / Discord", [
      ["User ID", firstTruthy(detail.userId, identity.userId), "mono"],
      ["Username", firstTruthy(identity.username)],
      ["Discriminator", firstDefined(identity.discriminator)],
      ["Display tag", firstTruthy(identity.displayTag)],
      ["Global name", firstTruthy(identity.globalName)],
      ["Avatar URL", firstTruthy(identity.avatarUrl), "mono"],
      ["Banner URL", firstTruthy(identity.bannerUrl), "mono"],
      ["Accent color", firstDefined(identity.accentColor)],
      ["Badge flags", firstArray(account.badgeFlags, identity.badgeFlags).join(", ") || "—"]
    ]);
  }

  function buildAccountDetailCard(detail = {}) {
    const identity = detail.identity || {};
    const account = detail.account || {};
    return detailCardElement("Account / Email", [
      ["Email", firstDefined(account.email, identity.email)],
      ["Email verified", boolText(firstDefinedValue(account.emailVerified, identity.emailVerified))],
      ["Locale", firstTruthy(account.locale, identity.locale)],
      ["MFA", boolText(firstDefinedValue(account.mfaEnabled, identity.mfaEnabled))],
      ["Premium type (compatibility raw value, ไม่ใช่ Nitro verdict)", firstDefined(account.premiumType, identity.premiumType)],
      ["Flags / Public", `${firstDefined(account.flags, identity.flags)} / ${firstDefined(account.publicFlags, identity.publicFlags)}`],
      ["Created", fmtTime(firstTruthyValue(account.accountCreatedAt, identity.accountCreatedAt))],
      ["Age", `${firstDefined(account.accountAgeDays, identity.accountAgeDays)} วัน`]
    ]);
  }

  function buildTargetMemberDetailCard(detail = {}) {
    const member = detail.targetMember || {};
    const roles = Array.isArray(member.roles) ? member.roles : [];
    return detailCardElement("Target Guild Member", [
      ["Nickname", firstTruthy(member.nick, member.nickname)],
      ["Joined at", fmtTime(member.joinedAt)],
      ["Pending verification", boolText(member.pending)],
      ["Timeout", boolText(member.timedOut)],
      ["Timeout until", fmtTime(member.communicationDisabledUntil)],
      ["Guild avatar", firstTruthy(member.avatarUrl, member.avatar), "mono"],
      [`Roles (${roles.length})`, roles.join(", ") || "—"]
    ]);
  }

  function buildDeviceDetailCard(detail = {}) {
    const device = detail.device || {};
    return detailCardElement("Browser / Device", [
      ["Browser", firstTruthy(device.browser)],
      ["OS", firstTruthy(device.os)],
      ["Platform", firstTruthy(device.platform)],
      ["Device type", firstTruthy(device.deviceType)],
      ["Language", firstTruthy(device.language)],
      ["Languages", firstArray(device.languages).join(", ") || "—"],
      ["Timezone", firstTruthy(device.timezone)],
      ["Screen / Viewport", `${firstTruthy(device.screenSize)} / ${firstTruthy(device.viewportSize)}`],
      ["Color depth / Pixel ratio", `${firstDefined(device.colorDepth)} / ${firstDefined(device.devicePixelRatio)}`],
      ["Touch points", firstDefined(device.touchPoints)],
      ["User-Agent", firstTruthy(device.userAgent), "mono"]
    ]);
  }

  function buildNetworkDetailCard(detail = {}) {
    const network = detail.network || {};
    const tracking = detail.tracking || {};
    return detailCardElement("Network / IP", [
      ["Raw IP", detail.sensitive?.rawIp || "ไม่มีข้อมูล", "mono secret-value"],
      ["Country/City", `${firstTruthy(network.country, network.countryCode)} / ${firstTruthy(network.city)}`],
      ["Region / Timezone", `${firstTruthy(network.region)} / ${firstTruthy(network.timezone)}`],
      ["ISP", firstTruthy(network.isp)],
      ["Org/ASN", `${firstTruthy(network.org)} / ${firstTruthy(network.asn, network.as)}`],
      ["VPN / Proxy / TOR", `${boolText(network.isVPN)} / ${boolText(network.isProxy)} / ${boolText(network.isTOR)}`],
      ["Hosting / Mobile", `${boolText(firstTruthyValue(network.isHosting, network.hosting))} / ${boolText(network.mobile)}`],
      ["Lookup", `${firstTruthy(network.lookupProvider)} / ${firstTruthy(network.lookupStatus, "unknown")}`],
      ["IP first seen / Last seen", `${fmtTime(tracking.firstSeenAt)} / ${fmtTime(tracking.lastSeenAt)}`]
    ]);
  }

  function buildMemberListCards(detail = {}) {
    const connections = Array.isArray(detail.connections) ? detail.connections : [];
    const guilds = Array.isArray(detail.guilds) ? detail.guilds : [];
    return [
      detailListCardElement("Connections", connections, connectionDetailElement),
      detailListCardElement("Guilds", guilds, guildDetailElement)
    ];
  }

  function buildMemberDetailElement(detail = {}) {
    const root = document.createDocumentFragment();
    const grid = document.createElement("div");
    grid.className = "grid grid-2";
    grid.append(
      buildIdentityDetailCard(detail),
      buildAccountDetailCard(detail),
      buildTargetMemberDetailCard(detail),
      buildDeviceDetailCard(detail),
      buildNetworkDetailCard(detail),
      buildVerificationCardElement(detail)
    );
    root.append(grid, ...buildMemberListCards(detail), ...buildRawSnapshotCards(detail));
    return root;
  }

  function buildVerifyLogSensitiveNotice(log = {}) {
    if (!log.sensitiveRedacted) return null;
    const notice = document.createElement("div");
    notice.className = "notice notice-warn mb-12";
    notice.textContent = "ข้อมูล sensitive ถูกซ่อนอยู่ เพราะยังไม่ได้รับ owner approval หรือ approval หมดอายุ";
    return notice;
  }

  function buildVerifyLogHeader(log = {}) {
    const user = log.user || {};
    const title = document.createElement("div");
    const identity = document.createElement("span");
    title.className = "list-title";
    identity.append(
      resultBadgeElement(log.result),
      document.createTextNode(` ${firstTruthy(user.globalName, log.globalName, user.username, log.username, log.userId, "Unknown")}`)
    );
    title.append(identity, riskBadgeElement(log.riskScore));
    return title;
  }

  function verifyLogIdentityRows(log = {}) {
    const user = log.user || {};
    const roles = Array.isArray(log.memberRoles) ? log.memberRoles : [];
    return [
      ["User ID", firstTruthy(log.userId, user.id), "mono"],
      ["Username", firstTruthy(user.username, log.username)],
      ["Global name", firstTruthy(user.globalName, log.globalName)],
      ["Email", `${firstTruthy(user.email, log.email)} · Verified: ${boolText(firstDefinedValue(user.verified, log.emailVerified))}`],
      ["Locale / Flags", `${firstTruthy(user.locale, log.locale)} / ${firstDefined(user.flags, log.flags)}`],
      ["Nickname", firstTruthy(log.memberNick, log.nickname)],
      ["Joined at", fmtTime(log.joinedAt)],
      ["Roles", roles.join(", ") || "—"]
    ];
  }

  function verifyLogNetworkRows(log = {}) {
    const ip = log.ipInfo || {};
    return [
      ["Raw IP", "ดูค่าฉบับเต็มได้จากเมนูสมาชิก → ดูข้อมูลทั้งหมด", "mono"],
      ["Country / City", `${firstTruthy(ip.country, ip.countryCode, log.countryCode)} / ${firstTruthy(ip.city, log.city)}`],
      ["ISP / ASN", `${firstTruthy(ip.isp, log.isp)} / ${firstTruthy(ip.asn, log.asn)}`],
      ["Lookup", `${firstTruthy(ip.lookupProvider)} / ${firstTruthy(ip.lookupStatus, "unknown")}`],
      ["VPN / Proxy / TOR / Hosting", `${boolText(firstDefinedValue(ip.isVPN, log.isVPN))} / ${boolText(firstDefinedValue(ip.isProxy, log.isProxy))} / ${boolText(firstDefinedValue(ip.isTOR, log.isTOR))} / ${boolText(firstDefinedValue(ip.isHosting, log.isHosting))}`]
    ];
  }

  function verifyLogDeviceRows(log = {}) {
    const device = log.device || {};
    return [
      ["Browser / OS / Platform", `${firstTruthy(device.browser, log.browser)} / ${firstTruthy(device.os, log.os)} / ${firstTruthy(device.platform, log.platform)}`],
      ["Timezone / Language", `${firstTruthy(device.timezone, log.timezone)} / ${firstTruthy(device.language, log.language)}`],
      ["Screen / Viewport", `${firstTruthy(device.screenSize, log.screenSize)} / ${firstTruthy(device.viewportSize, log.viewportSize)}`]
    ];
  }

  function verifyLogSnapshotRows(log = {}) {
    const connections = Array.isArray(log.connections) ? log.connections : [];
    const guilds = Array.isArray(log.guilds) ? log.guilds : [];
    const connectionNames = connections.map((item) => firstTruthy(item.type, item.name, "unknown")).join(", ") || "—";
    const guildNames = guilds.map((item) => firstTruthy(item.name, item.id, "unknown")).join(", ") || "—";
    return [
      ["Connections", `${firstDefined(log.connectionsCount, connections.length)} (${connectionNames})`],
      ["Guilds", `${firstDefined(log.guildsCount, guilds.length)} (${guildNames})`]
    ];
  }

  function verifyLogResultRows(log = {}) {
    return [
      ["Reason", firstTruthy(log.reason)],
      ["Policy", firstTruthy(log.policyResult, log.policy)],
      ["Role result", firstTruthy(log.roleResult, log.roleAssignmentResult)],
      ["Request ID", firstTruthy(log.requestId), "mono"],
      ["Time", fmtTime(log.verifiedAt || log.createdAt)]
    ];
  }

  function buildVerifyLogMeta(log = {}) {
    const meta = document.createElement("div");
    meta.className = "list-meta";
    const rows = [
      ...verifyLogIdentityRows(log),
      ...verifyLogNetworkRows(log),
      ...verifyLogDeviceRows(log),
      ...verifyLogSnapshotRows(log),
      ...verifyLogResultRows(log)
    ];
    rows.forEach(([label, value, valueClass]) => appendDetailRow(meta, label, value, valueClass));
    return meta;
  }

  function buildDetailedVerifyLogElement(log = {}) {
    const card = document.createElement("div");
    card.className = "list-item sensitive";
    const notice = buildVerifyLogSensitiveNotice(log);
    if (notice) card.appendChild(notice);
    card.append(buildVerifyLogHeader(log), buildVerifyLogMeta(log));
    return card;
  }

  async function openMemberDetail(userId, fallback = {}) {
    try {
      const detail = await api(
        `/api/guild/${encodeURIComponent(state.guildId)}/member/${encodeURIComponent(userId)}/full-detail`,
        { method: "POST", body: "{}" }
      );
      openDetailModal("รายละเอียดสมาชิก", buildMemberDetailElement(detail));
    } catch (err) {
      showToast(`โหลดรายละเอียดไม่สำเร็จ: ${err.message}`, "err");
      openDetailModal("รายละเอียดสมาชิก", buildDetailedVerifyLogElement(fallback || {}));
    }
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
      minAccountAgeDays: Math.max(0, Math.min(3650, Number.parseInt(readText("v-minAge"), 10) || 0)),
      minConnections: Math.max(1, Math.min(20, Number.parseInt(readText("v-minConnections"), 10) || 1)),
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

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
    } catch {
      return "";
    }
  }

  function previewImageElement(className, source) {
    const url = safeHttpUrl(source);
    if (!url) return null;
    const wrapper = document.createElement("div");
    const image = document.createElement("img");
    wrapper.className = className;
    image.src = url;
    image.alt = "";
    wrapper.appendChild(image);
    return wrapper;
  }

  function readEmbedPreviewPanel() {
    return {
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
  }

  function previewContentElement(contentText) {
    if (!contentText) return null;
    const content = document.createElement("div");
    content.className = "alert alert-info mb-0";
    content.style.marginBottom = "12px";
    content.textContent = contentText;
    return content;
  }

  function previewTitleElement(panel = {}) {
    const title = document.createElement("div");
    const titleUrl = safeHttpUrl(panel.titleUrl);
    title.className = "embed-preview-title";
    if (!titleUrl) {
      title.textContent = panel.title;
      return title;
    }
    const link = document.createElement("a");
    link.href = titleUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = panel.title;
    title.appendChild(link);
    return title;
  }

  function previewDescriptionElement(descriptionText) {
    const description = document.createElement("div");
    description.className = "embed-preview-desc";
    description.textContent = descriptionText;
    return description;
  }

  function previewFooterElement(panel = {}) {
    if (!panel.footerText && !panel.showTimestamp) return null;
    const footer = document.createElement("div");
    const timestamp = panel.showTimestamp ? ` · ${new Date().toLocaleString("th-TH")}` : "";
    footer.className = "embed-preview-footer";
    footer.textContent = `${panel.footerText || "Discord Verification System"}${timestamp}`;
    return footer;
  }

  function buildEmbedPreviewNodes(panel = {}) {
    return [
      previewContentElement(panel.content),
      previewTitleElement(panel),
      previewDescriptionElement(panel.description),
      previewImageElement("embed-preview-thumb", panel.thumbnailUrl),
      previewImageElement("embed-preview-img", panel.imageUrl),
      previewFooterElement(panel)
    ].filter(Boolean);
  }

  function renderPreviewButton(buttonBox, panel = {}) {
    const button = document.createElement("div");
    const hint = document.createElement("div");
    button.className = "button-preview";
    button.textContent = panel.buttonText;
    hint.className = "field-hint";
    hint.textContent = `ปุ่มจริงใน Discord จะถูกสร้างตามโหมด ${verifyModeLabel(readValue("p-verifyType"))}`;
    buttonBox.replaceChildren(button, hint);
  }

  function renderEmbedPreview() {
    const box = $("embed-preview");
    const btnBox = $("button-preview");

    if (!box || !btnBox) return;

    const panel = readEmbedPreviewPanel();
    const color = /^#[0-9A-Fa-f]{6}$/.test(panel.color) ? panel.color : "#5865F2";
    box.style.borderLeftColor = color;
    box.replaceChildren(...buildEmbedPreviewNodes(panel));
    renderPreviewButton(btnBox, panel);
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
          <span>${check.ok ? "✅" : "❌"} ${h(check.label || check.name || check.message || check.key || "Check")}</span>
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
          ${errors.map((e) => `❌ ${h(e.message || e.label || e.name || e.key || e)}`).join("<br>")}
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

  async function checkSetup() {
    const btn = $("btn-check-setup");
    try {
      setButtonLoading(btn, true, "กำลัง Check Setup...");
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/preflight`);
      renderValidation(data.preflight || data);
      showToast((data.preflight || data).ok ? "Setup พร้อมใช้งาน" : "พบจุดที่ต้องแก้", (data.preflight || data).ok ? "ok" : "warn");
      switchTab("verification");
    } catch (err) {
      showToast(`Check Setup ไม่สำเร็จ: ${err.message}`, "err");
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
    const check = $("btn-check-setup");
    const send = $("btn-send-panel");
    const update = $("btn-update-panel");
    const disable = $("btn-disable-verification");

    if (save) save.addEventListener("click", saveSettings);
    if (validate) validate.addEventListener("click", validateSettings);
    if (check) check.addEventListener("click", checkSetup);
    if (send) send.addEventListener("click", sendPanel);
    if (update) update.addEventListener("click", updatePanel);
    if (disable) disable.addEventListener("click", disableVerification);
  }

  function renderResourceButtons(container, items, { emptyText, prefix, datasetKey }) {
    container.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = emptyText;
      container.appendChild(empty);
      return;
    }
    const buttons = items.map((item) => {
      const button = document.createElement("button");
      const id = String(item?.id || "");
      const label = String(item?.name || "unknown");
      const idLabel = document.createElement("span");
      button.className = "btn btn-soft btn-sm";
      button.type = "button";
      button.dataset[datasetKey] = id;
      idLabel.className = "mono muted-2";
      idLabel.textContent = id;
      button.append(document.createTextNode(`${prefix}${label} `), idLabel);
      return button;
    });
    container.append(...buttons);
  }

  function renderResources(resources = {}) {
    const rolesBox = $("role-options");
    const channelsBox = $("channel-options");

    if (rolesBox) {
      const roles = Array.isArray(resources.roles) ? resources.roles : [];
      renderResourceButtons(rolesBox, roles, {
        emptyText: "โหลดรายการยศไม่ได้ หรือยังไม่มีข้อมูล",
        prefix: "",
        datasetKey: "pickRole"
      });
    }

    if (channelsBox) {
      const channels = Array.isArray(resources.channels) ? resources.channels : [];
      renderResourceButtons(channelsBox, channels, {
        emptyText: "โหลดรายการห้องไม่ได้ หรือยังไม่มีข้อมูล",
        prefix: "# ",
        datasetKey: "pickChannel"
      });
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

  function appendText(parent, text, className = "") {
    const node = document.createElement("div");
    if (className) node.className = className;
    node.textContent = String(text ?? "");
    parent.appendChild(node);
    return node;
  }

  function memberTableMessage(message, className = "empty") {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    const box = document.createElement("div");
    td.colSpan = 8;
    box.className = className;
    box.textContent = message;
    td.appendChild(box);
    tr.appendChild(td);
    return tr;
  }

  function memberTableLoadingRow() {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    const box = document.createElement("div");
    const spinner = document.createElement("div");
    const label = document.createElement("div");
    td.colSpan = 8;
    box.className = "loading-box";
    spinner.className = "spinner";
    label.textContent = "กำลังโหลดสมาชิก...";
    box.append(spinner, label);
    td.appendChild(box);
    tr.appendChild(td);
    return tr;
  }

  function memberLocationText(member = {}) {
    return [
      member.countryCode || member.ipInfo?.countryCode,
      member.city || member.ipInfo?.city,
      member.isp || member.ipInfo?.isp
    ].filter(Boolean).join(" / ") || "—";
  }

  function memberIdentityCell(member = {}) {
    const identity = document.createElement("td");
    appendText(identity, member.globalName || member.username || member.userId || "Unknown").style.fontWeight = "950";
    appendText(identity, member.userId || "—", "mono muted-2 small");
    appendText(identity, member.email || "—", "muted small");
    return identity;
  }

  function memberResultCell(member = {}) {
    const result = document.createElement("td");
    result.appendChild(resultBadgeElement(member.result || "success"));
    return result;
  }

  function memberRiskCell(member = {}) {
    const risk = document.createElement("td");
    risk.appendChild(riskBadgeElement(member.riskScore));
    return risk;
  }

  function memberNetworkCell(member = {}) {
    const ip = member.rawIp || member.ip || member.ipInfo?.ip || "—";
    const network = document.createElement("td");
    appendText(network, ip, "mono");
    appendText(network, memberLocationText(member), "muted small");
    return network;
  }

  function memberDeviceCell(member = {}) {
    const device = document.createElement("td");
    appendText(device, member.device?.browser || member.browser || "—");
    appendText(device, member.device?.os || member.os || "—", "muted small");
    return device;
  }

  function memberCountsCell(member = {}) {
    const counts = document.createElement("td");
    appendText(counts, `${member.connectionsCount ?? member.connections ?? 0} connections`);
    appendText(counts, `${member.guildsCount ?? member.guilds ?? 0} guilds`, "muted small");
    return counts;
  }

  function memberTimeCell(member = {}) {
    const time = document.createElement("td");
    time.textContent = fmtTime(member.verifiedAt || member.createdAt);
    return time;
  }

  function memberActionsCell(member = {}) {
    const actions = document.createElement("td");
    const detail = document.createElement("button");
    detail.className = "btn btn-soft btn-sm";
    detail.type = "button";
    detail.dataset.memberDetail = String(member.userId || "");
    detail.textContent = "ดูข้อมูลทั้งหมด";
    actions.append(detail);
    return actions;
  }

  function renderMemberRow(member = {}) {
    const tr = document.createElement("tr");

    tr.append(
      memberIdentityCell(member),
      memberResultCell(member),
      memberRiskCell(member),
      memberNetworkCell(member),
      memberDeviceCell(member),
      memberCountsCell(member),
      memberTimeCell(member),
      memberActionsCell(member)
    );
    return tr;
  }

  function bindMemberTableActions(members = []) {
    qsa("[data-member-detail]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.memberDetail;
        const detail = members.find((m) => String(m.userId) === String(userId));
        await openMemberDetail(userId, detail || {});
      });
    });
  }

  async function loadMembers(page = 0) {
    const body = $(SELECTORS.membersBody);
    if (!body) return;

    state.membersPage = Math.max(0, page);
    body.replaceChildren(memberTableLoadingRow());

    try {
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/members?${buildMembersQuery(state.membersPage)}`);
      const members = Array.isArray(data.members) ? data.members : [];

      if ($(SELECTORS.membersPage)) {
        $(SELECTORS.membersPage).textContent = `หน้า ${state.membersPage + 1}`;
      }

      if (!members.length) {
        body.replaceChildren(memberTableMessage("ไม่พบข้อมูลสมาชิก"));
        return;
      }

      body.replaceChildren(...members.map(renderMemberRow));
      bindMemberTableActions(members);
    } catch (err) {
      body.replaceChildren(memberTableMessage(`โหลดสมาชิกไม่สำเร็จ: ${err.message}`, "alert alert-danger"));
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

  function logTableLoadingRow() {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    const box = document.createElement("div");
    const spinner = document.createElement("div");
    const label = document.createElement("div");
    td.colSpan = 8;
    box.className = "loading-box";
    spinner.className = "spinner";
    label.textContent = "กำลังโหลด logs...";
    box.append(spinner, label);
    td.appendChild(box);
    tr.appendChild(td);
    return tr;
  }

  function logIdentityCell(log = {}) {
    const user = log.user || {};
    const cell = document.createElement("td");
    const name = user.globalName || log.globalName || user.username || log.username || log.userId || "Unknown";
    appendText(cell, name).style.fontWeight = "950";
    appendText(cell, log.userId || user.id || "—", "mono muted-2 small");
    return cell;
  }

  function logNetworkCell(log = {}) {
    const cell = document.createElement("td");
    const ip = log.rawIp || log.ip || log.ipInfo?.ip || "—";
    const location = `${log.ipInfo?.countryCode || log.countryCode || "—"} / ${log.ipInfo?.city || log.city || "—"}`;
    appendText(cell, ip, "mono");
    appendText(cell, location, "muted small");
    return cell;
  }

  function textTableCell(value, className = "") {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = String(value ?? "—");
    return cell;
  }

  function logActionsCell(log = {}) {
    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.className = "btn btn-soft btn-sm";
    button.type = "button";
    button.dataset.logDetail = String(log._id || log.id || log.userId || "");
    button.textContent = "รายละเอียด";
    cell.appendChild(button);
    return cell;
  }

  function renderLogRow(log = {}) {
    const row = document.createElement("tr");
    const result = document.createElement("td");
    const risk = document.createElement("td");
    result.appendChild(resultBadgeElement(log.result));
    risk.appendChild(riskBadgeElement(log.riskScore));
    row.append(
      logIdentityCell(log),
      result,
      risk,
      logNetworkCell(log),
      textTableCell(log.reason || "—"),
      textTableCell(log.roleResult || log.roleAssignmentResult || "—"),
      textTableCell(fmtTime(log.verifiedAt || log.createdAt)),
      logActionsCell(log)
    );
    return row;
  }

  function bindLogTableActions(logs = []) {
    qsa("[data-log-detail]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.logDetail;
        const detail = logs.find((log) => String(log._id || log.id || log.userId) === String(key));
        if (detail?.userId) {
          openMemberDetail(detail.userId, detail);
        } else {
          openDetailModal("รายละเอียด Verify Log", buildDetailedVerifyLogElement(detail || {}));
        }
      });
    });
  }

  async function loadLogs(page = 0) {
    const body = $(SELECTORS.logsBody);
    if (!body) return;

    state.logsPage = Math.max(0, page);
    body.replaceChildren(logTableLoadingRow());

    try {
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/logs?${buildLogsQuery(state.logsPage)}`);
      const logs = Array.isArray(data.logs) ? data.logs : [];

      if ($(SELECTORS.logsPage)) {
        $(SELECTORS.logsPage).textContent = `หน้า ${state.logsPage + 1}`;
      }

      if (!logs.length) {
        body.replaceChildren(memberTableMessage("ยังไม่มี logs"));
        return;
      }

      body.replaceChildren(...logs.map(renderLogRow));
      bindLogTableActions(logs);
    } catch (err) {
      body.replaceChildren(memberTableMessage(`โหลด logs ไม่สำเร็จ: ${err.message}`, "alert alert-danger"));
    }
  }

  async function loadRisk() {
    try {
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/risk`);
      renderRisk(data.risk || data);
    } catch (err) {
      const box = $(SELECTORS.riskRecent);
      if (box) {
        const alert = document.createElement("div");
        alert.className = "alert alert-danger";
        alert.textContent = `โหลด risk ไม่สำเร็จ: ${err.message}`;
        box.replaceChildren(alert);
      }
    }
  }

  function openDetailModal(title, content) {
    const modal = $("detail-modal");
    const titleEl = $("detail-modal-title");
    const body = $("detail-modal-body");

    if (!modal || !body) return;

    if (titleEl) titleEl.textContent = title || "รายละเอียด";
    if (content instanceof Node) {
      body.replaceChildren(content);
    } else {
      body.replaceChildren(document.createTextNode(String(content || "")));
    }
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
