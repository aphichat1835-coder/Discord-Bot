"use strict";

const { createViewHelpers } = require("../index/viewHelpers");
const { BASE_CSS } = require("../index/viewStyles");
const { OWNER_VERIFICATION_CSS } = require("./ownerStyles");

const { navBar, shell } = createViewHelpers(`${BASE_CSS}${OWNER_VERIFICATION_CSS}`);

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
      <div class="stat-card"><div id="stat-risk" class="num" style="color:var(--yellow2)">0</div><div class="label">ความเสี่ยงสูง</div><div class="sub">รายการที่ควรตรวจเพิ่ม</div></div>
    </div>
    <div class="verify-grid four mt-14">
      <div class="stat-card"><div id="stat-vpn" class="num">0</div><div class="label">VPN</div></div>
      <div class="stat-card"><div id="stat-proxy" class="num">0</div><div class="label">Proxy</div></div>
      <div class="stat-card"><div id="stat-tor" class="num">0</div><div class="label">TOR</div></div>
      <div class="stat-card"><div id="stat-pending" class="num">0</div><div class="label">Lookup ไม่สำเร็จ</div></div>
    </div>
    <div class="verify-grid two mt-14">
      <article class="verify-panel">
        <div class="section-title"><div><h2>สถานะระบบ</h2><p>ค่าที่ระบบกำลังใช้งานจริง</p></div><span id="overview-enabled" class="badge badge-muted">กำลังโหลด</span></div>
        <div class="kv">
          <div class="kv-row"><span class="kv-key">ยศหลังยืนยัน</span><span id="overview-role" class="kv-val">—</span></div>
          <div class="kv-row"><span class="kv-key">ห้องแผงยืนยัน</span><span id="overview-channel" class="kv-val">—</span></div>
          <div class="kv-row"><span class="kv-key">Message ID</span><span id="overview-message" class="kv-val mono">—</span></div>
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
      <article class="verify-panel">
        <div class="section-title"><div><h2>สมาชิกยืนยันล่าสุด</h2><p>บัญชีและสัญญาณความเสี่ยงล่าสุด</p></div><button class="btn btn-soft btn-sm btn-inline" type="button" data-tab="data">ดูทั้งหมด</button></div>
        <div id="overview-members" class="list"><div class="loading-box"><div class="spinner"></div>กำลังโหลด…</div></div>
      </article>
    </div>
    <article class="verify-panel mt-14">
      <div class="section-title"><div><h2>เหตุการณ์ล่าสุด</h2><p>ผลการยืนยันและเหตุผลล่าสุด</p></div><button class="btn btn-soft btn-sm btn-inline" type="button" data-tab="data">เปิดข้อมูลทั้งหมด</button></div>
      <div id="overview-logs" class="list"><div class="loading-box"><div class="spinner"></div>กำลังโหลด…</div></div>
    </article>
  </section>

  <section id="panel-system" data-section="system" role="tabpanel" aria-labelledby="tab-system" tabindex="0" class="hidden" hidden>
    <div class="verify-grid two">
      <article class="verify-panel">
        <div class="section-title"><div><h2>การทำงานหลัก</h2><p>เปิดระบบ เลือกยศและห้องที่ใช้งาน</p></div><span class="badge badge-info">Config</span></div>
        <div class="toggle-row"><div><div class="toggle-title">เปิดระบบยืนยันตัวตน</div><div class="toggle-sub">เมื่อปิด Callback จะไม่มอบยศ แม้ข้อความแผงเดิมยังอยู่</div></div><label class="toggle"><input id="v-enabled" type="checkbox" checked><span class="slider"></span></label></div>
        <div class="form-row form-row-2">
          <div><label for="v-roleId">Role ID หลังยืนยัน</label><input id="v-roleId" type="text" inputmode="numeric" placeholder="123456789012345678"><div class="field-hint">ยศต้องอยู่ต่ำกว่ายศสูงสุดของบอท</div></div>
          <div><label for="v-channelId">Channel ID ของแผง</label><input id="v-channelId" type="text" inputmode="numeric" placeholder="123456789012345678"><div class="field-hint">ห้องที่บอทส่งหรือแก้ไขข้อความได้</div></div>
        </div>
        <label for="v-messageId">Message ID ของแผงปัจจุบัน</label><input id="v-messageId" type="text" inputmode="numeric" placeholder="ปล่อยว่างหากยังไม่มีแผง"><div class="field-hint">ใช้แก้ข้อความเดิมโดยไม่สร้างแผงซ้ำ</div>
      </article>
      <article class="verify-panel">
        <div class="section-title"><div><h2>เลือกจากข้อมูล Discord</h2><p>รายการที่บอทมองเห็นและจัดการได้</p></div></div>
        <label>เลือกยศ</label><div id="role-options" class="resource-options"><div class="loading-box" style="width:100%"><div class="spinner"></div>กำลังโหลด Role…</div></div>
        <label class="mt-14">เลือกห้อง</label><div id="channel-options" class="resource-options"><div class="loading-box" style="width:100%"><div class="spinner"></div>กำลังโหลด Channel…</div></div>
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
          <div class="section-title"><div><h2>ตัวอย่างก่อนส่ง</h2><p>แสดงรูปแบบใกล้เคียงข้อความจริงใน Discord</p></div></div>
          <div id="embed-preview" class="embed-preview"><div class="embed-preview-title">🔐 ยืนยันตัวตนเพื่อเข้าดิส</div><div class="embed-preview-desc">กดปุ่มด้านล่างเพื่อยืนยันตัวตน</div></div>
          <div id="button-preview"><div class="button-preview">✅ ยืนยันตัวตน ✅</div></div>
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
    <div class="verify-grid two">
      <article class="verify-panel">
        <div class="section-title"><div><h2>เงื่อนไขบัญชี</h2><p>ข้อกำหนดที่สมาชิกต้องผ่านก่อนรับยศ</p></div><span class="badge badge-warn">Policy</span></div>
        <div class="toggle-row"><div><div class="toggle-title">บล็อก VPN/Proxy/TOR</div><div class="toggle-sub">ปฏิเสธเครือข่ายที่ปกปิดตัวตน</div></div><label class="toggle"><input id="v-blockVPN" type="checkbox" checked><span class="slider"></span></label></div>
        <div class="toggle-row"><div><div class="toggle-title">บล็อก Hosting/Datacenter</div><div class="toggle-sub">ปฏิเสธเครือข่ายเซิร์ฟเวอร์และดาต้าเซ็นเตอร์</div></div><label class="toggle"><input id="v-blockHosting" type="checkbox"><span class="slider"></span></label></div>
        <div class="toggle-row"><div><div class="toggle-title">ต้องมี Email</div></div><label class="toggle"><input id="v-requireEmail" type="checkbox"><span class="slider"></span></label></div>
        <div class="toggle-row"><div><div class="toggle-title">Email ต้องยืนยันแล้ว</div></div><label class="toggle"><input id="v-requireEmailVerified" type="checkbox"><span class="slider"></span></label></div>
        <div class="toggle-row"><div><div class="toggle-title">ต้องมี Connections</div></div><label class="toggle"><input id="v-requireConnections" type="checkbox"><span class="slider"></span></label></div>
        <div class="form-row form-row-2"><div><label for="v-minAge">อายุบัญชีขั้นต่ำ (วัน)</label><input id="v-minAge" type="number" min="0" max="3650" value="7"></div><div><label for="v-minConnections">Connections ขั้นต่ำ</label><input id="v-minConnections" type="number" min="1" max="20" value="1"></div></div>
        <label for="v-allowedCountries">ประเทศที่อนุญาต</label><input id="v-allowedCountries" type="text" placeholder="TH,US,JP หรือปล่อยว่าง">
        <label for="v-blockedCountries">ประเทศที่บล็อก</label><input id="v-blockedCountries" type="text" placeholder="CN,RU หรือปล่อยว่าง">
      </article>
      <article class="verify-panel">
        <div class="section-title"><div><h2>Anti-Alt และเครือข่ายซ้ำ</h2><p>กำหนดวิธีรับมือบัญชีหรืออุปกรณ์ที่สัมพันธ์กัน</p></div><span class="badge badge-warn">Hardening</span></div>
        <div class="toggle-row"><div><div class="toggle-title">เปิด Anti-Alt</div><div class="toggle-sub">เปิดใช้กฎ IP, Device และ Lookup ด้านล่าง</div></div><label class="toggle"><input id="v-antiAltEnabled" type="checkbox"><span class="slider"></span></label></div>
        <div class="form-row form-row-2"><div><label for="v-ipDuplicateAction">หลายบัญชีต่อ IP</label><select id="v-ipDuplicateAction"><option value="off">ปิด</option><option value="log_only">บันทึกอย่างเดียว</option><option value="delay">หน่วงตรวจสอบ</option><option value="block">บล็อก</option></select></div><div><label for="v-maxUsersPerIp">จำนวนสูงสุดต่อ IP</label><input id="v-maxUsersPerIp" type="number" min="1" max="20" value="3"></div></div>
        <div class="form-row form-row-2"><div><label for="v-deviceDuplicateAction">หลายบัญชีต่อ Device</label><select id="v-deviceDuplicateAction"><option value="off">ปิด</option><option value="log_only">บันทึกอย่างเดียว</option><option value="delay">หน่วงตรวจสอบ</option><option value="block">บล็อก</option></select></div><div><label for="v-maxUsersPerDevice">จำนวนสูงสุดต่อ Device</label><input id="v-maxUsersPerDevice" type="number" min="1" max="20" value="2"></div></div>
        <label for="v-previouslyBlockedIpAction">IP ที่เคยถูกบล็อก</label><select id="v-previouslyBlockedIpAction"><option value="off">ปิด</option><option value="log_only">บันทึกอย่างเดียว</option><option value="delay">หน่วงตรวจสอบ</option><option value="block">บล็อก</option></select>
        <label for="v-spoofedHeaderAction">Header ที่อาจปลอม IP</label><select id="v-spoofedHeaderAction"><option value="off">ปิด</option><option value="log_only">บันทึกอย่างเดียว</option><option value="delay">หน่วงตรวจสอบ</option><option value="block">บล็อก</option></select>
        <label for="v-unknownLookupAction">ตรวจ IP ไม่สำเร็จ</label><select id="v-unknownLookupAction"><option value="off">ปิด</option><option value="log_only">บันทึกอย่างเดียว</option><option value="delay">หน่วงตรวจสอบ</option><option value="block">บล็อก</option></select>
        <label for="v-securityDelayMs">เวลาหน่วง (ms)</label><input id="v-securityDelayMs" type="number" min="0" max="10000" value="5000">
      </article>
    </div>
    <div class="alert alert-info">กด “บันทึกทั้งหมด” ด้านบนหลังแก้เงื่อนไข ระบบจะตรวจรูปแบบและบันทึกให้เซิร์ฟเวอร์ที่กำลังเลือกเท่านั้น</div>
  </section>

  <section id="panel-data" data-section="data" role="tabpanel" aria-labelledby="tab-data" tabindex="0" class="hidden" hidden>
    <div class="alert alert-warn">ข้อมูลบัญชี Email, IP, Network, Device, Connections, Guild snapshots และ OAuth Token อยู่รวมใน “ดูข้อมูลทั้งหมด” ของสมาชิกแต่ละคน</div>
    <div class="data-stack">
      <article class="verify-panel">
        <div class="data-heading"><span class="data-index">1</span><div><h2>สมาชิกและข้อมูลฉบับเต็ม</h2><p class="muted small">ค้นหาบัญชีแล้วเปิดข้อมูลทั้งหมดในหน้าต่างเดียว</p></div></div>
        <div class="form-row form-row-3">
          <div><label for="members-search">ค้นหา</label><input id="members-search" type="search" placeholder="User ID / username / IP / email"></div>
          <div><label for="members-result">ผลการยืนยัน</label><select id="members-result"><option value="">ทั้งหมด</option><option value="success">Success</option><option value="failed">Failed</option><option value="blocked">Blocked</option></select></div>
          <div><label for="members-risk">ระดับความเสี่ยง</label><select id="members-risk"><option value="">ทั้งหมด</option><option value="high">สูง</option><option value="medium">ปานกลาง</option><option value="low">ต่ำ</option></select></div>
        </div>
        <div class="flex justify-between items-center gap-8 flex-wrap mt-14"><span class="muted small">รายละเอียดเต็มจะเปิดใน Drawer โดยไม่ออกจาก Dashboard</span><div class="flex gap-8"><button id="btn-members-prev" class="btn btn-soft btn-sm btn-inline" type="button">← ก่อนหน้า</button><span id="members-page" class="badge badge-muted">หน้า 1</span><button id="btn-members-next" class="btn btn-soft btn-sm btn-inline" type="button">ถัดไป →</button><button id="btn-members-refresh" class="btn btn-soft btn-sm btn-inline" type="button">รีเฟรช</button></div></div>
        <div class="table-wrap mt-14"><table><thead><tr><th>บัญชี</th><th>ผล</th><th>Risk</th><th>IP/Network</th><th>Device</th><th>Connections</th><th>เวลา</th><th></th></tr></thead><tbody id="members-body"><tr><td colspan="8"><div class="loading-box"><div class="spinner"></div>กำลังโหลดสมาชิก…</div></td></tr></tbody></table></div>
      </article>

      <article class="verify-panel">
        <div class="data-heading"><span class="data-index">2</span><div><h2>ประวัติการยืนยัน</h2><p class="muted small">เหตุการณ์ ผลลัพธ์ เหตุผล และการมอบยศย้อนหลัง</p></div></div>
        <div class="form-row form-row-3">
          <div><label for="logs-search">ค้นหา</label><input id="logs-search" type="search" placeholder="User ID / username / IP / reason"></div>
          <div><label for="logs-result">ผลลัพธ์</label><select id="logs-result"><option value="">ทั้งหมด</option><option value="success">Success</option><option value="failed">Failed</option><option value="blocked">Blocked</option><option value="pending">Pending</option></select></div>
          <div><label for="logs-risk">ระดับความเสี่ยง</label><select id="logs-risk"><option value="">ทั้งหมด</option><option value="high">สูง</option><option value="medium">ปานกลาง</option><option value="low">ต่ำ</option></select></div>
        </div>
        <div class="flex justify-between items-center gap-8 flex-wrap mt-14"><span class="muted small">ใช้ข้อมูลที่บันทึกจากการยืนยันจริง</span><div class="flex gap-8"><button id="btn-logs-prev" class="btn btn-soft btn-sm btn-inline" type="button">← ก่อนหน้า</button><span id="logs-page" class="badge badge-muted">หน้า 1</span><button id="btn-logs-next" class="btn btn-soft btn-sm btn-inline" type="button">ถัดไป →</button><button id="btn-logs-refresh" class="btn btn-soft btn-sm btn-inline" type="button">รีเฟรช</button></div></div>
        <div class="table-wrap mt-14"><table><thead><tr><th>บัญชี</th><th>ผล</th><th>Risk</th><th>IP/Location</th><th>Reason</th><th>Role Result</th><th>เวลา</th><th></th></tr></thead><tbody id="logs-body"><tr><td colspan="8"><div class="loading-box"><div class="spinner"></div>กำลังโหลดประวัติ…</div></td></tr></tbody></table></div>
      </article>

      <article class="verify-panel">
        <div class="data-heading"><span class="data-index">3</span><div><h2>ภาพรวมความเสี่ยง</h2><p class="muted small">การกระจายประเทศ เครือข่าย อุปกรณ์ และเหตุผลที่ไม่ผ่าน</p></div></div>
        <div class="verify-grid four"><div><h3>ประเทศ</h3><div id="risk-countries" class="list"><div class="loading-box">กำลังโหลด…</div></div></div><div><h3>ISP/ASN</h3><div id="risk-isps" class="list"><div class="loading-box">กำลังโหลด…</div></div></div><div><h3>Device</h3><div id="risk-devices" class="list"><div class="loading-box">กำลังโหลด…</div></div></div><div><h3>เหตุผล</h3><div id="risk-reasons" class="list"><div class="loading-box">กำลังโหลด…</div></div></div></div>
        <h3 class="mt-14">เหตุการณ์เสี่ยงล่าสุด</h3><div id="risk-recent" class="list mt-8"><div class="loading-box">กำลังโหลด…</div></div>
      </article>
    </div>
  </section>
</div>

<section id="validation-box" class="verify-panel hidden"><div class="section-title"><div><h2>ผลการตรวจสอบ</h2><p>สิทธิ์บอท ยศ ห้อง และค่าที่จำเป็น</p></div></div><div id="validation-body"></div></section>
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
