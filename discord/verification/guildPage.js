"use strict";

const { createViewHelpers } = require("../index/viewHelpers");
const { BASE_CSS } = require("../index/viewStyles");
const { OWNER_VERIFICATION_CSS } = require("./ownerStyles");

const { navBar, shell } = createViewHelpers(`${BASE_CSS}${OWNER_VERIFICATION_CSS}`);

function securityActionOptions() {
    return `<option value="allow">อนุญาตและบันทึก</option><option value="deny_role">ไม่ให้ยศ</option><option value="timeout">หมดเวลาใน Discord</option><option value="kick">เตะออกจากเซิร์ฟเวอร์</option><option value="ban">แบนจากเซิร์ฟเวอร์</option>`;
}

function securityRuleMarkup(key, title, description, hasThreshold = false, threshold = 2) {
    return `<section class="security-rule" data-security-rule="${key}">
      <div class="security-rule-head"><div><h3>${title}</h3><p>${description}</p></div><label class="toggle"><input id="rule-${key}-enabled" type="checkbox"><span class="slider"></span></label></div>
      <div class="security-rule-fields">
        ${hasThreshold ? `<div><label for="rule-${key}-threshold">จำนวนสูงสุดที่อนุญาต</label><input id="rule-${key}-threshold" type="number" min="1" max="20" value="${threshold}"></div>` : ""}
        <div><label for="rule-${key}-action">เมื่อพบเงื่อนไขนี้</label><select id="rule-${key}-action">${securityActionOptions()}</select></div>
        <div class="timeout-field"><label for="rule-${key}-timeout">ระยะเวลาหมดเวลา (นาที)</label><input id="rule-${key}-timeout" type="number" min="1" max="40320" value="60"></div>
      </div>
    </section>`;
}

function verificationGuildPage() {
    return shell("จัดการระบบยืนยันตัวตน", `
<div class="verify-shell">
${navBar("/verification")}

<header class="verify-panel verify-workspace-head">
  <div class="verify-server">
    <div id="side-icon" class="verify-server-icon" aria-hidden="true">S</div>
    <div style="min-width:0">
      <p class="verify-kicker">Verification workspace</p>
      <h1 id="guild-title" class="gradient-text">กำลังเปิดเซิร์ฟเวอร์…</h1>
      <p id="guild-subtitle">กำลังโหลดสถานะและการตั้งค่าจริงจากระบบ</p>
    </div>
  </div>
  <div class="verify-workspace-actions">
    <a class="btn btn-soft btn-inline" href="/verification">← รายชื่อเซิร์ฟเวอร์</a>
    <div><label for="guild-switcher">เปลี่ยนเซิร์ฟเวอร์</label><select id="guild-switcher" class="guild-switcher"><option value="">กำลังโหลด…</option></select></div>
    <button id="btn-save-settings" class="btn btn-primary btn-inline" type="button">บันทึกทั้งหมด</button>
  </div>
</header>

<nav class="verify-tabs" role="tablist" aria-label="หมวดระบบยืนยันตัวตน">
  <button id="tab-overview" class="verify-tab active" type="button" role="tab" aria-selected="true" aria-controls="panel-overview" data-tab="overview">ภาพรวม</button>
  <button id="tab-system" class="verify-tab" type="button" role="tab" aria-selected="false" aria-controls="panel-system" data-tab="system">ตั้งค่าระบบ</button>
  <button id="tab-panel" class="verify-tab" type="button" role="tab" aria-selected="false" aria-controls="panel-panel" data-tab="panel">ตั้งค่าแผง</button>
  <button id="tab-policy" class="verify-tab" type="button" role="tab" aria-selected="false" aria-controls="panel-policy" data-tab="policy">เงื่อนไขและยศ</button>
  <button id="tab-data" class="verify-tab" type="button" role="tab" aria-selected="false" aria-controls="panel-data" data-tab="data">ส่งบันทึก Webhook</button>
</nav>

<div id="overview-error"></div>
<div class="verify-content">
  <section id="panel-overview" data-section="overview" role="tabpanel" aria-labelledby="tab-overview" tabindex="0">
    <div class="verify-grid four">
      <div class="stat-card"><div id="stat-total" class="num">0</div><div class="label">การยืนยันทั้งหมด</div><div class="sub">เหตุการณ์ของเซิร์ฟเวอร์นี้</div></div>
      <div class="stat-card"><div id="stat-success" class="num" style="color:var(--green2)">0</div><div class="label">สำเร็จ</div><div id="stat-rate" class="sub">อัตราสำเร็จ 0%</div></div>
      <div class="stat-card"><div id="stat-blocked" class="num" style="color:var(--red2)">0</div><div class="label">ไม่ผ่าน/ถูกบล็อก</div><div class="sub">นโยบายหรือการทำงานไม่สำเร็จ</div></div>
      <div class="stat-card"><div id="stat-review" class="num" style="color:var(--yellow2)">0</div><div class="label">ควรตรวจเพิ่ม</div><div class="sub">VPN, Proxy, TOR หรือตรวจ IP ไม่สำเร็จ</div></div>
    </div>
    <div class="verify-grid four mt-14">
      <div class="stat-card"><div id="stat-vpn" class="num">0</div><div class="label">VPN</div></div>
      <div class="stat-card"><div id="stat-proxy" class="num">0</div><div class="label">Proxy</div></div>
      <div class="stat-card"><div id="stat-tor" class="num">0</div><div class="label">TOR</div></div>
      <div class="stat-card"><div id="stat-pending" class="num">0</div><div class="label">Lookup ไม่สำเร็จ</div></div>
    </div>
    <div class="verify-grid one mt-14">
      <article class="verify-panel system-summary-card">
        <div class="section-title"><div><h2>สถานะระบบ</h2><p>ค่าที่ระบบกำลังใช้งานจริง</p></div><span id="overview-enabled" class="badge badge-muted">กำลังโหลด</span></div>
        <div class="kv">
          <div class="kv-row"><span class="kv-key">ยศหลังยืนยัน</span><span id="overview-role" class="kv-val">—</span></div>
          <div class="kv-row"><span class="kv-key">ห้องแผงยืนยัน</span><span id="overview-channel" class="kv-val">—</span></div>
          <div class="kv-row"><span class="kv-key">โหมด</span><span id="overview-mode" class="kv-val">—</span></div>
          <div class="kv-row"><span class="kv-key">อัปเดตล่าสุด</span><span id="overview-updated" class="kv-val">—</span></div>
          <div class="kv-row"><span class="kv-key">แหล่งข้อมูล</span><span id="overview-source" class="kv-val">—</span></div>
        </div>
        <div class="action-grid mt-14">
          <button class="btn btn-soft" type="button" data-tab="system">แก้ระบบ</button>
          <button class="btn btn-soft" type="button" data-tab="panel">แก้แผง</button>
          <button class="btn btn-soft" type="button" data-tab="policy">แก้เงื่อนไข</button>
          <button class="btn btn-soft" type="button" data-tab="data">ตั้งค่า Webhook Log</button>
        </div>
      </article>
    </div>
  </section>

  <section id="panel-system" data-section="system" role="tabpanel" aria-labelledby="tab-system" tabindex="0" class="hidden" hidden>
    <div class="verify-grid one">
      <article class="verify-panel">
        <div class="section-title"><div><h2>ตั้งค่าการทำงาน</h2><p>เลือกข้อมูลจาก Discord โดยตรง ระบบจะบันทึก ID ที่จำเป็นให้เอง</p></div><span class="badge badge-info">Discord</span></div>
        <div class="toggle-row"><div><div class="toggle-title">เปิดระบบยืนยันตัวตน</div><div class="toggle-sub">เมื่อปิด Callback จะไม่มอบยศ แม้ข้อความแผงเดิมยังอยู่</div></div><label class="toggle"><input id="v-enabled" type="checkbox" checked><span class="slider"></span></label></div>
        <input id="v-roleId" type="hidden"><input id="v-channelId" type="hidden"><input id="v-messageId" type="hidden">
        <div class="resource-picker-grid mt-14">
          <section><div class="picker-label"><b>ยศที่จะได้รับ</b><span>เลือก 1 ยศ</span></div><div id="role-options" class="resource-options"><div class="loading-box" style="width:100%"><div class="spinner"></div>กำลังโหลดยศ…</div></div></section>
          <section><div class="picker-label"><b>ห้องสำหรับแผงยืนยัน</b><span>เลือก 1 ห้อง</span></div><div id="channel-options" class="resource-options"><div class="loading-box" style="width:100%"><div class="spinner"></div>กำลังโหลดห้อง…</div></div></section>
        </div>
        <details class="technical-details mt-14"><summary>ข้อมูลแผงที่ระบบดูแลอัตโนมัติ</summary><div class="kv mt-10"><div class="kv-row"><span class="kv-key">ข้อความแผงล่าสุด</span><span id="system-message-id" class="kv-val mono">ยังไม่มีแผง</span></div></div></details>
      </article>
    </div>
    <article class="verify-panel mt-14">
      <div class="section-title"><div><h2>ตรวจความพร้อม</h2><p>ตรวจสิทธิ์บอท ลำดับยศ ห้องและ Environment ก่อนเปิดใช้จริง</p></div></div>
      <div class="action-grid">
        <button id="btn-check-setup" class="btn btn-info" type="button">ตรวจ Setup</button>
        <button id="btn-disable-verification" class="btn btn-danger" type="button">ปิดระบบยืนยันตัวตน</button>
      </div>
    </article>
  </section>

  <section id="panel-panel" data-section="panel" role="tabpanel" aria-labelledby="tab-panel" tabindex="0" class="hidden" hidden>
    <div class="verify-grid two">
      <article class="verify-panel">
        <div class="section-title"><div><h2>เนื้อหาแผง Discord</h2><p>กำหนดข้อความ Embed รูปและปุ่ม</p></div><span class="badge badge-info">Live preview</span></div>
        <label for="p-content">ข้อความเหนือ Embed</label><textarea id="p-content" placeholder="ปล่อยว่างได้"></textarea>
        <label for="p-title">หัวข้อ</label><input id="p-title" type="text" maxlength="256" placeholder="🔐 ยืนยันตัวตนเพื่อเข้าดิส">
        <label for="p-description">คำอธิบาย</label><textarea id="p-description" maxlength="4000" placeholder="กดปุ่มด้านล่างเพื่อยืนยันตัวตน"></textarea>
        <div class="form-row form-row-2">
          <div><label for="p-color">สี Embed</label><input id="p-color" type="text" maxlength="7" placeholder="#5865F2"></div>
          <div><label for="p-verifyType">รูปแบบการยืนยัน</label><select id="p-verifyType"><option value="oauth">OAuth2 Verification</option><option value="direct">กดรับยศทันที</option></select></div>
        </div>
        <label for="p-buttonText">ข้อความบนปุ่ม</label><input id="p-buttonText" type="text" maxlength="80" placeholder="✅ ยืนยันตัวตน ✅">
        <label for="p-imageUrl">Image/GIF URL</label><input id="p-imageUrl" type="url" placeholder="https://…">
        <label for="p-thumbnailUrl">Thumbnail URL</label><input id="p-thumbnailUrl" type="url" placeholder="https://…">
        <label for="p-footerText">Footer</label><input id="p-footerText" type="text" maxlength="2048" placeholder="Discord Verification System">
        <label for="p-titleUrl">Title URL</label><input id="p-titleUrl" type="url" placeholder="https://…">
        <div class="toggle-row"><div><div class="toggle-title">แสดงเวลาใน Embed</div><div class="toggle-sub">เพิ่ม Timestamp ในข้อความที่ส่ง</div></div><label class="toggle"><input id="p-showTimestamp" type="checkbox"><span class="slider"></span></label></div>
      </article>
      <div>
        <article class="verify-panel">
          <div class="section-title"><div><h2>ตัวอย่างก่อนส่ง</h2><p>จำลองพื้นที่ข้อความจริงทั้งบนคอมพิวเตอร์และมือถือ</p></div><span class="badge badge-muted">Preview</span></div>
          <div class="discord-message-preview"><div class="discord-preview-author"><span class="discord-preview-avatar">B</span><div><b>Phomueangtai</b><small>BOT</small></div></div><div id="preview-content" class="discord-preview-content"></div><div id="embed-preview" class="embed-preview"><div class="embed-preview-title">🔐 ยืนยันตัวตนเพื่อเข้าดิส</div><div class="embed-preview-desc">กดปุ่มด้านล่างเพื่อยืนยันตัวตน</div></div><div id="button-preview"><div class="button-preview">✅ ยืนยันตัวตน ✅</div></div></div>
        </article>
        <article class="verify-panel mt-14">
          <div class="section-title"><div><h2>สถานะการซิงค์กับ Discord</h2><p>ตรวจข้อความจริงโดยไม่แก้ไขข้อมูล</p></div><span id="panel-sync-badge" class="badge badge-muted">ยังไม่ได้ตรวจ</span></div>
          <div id="panel-sync-detail" class="muted small">กดตรวจสอบเพื่อเปรียบเทียบเว็บกับแผงล่าสุดใน Discord</div>
          <button id="btn-check-panel-sync" class="btn btn-soft mt-14" type="button">ตรวจสอบการซิงค์</button>
        </article>
        <article class="verify-panel mt-14">
          <div class="section-title"><div><h2>ส่งและอัปเดตแผง</h2><p>ตรวจข้อมูลก่อนแก้ข้อความจริง</p></div></div>
          <div class="action-grid">
            <button id="btn-validate-panel" class="btn btn-info" type="button">ตรวจสอบแผง</button>
            <button id="btn-update-panel" class="btn btn-primary" type="button">แก้แผงเดิม</button>
            <button id="btn-send-panel" class="btn btn-success" type="button">ส่งแผงใหม่</button>
          </div>
        </article>
      </div>
    </div>
  </section>

  <section id="panel-policy" data-section="policy" role="tabpanel" aria-labelledby="tab-policy" tabindex="0" class="hidden" hidden>
    <div class="verify-grid one">
      <article class="verify-panel">
        <div class="section-title"><div><h2>เงื่อนไขบัญชี</h2><p>ข้อกำหนดที่สมาชิกต้องผ่านก่อนรับยศ</p></div><span class="badge badge-warn">Policy</span></div>
        <div class="toggle-row"><div><div class="toggle-title">ต้องมี Email</div></div><label class="toggle"><input id="v-requireEmail" type="checkbox"><span class="slider"></span></label></div>
        <div class="toggle-row"><div><div class="toggle-title">Email ต้องยืนยันแล้ว</div></div><label class="toggle"><input id="v-requireEmailVerified" type="checkbox"><span class="slider"></span></label></div>
        <div class="toggle-row"><div><div class="toggle-title">ต้องเชื่อมบัญชีภายนอกกับ Discord</div><div class="toggle-sub">เช่น Steam, Twitch, YouTube หรือ GitHub</div></div><label class="toggle"><input id="v-requireConnections" type="checkbox"><span class="slider"></span></label></div>
        <div class="form-row"><div><label for="v-minAge">อายุบัญชีขั้นต่ำ (วัน) — ระบุ 0 หากไม่จำกัด</label><input id="v-minAge" type="number" min="0" max="3650" value="0"></div></div>
      </article>
      <article class="verify-panel"><div class="section-title"><div><h2>กฎตรวจสอบและการดำเนินการ</h2><p>แต่ละกฎเปิด–ปิดและเลือกการทำงานใน Discord ได้แยกจากกัน</p></div></div><div id="security-rules" class="security-rules">
        ${securityRuleMarkup("vpnProxyTor", "VPN, Proxy หรือ TOR", "ตรวจเครือข่ายที่ปกปิดต้นทาง")}
        ${securityRuleMarkup("hosting", "Hosting หรือ Datacenter", "ตรวจ IP ของเซิร์ฟเวอร์และศูนย์ข้อมูล")}
        ${securityRuleMarkup("ipDuplicate", "หลายบัญชีต่อ IP", "จำกัดจำนวนบัญชีที่ใช้เครือข่ายเดียวกัน", true, 3)}
        ${securityRuleMarkup("deviceDuplicate", "หลายบัญชีต่ออุปกรณ์", "จำกัดจำนวนบัญชีที่ใช้อุปกรณ์เดียวกัน", true, 2)}
        ${securityRuleMarkup("previouslyBlockedIp", "IP ที่เคยถูกปฏิเสธ", "ตรวจประวัติการยืนยันจาก IP เดิม")}
        ${securityRuleMarkup("spoofedHeader", "ข้อมูล IP จากเบราว์เซอร์ไม่ตรงกัน", "ตรวจ Header ที่ขัดแย้งกับต้นทาง")}
        ${securityRuleMarkup("unknownLookup", "ตรวจสอบ IP ไม่สำเร็จ", "กำหนดวิธีรับมือเมื่อผู้ให้บริการตรวจ IP ล้มเหลว")}
      </div></article>
    </div>
    <div class="alert alert-info">กด “บันทึกทั้งหมด” ด้านบนหลังแก้เงื่อนไข ระบบจะตรวจรูปแบบและบันทึกให้เซิร์ฟเวอร์ที่กำลังเลือกเท่านั้น</div>
  </section>

  <section id="panel-data" data-section="data" role="tabpanel" aria-labelledby="tab-data" tabindex="0" class="hidden" hidden>
    <div class="data-stack">
      <article class="verify-panel oauth-recovery-panel">
        <div class="data-heading"><div><p class="verify-kicker">OAuth recovery</p><h2>บัญชีที่ต้องยืนยันใหม่</h2><p class="muted small">ตรวจ Token ที่หาย หมดอายุ ถอดรหัสไม่ได้ ถูกยกเลิก หรือขาด Scope โดยไม่ส่งข้อความรบกวนสมาชิก</p></div><div class="recovery-count-wrap"><strong id="oauth-recovery-count">—</strong><span>บัญชี</span></div></div>
        <div id="oauth-recovery-status" class="muted small mt-10">เปิดหมวดนี้เพื่อโหลดสถานะล่าสุด</div>
        <div class="flex gap-8 flex-wrap mt-14"><button id="btn-oauth-recovery-refresh" class="btn btn-soft btn-inline" type="button">ตรวจใหม่</button><button id="btn-oauth-recovery-revoke-all" class="btn btn-danger btn-inline" type="button" disabled>ถอนยศทั้งหมดในรายการ</button></div>
        <div id="oauth-recovery-list" class="recovery-list mt-14"><div class="empty">ยังไม่ได้โหลดข้อมูล</div></div>
      </article>

      <article class="verify-panel">
        <div class="data-heading">
          <div>
            <p class="verify-kicker">Discord Webhook Log</p>
            <h2>ส่งบันทึกการยืนยันตัวตน (Webhook Log)</h2>
            <p class="muted small">ส่งข้อมูลบัญชี เครือข่าย อุปกรณ์ และผลการยืนยันตัวตนไปยังห้อง Discord ที่กำหนดโดยอัตโนมัติ</p>
          </div>
          <div>
            <span id="webhook-badge-status" class="badge badge-muted">รอตั้งค่า</span>
          </div>
        </div>

        <div class="mt-14">
          <label for="webhook-url-input" style="display:block; margin-bottom:6px; font-weight:600;">Discord Webhook URL</label>
          <div style="display:flex; gap:10px; align-items:center;">
            <input id="webhook-url-input" type="url" placeholder="https://discord.com/api/webhooks/..." style="flex:1; padding:10px 14px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:rgba(0,0,0,0.2); color:#fff;">
            <button id="btn-save-webhook-url" class="btn btn-primary" type="button" style="white-space:nowrap; padding:10px 20px;">ตรวจสอบและบันทึก URL</button>
          </div>
          <p class="muted small mt-10">วิธีสร้าง Webhook: ไปที่การตั้งค่าห้องใน Discord &gt; การผสานรวม (Integrations) &gt; สร้างเว็บบุ๊ก (Webhooks) แล้วคัดลอกลิงก์มาวางที่นี่</p>
        </div>
      </article>

      <article class="verify-panel mt-14">
        <div class="section-title">
          <div>
            <h2>ความพร้อมของระบบ</h2>
            <p>ตรวจสอบสถานะก่อนเริ่มส่งข้อมูลไปยังห้อง Discord</p>
          </div>
          <button id="btn-refresh-webhook-status" class="btn btn-soft btn-sm" type="button">ตรวจใหม่</button>
        </div>

        <div id="webhook-checklist-container" class="mt-14" style="display:flex; flex-direction:column; gap:12px;">
          <div class="checklist-item" style="display:flex; align-items:center; gap:12px; padding:12px 16px; border-radius:8px; background:rgba(255,255,255,0.03);">
            <div id="check-icon-url" class="status-indicator-dot" style="width:12px; height:12px; border-radius:50%; background:var(--muted);"></div>
            <div style="flex:1;">
              <strong style="display:block;">รูปแบบ Webhook URL</strong>
              <span id="check-text-url" class="muted small">ยังไม่ได้ระบุ Webhook URL</span>
            </div>
            <span id="check-badge-url" class="badge badge-muted">ยังไม่พร้อม</span>
          </div>

          <div class="checklist-item" style="display:flex; align-items:center; gap:12px; padding:12px 16px; border-radius:8px; background:rgba(255,255,255,0.03);">
            <div id="check-icon-db" class="status-indicator-dot" style="width:12px; height:12px; border-radius:50%; background:var(--green2);"></div>
            <div style="flex:1;">
              <strong style="display:block;">การเชื่อมต่อฐานข้อมูล</strong>
              <span id="check-text-db" class="muted small">ระบบฐานข้อมูลหลักพร้อมทำงาน</span>
            </div>
            <span id="check-badge-db" class="badge badge-success">พร้อมใช้งาน</span>
          </div>

          <div class="checklist-item" style="display:flex; align-items:center; gap:12px; padding:12px 16px; border-radius:8px; background:rgba(255,255,255,0.03);">
            <div id="check-icon-queue" class="status-indicator-dot" style="width:12px; height:12px; border-radius:50%; background:var(--green2);"></div>
            <div style="flex:1;">
              <strong style="display:block;">ระบบคิวส่งข้อมูลและป้องกันการติดขัด</strong>
              <span id="check-text-queue" class="muted small">คิวส่งข้อมูลพร้อมทำงาน</span>
            </div>
            <span id="check-badge-queue" class="badge badge-success">พร้อมใช้งาน</span>
          </div>

          <div class="checklist-item" style="display:flex; align-items:center; gap:12px; padding:12px 16px; border-radius:8px; background:rgba(255,255,255,0.03);">
            <div id="check-icon-worker" class="status-indicator-dot" style="width:12px; height:12px; border-radius:50%; background:var(--muted);"></div>
            <div style="flex:1;">
              <strong style="display:block;">สถานะการทำงานปัจจุบัน</strong>
              <span id="check-text-worker" class="muted small">ระบบยังไม่เริ่มทำงาน กรุณาบันทึก URL และเลือกปุ่มเริ่มทำงานด้านล่าง</span>
            </div>
            <span id="check-badge-worker" class="badge badge-muted">รอเริ่มงาน</span>
          </div>
        </div>
      </article>

      <article class="verify-panel mt-14">
        <div class="section-title">
          <div>
            <h2>แผงควบคุมการส่งข้อมูล</h2>
            <p>เลือกรูปแบบการทำงานของระบบบันทึก Webhook</p>
          </div>
        </div>

        <div id="webhook-progress-box" class="hidden mt-10" style="padding:16px; border-radius:8px; background:rgba(88,101,242,0.1); border:1px solid rgba(88,101,242,0.3);">
          <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
            <strong id="webhook-progress-title">กำลังประมวลผลส่งข้อมูล...</strong>
            <span id="webhook-progress-count" style="font-weight:600;">0 / 0 รายการ</span>
          </div>
          <div style="height:8px; width:100%; border-radius:4px; background:rgba(255,255,255,0.1); overflow:hidden;">
            <div id="webhook-progress-bar" style="height:100%; width:0%; background:#5865F2; transition:width 0.3s ease;"></div>
          </div>
          <p id="webhook-progress-detail" class="muted small mt-10">ระบบกำลังส่งข้อมูลตามลำดับและจำกัดความเร็วเพื่อป้องกันข้อผิดพลาดจาก Discord</p>
        </div>

        <div class="action-grid mt-14" style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
          <div style="padding:16px; border-radius:10px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); display:flex; flex-direction:column; justify-content:space-between;">
            <div>
              <h3 style="margin:0 0 6px 0; font-size:1.1rem; color:#fff;">ส่งเฉพาะรายการใหม่</h3>
              <p class="muted small" style="margin:0 0 14px 0;">ระบบจะเริ่มส่งเฉพาะคนที่มายืนยันตัวตนใหม่ตั้งแต่ตอนนี้เป็นต้นไป โดยไม่ส่งประวัติเดิมย้อนหลัง</p>
            </div>
            <button id="btn-start-live-only" class="btn btn-success" type="button" style="width:100%; padding:12px; font-weight:600;">เริ่มทำงานระบบ Webhook</button>
          </div>

          <div style="padding:16px; border-radius:10px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); display:flex; flex-direction:column; justify-content:space-between;">
            <div>
              <h3 style="margin:0 0 6px 0; font-size:1.1rem; color:#fff;">ส่งประวัติเดิมทั้งหมดและทำงานต่อ</h3>
              <p class="muted small" style="margin:0 0 14px 0;">ระบบจะดึงประวัติการยืนยันตัวตนทั้งหมดในเซิร์ฟเวอร์ส่งไปยัง Webhook ให้ครบก่อน แล้วทำงานต่ออัตโนมัติ</p>
            </div>
            <button id="btn-start-backfill-all" class="btn btn-primary" type="button" style="width:100%; padding:12px; font-weight:600;">เริ่มตรวจส่ง Webhook ทั้งหมดและทำงานต่อ</button>
          </div>
        </div>
      </article>
    </div>
  </section>
</div>

<section id="validation-box" class="verify-panel hidden"><details id="validation-details" open><summary class="validation-summary"><span><b>ผลการตรวจสอบ</b><small>สิทธิ์บอท ยศ ห้อง และค่าที่จำเป็น</small></span><span id="validation-summary-badge" class="badge badge-muted">ยังไม่ได้ตรวจ</span></summary><div id="validation-body" class="mt-14"></div></details></section>
</div>

<div id="detail-modal" class="modal-backdrop" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="detail-modal-title" tabindex="-1">
    <div class="modal-head"><h2 id="detail-modal-title" class="modal-title">รายละเอียดสมาชิก</h2><button class="modal-close" type="button" aria-label="ปิด" data-close-modal>✕</button></div>
    <div id="detail-modal-body"></div>
    <div class="modal-actions"><button class="btn btn-soft btn-inline" type="button" data-close-modal>ปิด</button></div>
  </div>
</div>
<div id="oauth-recovery-confirm" class="modal-backdrop" aria-hidden="true">
  <div class="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="oauth-recovery-confirm-title" tabindex="-1">
    <div class="modal-head"><h2 id="oauth-recovery-confirm-title" class="modal-title">ยืนยันการถอนยศ</h2><button class="modal-close" type="button" aria-label="ยกเลิก" data-close-recovery-confirm>✕</button></div>
    <div id="oauth-recovery-confirm-text" class="notice notice-warn"></div>
    <p class="muted small mt-10">ระบบจะถอนเฉพาะยศยืนยันใน Discord และจะไม่ส่ง DM หรือข้อความแจ้งสมาชิก</p>
    <div class="modal-actions"><button class="btn btn-soft btn-inline" type="button" data-close-recovery-confirm>ยกเลิก</button><button id="btn-confirm-oauth-recovery-revoke" class="btn btn-danger btn-inline" type="button">ยืนยันถอนยศ</button></div>
  </div>
</div>
<div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true"></div>
<script src="/verification-assets/js/guild-dashboard.js"></script>`);
}

module.exports = { verificationGuildPage };
