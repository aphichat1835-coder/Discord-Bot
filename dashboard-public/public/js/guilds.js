/*
================================================================================
  Dashboard Public v2 — Guild Select Page JS
================================================================================
*/

(function () {
  "use strict";

  const state = {
    guilds: [],
    query: "",
    loading: true
  };

  const $ = (selector) => document.querySelector(selector);

  function h(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function initials(name) {
    const clean = String(name || "S").trim();
    if (!clean) return "S";

    const parts = clean
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);

    return parts.map((p) => p[0]).join("").toUpperCase() || clean[0].toUpperCase();
  }

  function iconUrl(guild) {
    if (!guild?.id || !guild?.icon) return "";
    return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=128`;
  }

  function permissionLabel(guild) {
    if (guild.owner) return "Owner";
    if (guild.permissionsText) return guild.permissionsText;
    return "Administrator";
  }

  function filterGuilds() {
    const q = state.query.trim().toLowerCase();

    if (!q) return state.guilds;

    return state.guilds.filter((guild) => {
      const name = String(guild.name || "").toLowerCase();
      const id = String(guild.id || "").toLowerCase();
      return name.includes(q) || id.includes(q);
    });
  }

  function renderGuildCard(guild) {
    const icon = iconUrl(guild);

    return `
      <a href="/guild/${encodeURIComponent(guild.id)}" class="guild-card" title="เปิด Dashboard ของ ${h(guild.name)}">
        <div class="guild-card-icon">
          ${icon ? `<img src="${h(icon)}" alt="">` : h(initials(guild.name))}
        </div>

        <div class="guild-card-name">${h(guild.name || "Unknown Server")}</div>
        <div class="guild-card-meta mono">${h(guild.id || "—")}</div>

        <div class="flex items-center gap-8 mt-12 flex-wrap">
          <span class="badge badge-info">${h(permissionLabel(guild))}</span>
          <span class="badge badge-cyan">จัดการได้</span>
        </div>
      </a>
    `;
  }

  function render() {
    const grid = $("#guild-grid");
    const count = $("#guild-count");

    if (!grid) return;

    if (state.loading) {
      grid.innerHTML = `
        <div class="loading-box card card-pad" style="grid-column: 1 / -1;">
          <div class="spinner"></div>
          <div>กำลังโหลดรายชื่อเซิร์ฟเวอร์...</div>
        </div>
      `;
      if (count) count.textContent = "กำลังโหลด";
      return;
    }

    const items = filterGuilds();

    if (count) {
      count.textContent = `${items.length} / ${state.guilds.length} เซิร์ฟเวอร์`;
    }

    if (!state.guilds.length) {
      grid.innerHTML = `
        <div class="empty" style="grid-column: 1 / -1;">
          <b>ไม่พบเซิร์ฟเวอร์ที่คุณมีสิทธิ์จัดการ</b><br>
          <span class="small">ต้องเป็น Owner หรือมีสิทธิ์ Administrator ในเซิร์ฟเวอร์นั้น</span>
        </div>
      `;
      return;
    }

    if (!items.length) {
      grid.innerHTML = `
        <div class="empty" style="grid-column: 1 / -1;">
          ไม่พบเซิร์ฟเวอร์ที่ตรงกับคำค้นหา
        </div>
      `;
      return;
    }

    grid.innerHTML = items.map(renderGuildCard).join("");
  }

  async function loadGuilds() {
    state.loading = true;
    render();

    try {
      const res = await fetch("/api/guilds", {
        headers: {
          Accept: "application/json"
        }
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      state.guilds = Array.isArray(data.guilds) ? data.guilds : [];
      state.loading = false;
      render();
    } catch (err) {
      state.loading = false;

      const grid = $("#guild-grid");
      if (grid) {
        grid.innerHTML = `
          <div class="alert alert-danger" style="grid-column: 1 / -1;">
            โหลดเซิร์ฟเวอร์ไม่สำเร็จ: ${h(err.message)}
          </div>
        `;
      }

      const count = $("#guild-count");
      if (count) count.textContent = "โหลดไม่ได้";
    }
  }

  function bindSearch() {
    const input = $("#guild-search");
    if (!input) return;

    input.addEventListener("input", () => {
      state.query = input.value || "";
      render();
    });
  }

  function bindRefresh() {
    const btn = $("#refresh-guilds");
    if (!btn) return;

    btn.addEventListener("click", () => {
      loadGuilds();
    });
  }

  function init() {
    bindSearch();
    bindRefresh();
    loadGuilds();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
