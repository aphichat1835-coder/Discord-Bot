/*
================================================================================
  Owner Verification Dashboard
  Owner Dashboard Verification Workspace

  หน้าที่:
  - โหลด overview/config และข้อมูลสมาชิกฉบับเต็มของ guild
  - แสดงข้อมูล verification ให้ละเอียดเป็นหมวด
  - ตั้งค่า verification ผ่านเว็บ
  - preview embed/button
  - validate config
  - send panel ใหม่
  - update/edit panel เดิมใน Discord
  - เปิดข้อมูลสมาชิกฉบับเต็มในหน้ารายละเอียดเดียว
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

    membersPage: 0,

    lastValidation: null,
    saving: false,
    sendingPanel: false,
    updatingPanel: false,

    activeTab: "overview"
  };

  const SECURITY_RULE_KEYS = [
    "vpnProxyTor",
    "hosting",
    "ipDuplicate",
    "deviceDuplicate",
    "previouslyBlockedIp",
    "spoofedHeader",
    "unknownLookup"
  ];

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
    overviewMode: "overview-mode",
    overviewUpdated: "overview-updated",
    overviewSource: "overview-source",

    validationBox: "validation-box",
    validationBody: "validation-body",

    membersBody: "members-body",
    membersPage: "members-page"
  };

  function qs(selector, root = document) {
    return root.querySelector(selector);
  }

  function qsa(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function compact(value, fallback = "—") {
    if (value === null || value === undefined || value === "") return fallback;
    return String(value);
  }

  function boolText(value) {
    return value ? "ใช่" : "ไม่ใช่";
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
    const guildId = encodeURIComponent(String(guild.id));
    const iconHash = encodeURIComponent(String(guild.icon));
    return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.webp?size=128`;
  }

  function initials(name) {
    const clean = String(name || "S").trim();
    const parts = clean.split(/\s+/).filter(Boolean).slice(0, 2);
    return parts.map((p) => p[0]).join("").toUpperCase() || clean[0]?.toUpperCase() || "S";
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

  function createElement(tag, className = "", text = "") {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== "") element.textContent = String(text);
    return element;
  }

  function replaceWithMessage(container, className, message) {
    if (!container) return;
    container.replaceChildren(createElement("div", className, message));
  }

  function setMessage(id, className, message) {
    replaceWithMessage($(id), className, message);
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

  function normalizeRuleAction(value, fallback = "allow") {
    const compatibility = { off: "allow", log_only: "allow", delay: "allow", block: "deny_role" };
    const actions = ["allow", "deny_role", "timeout", "kick", "ban"];
    const mapped = compatibility[String(value || "")] || String(value || "");
    return actions.includes(mapped) ? mapped : fallback;
  }

  function showToast(message, type = "ok") {
    const el = $(SELECTORS.toast);
    if (!el) return;

    el.className = `toast ${type} show`;
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
      btn.setAttribute("aria-busy", "true");
      btn.textContent = loadingText;
      return;
    }

    btn.disabled = false;
    btn.removeAttribute("aria-busy");
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
    const rawPath = String(path || "");
    const target = new URL(rawPath, window.location.origin);
    if (
      !rawPath.startsWith("/api/guild/") ||
      rawPath.startsWith("//") ||
      target.origin !== window.location.origin ||
      !target.pathname.startsWith("/api/guild/")
    ) {
      throw new Error("เส้นทาง API ไม่ได้รับอนุญาต");
    }
    const safePath = `${target.pathname}${target.search}`;
    // nosemgrep -- safePath is constrained above to this origin and the /api/guild/ namespace.
    const res = await fetch(safePath, {
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
    $(SELECTORS.sidebarToggle)?.setAttribute("aria-expanded", "true");
    $(SELECTORS.sidebarClose)?.focus();
  }

  function closeSidebar() {
    document.body.classList.remove("sidebar-open", "no-scroll");
    $(SELECTORS.sidebarToggle)?.setAttribute("aria-expanded", "false");
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

    qsa('[role="tab"][data-tab]').forEach((btn) => {
      const selected = btn.dataset.tab === tab;
      btn.classList.toggle("active", selected);
      btn.setAttribute("aria-selected", String(selected));
      btn.tabIndex = selected ? 0 : -1;
    });

    qsa("[data-section]").forEach((section) => {
      const hidden = section.dataset.section !== tab;
      section.classList.toggle("hidden", hidden);
      section.hidden = hidden;
    });

    closeSidebar();

    if (tab === "data") {
      loadMembers(state.membersPage);
    }
    if (tab === "panel") renderEmbedPreview();
  }

  function bindTabs() {
    const controls = qsa("[data-tab]");
    const tabs = qsa('[role="tab"][data-tab]');
    controls.forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    tabs.forEach((btn) => {
      btn.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        let index = tabs.indexOf(btn);
        if (event.key === "Home") index = 0;
        else if (event.key === "End") index = tabs.length - 1;
        else index = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[index].click();
        tabs[index].focus();
      });
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

    const name = state.currentGuild.name || "หน้าจัดการเซิร์ฟเวอร์";
    const id = state.currentGuild.id || state.guildId;
    const icon = iconUrl(state.currentGuild);

    setText(SELECTORS.guildTitle, name);
    setText(SELECTORS.guildSubtitle, `Guild ID: ${id}`);
    setText(SELECTORS.sideName, name);
    setText(SELECTORS.sideId, id);
    setText(SELECTORS.sidePerm, state.currentGuild.owner ? "สิทธิ์เจ้าของ/ผู้ดูแล" : "สิทธิ์ผู้ดูแล");

    const sideIcon = $(SELECTORS.sideIcon);
    if (sideIcon) {
      if (icon) {
        const image = document.createElement("img");
        image.src = icon;
        image.alt = "";
        sideIcon.replaceChildren(image);
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
    setText("system-message-id", verification.messageId || "ยังไม่มีแผง");
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

  function fillSecurityRules(rules = {}) {
    SECURITY_RULE_KEYS.forEach((key) => {
      const rule = rules[key] || {};
      setChecked(`rule-${key}-enabled`, rule.enabled === true);
      setSelect(`rule-${key}-action`, normalizeRuleAction(rule.action), "allow");
      setInput(`rule-${key}-timeout`, clampNumber(rule.timeoutMinutes, 1, 40320, 60));
      if (key === "ipDuplicate" || key === "deviceDuplicate") {
        setInput(`rule-${key}-threshold`, clampNumber(rule.threshold, 1, 20, key === "ipDuplicate" ? 3 : 2));
      }
      updateRuleTimeoutVisibility(key);
    });
  }

  function updateRuleTimeoutVisibility(key) {
    const section = qs(`[data-security-rule="${key}"]`);
    section?.classList.toggle("uses-timeout", readValue(`rule-${key}-action`) === "timeout");
  }

  function fillVerificationPolicy(verification = {}) {
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
    fillSecurityRules(verification.securityRules || {});
    fillVerificationPolicy(verification);

    if (state.resources) renderResources(state.resources);

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
    setText(SELECTORS.overviewMode, verifyModeLabel(mode));
    setText(SELECTORS.overviewUpdated, fmtTime(verification.updatedAt || state.currentConfig?.updatedAt));
    setText(SELECTORS.overviewSource, verification.updatedBy ? `อัปเดตโดย ${verification.updatedBy}` : "ยังไม่มีข้อมูล");
  }

  function renderStats(stats = {}) {
    setText(SELECTORS.statTotal, fmtNumber(stats.total));
    setText(SELECTORS.statSuccess, fmtNumber(stats.success));
    setText(SELECTORS.statBlocked, fmtNumber(stats.blocked));
    setText(SELECTORS.statRisk, fmtNumber(stats.highRisk));
    setText(SELECTORS.statRate, `อัตราสำเร็จ ${fmtPercent(stats.successRate)}`);
    setText(SELECTORS.statVpn, fmtNumber(stats.vpn));
    setText(SELECTORS.statProxy, fmtNumber(stats.proxy));
    setText(SELECTORS.statTor, fmtNumber(stats.tor));
    setText(SELECTORS.statPending, fmtNumber(stats.lookupFailed));
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

  function verificationSummaryRows(detail = {}) {
    const verification = detail.verification || {};
    const sources = [];
    if (detail.source?.hasVerifyLog) sources.push("VerifyLog");
    if (detail.source?.hasOAuthUser) sources.push("OAuthUser");
    return [
      ["Source", sources.join(" ") || "—"],
      ["Last result", verification.latest?.result || verification.lastVerify?.result || "—"],
      ["Verified at", fmtTime(verification.latest?.verifiedAt || verification.lastVerify?.verifiedAt)]
    ];
  }

  function oauthStatusRows(token = {}) {
    return [
      ["OAuth scope", token.oauth?.scope || "—"],
      ["Token type", token.oauth?.tokenType || "—"],
      ["Has access token", boolText(token.oauth?.hasAccessToken)],
      ["Has refresh token", boolText(token.oauth?.hasRefreshToken)],
      ["Expires at", fmtTime(token.oauth?.expiresAt)],
      ["Last refresh at", fmtTime(token.oauth?.lastRefreshAt)],
      ["Refresh failures", token.oauth?.refreshFailCount ?? 0],
      ["Revoked at", fmtTime(token.oauth?.revokedAt)],
      ["Admin OAuth access/refresh", `${boolText(token.adminOAuth?.hasAccessToken)} / ${boolText(token.adminOAuth?.hasRefreshToken)}`]
    ];
  }

  function secretControl(label, value) {
    const row = createElement("div", "secret-control");
    const text = createElement("div", "secret-control-value");
    const name = createElement("b", "", label);
    const code = createElement("code", "mono", value ? "••••••••••••••••" : "ไม่มีข้อมูล");
    const actions = createElement("div", "secret-control-actions");
    let timer = null;
    if (value) {
      const reveal = createElement("button", "btn btn-soft btn-sm btn-inline", "แสดง");
      const copy = createElement("button", "btn btn-soft btn-sm btn-inline", "คัดลอก");
      reveal.type = "button";
      copy.type = "button";
      reveal.addEventListener("click", () => {
        const showing = reveal.dataset.visible === "true";
        reveal.dataset.visible = String(!showing);
        reveal.textContent = showing ? "แสดง" : "ซ่อน";
        code.textContent = showing ? "••••••••••••••••" : value;
        clearTimeout(timer);
        if (!showing) timer = setTimeout(() => {
          reveal.dataset.visible = "false";
          reveal.textContent = "แสดง";
          code.textContent = "••••••••••••••••";
        }, 30000);
      });
      copy.addEventListener("click", () => copyText(value, `คัดลอก ${label} แล้ว`));
      actions.append(reveal, copy);
    }
    text.append(name, code);
    row.append(text, actions);
    return row;
  }

  function sensitiveValuesElement(detail = {}) {
    const sensitive = detail.sensitive || {};
    const oauth = sensitive.oauth || {};
    const adminOAuth = sensitive.adminOAuth || {};
    const root = createElement("div", "secret-list");
    root.append(
      secretControl("Access Token", oauth.accessToken),
      secretControl("Refresh Token", oauth.refreshToken),
      secretControl("Admin OAuth Access Token", adminOAuth.accessToken),
      secretControl("Admin OAuth Refresh Token", adminOAuth.refreshToken)
    );
    return root;
  }

  function verificationResultRows(detail = {}) {
    const verification = detail.verification || {};
    return [
      ["Join result", verification.latest?.joinResult?.status || verification.latest?.joinResult || "—"],
      ["Role assignment", verification.latest?.roleAssignResult?.status || verification.latest?.roleAssignResult || "—"],
      ["Request ID", verification.latest?.requestId || "—", "mono"]
    ];
  }

  function missingOAuthScopeIssues(oauth = {}) {
    const granted = new Set(String(oauth.scope || "").split(/\s+/).filter(Boolean));
    const required = ["identify", "identify.premium", "email", "connections", "guilds", "guilds.members.read", "guilds.join"];
    return required
      .filter(scope => !granted.has(scope))
      .map(scope => `ขาด scope: ${scope}`);
  }

  function oauthCredentialIssues(oauth = {}, revealed = {}) {
    const issues = [];
    if (!oauth.hasAccessToken) issues.push("ไม่มี Access Token");
    if (!oauth.hasRefreshToken) issues.push("ไม่มี Refresh Token — Token หมดแล้วต้อง OAuth ใหม่");
    if (oauth.hasAccessToken && !revealed.accessToken) issues.push("ถอด Access Token ที่เก็บไว้ไม่สำเร็จ");
    if (oauth.hasRefreshToken && !revealed.refreshToken) issues.push("ถอด Refresh Token ที่เก็บไว้ไม่สำเร็จ");
    return issues;
  }

  function oauthLifecycleIssues(oauth = {}, now = Date.now()) {
    const issues = [];
    if (oauth.revokedAt) issues.push("Token ถูก revoke หรือ refresh ไม่สำเร็จเกินกำหนด — ควร OAuth ใหม่");
    if (Number(oauth.refreshFailCount || 0) > 0) issues.push(`Refresh ล้มเหลว ${oauth.refreshFailCount} ครั้ง`);
    if (oauth.expiresAt && Number(oauth.expiresAt) <= now) {
      issues.push(oauth.hasRefreshToken ? "Access Token หมดอายุ — ระบบจะใช้ Refresh Token ต่ออายุ" : "Access Token หมดอายุและต่ออายุไม่ได้");
    }
    return issues;
  }

  function oauthReadinessIssues(detail = {}) {
    const oauth = detail.oauthTokens?.oauth || {};
    const revealed = detail.sensitive?.oauth || {};
    return [
      ...missingOAuthScopeIssues(oauth),
      ...oauthCredentialIssues(oauth, revealed),
      ...oauthLifecycleIssues(oauth)
    ];
  }

  function oauthReadinessNotice(detail = {}) {
    const issues = oauthReadinessIssues(detail);
    if (!issues.length) return null;
    const notice = document.createElement("div");
    notice.className = "notice notice-warn mt-10";
    const title = document.createElement("strong");
    const list = document.createElement("ul");
    title.textContent = "⚠️ คนนี้ยังขาดหรือควรตรวจสอบ";
    issues.forEach(issue => {
      const item = document.createElement("li");
      item.textContent = issue;
      list.appendChild(item);
    });
    notice.append(title, list);
    return notice;
  }

  function buildVerificationCardElement(detail = {}) {
    const token = detail.oauthTokens || {};
    const sensitive = detail.sensitive || {};
    const extra = createElement("div", "");
    const notice = oauthReadinessNotice(detail);
    if (notice) extra.appendChild(notice);
    extra.appendChild(sensitiveValuesElement(detail));
    return detailCardElement("การยืนยันและ OAuth", [
      ...verificationSummaryRows(detail),
      ...oauthStatusRows(token),
      ...verificationResultRows(detail)
    ], extra);
  }

  function connectionDetailElement(connection = {}) {
    const item = document.createElement("div");
    const metadataKeys = connection.metadata && typeof connection.metadata === "object" && !Array.isArray(connection.metadata)
      ? Object.keys(connection.metadata)
      : [];
    const integrationCount = Array.isArray(connection.integrations) ? connection.integrations.length : 0;
    item.className = "detail-entity-card";
    const head = createElement("div", "detail-entity-head");
    head.append(createElement("b", "", connection.type || "ไม่ทราบบริการ"), badgeElement(connection.verified ? "ยืนยันแล้ว" : "ยังไม่ยืนยัน", connection.verified ? "badge-ok" : "badge-muted"));
    const meta = createElement("div", "detail-entity-meta");
    appendDetailRow(meta, "ชื่อบัญชี", connection.name || connection.username || "—");
    appendDetailRow(meta, "Account ID", connection.id || "—", "mono");
    appendDetailRow(meta, "การมองเห็น", connection.visibility ?? "—");
    appendDetailRow(meta, "ถูกยกเลิก", boolText(connection.revoked));
    appendDetailRow(meta, "Integrations", integrationCount);
    appendDetailRow(meta, "Metadata", metadataKeys.join(", ") || "—");
    item.append(head, meta);
    if (connection.raw) item.append(rawSnapshotDetailsElement("ข้อมูล Connection ทั้งหมด", connection.raw));
    return item;
  }

  function guildDetailElement(guild = {}) {
    const item = document.createElement("div");
    const permissionFlags = Array.isArray(guild.permissionFlags) ? guild.permissionFlags : [];
    item.className = "detail-entity-card guild-entity";
    const head = createElement("div", "detail-entity-head");
    const icon = createElement("div", "detail-guild-icon", initials(guild.name || "S"));
    const iconUrl = guild.iconUrl || (guild.id && guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=64` : "");
    if (iconUrl) {
      const image = document.createElement("img"); image.src = iconUrl; image.alt = ""; image.loading = "lazy"; icon.replaceChildren(image);
    }
    const title = createElement("div", "");
    title.append(createElement("b", "", guild.name || guild.id || "ไม่ทราบชื่อเซิร์ฟเวอร์"), createElement("small", "mono muted-2", guild.id || "—"));
    head.append(icon, title);
    const meta = createElement("div", "detail-entity-meta");
    appendDetailRow(meta, "เจ้าของเซิร์ฟเวอร์", boolText(guild.owner || guild.isOwner));
    appendDetailRow(meta, "ผู้ดูแลระบบ", boolText(guild.isAdmin));
    appendDetailRow(meta, "จัดการเซิร์ฟเวอร์", boolText(guild.canManageGuild));
    appendDetailRow(meta, "จัดการยศ", boolText(guild.canManageRoles));
    appendDetailRow(meta, "แบนสมาชิก", boolText(guild.canBanMembers));
    appendDetailRow(meta, "Permission bitfield", guild.permissions || "0", "mono");
    appendDetailRow(meta, "สิทธิ์ที่พบ", permissionFlags.join(", ") || "—");
    item.append(head, meta);
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
    return detailCardElement("ตัวตนบน Discord", [
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
    const scopes = String(detail.oauthTokens?.oauth?.scope || "").split(/\s+/);
    const premiumKnown = scopes.includes("identify.premium");
    const premiumLabels = { 0: "ไม่มี Nitro", 1: "Nitro Classic", 2: "Nitro", 3: "Nitro Basic" };
    const rawProfile = detail.rawSnapshots?.profile || {};
    const mfaKnown = Object.hasOwn(rawProfile, "mfa_enabled") || Object.hasOwn(rawProfile, "mfaEnabled");
    return detailCardElement("บัญชีและความปลอดภัย", [
      ["Email", firstDefined(account.email, identity.email)],
      ["Email verified", boolText(firstDefinedValue(account.emailVerified, identity.emailVerified))],
      ["Locale", firstTruthy(account.locale, identity.locale)],
      ["MFA / 2FA", mfaKnown ? boolText(firstDefinedValue(account.mfaEnabled, identity.mfaEnabled)) : "Discord ไม่ได้ส่งข้อมูล"],
      ["Nitro", premiumKnown ? (premiumLabels[Number(firstDefinedValue(account.premiumType, identity.premiumType) || 0)] || "ไม่ทราบประเภท") : "Discord ไม่ได้ส่งข้อมูล"],
      ["Flags / Public", `${firstDefined(account.flags, identity.flags)} / ${firstDefined(account.publicFlags, identity.publicFlags)}`],
      ["Created", fmtTime(firstTruthyValue(account.accountCreatedAt, identity.accountCreatedAt))],
      ["Age", `${firstDefined(account.accountAgeDays, identity.accountAgeDays)} วัน`]
    ]);
  }

  function buildTargetMemberDetailCard(detail = {}) {
    const member = detail.targetMember || {};
    const roles = Array.isArray(member.roles) ? member.roles : [];
    return detailCardElement("ข้อมูลในเซิร์ฟเวอร์นี้", [
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
    return detailCardElement("อุปกรณ์และเบราว์เซอร์", [
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
    return detailCardElement("เครือข่ายและ IP", [
      ["Country/City", `${firstTruthy(network.country, network.countryCode)} / ${firstTruthy(network.city)}`],
      ["Region / Timezone", `${firstTruthy(network.region)} / ${firstTruthy(network.timezone)}`],
      ["ISP", firstTruthy(network.isp)],
      ["Org/ASN", `${firstTruthy(network.org)} / ${firstTruthy(network.asn, network.as)}`],
      ["VPN / Proxy / TOR", `${boolText(network.isVPN)} / ${boolText(network.isProxy)} / ${boolText(network.isTOR)}`],
      ["Hosting / Mobile", `${boolText(firstTruthyValue(network.isHosting, network.hosting))} / ${boolText(network.mobile)}`],
      ["Lookup", `${firstTruthy(network.lookupProvider)} / ${firstTruthy(network.lookupStatus, "unknown")}`],
      ["IP first seen / Last seen", `${fmtTime(tracking.firstSeenAt)} / ${fmtTime(tracking.lastSeenAt)}`]
    ], secretControl("IP ที่ระบบตรวจพบ", detail.sensitive?.rawIp));
  }

  function buildMemberListCards(detail = {}) {
    const connections = Array.isArray(detail.connections) ? detail.connections : [];
    const guilds = Array.isArray(detail.guilds) ? detail.guilds : [];
    return [
      detailListCardElement("บัญชีภายนอกที่เชื่อมกับ Discord", connections, connectionDetailElement),
      detailListCardElement("เซิร์ฟเวอร์ทั้งหมดที่ Discord ส่งมา", guilds, guildDetailElement)
    ];
  }

  function ipHistorySummaryRows(history = {}) {
    return [
      ["First seen / Last seen", `${fmtTime(history.firstSeenAt)} / ${fmtTime(history.lastSeenAt)}`],
      ["Verification count / Users", `${history.totalVerifications ?? 0} / ${history.uniqueUsers ?? 0}`],
      ["Users on this IP", Array.isArray(history.users) ? history.users.length : 0],
      ["Device fingerprints", Array.isArray(history.deviceFingerprints) ? history.deviceFingerprints.length : 0],
      ["Role snapshots", Array.isArray(history.roleSnapshots) ? history.roleSnapshots.length : 0],
      ["Last result / Role", `${history.lastResult || "—"} / ${history.lastRoleId || "—"}`]
    ];
  }

  function ipHistoryNetworkRows(history = {}) {
    const location = history.location || {};
    const signals = history.signals || {};
    return [
      ["Country / City / ISP", `${location.country || location.countryCode || "—"} / ${location.city || "—"} / ${location.isp || "—"}`],
      ["VPN / Proxy / TOR / Hosting / Mobile", `${boolText(signals.isVPN)} / ${boolText(signals.isProxy)} / ${boolText(signals.isTOR)} / ${boolText(signals.hosting)} / ${boolText(signals.mobile)}`]
    ];
  }

  function ipHistoryPageUrl(userId, kind, page) {
    return `/api/guild/${encodeURIComponent(state.guildId)}/member/${encodeURIComponent(userId)}/ip-history?kind=${encodeURIComponent(kind)}&page=${page}&limit=100`;
  }

  async function loadMoreIpHistory(view) {
    view.button.disabled = true;
    try {
      const result = await api(ipHistoryPageUrl(view.userId, view.kind, view.nextPage));
      view.items.push(...(Array.isArray(result.items) ? result.items : []));
      view.pre.textContent = JSON.stringify(view.items, null, 2);
      view.summary.textContent = `${view.label} (${view.items.length}/${result.total ?? view.items.length})`;
      view.nextPage++;
      if (!result.hasMore) view.button.remove();
    } catch (err) {
      showToast(`โหลด ${view.label} ไม่สำเร็จ: ${err.message}`, "err");
    } finally {
      view.button.disabled = false;
    }
  }

  function ipHistoryCategoryElement({ userId, history, kind, label, field }) {
    const items = Array.isArray(history[field]) ? [...history[field]] : [];
    const pageInfo = history.pagination?.[kind] || { page: 0, total: items.length, hasMore: false };
    const details = rawSnapshotDetailsElement(
      `${label} (${items.length}/${pageInfo.total ?? items.length})`,
      items
    );
    if (!pageInfo.hasMore || !userId) return details;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-soft mt-8";
    button.textContent = `โหลด ${label} เพิ่ม`;
    const view = {
      userId,
      history,
      kind,
      label,
      items,
      button,
      nextPage: Number(pageInfo.page || 0) + 1,
      summary: details.querySelector("summary"),
      pre: details.querySelector("pre")
    };
    button.addEventListener("click", () => loadMoreIpHistory(view));
    details.appendChild(button);
    return details;
  }

  function ipHistoryPagerElement(detail, history) {
    const root = document.createElement("div");
    const userId = firstTruthyValue(detail.identity?.userId, detail.userId);
    const definitions = [
      ["users", "Users", "users"],
      ["devices", "Devices", "deviceFingerprints"],
      ["roles", "Role snapshots", "roleSnapshots"]
    ];
    root.append(...definitions.map(([kind, label, field]) =>
      ipHistoryCategoryElement({ userId, history, kind, label, field })
    ));
    return root;
  }

  function buildIpIdentityHistoryCard(detail = {}) {
    const history = detail.sensitive?.ipIdentity;
    if (!history) return null;
    const rows = [
      ...ipHistorySummaryRows(history),
      ...ipHistoryNetworkRows(history)
    ];
    const raw = ipHistoryPagerElement(detail, history);
    const card = detailCardElement("ประวัติ IP อุปกรณ์ และยศ", rows, raw);
    card.classList.add("mt-14");
    return card;
  }

  function buildDataQualityCard(detail = {}) {
    const metadata = detail.verification?.snapshotMeta;
    if (!metadata) return null;
    const card = detailCardElement("Snapshot / Data Quality", [], rawSnapshotDetailsElement("เปิดดูสถานะการเก็บข้อมูลทุกหมวด", metadata));
    card.classList.add("mt-14");
    return card;
  }

  function existingDetailCards(...cards) {
    return cards.filter(Boolean);
  }

  function memberDetailSection(title, subtitle, nodes = [], open = false) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const text = createElement("span", "member-detail-section-title");
    const body = createElement("div", "member-detail-section-body");
    details.className = "member-detail-section";
    details.open = open;
    text.append(createElement("b", "", title), createElement("small", "", subtitle));
    summary.append(text, createElement("span", "member-detail-chevron", "⌄"));
    nodes.filter(Boolean).forEach(node => body.appendChild(node));
    details.append(summary, body);
    return details;
  }

  function memberProfileHeader(detail = {}) {
    const identity = detail.identity || {};
    const root = createElement("header", "member-profile-header");
    if (identity.bannerUrl) {
      const banner = document.createElement("img");
      banner.className = "member-profile-banner";
      banner.src = identity.bannerUrl;
      banner.alt = "";
      root.appendChild(banner);
    }
    const content = createElement("div", "member-profile-content");
    const avatar = createElement("div", "member-profile-avatar", initials(identity.globalName || identity.username || "U"));
    if (identity.avatarUrl) {
      const image = document.createElement("img"); image.src = identity.avatarUrl; image.alt = "รูปโปรไฟล์"; avatar.replaceChildren(image);
    }
    const title = createElement("div", "member-profile-name");
    title.append(createElement("h2", "", identity.globalName || identity.username || "ไม่ทราบชื่อ"), createElement("div", "", identity.displayTag || identity.username || "—"), createElement("code", "mono", identity.userId || detail.userId || "—"));
    content.append(avatar, title, resultBadgeElement(detail.verification?.latest?.result || detail.verification?.lastVerify?.result || "success"));
    root.appendChild(content);
    return root;
  }

  function verificationHistoryElement(detail = {}) {
    const history = Array.isArray(detail.history) ? detail.history : [];
    const root = createElement("div", "verification-timeline");
    if (!history.length) return createElement("div", "empty", "ยังไม่มีประวัติการยืนยัน");
    history.forEach(item => {
      const row = createElement("article", "timeline-item");
      const head = createElement("div", "timeline-head");
      head.append(resultBadgeElement(item.result), createElement("time", "", fmtTime(item.verifiedAt)));
      row.append(head, createElement("div", "timeline-reason", item.reason || "ไม่มีเหตุผลเพิ่มเติม"));
      if (Array.isArray(item.findings) && item.findings.length) row.appendChild(createElement("div", "muted small", `สิ่งที่พบ: ${item.findings.join(", ")}`));
      root.appendChild(row);
    });
    if (detail.historyTruncated) root.appendChild(createElement("div", "notice notice-warn", "แสดง 100 รายการล่าสุด"));
    return root;
  }

  function buildMemberDetailElement(detail = {}) {
    const root = document.createDocumentFragment();
    const [connections, guilds] = buildMemberListCards(detail);
    const rawCards = buildRawSnapshotCards(detail);
    root.append(
      memberProfileHeader(detail),
      memberDetailSection("ตัวตนและบัญชี", "ชื่อ รูปโปรไฟล์ Email Nitro MFA และอายุบัญชี", [buildIdentityDetailCard(detail), buildAccountDetailCard(detail)], true),
      memberDetailSection("ข้อมูลในเซิร์ฟเวอร์นี้", "Nickname ยศ วันที่เข้า Avatar และสถานะหมดเวลา", [buildTargetMemberDetailCard(detail)]),
      memberDetailSection("เซิร์ฟเวอร์ทั้งหมด", `${Array.isArray(detail.guilds) ? detail.guilds.length : 0} เซิร์ฟเวอร์ พร้อมสิทธิ์ที่ Discord ส่งมา`, [guilds]),
      memberDetailSection("บัญชีภายนอก", `${Array.isArray(detail.connections) ? detail.connections.length : 0} บริการที่เชื่อมกับ Discord`, [connections]),
      memberDetailSection("อุปกรณ์และเครือข่าย", "Browser OS หน้าจอ ISP ตำแหน่ง VPN Proxy TOR และ IP", [buildDeviceDetailCard(detail), buildNetworkDetailCard(detail)]),
      memberDetailSection("ประวัติการยืนยัน", `${Array.isArray(detail.history) ? detail.history.length : 0} เหตุการณ์ล่าสุด`, [verificationHistoryElement(detail)]),
      memberDetailSection("OAuth และ Token", "Scope วันหมดอายุ สถานะ Refresh และข้อมูลเข้ารหัส", [buildVerificationCardElement(detail)]),
      memberDetailSection("ประวัติ IP อุปกรณ์ และยศ", "ข้อมูลความสัมพันธ์ที่บันทึกจากการยืนยันของระบบนี้", existingDetailCards(buildIpIdentityHistoryCard(detail))),
      memberDetailSection("คุณภาพและข้อมูลต้นฉบับ", "สถานะการดึงข้อมูลและ Snapshot ที่ระบบเก็บได้", [...existingDetailCards(buildDataQualityCard(detail)), ...rawCards])
    );
    return root;
  }

  function buildVerifyLogSensitiveNotice(log = {}) {
    if (!log.sensitiveRedacted) return null;
    const notice = document.createElement("div");
    notice.className = "notice notice-warn mb-12";
    notice.textContent = "รายการ log นี้แสดงข้อมูลสรุป หากต้องการข้อมูลเต็มให้เปิด Member Detail ของผู้ใช้คนนั้น";
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
    title.append(identity);
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
    const securityRules = Object.fromEntries(SECURITY_RULE_KEYS.map((key) => {
      const rule = {
        enabled: readBool(`rule-${key}-enabled`),
        action: normalizeRuleAction(readValue(`rule-${key}-action`)),
        timeoutMinutes: clampNumber(readText(`rule-${key}-timeout`), 1, 40320, 60)
      };
      if (key === "ipDuplicate" || key === "deviceDuplicate") {
        rule.threshold = clampNumber(readText(`rule-${key}-threshold`), 1, 20, key === "ipDuplicate" ? 3 : 2);
      }
      return [key, rule];
    }));

    return {
      enabled: readBool("v-enabled"),
      roleId: roleId || null,
      channelId: channelId || null,
      messageId: messageId || null,

      securityRules,
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
    const content = $("preview-content");
    if (content) {
      content.textContent = panel.content || "";
      content.hidden = !panel.content;
    }
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
      body.replaceChildren();
      return;
    }

    box.classList.remove("hidden");

    const checks = Array.isArray(result.checks) ? result.checks : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const summaryBadge = $("validation-summary-badge");
    if (summaryBadge) {
      summaryBadge.className = `badge ${errors.length ? "badge-failed" : warnings.length ? "badge-warn" : "badge-ok"}`;
      summaryBadge.textContent = errors.length ? `${errors.length} จุดต้องแก้` : warnings.length ? `${warnings.length} คำเตือน` : "พร้อมใช้งาน";
    }

    const remediation = (text) => {
      const value = String(text || "");
      if (/Role|ยศ/i.test(value)) return ["ตรวจว่ายศยังอยู่ในเซิร์ฟเวอร์", "เลื่อนยศของบอทให้อยู่สูงกว่ายศที่จะมอบ", "ให้สิทธิ์ Manage Roles แก่บอท แล้วตรวจใหม่"];
      if (/Channel|ห้อง|View Channel|Send Messages|Embed Links/i.test(value)) return ["เลือกห้องที่บอทมองเห็น", "อนุญาต View Channel, Send Messages และ Embed Links", "กลับมากดตรวจสอบอีกครั้ง"];
      if (/Token|CLIENT|SECRET|State|Environment/i.test(value)) return ["ตรวจ Environment Variables ของบริการที่รันบอท", "ใช้ค่าจาก Discord Application เดียวกับ Bot Token", "รีสตาร์ตบริการแล้วตรวจใหม่ โดยห้ามส่งค่าลับผ่านแชต"];
      if (/guild|เซิร์ฟเวอร์|member/i.test(value)) return ["ตรวจว่าบอทยังอยู่ในเซิร์ฟเวอร์", "ตรวจสิทธิ์และลำดับยศของบอท", "รีโหลดข้อมูลแล้วลองใหม่"];
      return ["อ่านข้อความปัญหาและตรวจค่าที่เกี่ยวข้อง", "แก้การตั้งค่าในหมวดนี้", "กดตรวจสอบซ้ำก่อนส่งแผง"];
    };

    const issueButton = (kind, text) => {
      const button = createElement("button", `validation-issue ${kind}`);
      button.type = "button";
      button.append(createElement("span", "", kind === "warning" ? "⚠️" : "!"), createElement("span", "", text), createElement("span", "validation-open", "ดูวิธีแก้ →"));
      button.addEventListener("click", () => {
        const list = createElement("ol", "remediation-list");
        remediation(text).forEach(step => list.appendChild(createElement("li", "", step)));
        openDetailModal("แนวทางแก้ไข", detailCardElement(text, [], list));
      });
      return button;
    };

    const grid = createElement("div", "grid grid-3");
    const addStat = (value, label, color) => {
      const card = createElement("div", "stat-card");
      const number = createElement("div", "num", value);
      number.style.color = color;
      card.append(number, createElement("div", "label", label));
      grid.appendChild(card);
    };
    addStat(checks.filter((check) => check.ok).length, "ผ่าน", "var(--green-2)");
    addStat(warnings.length, "เตือน", "var(--yellow-2)");
    addStat(errors.length, "ผิดพลาด", "var(--red-2)");

    const nodes = [grid];
    if (warnings.length) {
      const warningBox = createElement("div", "alert alert-warn mt-14");
      warningBox.replaceChildren(...warnings.map((warning) => issueButton("warning", String(warning))));
      nodes.push(warningBox);
    }
    if (errors.length) {
      const errorBox = createElement("div", "alert alert-danger mt-14");
      errorBox.replaceChildren(...errors.map((error) => issueButton("error", String(error?.message || error?.label || error?.name || error?.key || error))));
      nodes.push(errorBox);
    }

    const list = createElement("div", "list mt-14");
    if (!checks.length) {
      list.appendChild(createElement("div", "empty", "ยังไม่มีผลตรวจ"));
    } else {
      const checkNodes = checks.map((check) => {
        const item = document.createElement("details");
        item.className = "validation-check";
        const title = createElement("div", "list-title");
        title.append(
          createElement("span", "", `${check.ok ? "✅" : "❌"} ${check.label || check.name || check.message || check.key || "Check"}`),
          createElement("span", check.ok ? "badge badge-ok" : "badge badge-failed", check.ok ? "ผ่าน" : "ไม่ผ่าน")
        );
        const summary = document.createElement("summary");
        summary.appendChild(title);
        item.appendChild(summary);
        if (check.detail) item.appendChild(createElement("div", "list-meta validation-check-detail", check.detail));
        return item;
      });
      list.append(...checkNodes);
    }
    nodes.push(list);
    body.replaceChildren(...nodes);
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
      switchTab("system");
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

  const PANEL_SYNC_LABELS = {
    content: "ข้อความเหนือ Embed",
    title: "หัวข้อ",
    description: "คำอธิบาย",
    color: "สี Embed",
    imageUrl: "รูปภาพ",
    thumbnailUrl: "รูปย่อ",
    footerText: "Footer",
    titleUrl: "ลิงก์หัวข้อ",
    showTimestamp: "เวลาใน Embed",
    buttonText: "ข้อความบนปุ่ม",
    verifyType: "รูปแบบการยืนยัน"
  };

  function panelSyncBadgeView(sync = {}) {
    if (sync.inSync) return { className: "badge badge-ok", text: "ตรงกัน" };
    if (sync.status === "different") return { className: "badge badge-warn", text: "ข้อมูลต่างกัน" };
    const textByStatus = {
      not_configured: "ยังไม่มีแผง",
      message_missing: "ไม่พบข้อความ",
      cannot_read: "อ่านไม่ได้"
    };
    return { className: "badge badge-failed", text: textByStatus[sync.status] || "ตรวจไม่สำเร็จ" };
  }

  function panelSyncDescription(sync = {}) {
    if (sync.inSync) return "ค่าบนเว็บตรงกับข้อความจริงใน Discord";
    if (sync.status === "different") {
      const differences = Array.isArray(sync.differences) ? sync.differences : [];
      return `ข้อมูลที่ต่างกัน: ${differences.map(key => PANEL_SYNC_LABELS[key] || key).join(", ")}`;
    }
    return "ยังเปรียบเทียบกับข้อความจริงไม่ได้ กรุณาตรวจห้อง สิทธิ์บอท และข้อความแผง";
  }

  function panelSyncLoadButton(sync = {}) {
    if (sync.status !== "different" || !sync.actualPanel) return null;
    const load = createElement("button", "btn btn-soft btn-sm btn-inline", "โหลดค่าจาก Discord มาแก้ไข");
    load.type = "button";
    load.addEventListener("click", () => {
      fillPanelConfig(sync.actualPanel, sync.actualPanel.verifyType || "oauth");
      renderEmbedPreview();
      showToast("โหลดค่าจาก Discord แล้ว กดบันทึกเมื่อพร้อม", "ok");
    });
    return load;
  }

  function renderPanelSyncResult(sync = {}) {
    const badge = $("panel-sync-badge");
    const detail = $("panel-sync-detail");
    const badgeView = panelSyncBadgeView(sync);
    if (badge) {
      badge.className = badgeView.className;
      badge.textContent = badgeView.text;
    }
    if (!detail) return;
    detail.replaceChildren(createElement("p", "", panelSyncDescription(sync)));
    const load = panelSyncLoadButton(sync);
    if (load) detail.appendChild(load);
  }

  function renderPanelSyncError(err) {
    const badge = $("panel-sync-badge");
    const detail = $("panel-sync-detail");
    if (badge) {
      badge.className = "badge badge-failed";
      badge.textContent = "ตรวจไม่สำเร็จ";
    }
    if (detail) detail.textContent = err.message;
    showToast(`ตรวจการซิงค์ไม่สำเร็จ: ${err.message}`, "err");
  }

  async function checkPanelSync() {
    const btn = $("btn-check-panel-sync");
    try {
      setButtonLoading(btn, true, "กำลังตรวจสอบ...");
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/verify/panel/sync`);
      renderPanelSyncResult(data.sync || {});
    } catch (err) {
      renderPanelSyncError(err);
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
    const sync = $("btn-check-panel-sync");

    if (save) save.addEventListener("click", saveSettings);
    if (validate) validate.addEventListener("click", validateSettings);
    if (check) check.addEventListener("click", checkSetup);
    if (send) send.addEventListener("click", sendPanel);
    if (update) update.addEventListener("click", updatePanel);
    if (disable) disable.addEventListener("click", disableVerification);
    if (sync) sync.addEventListener("click", checkPanelSync);
    SECURITY_RULE_KEYS.forEach((key) => {
      $(`rule-${key}-action`)?.addEventListener("change", () => updateRuleTimeoutVisibility(key));
    });
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
      const selectedId = datasetKey === "pickRole" ? readText("v-roleId") : readText("v-channelId");
      button.classList.toggle("selected", selectedId === id);
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
        qsa("[data-pick-role]").forEach(item => item.classList.toggle("selected", item === btn));
        showToast("เลือกยศแล้ว", "ok");
      });
    });

    qsa("[data-pick-channel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setInput("v-channelId", btn.dataset.pickChannel || "");
        qsa("[data-pick-channel]").forEach(item => item.classList.toggle("selected", item === btn));
        showToast("เลือกห้องแล้ว", "ok");
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

      replaceWithMessage(rolesBox, "alert alert-warn", `โหลดรายการยศไม่ได้: ${err.message}`);
      replaceWithMessage(channelsBox, "alert alert-warn", `โหลดรายการห้องไม่ได้: ${err.message}`);
    }
  }

  async function loadOverview() {
    try {
      const data = await api(`/api/guild/${encodeURIComponent(state.guildId)}/overview`);

      state.overviewData = data;

      updateGuildInfo(data.guild || data.currentGuild || data.guildInfo || {});
      fillConfig(data.config || data.guildConfig || state.currentConfig || {});

      renderStats(data.stats || {});

      return data;
    } catch (err) {
      showToast(`โหลด overview ไม่สำเร็จ: ${err.message}`, "err");

      setMessage("overview-error", "alert alert-danger", `โหลดข้อมูล dashboard ไม่สำเร็จ: ${err.message}`);

      return null;
    }
  }

  function buildMembersQuery(page = 0) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", "25");

    const q = readText("members-search");
    const result = readValue("members-result");

    if (q) params.set("q", q);
    if (result) params.set("result", result);

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
    const box = document.createElement("div");
    box.className = className;
    box.textContent = message;
    return box;
  }

  function memberTableLoadingRow() {
    const box = document.createElement("div");
    const spinner = document.createElement("div");
    const label = document.createElement("div");
    box.className = "loading-box";
    spinner.className = "spinner";
    label.textContent = "กำลังโหลดสมาชิก...";
    box.append(spinner, label);
    return box;
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
    const card = document.createElement("article");
    const top = createElement("div", "member-card-top");
    const avatar = createElement("div", "member-avatar");
    const identity = createElement("div", "member-card-identity");
    const name = createElement("h3", "", member.globalName || member.username || member.userId || "ไม่ทราบชื่อ");
    const tag = createElement("div", "muted small", member.tag || member.username || "ไม่มี Username");
    const id = createElement("div", "mono muted-2 small", member.userId || "—");
    const status = createElement("div", "member-card-status");
    const facts = createElement("div", "member-card-facts");
    const action = createElement("button", "btn btn-soft member-open", "เปิดข้อมูลทั้งหมด");
    card.className = "member-card";
    action.type = "button";
    action.dataset.memberDetail = String(member.userId || "");

    const avatarUrl = member.avatarUrl || member.discordSnapshot?.avatarUrl || member.user?.avatarUrl;
    if (avatarUrl) {
      const image = document.createElement("img");
      image.src = avatarUrl;
      image.alt = `รูปโปรไฟล์ของ ${name.textContent}`;
      image.loading = "lazy";
      image.addEventListener("error", () => { avatar.textContent = initials(name.textContent); }, { once: true });
      avatar.appendChild(image);
    } else avatar.textContent = initials(name.textContent);

    identity.append(name, tag, id);
    status.append(resultBadgeElement(member.result || "success"), createElement("span", "muted small", fmtTime(member.verifiedAt || member.createdAt)));
    top.append(avatar, identity, status);
    facts.append(
      createElement("span", "", `${member.connectionsCount ?? member.connections ?? 0} บัญชีที่เชื่อม`),
      createElement("span", "", `${member.guildsCount ?? member.guilds ?? 0} เซิร์ฟเวอร์`),
      createElement("span", "", memberLocationText(member)),
      createElement("span", "", `${member.device?.browser || member.browser || "ไม่ทราบเบราว์เซอร์"} · ${member.device?.os || member.os || "ไม่ทราบระบบ"}`)
    );
    card.append(top, facts, action);
    return card;
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

    state.modalReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    if (titleEl) titleEl.textContent = title || "รายละเอียด";
    if (content instanceof Node) {
      body.replaceChildren(content);
    } else {
      body.replaceChildren(document.createTextNode(String(content || "")));
    }
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("no-scroll");
    modal.querySelector(".modal")?.focus();
  }

  function closeDetailModal() {
    const modal = $("detail-modal");
    if (modal) {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("no-scroll");
    state.modalReturnFocus?.focus?.();
    state.modalReturnFocus = null;
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

    ["members-search", "members-result"].forEach((id) => {
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

  function tabFromHash() {
    try {
      const raw = decodeURIComponent(location.hash.replace(/^#/, "") || "overview");
      const aliases = {
        verification: "system",
        security: "policy",
        members: "data",
        logs: "data",
        risk: "data",
        privacy: "data"
      };
      return aliases[raw] || raw;
    } catch {
      return "overview";
    }
  }

  function bindHashTabs() {
    qsa("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        syncTabToHash(btn.dataset.tab);
      });
    });

    window.addEventListener("hashchange", () => {
      const tab = tabFromHash();
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
      mobile.textContent = title.textContent || "หน้าจัดการเซิร์ฟเวอร์";
    }
  }

  async function loadGuildSwitcher() {
    const select = $("guild-switcher");
    if (!select) return;

    try {
      const response = await fetch("/api/guilds", {
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error("guild_list_unavailable");

      const guilds = Array.isArray(data.guilds) ? data.guilds : [];
      const fragment = document.createDocumentFragment();
      for (const guild of guilds) {
        const option = document.createElement("option");
        option.value = String(guild.id || "");
        option.textContent = String(guild.name || guild.id || "ไม่ทราบชื่อเซิร์ฟเวอร์");
        option.selected = option.value === state.guildId;
        fragment.appendChild(option);
      }

      select.replaceChildren(fragment);
      select.disabled = guilds.length === 0;
      if (guilds.length === 0) {
        const empty = document.createElement("option");
        empty.textContent = "ไม่พบเซิร์ฟเวอร์";
        select.appendChild(empty);
      }
    } catch {
      const unavailable = document.createElement("option");
      unavailable.textContent = "โหลดรายชื่อไม่สำเร็จ";
      select.replaceChildren(unavailable);
      select.disabled = true;
    }
  }

  function bindGuildSwitcher() {
    const select = $("guild-switcher");
    if (!select) return;
    select.addEventListener("change", () => {
      const guildId = String(select.value || "");
      if (!/^\d{17,22}$/.test(guildId) || guildId === state.guildId) return;
      window.location.assign(`/verification/${encodeURIComponent(guildId)}#${encodeURIComponent(state.activeTab)}`);
    });
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
      setMessage(
        "overview-error",
        "alert alert-danger",
        "ไม่พบ Guild ID จาก URL กรุณากลับไปเลือกเซิร์ฟเวอร์ใหม่"
      );

      return;
    }

    await Promise.allSettled([
      loadOverview(),
      loadResources(),
      loadGuildSwitcher()
    ]);

    const initialTab = tabFromHash();
    const hasTab = qsa("[data-section]").some((section) => section.dataset.section === initialTab);

    switchTab(hasTab ? initialTab : "overview");
  }

  function init() {
    state.guildId = getGuildIdFromPath();

    bindSidebar();
    bindTabs();
    bindHashTabs();

    bindPreviewInputs();
    bindVerificationActions();

    bindMembersControls();

    bindModal();
    bindUtilityActions();
    bindGuildSwitcher();
    patchGuildInfoObserver();

    bootInitialData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
