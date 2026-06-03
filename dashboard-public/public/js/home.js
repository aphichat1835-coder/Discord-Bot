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
    if (el) el.textContent = String(new Date().getFullYear());
  }

  function bindCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const text = btn.getAttribute("data-copy") || "";

        try {
          await navigator.clipboard.writeText(text);
          const old = btn.textContent;
          btn.textContent = "คัดลอกแล้ว";
          setTimeout(() => {
            btn.textContent = old;
          }, 1200);
        } catch {
          btn.textContent = "คัดลอกไม่ได้";
        }
      });
    });
  }

  function bindSmoothAnchors() {
    document.querySelectorAll("a[href^='#']").forEach((link) => {
      link.addEventListener("click", (event) => {
        const id = link.getAttribute("href");
        const target = id ? document.querySelector(id) : null;

        if (!target) return;

        event.preventDefault();
        target.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      });
    });
  }

  function init() {
    setYear();
    bindCopyButtons();
    bindSmoothAnchors();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
