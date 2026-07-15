/*
================================================================================
  Unified Runtime — Verification Callback JS
  - Public callback ไม่โชว์ debug/internal logs ให้ผู้ใช้ทั่วไป
  - แสดง requestId เฉพาะตอน error เพื่อแจ้งแอดมินได้
  - ส่งข้อมูล browser/device summary ให้ backend ใช้บันทึก
================================================================================
*/

(function () {
  "use strict";

  const q = new URLSearchParams(location.search);
  const code = q.get("code");
  const state = q.get("state");
  const error = q.get("error");
  const errorDescription = q.get("error_description");

  const showDebug = false;

  const errorMap = {
    access_denied: "คุณปฏิเสธการอนุญาต กรุณากลับไปที่ Discord แล้วกดปุ่มยืนยันใหม่อีกครั้ง",

    missing_code_or_state: "ไม่พบรหัสยืนยันตัวตน กรุณากดปุ่มจาก Discord ใหม่อีกครั้ง",
    missing_oauth_code: "ไม่พบรหัส OAuth กรุณากดปุ่มยืนยันใหม่อีกครั้ง",
    invalid_callback_state: "ลิงก์ยืนยันไม่ถูกต้อง กรุณากดปุ่มใหม่อีกครั้ง",
    oauth_code_expired_or_used: "ลิงก์ยืนยันถูกใช้ไปแล้วหรือหมดอายุ กรุณากดปุ่มยืนยันใหม่ใน Discord",

    expired_or_invalid: "ลิงก์ยืนยันหมดอายุหรือไม่ถูกต้อง กรุณากดปุ่มใหม่อีกครั้ง",
    invalid_or_expired_link: "ลิงก์ยืนยันไม่ถูกต้อง กรุณากดปุ่มใหม่อีกครั้ง",
    invalid_panel: "แผงยืนยันไม่ถูกต้อง กรุณาแจ้งแอดมินสร้างแผงใหม่",

    role_mismatch: "ลิงก์นี้ไม่ตรงกับการตั้งค่าปัจจุบัน กรุณากดปุ่มใหม่อีกครั้ง",
    role_mismatch_latest_config: "ลิงก์ยืนยันไม่ตรงกับการตั้งค่าปัจจุบัน กรุณาใช้แผงล่าสุด",
    panel_revision_mismatch: "แผงยืนยันนี้ไม่ใช่แผงล่าสุด กรุณากดปุ่มจากแผงยืนยันล่าสุดใน Discord",
    guild_config_missing_role: "ระบบยังไม่ได้ตั้งค่า Role ID กรุณาแจ้งแอดมิน",
    verification_disabled: "ระบบยืนยันตัวตนของเซิร์ฟเวอร์นี้ยังไม่เปิดใช้งาน",
    server_not_configured: "เซิร์ฟเวอร์นี้ยังไม่ได้ตั้งค่าระบบยืนยันตัวตน",

    oauth_user_mismatch: "บัญชี Discord ไม่ตรงกับผู้ที่กดปุ่มยืนยัน",
    guild_join_failed: "ระบบไม่สามารถพาคุณเข้าเซิร์ฟเวอร์ได้ กรุณาเข้าดิสก่อนแล้วลองใหม่",
    member_not_found_after_oauth: "ระบบหาโปรไฟล์สมาชิกในเซิร์ฟเวอร์ไม่เจอ กรุณาเข้าดิสก่อนแล้วลองใหม่",

    new_account: "บัญชี Discord อายุน้อยเกินไป ไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์",
    network_risk_vpn_proxy_tor: "ตรวจพบการใช้ VPN, Proxy หรือ TOR กรุณาปิดก่อนแล้วลองใหม่",
    email_requirement_failed: "บัญชีนี้ไม่มี Email หรือ Email ยังไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์",
    connections_requirement_failed: "บัญชีนี้ยังไม่ผ่านเงื่อนไข connections ของเซิร์ฟเวอร์",
    country_not_allowed: "ประเทศของคุณไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์",
    country_blocked: "ประเทศของคุณถูกบล็อกโดยเซิร์ฟเวอร์นี้",
    rate_limited: "มีการยืนยันถี่เกินไป กรุณารอสักครู่แล้วลองใหม่",
    spoofed_ip_header: "ระบบตรวจพบข้อมูลเครือข่ายผิดปกติ กรุณาปิด proxy/VPN หรือเปลี่ยนเครือข่ายแล้วลองใหม่",
    ip_lookup_failed: "ระบบตรวจสอบเครือข่ายช้า กรุณารอสักครู่แล้วลองใหม่",
    ip_duplicate_limit: "เครือข่ายนี้มีการยืนยันหลายบัญชีเกินเงื่อนไขของเซิร์ฟเวอร์",
    device_duplicate_limit: "อุปกรณ์นี้มีการยืนยันหลายบัญชีเกินเงื่อนไขของเซิร์ฟเวอร์",
    previously_blocked_ip: "เครือข่ายนี้มีประวัติความเสี่ยง กรุณาแจ้งแอดมินหากคิดว่าเป็นข้อผิดพลาด",
    hosting_blocked: "เครือข่ายนี้เป็น Hosting/Datacenter ไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์",

    role_assign_failed: "ยืนยันผ่านแล้ว แต่ระบบไม่สามารถให้ยศได้ กรุณาแจ้งแอดมิน",
    missing_verify_token: "ไม่พบรหัสยืนยันตัวตน กรุณากดปุ่มจาก Discord ใหม่อีกครั้ง",

    verify_internal_error: "ระบบยืนยันตัวตนมีปัญหาภายใน กรุณาลองใหม่อีกครั้ง",
    internal_error: "ระบบมีปัญหาภายใน กรุณาลองใหม่อีกครั้ง",
    invalid_json_response: "ระบบตอบกลับไม่ถูกต้อง กรุณาลองใหม่"
  };

  const stepOrder = ["discord", "account", "security", "role"];

  function $(id) {
    return document.getElementById(id);
  }

  function show(id) {
    document.querySelectorAll(".callback-state").forEach((el) => {
      el.classList.remove("active");
      el.setAttribute("aria-hidden", "true");
    });

    const target = $(id);
    if (target) {
      target.classList.add("active");
      target.setAttribute("aria-hidden", "false");
      target.focus({ preventScroll: true });
    }
  }

  function setStep(activeStep) {
    const activeIndex = stepOrder.indexOf(activeStep);

    document.querySelectorAll(".verify-step").forEach((el) => {
      const index = stepOrder.indexOf(el.dataset.step);

      el.classList.remove("active", "done");
      el.removeAttribute("aria-current");

      if (index < activeIndex) {
        el.classList.add("done");
      } else if (index === activeIndex) {
        el.classList.add("active");
        el.setAttribute("aria-current", "step");
      }
    });
  }

  function setStatus(text, step) {
    const el = $("statusText");
    if (el) el.textContent = text;

    if (step) setStep(step);
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text ?? "";
  }

  function cleanCode(codeLike) {
    return String(codeLike || "")
      .split(":")[0]
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80);
  }

  function getFriendlyError(dataOrCode, fallback) {
    const code = typeof dataOrCode === "string"
      ? cleanCode(dataOrCode)
      : cleanCode(dataOrCode?.code || dataOrCode?.debugCode);

    return errorMap[code] || fallback || "ยืนยันตัวตนไม่สำเร็จ";
  }

  function fail(message, detail, requestId) {
    setText("err-msg", message || "ยืนยันตัวตนไม่สำเร็จ");

    const requestBox = $("request-id");

    if (requestBox) {
      requestBox.textContent = requestId ? `รหัสอ้างอิง: ${requestId}` : "";
      requestBox.style.display = requestId ? "block" : "none";
    }

    const detailBox = $("err-detail");

    if (detailBox) {
      if (showDebug && detail) {
        detailBox.style.display = "block";
        detailBox.textContent = `Debug: ${detail}`;
      } else {
        detailBox.style.display = "none";
        detailBox.textContent = "";
      }
    }

    show("s-error");
  }

  function success(data) {
    setText("ok-msg", data.message || "ระบบเพิ่มยศให้เรียบร้อยแล้ว");

    if (data.user) {
      setText("name", data.user.globalName || data.user.username || "Discord User");
      setText("tag", data.user.tag || data.user.id || "—");

      const avatar = $("avatar");

      if (avatar && data.user.avatarUrl) {
        avatar.src = data.user.avatarUrl;
        avatar.style.display = "block";
      } else if (avatar) {
        avatar.style.display = "none";
      }
    }

    if (data.roleName) {
      setText("roleName", data.roleName);

      const rolePill = $("rolePill");
      if (rolePill) rolePill.style.display = "inline-flex";
    }

    show("s-success");
  }

  function getDevicePayload() {
    const screenSize = typeof screen !== "undefined"
      ? `${screen.width}x${screen.height}`
      : "";

    const browserLanguages = Array.isArray(navigator.languages) ? navigator.languages : [];
    return {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      language: navigator.language || "",
      languages: browserLanguages.slice(0, 8),
      languagesReportedCount: browserLanguages.length,
      languagesTruncated: browserLanguages.length > 8,
      platform: navigator.platform || "",
      userAgent: navigator.userAgent || "",
      screenSize,
      viewportSize: `${window.innerWidth}x${window.innerHeight}`,
      colorDepth: typeof screen !== "undefined" ? screen.colorDepth : null,
      devicePixelRatio: window.devicePixelRatio || 1,
      touchPoints: navigator.maxTouchPoints || 0,
      referrer: document.referrer || ""
    };
  }

  async function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function run() {
    setStep("discord");

    // OAuth authorization codes are one-time credentials. Remove them from the
    // address bar after capture so a manual refresh cannot submit the same code.
    if ((code || error) && globalThis.history?.replaceState) {
      globalThis.history.replaceState(null, "", globalThis.location.pathname);
    }

    if (error) {
      fail(
        errorMap[error] || errorDescription || error,
        error
      );
      return;
    }

    if (!code || !state) {
      fail(
        "ไม่พบรหัสยืนยันตัวตน กรุณากดปุ่มจาก Discord ใหม่อีกครั้ง",
        "missing_code_or_state"
      );
      return;
    }

    try {
      setStatus("กำลังรับข้อมูลจาก Discord", "discord");
      await wait(80);

      setStatus("กำลังตรวจสอบบัญชี Discord", "account");
      await wait(80);

      setStatus("กำลังตรวจสอบเงื่อนไขความปลอดภัย", "security");
      await wait(80);

      const payload = {
        code,
        state,
        ...getDevicePayload()
      };

      const res = await fetch("/auth/callback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(payload)
      });

      setStatus("กำลังเพิ่มยศให้คุณ", "role");

      const data = await res.json().catch(() => null);

      if (!data) {
        fail(
          errorMap.invalid_json_response,
          "invalid_json_response"
        );
        return;
      }

      if (!res.ok || data.success === false) {
        const friendly = getFriendlyError(data, data.error || "ยืนยันตัวตนไม่สำเร็จ");
        fail(friendly, data.debugCode || data.code, data.requestId);
        return;
      }

      document.querySelectorAll(".verify-step").forEach((el) => {
        el.classList.remove("active");
        el.classList.add("done");
      });

      await wait(180);
      success(data);
    } catch (err) {
      fail(
        "เชื่อมต่อระบบยืนยันตัวตนไม่ได้ กรุณาลองใหม่อีกครั้ง",
        err.message
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
