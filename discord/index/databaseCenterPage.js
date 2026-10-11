'use strict';

const { createViewHelpers } = require("./viewHelpers");
const { BASE_CSS } = require("./viewStyles");

const {
    escapeHtml,
    navBar,
    shell,
    toastScript
} = createViewHelpers(BASE_CSS);

function buildDatabaseCenterPage() {
    return shell("ศูนย์จัดการฐานข้อมูล", `
<div class="container">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
        <div>
            <h1 class="page-title gradient-text" style="margin-bottom:4px;">🗄️ ศูนย์จัดการฐานข้อมูล (Database Center)</h1>
            <p class="page-sub" style="margin-bottom:0;" id="lastDbUpdate">ระบบตรวจสอบและควบคุมสถาปัตยกรรมฐานข้อมูล 3-Tier (RAM + SQLite + MongoDB)</p>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
            <button type="button" class="btn btn-sm btn-secondary" onclick="refreshCurrentTab()" id="btnRefresh">🔄 รีเฟรชข้อมูล</button>
            <button type="button" class="btn btn-sm btn-primary" onclick="runDbHealthCheck()" id="btnCheckAll">🩺 ตรวจสุขภาพฐานข้อมูล</button>
            <button type="button" class="btn btn-sm btn-secondary" onclick="triggerSqliteAction('full_check')" id="btnFullCheck" title="Diagnostic Check (No Operational Data Mutation)">🔍 Diagnostic Check (No Mutation)</button>
            <button type="button" class="btn btn-sm btn-danger" onclick="triggerSqliteAction('emergency_trim', 'ยืนยันเริ่ม Emergency Auto-Trim หรือไม่?\\nระบบจะลบเฉพาะ Expired Asset Cache, Expired Cache และ History พ้น Retention\\n(Core Data จะได้รับการปกป้อง 100%)')" id="btnEmergencyTrim" style="background:#da3633;border-color:#f85149;color:#fff;">🚨 Emergency Auto-Trim</button>
        </div>
    </div>

    ${navBar("/database")}

    <!-- ── TAB CONTROLS (SPA - NO PAGE RELOAD) ── -->
    <div class="db-tabs" style="display:flex;gap:6px;border-bottom:1px solid var(--border);padding-bottom:12px;margin:18px 0 22px 0;">
        <button type="button" class="db-tab-btn active" id="tabBtn-overview" onclick="switchDbTab('overview')">📊 ภาพรวมระบบ (Overview)</button>
        <button type="button" class="db-tab-btn" id="tabBtn-sqlite" onclick="switchDbTab('sqlite')">📁 SQLite (Operational DB)</button>
        <button type="button" class="db-tab-btn" id="tabBtn-mongo" onclick="switchDbTab('mongo')">🍃 MongoDB (Identity & Security)</button>
    </div>

    <!-- ═════════════════════════════════════════════════════════════════════ -->
    <!--  TAB 1: ภาพรวมระบบ (OVERVIEW)                                        -->
    <!-- ═════════════════════════════════════════════════════════════════════ -->
    <div id="tabContent-overview" class="db-tab-content">
        <!-- Status Cards -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:16px;margin-bottom:20px;">
            <!-- SQLite Card -->
            <div class="card" style="margin-bottom:0;border-left:4px solid var(--blue2);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <span style="font-size:1.4em;">📁</span>
                        <div>
                            <div style="font-weight:700;font-size:1.05em;">SQLite 3 (Local Operational)</div>
                            <div style="font-size:0.75em;color:var(--text3);" id="ov-sqlite-path">--</div>
                            <div style="font-size:0.75em;margin-top:2px;" id="ov-sqlite-persistent">Persistent Storage: --</div>
                        </div>
                    </div>
                    <span id="ov-sqlite-badge" class="badge" style="background:var(--green2);color:#000;font-weight:700;">🟢 ปกติ</span>
                </div>
                <div style="margin:14px 0 8px 0;">
                    <div style="display:flex;justify-content:space-between;font-size:0.85em;margin-bottom:4px;">
                        <span>พื้นที่ที่ใช้ (Footprint):</span>
                        <strong id="ov-sqlite-size-text">-- MB / 4,096 MB</strong>
                    </div>
                    <div class="progress-bg" style="height:10px;">
                        <div class="progress-fill" id="ov-sqlite-bar" style="width:0%;background:var(--blue2);"></div>
                    </div>
                </div>
                <div style="font-size:0.8em;color:var(--text2);margin-top:8px;" id="ov-sqlite-reason">ระบบฐานข้อมูลทำงานปกติ</div>
                <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:10px;margin-top:12px;font-size:0.82em;">
                    <span>จำนวนข้อมูลรวม: <strong id="ov-sqlite-records" style="color:var(--text1);">0</strong> รายการ</span>
                    <a href="javascript:void(0)" onclick="switchDbTab('sqlite')" style="color:var(--accent3);">ดูรายละเอียดเชิงลึก →</a>
                </div>
            </div>

            <!-- MongoDB Card -->
            <div class="card" style="margin-bottom:0;border-left:4px solid var(--green2);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <span style="font-size:1.4em;">🍃</span>
                        <div>
                            <div style="font-weight:700;font-size:1.05em;">MongoDB Atlas (Authoritative Core)</div>
                            <div style="font-size:0.75em;color:var(--text3);" id="ov-mongo-db">--</div>
                        </div>
                    </div>
                    <span id="ov-mongo-badge" class="badge" style="background:var(--green2);color:#000;font-weight:700;">🟢 ปกติ</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0 8px 0;">
                    <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                        <div style="font-size:0.75em;color:var(--text3);">⏱️ Ping Latency</div>
                        <div style="font-size:1.1em;font-weight:700;color:var(--yellow2);" id="ov-mongo-ping">-- ms</div>
                    </div>
                    <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                        <div style="font-size:0.75em;color:var(--text3);">📚 Collections ทั้งหมด</div>
                        <div style="font-size:1.1em;font-weight:700;color:var(--green2);" id="ov-mongo-models">17 โมเดล</div>
                    </div>
                </div>
                <div style="font-size:0.8em;color:var(--text2);margin-top:8px;">Authoritative Store สำหรับ Identity, Verification, Snapshots และ Security</div>
                <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:10px;margin-top:12px;font-size:0.82em;">
                    <span>Pool: <strong id="ov-mongo-pool">20 max</strong></span>
                    <a href="javascript:void(0)" onclick="switchDbTab('mongo')" style="color:var(--accent3);">เปิดดู Collections →</a>
                </div>
            </div>
        </div>

        <!-- Metric Grid -->
        <div class="grid" style="margin-bottom:20px;">
            <div class="stat"><div class="val" id="st-core-records" style="color:var(--blue2);">0</div><div class="lbl">📦 ข้อมูลหลัก (Core Records)</div></div>
            <div class="stat"><div class="val" id="st-cache-records" style="color:var(--yellow2);">0</div><div class="lbl">⚡ ข้อมูลแคช (Cache Records)</div></div>
            <div class="stat"><div class="val" id="st-history-records" style="color:#e879f9;">0</div><div class="lbl">📜 บันทึกประวัติ (History Records)</div></div>
            <div class="stat"><div class="val" id="st-temp-records" style="color:var(--orange);">0</div><div class="lbl">⏳ ข้อมูลชั่วคราว (Temp Records)</div></div>
        </div>

        <!-- Maintenance History Summary -->
        <div class="card">
            <h3>🛠️ การบำรุงรักษาล่าสุด (Maintenance Timestamps)</h3>
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;margin-top:10px;">
                <div style="background:var(--bg-box);padding:10px 14px;border-radius:6px;">
                    <div style="font-size:0.78em;color:var(--text3);">🧹 Last Cleanup (ทำความสะอาดล่าสุด)</div>
                    <div style="font-weight:600;margin-top:4px;" id="ov-last-cleanup">--</div>
                </div>
                <div style="background:var(--bg-box);padding:10px 14px;border-radius:6px;">
                    <div style="font-size:0.78em;color:var(--text3);">📦 Last Backup (สำรองข้อมูลล่าสุด)</div>
                    <div style="font-weight:600;margin-top:4px;" id="ov-last-backup">--</div>
                </div>
                <div style="background:var(--bg-box);padding:10px 14px;border-radius:6px;">
                    <div style="font-size:0.78em;color:var(--text3);">🛡️ Last Integrity Check (ตรวจความสมบูรณ์)</div>
                    <div style="font-weight:600;margin-top:4px;" id="ov-last-integrity">--</div>
                </div>
                <div style="background:var(--bg-box);padding:10px 14px;border-radius:6px;">
                    <div style="font-size:0.78em;color:var(--text3);">⚡ Last WAL Checkpoint (อัปเดตไฟล์หลัก)</div>
                    <div style="font-weight:600;margin-top:4px;" id="ov-last-checkpoint">--</div>
                </div>
            </div>
        </div>
    </div>

    <!-- ═════════════════════════════════════════════════════════════════════ -->
    <!--  TAB 2: SQLITE (OPERATIONAL DB)                                       -->
    <!-- ═════════════════════════════════════════════════════════════════════ -->
    <div id="tabContent-sqlite" class="db-tab-content" style="display:none;">
        <!-- Engine Status & Pragmas -->
        <div class="card" style="margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:1.8em;">📁</span>
                    <div>
                        <h3 style="margin:0 0 2px 0;">SQLite Operational Engine</h3>
                        <span id="sql-db-file" style="font-size:0.78em;color:var(--text3);">--</span>
                    </div>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <span class="badge" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;" id="badge-persistent">Storage: --</span>
                    <span class="badge" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;" id="badge-wal">WAL Mode: --</span>
                    <span class="badge" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;" id="badge-version">Schema: --</span>
                    <span class="badge" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;" id="badge-fk">Foreign Keys: --</span>
                </div>
            </div>
        </div>

        <!-- Storage & Quota Breakdown -->
        <div class="card" style="margin-bottom:16px;">
            <h3>💾 พื้นที่และการจำกัดขนาด (Storage & Quotas)</h3>
            <div style="margin:14px 0 10px 0;">
                <div style="display:flex;justify-content:space-between;font-size:0.85em;margin-bottom:4px;">
                    <span>ขนาดรวม SQLite Footprint:</span>
                    <strong id="sql-footprint-text">0 MB / 4,096 MB (0%)</strong>
                </div>
                <div class="progress-bg" style="height:12px;">
                    <div class="progress-fill" id="sql-quota-bar" style="width:0%;background:var(--blue2);"></div>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:0.75em;color:var(--text3);margin-top:4px;">
                    <span>0 MB</span>
                    <span>Soft Limit (3 GB)</span>
                    <span>Critical Limit (3.6 GB)</span>
                    <span>Hard Limit (4 GB)</span>
                </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px;margin-top:16px;">
                <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                    <div style="font-size:0.75em;color:var(--text3);">ไฟล์หลัก (.sqlite)</div>
                    <div style="font-weight:700;margin-top:2px;" id="sql-file-main">-- MB</div>
                </div>
                <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                    <div style="font-size:0.75em;color:var(--text3);">ไฟล์ Log (.sqlite-wal)</div>
                    <div style="font-weight:700;margin-top:2px;" id="sql-file-wal">-- MB</div>
                </div>
                <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                    <div style="font-size:0.75em;color:var(--text3);">ไฟล์ Shared (.sqlite-shm)</div>
                    <div style="font-weight:700;margin-top:2px;" id="sql-file-shm">-- MB</div>
                </div>
                <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                    <div style="font-size:0.75em;color:var(--text3);">พื้นที่ดิสก์ว่าง (Filesystem Free)</div>
                    <div style="font-weight:700;margin-top:2px;color:var(--green2);" id="sql-fs-free">-- MB</div>
                </div>
            </div>

            <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px;">
                <div style="font-size:0.85em;font-weight:700;margin-bottom:8px;color:var(--text1);">📦 พื้นที่จัดเก็บรวมที่จัดการ (Managed Storage Breakdown)</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:8px;">
                    <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                        <div style="font-size:0.75em;color:var(--text3);">ฐานข้อมูล SQLite</div>
                        <div style="font-weight:700;margin-top:2px;" id="sql-managed-db">-- MB</div>
                    </div>
                    <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                        <div style="font-size:0.75em;color:var(--text3);">ไฟล์สำรอง (Backups)</div>
                        <div style="font-weight:700;margin-top:2px;" id="sql-managed-backup">-- MB</div>
                    </div>
                    <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                        <div style="font-size:0.75em;color:var(--text3);">แคชรูปภาพ (Assets)</div>
                        <div style="font-weight:700;margin-top:2px;" id="sql-managed-asset">-- MB</div>
                    </div>
                    <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                        <div style="font-size:0.75em;color:var(--text3);">รวมที่ใช้ (Total Managed)</div>
                        <div style="font-weight:700;margin-top:2px;color:var(--accent3);" id="sql-managed-total">-- MB</div>
                    </div>
                    <div style="background:var(--bg-box);padding:8px 12px;border-radius:6px;">
                        <div style="font-size:0.75em;color:var(--text3);">ดิสก์ว่าง (Free Disk)</div>
                        <div style="font-weight:700;margin-top:2px;color:var(--green2);" id="sql-managed-free">-- MB</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Categories & Table Inventory -->
        <div class="card" style="margin-bottom:16px;">
            <h3>📊 สถิติข้อมูลแยกตามประเภท (Data Categories)</h3>
            <div style="overflow-x:auto;margin-top:10px;">
                <table style="width:100%;border-collapse:collapse;font-size:0.85em;">
                    <thead>
                        <tr style="border-bottom:2px solid var(--border);text-align:left;">
                            <th style="padding:8px;">ประเภท / หมวดหมู่</th>
                            <th style="padding:8px;">ชื่อตาราง (Table Name)</th>
                            <th style="padding:8px;">คำอธิบาย</th>
                            <th style="padding:8px;text-align:right;">จำนวน Records</th>
                        </tr>
                    </thead>
                    <tbody id="sql-categories-body">
                        <tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text3);">กำลังโหลดข้อมูลตาราง...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <!-- SQLite Controls & Maintenance Buttons -->
        <div class="card" style="margin-bottom:16px;">
            <h3>🛠️ แผงควบคุมและบำรุงรักษา (Maintenance Controls)</h3>
            <p style="font-size:0.82em;color:var(--text2);margin-bottom:12px;">สั่งการบำรุงรักษาฐานข้อมูล SQLite ผ่านระบบควบคุมความปลอดภัย</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button type="button" class="btn btn-sm btn-danger" onclick="triggerSqliteAction('emergency_trim', 'ยืนยันเริ่ม Emergency Auto-Trim หรือไม่?\\nระบบจะลบเฉพาะ Expired Asset Cache, Expired Cache และ History พ้น Retention\\n(Core Data จะได้รับการปกป้อง 100%)')" style="background:#da3633;border-color:#f85149;color:#fff;">🚨 Emergency Auto-Trim</button>
                <button type="button" class="btn btn-sm btn-secondary" onclick="triggerSqliteAction('full_check')" title="Diagnostic Check (No Operational Data Mutation)">🔍 Diagnostic Check (No Mutation)</button>
                <button type="button" class="btn btn-sm btn-secondary" onclick="triggerSqliteAction('integrity')">🩺 ตรวจ Integrity</button>
                <button type="button" class="btn btn-sm btn-secondary" onclick="triggerSqliteAction('cleanup_expired')">🧹 ล้างข้อมูลหมดอายุ</button>
                <button type="button" class="btn btn-sm btn-warning" onclick="triggerSqliteAction('cleanup_cache', 'ต้องการล้างข้อมูลแคชทั้งหมดใช่หรือไม่?')">🗑️ ล้างแคชทั้งหมด</button>
                <button type="button" class="btn btn-sm btn-warning" onclick="triggerSqliteAction('cleanup_history', 'ต้องการล้างประวัติเก่าเกิน 30 วันใช่หรือไม่?')">📜 ล้างประวัติ 30 วัน</button>
                <button type="button" class="btn btn-sm btn-secondary" onclick="triggerSqliteAction('checkpoint')">⚡ Checkpoint WAL</button>
                <button type="button" class="btn btn-sm btn-secondary" onclick="triggerSqliteAction('vacuum')">🧹 Incremental Vacuum</button>
                <button type="button" class="btn btn-sm btn-primary" onclick="triggerSqliteAction('backup')">📦 สร้าง Backup เดี๋ยวนี้</button>
            </div>
        </div>

        <!-- Database Console (Strict Allowlist) -->
        <div class="card" style="margin-bottom:16px;background:#0d1117;border:1px solid #30363d;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="color:#58a6ff;font-family:monospace;font-size:1.1em;font-weight:700;">&gt;_</span>
                    <h3 style="margin:0;color:#c9d1d9;">SQLite Database Console</h3>
                </div>
                <span style="font-size:0.75em;color:#8b949e;background:#161b22;padding:2px 8px;border-radius:4px;border:1px solid #30363d;">🔒 Allowlisted Commands Only</span>
            </div>
            <p style="font-size:0.78em;color:#8b949e;margin-bottom:10px;">
                คอนโซลเฉพาะคำสั่งจัดการฐานข้อมูล (ไม่อนุญาตให้รันคำสั่ง OS Shell) | คำสั่งที่ใช้ได้: <code>status</code>, <code>health</code>, <code>stats</code>, <code>tables</code>, <code>migrations</code>, <code>integrity</code>, <code>cleanup</code>, <code>checkpoint</code>, <code>vacuum</code>, <code>backup</code>, <code>emergency-trim</code>, <code>full-check</code>
            </p>

            <!-- Console Output Area -->
            <pre id="consoleOutput" style="background:#010409;color:#3fb950;padding:12px;border-radius:6px;font-family:monospace;font-size:0.82em;min-height:140px;max-height:280px;overflow-y:auto;border:1px solid #21262d;white-space:pre-wrap;margin-bottom:10px;">ยินดีต้อนรับสู่ SQLite Database Console\nพิมพ์คำสั่งที่ต้องการ หรือกดปุ่มลัดด้านล่าง...</pre>

            <!-- Input Prompt -->
            <form id="consoleForm" onsubmit="submitConsole(event)" style="display:flex;gap:8px;">
                <span style="color:#58a6ff;font-family:monospace;align-self:center;font-weight:700;">sqlite&gt;</span>
                <input type="text" id="consoleInput" placeholder="พิมพ์คำสั่ง เช่น status, stats, integrity, tables, emergency-trim..." style="flex:1;background:#161b22;border:1px solid #30363d;color:#f0f6fc;font-family:monospace;padding:8px 12px;border-radius:4px;font-size:0.85em;">
                <button type="submit" class="btn btn-sm btn-primary">ส่งคำสั่ง</button>
            </form>

            <!-- Quick Command Chips -->
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
                <span style="font-size:0.75em;color:#8b949e;align-self:center;">คำสั่งด่วน:</span>
                <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 8px;" onclick="runQuickConsole('status')">status</button>
                <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 8px;" onclick="runQuickConsole('stats')">stats</button>
                <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 8px;" onclick="runQuickConsole('tables')">tables</button>
                <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 8px;" onclick="runQuickConsole('migrations')">migrations</button>
                <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 8px;" onclick="runQuickConsole('integrity')">integrity</button>
                <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 8px;" onclick="runQuickConsole('cleanup')">cleanup</button>
                <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 8px;background:#3b1e1e;border-color:#f85149;color:#ff7b72;" onclick="runQuickConsole('emergency-trim')">🚨 emergency-trim</button>
                <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 8px;" onclick="runQuickConsole('full-check')">🔍 full-check</button>
            </div>
        </div>

        <!-- Backups List -->
        <div class="card">
            <h3>📦 รายการไฟล์สำรองข้อมูล (Backups List - เก็บ 2 ชุดล่าสุด)</h3>
            <div style="overflow-x:auto;margin-top:10px;">
                <table style="width:100%;border-collapse:collapse;font-size:0.85em;">
                    <thead>
                        <tr style="border-bottom:2px solid var(--border);text-align:left;">
                            <th style="padding:8px;">ชื่อไฟล์ (Filename)</th>
                            <th style="padding:8px;">ขนาด (Size)</th>
                            <th style="padding:8px;">เวลาที่สร้าง (Created At)</th>
                        </tr>
                    </thead>
                    <tbody id="sql-backups-body">
                        <tr><td colspan="3" style="text-align:center;padding:16px;color:var(--text3);">กำลังโหลดรายการสำรองข้อมูล...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- ═════════════════════════════════════════════════════════════════════ -->
    <!--  TAB 3: MONGODB (IDENTITY & SECURITY)                                -->
    <!-- ═════════════════════════════════════════════════════════════════════ -->
    <div id="tabContent-mongo" class="db-tab-content" style="display:none;">
        <div class="card" style="margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:1.8em;">🍃</span>
                    <div>
                        <h3 style="margin:0 0 2px 0;">MongoDB Atlas Cluster</h3>
                        <span id="mg-host-text" style="font-size:0.78em;color:var(--text3);">--</span>
                    </div>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <span class="badge" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;" id="mg-badge-conn">Status: --</span>
                    <span class="badge" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;" id="mg-badge-ping">Ping: -- ms</span>
                </div>
            </div>
        </div>

        <!-- Collections Explorer -->
        <div class="card" style="margin-bottom:16px;">
            <h3>📚 รายการ Collections ของระบบยืนยันตัวตนและความปลอดภัย</h3>
            <p style="font-size:0.82em;color:var(--text2);margin-bottom:12px;">สามารถเลือกเปิดดูตัวอย่างข้อมูลแบบปลอดภัย (Sensitive Fields จะถูก Mask อัตโนมัติ)</p>
            <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;font-size:0.85em;">
                    <thead>
                        <tr style="border-bottom:2px solid var(--border);text-align:left;">
                            <th style="padding:8px;">ชื่อโมเดล (Model Name)</th>
                            <th style="padding:8px;">ชื่อ Collection ใน Mongo</th>
                            <th style="padding:8px;text-align:right;">จำนวน Documents</th>
                            <th style="padding:8px;text-align:right;">Indexes</th>
                            <th style="padding:8px;text-align:center;">การตรวจสอบ</th>
                        </tr>
                    </thead>
                    <tbody id="mg-collections-body">
                        <tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text3);">กำลังโหลด Collections...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Safe Data Explorer Drawer / Modal -->
        <div id="safeExplorerModal" class="card" style="display:none;margin-top:16px;border:1px solid var(--accent3);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:1.2em;">🔍</span>
                    <h3 style="margin:0;" id="explorerTitle">ตัวอย่างข้อมูล: --</h3>
                </div>
                <button type="button" class="btn btn-sm btn-secondary" onclick="closeSafeExplorer()">✕ ปิดหน้าต่าง</button>
            </div>
            <p style="font-size:0.78em;color:var(--text3);margin-bottom:10px;">
                🛡️ ป้องกันข้อมูลลับ: ฟิลด์ Token, Password, Key, Raw IP และ Email จะถูกเข้ารหัส/ซ่อนบางส่วน (Masked) โดยอัตโนมัติ
            </p>
            <pre id="explorerData" style="background:#090d16;padding:12px;border-radius:6px;font-family:monospace;font-size:0.82em;max-height:360px;overflow-y:auto;border:1px solid var(--border);white-space:pre-wrap;color:#e2e8f0;">กำลังโหลดข้อมูล...</pre>
        </div>
    </div>
</div>

<style>
.db-tab-btn {
    background: transparent;
    border: none;
    color: var(--text3);
    font-size: 0.9em;
    font-weight: 600;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
}
.db-tab-btn:hover {
    color: var(--text1);
    background: var(--bg-hover);
}
.db-tab-btn.active {
    color: #fff;
    background: var(--accent);
}
</style>

<script>
let currentTab = 'overview';

function switchDbTab(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.db-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.db-tab-content').forEach(c => c.style.display = 'none');

    const activeBtn = document.getElementById('tabBtn-' + tabName);
    const activeContent = document.getElementById('tabContent-' + tabName);
    if (activeBtn) activeBtn.classList.add('active');
    if (activeContent) activeContent.style.display = 'block';

    // Update URL hash without full reload
    if (window.history && window.history.replaceState) {
        window.history.replaceState(null, null, '#tab=' + tabName);
    }

    if (tabName === 'overview') loadDbOverview();
    else if (tabName === 'sqlite') loadSqliteDetails();
    else if (tabName === 'mongo') loadMongoDetails();
}

function refreshCurrentTab() {
    if (currentTab === 'overview') loadDbOverview();
    else if (currentTab === 'sqlite') loadSqliteDetails();
    else if (currentTab === 'mongo') loadMongoDetails();
    showToast('รีเฟรชข้อมูลเรียบร้อย', 'ok');
}

// ── 1. LOAD OVERVIEW ──
async function loadDbOverview() {
    try {
        const res = await fetch('/api/database/overview');
        if (!res.ok) throw new Error('API Error: ' + res.status);
        const data = await res.json();
        const sq = data.databases.sqlite;
        const mg = data.databases.mongodb;

        // SQLite Card
        document.getElementById('ov-sqlite-path').textContent = sq.path || '-';
        const sqBadge = document.getElementById('ov-sqlite-badge');
        sqBadge.textContent = sq.statusLabel;
        sqBadge.style.background = sq.status === 'ok' ? 'var(--green2)' : (sq.status === 'warning' ? 'var(--orange)' : 'var(--red2)');
        document.getElementById('ov-sqlite-size-text').textContent = sq.footprintMb + ' MB / ' + sq.hardLimitMb.toLocaleString() + ' MB (' + sq.usedPercent + '%)';
        document.getElementById('ov-sqlite-bar').style.width = Math.min(sq.usedPercent, 100) + '%';
        document.getElementById('ov-sqlite-reason').textContent = sq.degradedReason;
        document.getElementById('ov-sqlite-records').textContent = sq.records.total.toLocaleString();

        // MongoDB Card
        document.getElementById('ov-mongo-db').textContent = mg.name ? 'Database: ' + mg.name : 'Not Connected';
        const mgBadge = document.getElementById('ov-mongo-badge');
        mgBadge.textContent = mg.statusLabel;
        mgBadge.style.background = mg.status === 'ok' ? 'var(--green2)' : 'var(--red2)';
        document.getElementById('ov-mongo-ping').textContent = mg.pingMs !== null ? mg.pingMs + ' ms' : '-';
        document.getElementById('ov-mongo-models').textContent = mg.modelsCount + ' โมเดล';
        document.getElementById('ov-mongo-pool').textContent = mg.pool ? (mg.pool.maxPoolSize + ' max') : '-';

        // Stats
        document.getElementById('st-core-records').textContent = sq.records.core.toLocaleString();
        document.getElementById('st-cache-records').textContent = sq.records.cache.toLocaleString();
        document.getElementById('st-history-records').textContent = sq.records.history.toLocaleString();
        document.getElementById('st-temp-records').textContent = sq.records.temp.toLocaleString();

        const persistEl = document.getElementById('ov-sqlite-persistent');
        if (persistEl) {
            if (sq.storage && sq.storage.persistentMountVerified) {
                persistEl.textContent = 'Persistent Storage: ✅ Owner-Confirmed Persistent Path';
                persistEl.style.color = 'var(--green2)';
            } else if (sq.storage && sq.storage.configuredPersistentPath) {
                persistEl.textContent = 'Persistent Storage: 🟡 Path Configured (Mount Unverified)';
                persistEl.style.color = 'var(--yellow)';
            } else if (sq.storage && sq.storage.allowInSource) {
                persistEl.textContent = 'Persistent Storage: ℹ️ Owner-Permitted In-Source Storage';
                persistEl.style.color = 'var(--text2)';
            } else {
                persistEl.textContent = 'Persistent Storage: ❌ Ephemeral / In-Source';
                persistEl.style.color = 'var(--orange)';
            }
        }

        // Timestamps
        document.getElementById('ov-last-cleanup').textContent = sq.lastMaintenance.lastCleanup ? new Date(sq.lastMaintenance.lastCleanup).toLocaleString('th-TH') : 'ยังไม่มี';
        document.getElementById('ov-last-backup').textContent = sq.lastMaintenance.lastBackup ? new Date(sq.lastMaintenance.lastBackup).toLocaleString('th-TH') : 'ยังไม่มี';
        document.getElementById('ov-last-integrity').textContent = sq.lastMaintenance.lastIntegrityCheck ? new Date(sq.lastMaintenance.lastIntegrityCheck).toLocaleString('th-TH') : 'ยังไม่มี';
        document.getElementById('ov-last-checkpoint').textContent = sq.lastMaintenance.lastCheckpoint ? new Date(sq.lastMaintenance.lastCheckpoint).toLocaleString('th-TH') : 'ยังไม่มี';
        document.getElementById('lastDbUpdate').textContent = 'อัปเดตล่าสุด: ' + new Date().toLocaleTimeString('th-TH');
    } catch (e) {
        showToast('ดึงข้อมูลภาพรวมไม่สำเร็จ: ' + e.message, 'err');
    }
}

// ── 2. LOAD SQLITE DETAILS ──
async function loadSqliteDetails() {
    try {
        const res = await fetch('/api/database/sqlite');
        if (!res.ok) throw new Error('API Error: ' + res.status);
        const data = await res.json();

        document.getElementById('sql-db-file').textContent = data.path;
        document.getElementById('badge-wal').textContent = 'WAL Mode: ' + (data.pragmas.journalMode || '-').toUpperCase();
        document.getElementById('badge-version').textContent = 'Schema Version: v' + data.pragmas.userVersion;
        document.getElementById('badge-fk').textContent = 'Foreign Keys: ' + (data.pragmas.foreignKeys ? 'ON' : 'OFF');

        // Storage
        const st = data.storage;
        const persistBadge = document.getElementById('badge-persistent');
        if (persistBadge) {
            if (st.persistentMountVerified) {
                persistBadge.textContent = 'Storage: ✅ Owner-Confirmed Persistent Path';
                persistBadge.style.color = 'var(--green2)';
                persistBadge.style.borderColor = 'var(--green2)';
            } else if (st.configuredPersistentPath) {
                persistBadge.textContent = 'Storage: 🟡 Path Configured (Unverified Mount)';
                persistBadge.style.color = 'var(--yellow)';
                persistBadge.style.borderColor = 'var(--yellow)';
            } else if (st.allowInSource) {
                persistBadge.textContent = 'Storage: ℹ️ Owner-Permitted In-Source Storage';
                persistBadge.style.color = 'var(--text2)';
                persistBadge.style.borderColor = 'var(--text2)';
            } else {
                persistBadge.textContent = 'Storage: ❌ Ephemeral / In-Source';
                persistBadge.style.color = 'var(--orange)';
                persistBadge.style.borderColor = 'var(--orange)';
            }
        }

        const pct = ((st.totalMb / st.limits.hardMb) * 100).toFixed(1);
        document.getElementById('sql-footprint-text').textContent = st.totalMb + ' MB / ' + st.limits.hardMb.toLocaleString() + ' MB (' + pct + '%)';
        document.getElementById('sql-quota-bar').style.width = Math.min(pct, 100) + '%';
        document.getElementById('sql-file-main').textContent = (st.mainBytes / (1024*1024)).toFixed(2) + ' MB';
        document.getElementById('sql-file-wal').textContent = (st.walBytes / (1024*1024)).toFixed(2) + ' MB';
        document.getElementById('sql-file-shm').textContent = (st.shmBytes / (1024*1024)).toFixed(2) + ' MB';
        document.getElementById('sql-fs-free').textContent = st.filesystem.availableMb !== null ? st.filesystem.availableMb.toLocaleString() + ' MB' : 'ไม่ระบุ';

        // Managed Storage Breakdown
        if (st.managedStorage) {
            const ms = st.managedStorage;
            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = (val !== null && val !== undefined) ? val + ' MB' : '-';
            };
            setVal('sql-managed-db', ms.databaseMb);
            setVal('sql-managed-backup', ms.backupMb);
            setVal('sql-managed-asset', ms.assetMb);
            setVal('sql-managed-total', ms.totalManagedMb);
            setVal('sql-managed-free', ms.freeDiskMb);
        }

        // Categories Table
        const tbody = document.getElementById('sql-categories-body');
        let html = '';
        for (const [catKey, catVal] of Object.entries(data.categories)) {
            const sizeLabel = catVal.sizeMb !== undefined ? ' (' + catVal.sizeMb + ' MB)' : '';
            html += '<tr style="background:var(--bg-box);font-weight:700;"><td colspan="3" style="padding:8px 10px;color:var(--accent3);">' + catVal.label + sizeLabel + '</td><td style="padding:8px 10px;text-align:right;">รวม ' + catVal.count.toLocaleString() + ' รายการ</td></tr>';
            for (const [tblKey, tblVal] of Object.entries(catVal.tables)) {
                const tblSize = tblVal.sizeMb !== undefined ? ' (' + tblVal.sizeMb + ' MB)' : '';
                html += '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 10px;color:var(--text3);font-size:0.9em;">↳ ' + catKey + '</td><td style="padding:6px 10px;font-family:monospace;font-weight:600;">' + tblKey + '</td><td style="padding:6px 10px;color:var(--text2);">' + tblVal.label + tblSize + '</td><td style="padding:6px 10px;text-align:right;font-weight:600;">' + tblVal.count.toLocaleString() + '</td></tr>';
            }
        }
        tbody.innerHTML = html;

        // Backups Table
        const bbody = document.getElementById('sql-backups-body');
        if (data.backups && data.backups.length > 0) {
            bbody.innerHTML = data.backups.map(b => 
                '<tr style="border-bottom:1px solid var(--border);">' +
                '<td style="padding:8px;font-family:monospace;">' + b.filename + '</td>' +
                '<td style="padding:8px;">' + b.sizeMb + ' MB</td>' +
                '<td style="padding:8px;">' + new Date(b.createdAt).toLocaleString('th-TH') + '</td>' +
                '</tr>'
            ).join('');
        } else {
            bbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:16px;color:var(--text3);">ยังไม่มีไฟล์สำรองข้อมูลในระบบ</td></tr>';
        }
    } catch (e) {
        showToast('ดึงรายละเอียด SQLite ไม่สำเร็จ: ' + e.message, 'err');
    }
}

// ── 3. ACTIONS & CONSOLE ──
async function triggerSqliteAction(action, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    try {
        showToast('กำลังดำเนินการ ' + action + '...', 'ok');
        const res = await fetch('/api/database/sqlite/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'ดำเนินการสำเร็จ', 'ok');
            loadSqliteDetails();
            loadDbOverview();
        } else {
            showToast('ล้มเหลว: ' + (data.error || data.message), 'err');
        }
    } catch (e) {
        showToast('เกิดข้อผิดพลาด: ' + e.message, 'err');
    }
}

async function submitConsole(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('consoleInput');
    const cmd = (input.value || '').trim();
    if (!cmd) return;
    input.value = '';
    await runConsoleCommand(cmd);
}

function runQuickConsole(cmd) {
    runConsoleCommand(cmd);
}

async function runConsoleCommand(cmd) {
    const outEl = document.getElementById('consoleOutput');
    outEl.textContent += '\n\nsqlite> ' + cmd + '\nกำลังประมวลผล...';
    outEl.scrollTop = outEl.scrollHeight;

    try {
        const res = await fetch('/api/database/sqlite/console', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd })
        });
        const data = await res.json();
        outEl.textContent = outEl.textContent.replace('กำลังประมวลผล...', '');
        outEl.textContent += data.output + '\n(เวลาที่ใช้: ' + data.durationMs + 'ms)';
        outEl.scrollTop = outEl.scrollHeight;
    } catch (e) {
        outEl.textContent += '\n❌ ข้อผิดพลาดในการเชื่อมต่อ: ' + e.message;
        outEl.scrollTop = outEl.scrollHeight;
    }
}

// ── 4. LOAD MONGODB DETAILS ──
async function loadMongoDetails() {
    try {
        const res = await fetch('/api/database/mongo');
        if (!res.ok) throw new Error('API Error: ' + res.status);
        const data = await res.json();

        document.getElementById('mg-host-text').textContent = 'Host: ' + data.host + ' | Database: ' + (data.databaseName || '-');
        document.getElementById('mg-badge-conn').textContent = 'Status: ' + (data.connected ? 'CONNECTED' : 'DISCONNECTED');
        document.getElementById('mg-badge-conn').style.background = data.connected ? 'var(--green2)' : 'var(--red2)';
        document.getElementById('mg-badge-conn').style.color = '#000';
        document.getElementById('mg-badge-ping').textContent = 'Ping: ' + (data.pingMs || 0) + ' ms';

        const tbody = document.getElementById('mg-collections-body');
        if (data.collections && data.collections.length > 0) {
            tbody.innerHTML = data.collections.map(c => 
                '<tr style="border-bottom:1px solid var(--border);">' +
                '<td style="padding:10px 8px;font-weight:600;">' + c.name + '</td>' +
                '<td style="padding:10px 8px;font-family:monospace;color:var(--text3);">' + c.collectionName + '</td>' +
                '<td style="padding:10px 8px;text-align:right;font-weight:700;color:var(--accent3);">' + c.count.toLocaleString() + '</td>' +
                '<td style="padding:10px 8px;text-align:right;color:var(--text2);">' + c.indexesCount + '</td>' +
                '<td style="padding:10px 8px;text-align:center;">' +
                    '<button type="button" class="btn btn-sm btn-secondary" onclick="openSafeExplorer(\'' + c.name + '\')">🔍 ดูตัวอย่างข้อมูล</button>' +
                '</td>' +
                '</tr>'
            ).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text3);">ไม่พบ Collections หรือไม่ได้เชื่อมต่อ</td></tr>';
        }
    } catch (e) {
        showToast('ดึงข้อมูล MongoDB ไม่สำเร็จ: ' + e.message, 'err');
    }
}

async function openSafeExplorer(modelName) {
    const modal = document.getElementById('safeExplorerModal');
    const title = document.getElementById('explorerTitle');
    const pre = document.getElementById('explorerData');

    title.textContent = 'ตัวอย่างข้อมูล: ' + modelName;
    pre.textContent = 'กำลังโหลดตัวอย่างข้อมูลที่ปลอดภัย...';
    modal.style.display = 'block';
    modal.scrollIntoView({ behavior: 'smooth' });

    try {
        const res = await fetch('/api/database/mongo/collection/' + encodeURIComponent(modelName) + '?limit=3');
        const data = await res.json();
        if (data.success) {
            pre.textContent = JSON.stringify(data.documents, null, 2);
        } else {
            pre.textContent = '❌ ไม่สามารถดึงข้อมูลได้: ' + (data.error || 'Unknown error');
        }
    } catch (e) {
        pre.textContent = '❌ เกิดข้อผิดพลาด: ' + e.message;
    }
}

function closeSafeExplorer() {
    document.getElementById('safeExplorerModal').style.display = 'none';
}

async function runDbHealthCheck() {
    showToast('กำลังตรวจสุขภาพฐานข้อมูลทั้งหมด...', 'ok');
    try {
        await triggerSqliteAction('check');
        refreshCurrentTab();
    } catch (_) {}
}

// Initial Tab Resolution from Hash
(function() {
    const hash = window.location.hash || '';
    if (hash.includes('tab=sqlite')) switchDbTab('sqlite');
    else if (hash.includes('tab=mongo')) switchDbTab('mongo');
    else switchDbTab('overview');
})();

dashboardInterval(refreshCurrentTab, 15000);
</script>
`);
}

module.exports = {
    buildDatabaseCenterPage
};
