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
      <h1 id="guild-title">กำลังเปิดเซิร์ฟเวอร์…</h1>
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
  <button id="tab-data" class="verify-tab" type="button" role="tab" aria-selected="false" aria-controls="panel-data" data-tab="data">ข้อมูลผู้ยืนยัน</button>
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
          <button class="btn btn-soft" type="button" data-tab="data">เปิดข้อมูลสมาชิก</button>
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
        <div class="form-row form-row-2"><div><label for="v-minAge">อายุบัญชีขั้นต่ำ (วัน)</label><input id="v-minAge" type="number" min="0" max="3650" value="7"></div><div><label for="v-minConnections">ต้องเชื่อมอย่างน้อยกี่บริการ</label><input id="v-minConnections" type="number" min="1" max="20" value="1"></div></div>
        <label for="v-allowedCountries">ประเทศที่อนุญาต</label><input id="v-allowedCountries" type="text" placeholder="TH,US,JP หรือปล่อยว่าง">
        <label for="v-blockedCountries">ประเทศที่บล็อก</label><input id="v-blockedCountries" type="text" placeholder="CN,RU หรือปล่อยว่าง">
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
    <div class="data-stack"><article class="verify-panel member-directory">
        <div class="data-heading"><div><h2>สมาชิกและข้อมูลฉบับเต็ม</h2><p class="muted small">ข้อมูลบัญชี เซิร์ฟเวอร์ อุปกรณ์ เครือข่าย ประวัติ และ OAuth อยู่ในโปรไฟล์เดียว</p></div></div>
        <div class="form-row form-row-2">
          <div><label for="members-search">ค้นหา</label><input id="members-search" type="search" placeholder="User ID / username / IP / email"></div>
          <div><label for="members-result">ผลการยืนยัน</label><select id="members-result"><option value="">ทั้งหมด</option><option value="success">สำเร็จ</option><option value="failed">ไม่สำเร็จ</option><option value="blocked">ไม่ผ่านเงื่อนไข</option></select></div>
        </div>
        <div class="flex justify-between items-center gap-8 flex-wrap mt-14"><span class="muted small">แตะสมาชิกเพื่อเปิดหน้าข้อมูลแบบเต็มโดยไม่ออกจาก Dashboard</span><div class="flex gap-8"><button id="btn-members-prev" class="btn btn-soft btn-sm btn-inline" type="button">← ก่อนหน้า</button><span id="members-page" class="badge badge-muted">หน้า 1</span><button id="btn-members-next" class="btn btn-soft btn-sm btn-inline" type="button">ถัดไป →</button><button id="btn-members-refresh" class="btn btn-soft btn-sm btn-inline" type="button">รีเฟรช</button></div></div>
        <div id="members-body" class="member-card-grid mt-14"><div class="loading-box"><div class="spinner"></div>กำลังโหลดสมาชิก…</div></div>
      </article></div>
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
<div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true"></div>
<script src="/verification-assets/js/guild-dashboard.js"></script>`);
}

module.exports = { verificationGuildPage };
