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
    const res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers || {})
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

  function fillConfig(config) {
    state.currentConfig = config || {};
    const verification = state.currentConfig.verification || {};
    const panel = verification.panel || {};

    const mode = normalizeVerifyMode(
      panel.verifyType ||
      verification.oauthMode ||
      verification.verifyType ||
      "oauth"
    );

    setChecked("v-enabled", verification.enabled !== false);
    setInput("v-roleId", verification.roleId || "");
    setInput("v-channelId", verification.channelId || "");
    setInput("v-messageId", verification.messageId || "");

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

    setChecked("v-blockVPN", verification.blockVPN !== false);
    setChecked("v-requireEmail", !!verification.requireEmail);
    setChecked("v-requireEmailVerified", !!verification.requireEmailVerified);
    setChecked("v-requireConnections", !!verification.requireConnections);
    setInput("v-minAge", verification.minAccountAgeDays ?? 7);
    setInput("v-minConnections", verification.minConnections ?? 1);
    setInput("v-allowedCountries", Array.isArray(verification.allowedCountries) ? verification.allowedCountries.join(",") : "");
    setInput("v-blockedCountries", Array.isArray(verification.blockedCountries) ? verification.blockedCountries.join(",") : "");

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
