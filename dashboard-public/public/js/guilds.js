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

  function showToast(message, type = "info") {
    const toast = $("#toast");
    if (!toast) return;

    toast.textContent = message;
    toast.className = `toast show ${type}`;

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.classList.remove("show");
    }, 2600);
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

    const ext = String(guild.icon).startsWith("a_") ? "gif" : "webp";
    return `https://cdn.discordapp.com/icons/${encodeURIComponent(guild.id)}/${encodeURIComponent(guild.icon)}.${ext}?size=128`;
  }

  function permissionLabel(guild) {
    if (guild.owner || guild.isOwner) return "Owner";
    if (guild.isAdmin) return "Administrator";
    if (guild.canManageGuild) return "Manage Guild";
    if (guild.canManageRoles) return "Manage Roles";
    if (guild.permissionsText) return guild.permissionsText;
    return "จัดการได้";
  }

  function permissionBadges(guild) {
    const badges = [];

    if (guild.owner || guild.isOwner) {
      badges.push(`<span class="badge badge-ok">Owner</span>`);
    } else if (guild.isAdmin) {
      badges.push(`<span class="badge badge-info">Administrator</span>`);
    } else if (guild.canManageGuild) {
      badges.push(`<span class="badge badge-cyan">Manage Guild</span>`);
    } else if (guild.canManageRoles) {
      badges.push(`<span class="badge badge-cyan">Manage Roles</span>`);
    } else {
      badges.push(`<span class="badge badge-muted">${h(permissionLabel(guild))}</span>`);
    }

    if (guild.canManage !== false) {
      badges.push(`<span class="badge badge-cyan">Dashboard</span>`);
    }

    return badges.join("");
  }

  function filterGuilds() {
    const q = state.query.trim().toLowerCase();

    if (!q) return state.guilds;

    return state.guilds.filter((guild) => {
      const name = String(guild.name || "").toLowerCase();
      const id = String(guild.id || "").toLowerCase();
      const label = permissionLabel(guild).toLowerCase();

      return name.includes(q) || id.includes(q) || label.includes(q);
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
          ${permissionBadges(guild)}
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
          <span class="small">
            ต้องเป็น Owner หรือมีสิทธิ์ Administrator / Manage Guild / Manage Roles ในเซิร์ฟเวอร์นั้น
          </span>
          <div class="mt-14">
            <a class="btn btn-primary" href="/auth/login">Login ใหม่ด้วย Discord</a>
          </div>
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

      if (res.status === 401) {
        showToast("Session หมดอายุ กรุณา Login ใหม่", "err");
        setTimeout(() => {
          location.href = "/auth/login";
        }, 650);
        return;
      }

      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      state.guilds = Array.isArray(data.guilds) ? data.guilds : [];
      state.loading = false;
      render();

      if (/^\d{17,22}$/.test(String(data.preferredGuildId || "")) &&
          state.guilds.some((guild) => guild.id === String(data.preferredGuildId))) {
        location.assign(`/guild/${encodeURIComponent(data.preferredGuildId)}`);
        return;
      }

      showToast("โหลดรายชื่อเซิร์ฟเวอร์แล้ว", "ok");
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

      showToast("โหลดเซิร์ฟเวอร์ไม่สำเร็จ", "err");
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
