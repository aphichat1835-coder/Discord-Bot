# SQLite & Database Center Operations Runbook

Updated: 2026-09-23

คู่มือการดูแลรักษา การเฝ้าระวัง การสำรองข้อมูล และการกู้คืนฐานข้อมูลสำหรับ **SQLite 3 (`better-sqlite3@13.0.3`)** และ **ศูนย์จัดการฐานข้อมูล (Database Center)** บน Owner Dashboard

---

## 1. Storage Quotas & Thresholds (การควบคุมพื้นที่ดิสก์)

ระบบเฝ้าระวังขนาด Footprint รวมของ SQLite (`.sqlite` + `-wal` + `-shm`):

| ระดับสถานะ | ขนาด Footprint | พฤติกรรมและการตอบสนองของระบบ |
| :--- | :--- | :--- |
| **🟢 ปกติ (Normal)** | `< 3,072 MB (3.0 GB)` | ทำงานตามปกติ รอบการคลีนนิ่งและ Checkpoint ทำตามคาบเวลาปกติ |
| **🟡 ควรตรวจสอบ (Soft Limit)** | `≥ 3,072 MB` | เพิ่มความถี่ในการทำ Bounded Cleanup เบื้องหลัง พร้อมบันทึกแจ้งเตือน |
| **🟠 ใกล้ถึงขีดจำกัด (Critical)** | `≥ 3,686 MB` | ระงับการเขียนแคชใหม่ (Cache Throttled) ล้างข้อมูลแคชและประวัติเก่าเข้มข้นขึ้น |
| **🔴 แตะเพดาน (Hard Limit)** | `≥ 4,096 MB (4.0 GB)` | **Emergency Write Brake**: ระงับการเขียนแคชและประวัติที่ไม่สำคัญ เพื่อป้องกันดิสก์เต็ม **(ห้ามลบหรือบล็อกข้อมูลหลัก Core Data เด็ดขาด)** |

สามารถปรับแต่งขนาดได้ผ่าน Environment Variables ใน `.env`:
- `SQLITE_QUOTA_SOFT_MB` (ค่าเริ่มต้น: `3072`)
- `SQLITE_QUOTA_CRIT_MB` (ค่าเริ่มต้น: `3686`)
- `SQLITE_QUOTA_HARD_MB` (ค่าเริ่มต้น: `4096`)

### ⚡ นโยบายการตอบสนองต่อภาวะวิกฤต (Emergency Policy B & P0 Journal Durability)
ระบบแยกแยะภาวะวิกฤตออกเป็น 2 ประเภทอย่างชัดเจนตามสาเหตุทางเทคนิค:
1. **Physical Storage Emergency (พื้นที่จัดเก็บดิสก์วิกฤต)**:
   - เงื่อนไข: Footprint รวม > Critical (`3,686 MB`), หรือ WAL > `500 MB`, หรือพื้นที่ดิสก์เครื่องเหลือน้อยกว่า `100 MB`
   - การตอบสนอง: ส่ง Webhook Alert (CRITICAL) ➔ ดำเนินการ **Emergency Auto-Trim** ล้างแคชหมดอายุ/LRU และประวัติเก่าที่พ้นกำหนดทันทีเพื่อคืนพื้นที่ดิสก์จริง
2. **Buffer Queue Emergency (แรงกดดันคิวใน RAM / Writer Pressure)**:
   - เงื่อนไข: Write-behind buffer queue รวมสะสมในหน่วยความจำ RAM `≥ 2,000` รายการ
   - การตอบสนอง: ส่ง Webhook Alert (CRITICAL) ➔ สั่ง Drain Buffer ผ่านการ **Active Flush** และใช้ **Priority Drop** (สลัด Event ระดับต่ำ P2/P1 ทิ้ง โดยคุ้มครอง P0 ไม่ให้สูญหาย) **โดยไม่เรียก Emergency Trim บนไฟล์ดิสก์** เนื่องจากปัญหาคิวล้นใน RAM ไม่ได้เกิดจากดิสก์เต็ม และการลบแคชไฟล์บนดิสก์ไม่ได้ช่วยลดคิวใน RAM โดยตรง

#### 🛡️ ระบบคุ้มครองความคงทนของข้อมูลระดับวิกฤต (P0 Emergency Journal Durability)
สำหรับ Event ระดับ **P0 (Critical Telemetry & Security Lifecycle)** ระบบมีเกราะป้องกันข้อมูลสูญหาย 3 ชั้น (`database/sqlite/repositories/history/p0Journal.js`):
1. **Direct Fast-Path Write**: เขียนลงฐานข้อมูล SQLite ทันที
2. **Critical Retry Queue**: หาก SQLite ติด Busy/Lock ชั่วคราว Event P0 จะถูกพักไว้ใน `criticalRetryQueue` (จำกัดเพดาน 100 รายการ) เพื่อรอ Retry ในรอบถัดไป
3. **Emergency Disk Journal (`data/p0-emergency.journal`)**: หาก Queue เต็มหรือฐานข้อมูลเขียนไม่ได้กะทันหัน ระบบจะ Spool ข้อมูล P0 ลงไฟล์ Emergency Journal บนดิสก์ทันที เพื่อรับประกัน **Zero Data Loss** และจะทำการ Drain อ่านกลับมาบันทึกลง SQLite อัตโนมัติเมื่อฐานข้อมูลพร้อมใช้งาน

#### 💽 การเฝ้าระวังพื้นที่จัดเก็บแบบแยกไดรฟ์ (Multi-Volume Mount Monitoring)
เครื่องยนต์ `storageCheck.js` มีระบบตรวจสอบดิสก์แบบแยกอิสระ 3 จุด:
- **Database Volume**: ตรวจสอบพื้นที่ว่างของไดรฟ์ที่เก็บ `SQLITE_DB_PATH`
- **Backup Volume**: ตรวจสอบพื้นที่ว่างของไดรฟ์ที่เก็บ `SQLITE_BACKUP_DIR`
- **Asset Cache Volume**: ตรวจสอบพื้นที่ว่างของไดรฟ์ที่เก็บ `SQLITE_ASSET_DIR`
หากแยก Mount point คนละไดรฟ์ ระบบจะประเมินพื้นที่ว่างแยกกันอย่างแม่นยำ ไม่รวมตัวเลขปะปนกัน พร้อมระบบ **Auto-Detection** ตรวจจับ Physical Mount `/persistent` บนโฮสติ้งให้อัตโนมัติ ป้องกันปัญหาพื้นที่ดิสก์เต็มแบบไม่รู้ตัว

---

## 2. Database Center ใน Owner Dashboard (`/database`)

เข้าสู่หน้า Dashboard ผ่านเมนู **🗄️ ฐานข้อมูล** หรือเส้นทาง `/database` (ต้องยืนยันตัวตนด้วย Owner PIN):

- เป็นหน้าแบบ **Single-Page Application (SPA)** สลับเนื้อหาได้ทันทีโดยไม่โหลดหน้าใหม่
- แบ่งออกเป็น 3 แท็บหลัก:
  1. **📊 ภาพรวมระบบ (Overview)**: สรุปสถานะภาพรวมของทั้ง SQLite และ MongoDB, ขนาด Footprint, แถบ Quota, จำนวน Records รวมแยกตามหมวดหมู่, และเวลาการทำบำรุงรักษาล่าสุด
  2. **📁 SQLite (Operational DB)**: รายละเอียดเครื่องยนต์ SQLite (WAL mode, Foreign keys, Schema version), ตารางแยกหมวดหมู่ (Core, Temp, History, Cache), ปุ่มสั่งการบำรุงรักษา (Integrity, Cleanup, Vacuum, Backup) และ **Database Console**
  3. **🍃 MongoDB (Identity & Security)**: สถานะคลัสเตอร์, Ping latency, รายการ Collections และ **Safe Data Explorer** สำหรับดูตัวอย่างข้อมูลแบบ Masked/Redacted ปลอดภัย

### 🔒 ข้อกำหนดความปลอดภัยของ Database Console
คอนโซลในหน้าเว็บอนุญาตให้รันเฉพาะคำสั่ง Allowlist ฐานข้อมูลทั้ง 14 คำสั่งเท่านั้น:
- `status`, `health` — ตรวจสอบสถานะภาพรวมและสุขภาพฐานข้อมูล
- `stats` — ดูสถิติแถวข้อมูลแยกตามหมวดหมู่ (Core, Temp, History, Cache)
- `tables` — แสดงรายชื่อตารางทั้งหมดพร้อมจำนวนแถว
- `migrations` — ดูประวัติ Schema Migrations และเวอร์ชันปัจจุบัน
- `integrity` — ตรวจสอบความสมบูรณ์เชิงลึกของข้อมูล (PRAGMA integrity_check)
- `cleanup`, `cleanup cache`, `cleanup history` — สั่งล้างข้อมูลหมดอายุ แคช หรือประวัติย้อนหลัง (Retention ตามค่าคอนฟิก)
- `checkpoint` — รวมไฟล์ WAL กลับเข้าสู่ไฟล์หลัก
- `vacuum` — รัน Incremental Vacuum คืนพื้นที่ที่ว่าง
- `backup` — สร้างไฟล์สำรองข้อมูลทันที
- `emergency-trim` — สั่งทำ Emergency Auto-Trim ล้างข้อมูลแคชและประวัติหมดอายุทันทีเพื่อคืนพื้นที่
- `full-check` — ตรวจสอบความสมบูรณ์แบบละเอียดครบวงจร (Integrity, Foreign Keys, PRAGMAs, Migrations, Storage)

> [!CAUTION]
> **ระบบบล็อกคำสั่ง OS Shell (เช่น `rm`, `curl`, `wget`, `bash`) 100%**: เพื่อความปลอดภัยสูงสุด ห้ามเปิดใช้ Arbitrary OS Shell จากหน้าเว็บ

---

## 3. ชุดคำสั่ง CLI มาตรฐาน (`npm run db:sqlite:*`)

ผู้ดูแลระบบสามารถสั่งการผ่าน Terminal ได้โดยตรง โดยระบบ CLI จะเรียกผ่าน `DatabaseService` เดียวกันกับหน้าเว็บ:

| คำสั่ง NPM | สคริปต์ที่รัน | หน้าที่และการทำงาน |
| :--- | :--- | :--- |
| `npm run db:sqlite:status` | `scripts/db/status.js` | แสดงสถานะสรุปของทั้ง SQLite และ MongoDB เป็นภาษาไทย |
| `npm run db:sqlite:stats` | `scripts/db/stats.js` | แสดงสถิติและจำนวนแถวแยกตามหมวดหมู่ Core, Temp, History, Cache |
| `npm run db:sqlite:check` | `scripts/db/checkSqlite.js` | ตรวจสอบไฟล์, PRAGMAs, Migrations, Read/Write probe และ Quota |
| `npm run db:sqlite:integrity` | `scripts/db/integrity.js` | ตรวจสอบความสมบูรณ์เชิงลึกและ Foreign Key Constraints |
| `npm run db:sqlite:cleanup` | `scripts/db/cleanup.js` | ทำความสะอาดข้อมูลหมดอายุและประวัติเก่าตาม Retention Policy |
| `npm run db:sqlite:backup` | `scripts/db/backupSqlite.js` | สำรองข้อมูล SQLite แบบ Online (เก็บ 2 ชุดล่าสุด ตรวจพื้นที่ว่างก่อนทำ) |
| `npm run db:sqlite:restore` | `scripts/db/restoreSqlite.js` | กู้คืนฐานข้อมูลจากไฟล์แบ็กอัป พร้อมระบบตรวจ Integrity และสร้าง Rollback `.bak` |
| `npm run db:sqlite:migrate` | `scripts/db/migrate.js` | ตรวจสอบและรัน Schema Migrations ที่ค้างอยู่ |

---

## 4. นโยบายการสำรองข้อมูลและการกู้คืน (Backup & Restore Policy)

1. **Online Non-blocking Backup**:
   - ใช้ SQLite Native Backup API ไม่ล็อกระบบ บอททำงานต่อได้ตามปกติ
   - **การจำกัดจำนวนชุด (Rotation)**: เก็บไฟล์สำรองในเครื่องเพียง **2 ชุดล่าสุด** เป็นค่าเริ่มต้น เพื่อประหยัดพื้นที่ดิสก์
   - **การตรวจพื้นที่ว่าง (Disk Free Space Check)**: ตรวจสอบพื้นที่ว่างของ Filesystem ก่อนเริ่ม Backup เสมอ (ต้องมีที่ว่างอย่างน้อย 1.5 เท่าของขนาดฐานข้อมูล) หากไม่พอจะยกเลิกทันทีเพื่อป้องกันดิสก์เต็ม
2. **Safe Restore Safeguards, Process Lock & Auto-Rollback**:
   - คำสั่ง: `node scripts/db/restoreSqlite.js --source ./backups/sqlite_backup_<timestamp>.sqlite`
   - **🔒 Process Lock & Split-Brain Prevention (`processLock.js`)**:
     - ระบบตรวจเช็กสถานะการทำงานของบอทผ่านไฟล์ Lock (`data/discordbot.sqlite.lock`) ด้วย `isPidAlive(pid)` (POSIX signal 0)
     - **คำสั่ง Restore จะปฏิเสธการทำงานทันที (Abort with Error)** หากตรวจพบบอทกำลังรันอยู่ เพื่อป้องกันการเขียนทับไฟล์ฐานข้อมูลในขณะที่มีการเปิดใช้งาน (Split-Brain / Database Corruption)
     - หากจำเป็นต้องกู้คืนในกรณีฉุกเฉินขณะที่ Process ค้าง สามารถใส่แฟล็กข้ามได้:
       ```bash
       node scripts/db/restoreSqlite.js --source ./backups/sqlite_backup_<timestamp>.sqlite --force
       ```
   - **🔄 ลำดับการกู้คืนแบบ 4 ขั้นตอน (4-Stage Staging Verification Workflow)**:
     1. **1/4 Verifying Source Backup Integrity**: ตรวจสอบ `PRAGMA user_version = 4` และความสมบูรณ์ของไฟล์ต้นทางก่อนแตะต้องฐานข้อมูลจริง
     2. **2/4 Securing Current Target Database**: สร้างไฟล์สำรองย้อนกลับ (`.pre-restore-<timestamp>.bak`) ของฐานข้อมูลปัจจุบันอัตโนมัติ (เก็บหมุนเวียน 2 ชุดล่าสุด)
     3. **3/4 Staging Copy & Isolation Check**: คัดลอกไฟล์แบ็กอัปไปยังไฟล์ชั่วคราว (`<target>.staging`) และรัน `PRAGMA integrity_check` บนไฟล์ Staging ก่อน หากพบข้อผิดพลาดจะยกเลิกทันทีโดยที่ไฟล์ฐานข้อมูลจริงยังไม่ถูกแตะต้อง
     4. **4/4 Atomic Replacement & Post-Flight Integrity**: ย้ายไฟล์ Staging เข้าแทนที่ฐานข้อมูลจริง ลบไฟล์ `-wal` และ `-shm` เก่าทิ้งเพื่อป้องกัน Log replay ทับ และตรวจความสมบูรณ์หลังการกู้คืนเสร็จสิ้น
   - **Auto-Rollback**: หากเกิดความผิดพลาดในขั้นตอนใด ๆ ระบบจะ Rollback ดึงข้อมูลจากไฟล์ `.bak` กลับมาคืนตำแหน่งเดิมทันทีโดยอัตโนมัติ

3. **Schema Migrations Lineage (`PRAGMA user_version = 4`)**:
   - `001_initial_core.sql`: Core state tables, tokens, DMs, nonces, settings.
   - `002_history_events.sql`: Telemetry & history tables (voice, commands, sessions).
   - `003_cache_subsystem.sql`: Generic key-value cache tables with namespace.
   - `004_session_runtime_and_assets.sql`: Voice session runtime heartbeats & lean filesystem asset cache metadata.
   - ทุกครั้งที่รัน migration สำเร็จ ระบบจะบันทึก checksum และกำหนด `PRAGMA user_version = 4` เพื่อรับประกันความเข้ากันได้ของสถาปัตยกรรม (Bootstrap Lineage)

> [!WARNING]
> ### ข้อควรระวังเชิงประวัติศาสตร์ของการ Migration (Migration 004 Hazard Note)
> ในไฟล์ `004_session_runtime_and_assets.sql` มีการใช้คำสั่ง `DROP TABLE IF EXISTS asset_cache;` เพื่ออัปเกรดโครงสร้างจากแคชแบบ Binary BLOB ในตัวฐานข้อมูลเดิม ไปเป็นโครงสร้างชี้ไฟล์บนดิสก์ (Filesystem Metadata Pointer)  
> **นโยบายการ Migration ของโปรเจกต์ (Immutable Forward-Only Migrations):**
> 1. คำสั่ง `DROP TABLE` อนุญาตให้ใช้ได้เฉพาะกับตารางแคชชั่วคราว (Ephemeral Cache) ที่สามารถสร้างใหม่ได้อัตโนมัติเท่านั้น
> 2. **ห้ามใช้ `DROP TABLE` กับตารางข้อมูลหลัก (Core Tables)** เช่น `quest_logs`, `scheduled_runners`, `dm_notifications`, `verification_recovery` หรือตารางประวัติเด็ดขาด
> 3. การปรับปรุงโครงสร้างในอนาคตทั้งหมดต้องเป็น **Immutable Forward-Only** โดยใช้ `ALTER TABLE ADD COLUMN` หรือสร้างตารางใหม่แล้วโอนย้ายข้อมูลผ่าน Transaction ที่มี Rollback ปลอดภัย

4. **Pre-Migration Safety Backups & Isolated Retention**:
   - เมื่อระบบตรวจพบว่า Migration ใดมีคำสั่งที่เสี่ยง (Destructive เช่น `DROP TABLE`) ระบบจะสร้าง Snapshot สำรองข้อมูลล่วงหน้า (`sqlite_backup_pre_migration_<id>_<timestamp>.sqlite`) อัตโนมัติก่อนลงมือ Migration
   - **การแยก Namespace และ Retention อิสระ**: ไฟล์ Pre-migration Backup ถูกแยกการหมุนเวียนออกจาก Daily Backup ปกติ ไม่ปะปนกัน และจำกัดจำนวนชุดอัตโนมัติ (ค่าเริ่มต้น: **3 ชุดล่าสุด**) เพื่อป้องกันไม่ให้ไฟล์แบ็กอัปสะสมไม่จำกัดในระยะยาว
   - สามารถกำหนดได้ผ่าน `SQLITE_PRE_MIGRATION_BACKUP_RETENTION` ใน `.env`

---

## 5. การแก้ปัญหาเมื่อเกิดเหตุฉุกเฉิน (Troubleshooting)

### ปัญหาที่ 1: ไฟล์ WAL มีขนาดใหญ่ผิดปกติ (> 500MB)
- **สาเหตุ**: มี Transaction อ่านค้างอยู่ หรือมี Concurrency สูงทำให้ Checkpoint แบบ PASSIVE รวมไฟล์ไม่สำเร็จ
- **วิธีแก้**:
  ```bash
  npm run db:sqlite:check
  ```
  หรือสั่ง Checkpoint ทันที:
  ```bash
  node -e "const { getDatabase } = require('./database/sqlite/connection'); getDatabase().pragma('wal_checkpoint(TRUNCATE)');"
  ```

### ปัญหาที่ 2: พื้นที่ดิสก์ใกล้เต็ม (เข้าสู่สถานะ Critical หรือ Hard Limit)
- **วิธีแก้**:
  1. สั่งรันคำสั่งทำความสะอาดข้อมูล:
     ```bash
     npm run db:sqlite:cleanup
     ```
  2. รัน Incremental Vacuum เพื่อคืนพื้นที่:
     ```bash
     node -e "const { getDatabase } = require('./database/sqlite/connection'); const { runIncrementalVacuum } = require('./database/sqlite/maintenance/vacuum'); runIncrementalVacuum(getDatabase(), 1000);"
     ```
  3. ตรวจสอบพื้นที่อีกครั้งด้วย `npm run db:sqlite:stats`

---

## 6. Production Deployment Checklist (รายการตรวจสอบความพร้อมก่อนขึ้น Production)

ก่อนนำขึ้น Production (เช่น Dedicated Discord Bot Hosting / Pterodactyl Container / VPS / Docker):

- [ ] **1. ตั้งค่า Persistent Volume Mount**: ตรวจสอบว่าโฮสต์หรือคอนเทนเนอร์มีการ Mount โฟลเดอร์ภายนอก (เช่น `/persistent/`) เพื่อป้องกันข้อมูลสูญหายเมื่อคอนเทนเนอร์ถูก Rebuild หรือ Restart
- [ ] **2. ตั้งค่า Environment Variables ในไฟล์ `.env` หรือ Dashboard ของโฮสติ้ง**:
  ```env
  SQLITE_DB_PATH=/persistent/discordbot.sqlite
  SQLITE_BACKUP_DIR=/persistent/backups
  SQLITE_ASSET_DIR=/persistent/cache-assets
  SQLITE_PERSISTENCE_CONFIRMED=true
  SQLITE_QUOTA_SOFT_MB=3072
  SQLITE_QUOTA_CRIT_MB=3686
  SQLITE_QUOTA_HARD_MB=4096
  ```
- [ ] **3. ตรวจสอบสิทธิ์การเข้าถึงไฟล์ (File Permissions)**:
  - โฟลเดอร์ที่ Mount ต้องมีสิทธิ์อ่านและเขียน (`R_OK | W_OK`) สำหรับ Node.js process user
- [ ] **4. ตรวจสอบพื้นที่ว่างบนดิสก์ (Disk Free Space)**:
  - Persistent volume ต้องมีพื้นที่ว่างขั้นต่ำอย่างน้อย **1 GB** (Storage Guard จะแจ้งเตือน `filesystemWarning` หากมีระหว่าง 100MB–1GB และจะขึ้น `filesystemCritical` หากต่ำกว่า 100MB)
- [ ] **5. ทดสอบ Pre-flight ผ่าน CLI**:
  ```bash
  npm run check:storage
  npm run db:sqlite:check
  ```
  - หากระบบตรวจพบ In-Source Storage ในโหมด Production ระบบจะขึ้น `[STORAGE] ⚠️ pathWarning` เพื่อแจ้งเตือน แต่จะไม่สั่ง Crash หรือขัดขวางการทำงานของบอท

---

## 7. การจัดการ Asset Cache & ป้องกัน Orphan File บนดิสก์ (`assetCacheManager.js`)

ระบบแคชไฟล์ไบนารีภายนอก (Avatar, Server Icon, Attachment) มีระบบควบคุมพื้นที่และสุขอนามัยของไฟล์บนดิสก์:
- **โควตาความจุรวม (Quota)**: จำกัดพื้นที่ไดเรกทอรี `SQLITE_ASSET_DIR` รวมไม่เกิน **500 MB**
- **การคำนวณพื้นที่แบบ Deduplicated**: คำนวณขนาดจริงตามไฟล์ไม่ซ้ำ (`relative_path`) แม้จะมีหลาย Cache Keys ชี้มาที่รูปเดียวกัน
- **🛡️ Orphan File Prevention (การป้องกันไฟล์ขยะตกค้าง)**:
  - การบันทึกไฟล์แคชลงดิสก์ใช้หลักการ Atomic: เขียนไฟล์ไบนารีลงดิสก์ก่อน ➔ บันทึก Metadata ลง SQLite
  - **หากการ Insert หรือ Update ลง SQLite ล้มเหลว**: ระบบจะทำการ **`unlinkSync` ลบไฟล์บนดิสก์ทิ้งทันที** เพื่อไม่ให้เกิดไฟล์ขยะที่ไร้การอ้างอิงสะสมค้างบนดิสก์
- **Phased LRU Eviction**: เมื่อขนาดพื้นที่เกิน 500 MB ระบบจะคัดกรองไฟล์ที่มี `last_accessed_at` เก่าที่สุดออกตามลำดับเพื่อคืนพื้นที่ให้ต่ำกว่าเพดาน

---

## 8. ระบบความปลอดภัยของข้อมูล Telemetry (Command Telemetry Sanitizer)

ตาราง `command_events` และ `session_events` มีตัวกรอง Sanitizer อัตโนมัติก่อนบันทึกลง SQLite:
- **🔒 Credential & Token Redaction**: ตรวจจับและแทนที่ Discord Token, Session Cookie, รหัสผ่าน, และ API Key ใน Interaction Details ให้เป็นค่า Safe Placeholder โดยอัตโนมัติ
- **🧬 Bounded Object Depth (`depth >= 5`)**: วัตถุ JSON หรือ Options ที่มีความซ้อนลึกเกิน 5 ชั้น จะถูกแทนที่ด้วย `"[REDACTED_NESTED]"` เพื่อป้องกัน Denial-of-Service จาก Circular References และป้องกันการลักลอบบันทึก Payload ขนาดใหญ่เกินความจำเป็นลงฐานข้อมูล Local
