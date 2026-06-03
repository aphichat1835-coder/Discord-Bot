/*
================================================================================
  Dashboard Public v2 — Home Page JS
================================================================================
*/

(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);

  function setYear() {
    const el = $("#year");
    if (el) {
      el.textContent = String(new Date().getFullYear());
    }
  }

  async function copyText(text) {
    const value = String(text || "");

    if (!value) return false;

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "-9999px";

    document.body.appendChild(textarea);
    textarea.select();

    let ok = false;

    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }

    textarea.remove();
    return ok;
  }

  function bindCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const text = btn.getAttribute("data-copy") || "";
        const old = btn.textContent;

        try {
          const ok = await copyText(text);
          btn.textContent = ok ? "คัดลอกแล้ว" : "คัดลอกไม่ได้";
        } catch {
          btn.textContent = "คัดลอกไม่ได้";
        }

        setTimeout(() => {
          btn.textContent = old;
        }, 1200);
      });
    });
  }

  function bindSmoothAnchors() {
    document.querySelectorAll("a[href^='#']").forEach((link) => {
      link.addEventListener("click", (event) => {
        const id = link.getAttribute("href");

        if (!id || id === "#") return;

        let target = null;

        try {
          target = document.querySelector(id);
        } catch {
          target = null;
        }

        if (!target) return;

        event.preventDefault();

        target.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      });
    });
  }

  function bindLoginButtons() {
    document.querySelectorAll("a[href='/auth/login'], a[href='/oauth/admin']").forEach((link) => {
      link.addEventListener("click", () => {
        const old = link.textContent;
        link.dataset.oldText = old;
        link.textContent = "กำลังเปิด Discord...";
        link.classList.add("is-loading");

        setTimeout(() => {
          if (link.dataset.oldText) {
            link.textContent = link.dataset.oldText;
            link.classList.remove("is-loading");
          }
        }, 2500);
      });
    });
  }

  function init() {
    setYear();
    bindCopyButtons();
    bindSmoothAnchors();
    bindLoginButtons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
