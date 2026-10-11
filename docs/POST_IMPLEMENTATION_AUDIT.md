# รายงานการตรวจสอบสถาปัตยกรรมระบบฐานข้อมูลหลังการติดตั้ง (Post-Implementation Architecture Audit Report)

**วันที่บันทึก:** 2026-09-23  
**สถานะ:** ดำเนินการแก้ไขและผ่านการทดสอบครบถ้วน 100% (RESOLVED & VERIFIED)  
**ผลลัพธ์หลังแก้ไข:** ข้อบกพร่องระดับ D = 0 รายการ, ระดับ C = 0 รายการ (Owner ตัดสินใจและล็อก Policy ครบถ้วน)

---

## 1. บทสรุปการประเมิน (Executive Summary)

การตรวจสอบสถาปัตยกรรมระบบฐานข้อมูลแบบ 3-Tier (MongoDB Atlas + SQLite Local Persistent + RAM Write-Behind) ที่ได้รับการติดตั้งแล้ว ได้ทำการวิเคราะห์เชิงลึกใน 10 มิติหลัก:
1. การตัดสินใจเชิงสถาปัตยกรรมที่ AI เลือกเองโดยไม่ได้ระบุใน Requirement
2. สมมติฐานที่อาจขัดกับ Final Architecture
3. พฤติกรรมที่เปลี่ยนไปจากระบบเดิม
4. ความซ้ำซ้อนของระบบ (Duplicate / Redundant systems)
5. จุดที่อาจเป็น Source of Truth ที่ผิดหรือคลุมเครือ
6. ความเสี่ยงด้าน Persistence / Backup / Recovery
7. ความเสี่ยงการจัดวางข้อมูลระหว่าง SQLite และ MongoDB
8. พฤติกรรมและความเสี่ยงของ Voice / Token / 429 Quarantine
9. ความเสี่ยงด้านความปลอดภัยและการรั่วไหลของข้อมูลลับ (Security & Secret Leakage)
10. ความเสี่ยงด้าน Migration และการสูญหายของข้อมูล (Data Loss)

---

## 2. ตารางสรุปการจำแนกสถานะ (Classification Matrix)

| ระดับ | ความหมาย | จำนวนรายการ |
| :---: | :--- | :---: |
| **D** | **ขัดกับ Architecture / มีความเสี่ยงต่อ Runtime ใน Production ต้องแก้ไข** | 1 รายการ |
| **C** | **AI ตัดสินใจเองและส่งผลต่อพฤติกรรมระบบ ควรให้ Owner พิจารณาตัดสินใจ** | 4 รายการ |
| **B** | **AI ตัดสินใจเอง แต่เป็นการออกแบบเชิงเทคนิคที่ดี ไม่มีปัญหาสำคัญ** | 4 รายการ |
| **A** | **ตรงตาม Final Architecture และนโยบายความปลอดภัยสมบูรณ์ 100%** | 3 รายการ |

---

## 3. รายละเอียดผลการตรวจสอบรายข้อ (Detailed Findings)

---

### 🔴 กลุ่ม D: ขัดกับ Architecture และควรแก้ (Action Required)

#### รายการที่ 1: Production Storage Source-Isolation Guard (`storageCheck.js`) เสี่ยงทำให้บอท Crash ตอนบูตบน Hosting
* **สิ่งที่ implement อยู่ตอนนี้:**  
  ใน `database/sqlite/maintenance/storageCheck.js` หากรันด้วย `NODE_ENV === "production"` โค้ดจะบังคับว่าโฟลเดอร์ SQLite (`SQLITE_DB_PATH`), Backup (`SQLITE_BACKUP_DIR`), และ Assets (`SQLITE_ASSET_DIR`) ต้อง **ไม่อยู่ภายใน Source Repository** และดิสก์ต้องมีพื้นที่ว่างอย่างน้อย **1,000 MB (1GB)** มิฉะนั้นใน `startupCheck.js` จะสั่ง `throw new Error(...)` ทำให้บอท **Fatal Crash ทันทีขณะบูต** เว้นแต่จะระบุ `ALLOW_IN_SOURCE_STORAGE=true`
* **ที่มาของการตัดสินใจ:**  
  **AI ตัดสินใจเองทั้งหมด** โดยตั้งสมมติฐานเกินความจำเป็นว่าใน Production ทุกคนจะมี Docker External Volume Mount
* **ความเสี่ยง / ผลกระทบ:**  
  บน Dedicated Discord Bot Hosting (เช่น Pterodactyl Panel, VPS ทั่วไป, หรือ Node Container ใน `/home/container`) ทั้งโปรเจกต์จะอยู่ในไดเรกทอรีเดียวกัน และมักไม่มี Volume แยก หากนำโค้ดไปรันด้วย `NODE_ENV=production` **บอทจะแคชไม่ยอมสตาร์ททันที**
* **จำเป็นต้องแก้หรือไม่:** **จำเป็นต้องแก้ (เกรด D)**
* **ทางเลือกในการแก้:**
  * **Option 1 (แนะนำ):** ปรับให้เป็น `Warning` แจ้งเตือนในคอนโซลและ Webhook เท่านั้น **ไม่สั่งบล็อกหรือ Crash การบูต**
  * **Option 2:** กำหนดค่าเริ่มต้น `ALLOW_IN_SOURCE_STORAGE=true` ให้เป็น Default หากไม่ได้ระบุ
  * **Option 3:** ลดเกณฑ์พื้นที่ดิสก์ขั้นต่ำลงเหลือ 100MB และแสดงคำแนะนำแทนการ throw error

---

### 🟡 กลุ่ม C: AI ตัดสินใจเองและควรให้ Owner ตัดสินใจ (Owner Decision Required)

#### รายการที่ 2: การยกเว้น Voice ไม่ให้หยุดทำงานเมื่อโทเค็นติด 429 Rate Limit (`voiceWorker/lifecycle.js`)
* **สิ่งที่ implement อยู่ตอนนี้:**  
  ใน `discord/voiceWorker/lifecycle.js` เมื่อ `tokenCoordinator` ส่งสัญญาณว่าโทเค็นถูกกักกันด้วยเหตุผล **HTTP 429 (Rate Limit / Backoff)** โค้ดจะ **ไม่ตัดหรือหยุด Voice Session** ที่กำลังเชื่อมต่ออยู่ โดยปล่อยให้รันต่อไป และตัดเฉพาะเมื่อถูกกักกันด้วยเหตุผลที่เป็น Fatal Error จริงๆ (เช่น 401 Unauthorized, Token Invalid, Account Disabled)
* **ที่มาของการตัดสินใจ:**  
  **AI ตัดสินใจเอง** เนื่องจาก Voice Connection ทำงานผ่าน WebSocket และ UDP โดยตรง ไม่ได้ยิง REST API การที่ REST โดน 429 ชั่วคราว (เช่น 10-60 วินาที) แล้วไปตัดห้องเสียง ทำให้ผู้ใช้หลุดโดยไม่จำเป็น
* **ความเสี่ยง / ผลกระทบ:**  
  * *ข้อดี:* ห้องเสียงนิ่งและเสถียรมาก ไม่โดนผลกระทบจากการที่ Quest หรือ Task เบื้องหลังโดน 429
  * *ความเสี่ยง:* หาก Discord เริ่มเข้มงวดกับบัญชีนั้นในระดับ Gateway การถือ Session ต่อไปในขณะที่ REST โดน 429 อาจมีความเสี่ยงที่บัญชีจะถูกเพ่งเล็ง
* **จำเป็นต้องแก้หรือไม่:** **ควรให้ Owner ตัดสินใจ (เกรด C)**
* **ทางเลือก:**
  * **Option 1 (คงไว้ตามปัจจุบัน - แนะนำ):** ปล่อยให้ Voice เชื่อมต่อต่อไปเมื่อโดน REST 429 เพื่อความเสถียรสูงสุด
  * **Option 2 (ย้อนกลับสู่ระบบเดิม):** เมื่อโทเค็นโดน Quarantine ด้วยเหตุใดก็ตาม (รวมถึง 429) ให้หยุด Voice Session ทันทีเหมือนเวอร์ชันก่อนหน้า

---

#### รายการที่ 3: ความซ้ำซ้อนของ Mongoose Models (Verification Subsystem vs Centralized Database)
* **สิ่งที่ implement อยู่ตอนนี้:**  
  * มี Mongoose Models 17 ตัวอยู่ใน `discord/verification/models/` (โค้ดระบบ Verification ทั้งหมดในโปรเจกต์ยังคง `require()` จากที่นี่)
  * มี Mongoose Models 17 ตัวแบบเดียวกันสร้างใหม่อยู่ใน `database/mongo/models/` (มีเพียง Database Center Dashboard เท่านั้นที่เรียกใช้)
* **ที่มาของการตัดสินใจ:**  
  **AI ตัดสินใจเอง** ระหว่างการจัดทำโฟลเดอร์โครงสร้างกลาง `database/` เพื่อให้เป็นไปตาม Architecture โดยยังไม่ได้ Refactor จุดนำเข้าของโมดูลเก่าใน `discord/verification/`
* **ความเสี่ยง / ผลกระทบ:**  
  แม้ว่า Runtime Mongoose จะ reuse โมเดลตัวเดียวกันผ่าน `mongoose.models` แต่ในเชิง Maintainability มีไฟล์ Schema ซ้ำกัน 2 แห่ง เสี่ยงต่อการแก้ไขฟิลด์ไม่ตรงกันในอนาคต
* **จำเป็นต้องแก้หรือไม่:** **ควรให้ Owner ตัดสินใจ (เกรด C)**
* **ทางเลือก:**
  * **Option 1 (แนะนำ):** ปรับไฟล์ใน `discord/verification/models/*.js` ให้ re-export จาก `database/mongo/models/*.js` เพื่อให้ Single Source of Truth อยู่ที่จุดเดียว โดยไม่กระทบโค้ดเดิม
  * **Option 2:** คงไว้ตามเดิม ไม่แตะต้อง เพราะในทาง Runtime ไม่เกิดข้อผิดพลาดใดๆ

---

#### รายการที่ 4: การย้าย Scheduled Runners & DM Notifications ไปยัง SQLite โดยไม่มีสคริปต์ Sync ข้อมูลเก่าจาก MongoDB
* **สิ่งที่ implement อยู่ตอนนี้:**  
  * `ScheduledRunner` และ `DmNotification` ถูกย้ายไปอ่านและเขียนบน SQLite 100%
  * โค้ด SQLite เริ่มต้นจากตารางว่างเปล่า โดย **ไม่มีการรันคำสั่งดึงข้อมูล Scheduled Runner เก่า หรือ DM ค้างส่งที่อาจจะเคยมีอยู่ใน MongoDB Atlas มาลง SQLite**
* **ที่มาของการตัดสินใจ:**  
  **AI ตัดสินใจเอง** โดยระบุเป็น Assumption ไว้ใน `docs/database-architecture.md` (ข้อ 2.4: "No Backward Data Migration")
* **ความเสี่ยง / ผลกระทบ:**  
  หาก Owner หรือผู้ใช้เคยตั้งเวลา Scheduled Quest Runner อัตโนมัติไว้ก่อนหน้านี้ใน MongoDB Atlas ข้อมูลเหล่านั้นจะ **ไม่ถูกโหลดขึ้นมาทำงานบน SQLite** ทำให้บอทไม่รันเควสต์ตามเวลาเดิมจนกว่าจะเข้าไปตั้งค่าใหม่ผ่านหน้าเว็บ `/quests`
* **จำเป็นต้องแก้หรือไม่:** **ควรให้ Owner ตัดสินใจ (เกรด C)**
* **ทางเลือก:**
  * **Option 1:** สร้างสคริปต์ One-time Sync (`scripts/db/syncMongoToSqlite.js`) เพื่อดึง ScheduledRunner จาก Mongo มาใส่ลง SQLite อัตโนมัติในตอนเปิดเครื่องครั้งแรก
  * **Option 2:** ไม่ต้องทำ ปล่อยให้เริ่มต้นใหม่ตามเดิม (หากใน Production ไม่มี Scheduled Runner เดิม หรือยอมรับการตั้งค่าใหม่ได้)

---

#### รายการที่ 5: Data Masking ใน Database Center Preview กับนโยบาย Binding Owner Intent (OI-04)
* **สิ่งที่ implement อยู่ตอนนี้:**  
  ใน `database/services/databaseService.js` ฟังก์ชัน `maskSensitiveValue` ทำการซ่อนค่า IP Address (เช่น `192.168.***.***`), Token, และ Password ในการแสดงตัวอย่างข้อมูลคอลเลกชัน MongoDB บนหน้า Dashboard Center (`/database`)
* **ที่มาของการตัดสินใจ:**  
  **AI ตัดสินใจเอง** เพื่อความปลอดภัยในการเปิดดูหน้าเว็บ
* **ความเสี่ยง / ผลกระทบ:**  
  ใน `docs/OWNER_INTENT_POLICY.md` (OI-04) ระบุว่า:
  > *"After Owner PIN login, the Dashboard must allow direct access to token, raw IP, and full detail without a reason field, repeated PIN, step-up authentication, approval queue, or blocking reveal-intent workflow. Do not add masking/redaction merely because a field is sensitive."*
  
  การที่หน้า Database Center Masking ข้อมูลดิบหลังจากผ่าน Owner PIN มาแล้ว อาจขัดต่อเจตนารมณ์ของ Owner ที่ต้องการดูข้อมูลจริงเพื่อตรวจสอบปัญหา
* **จำเป็นต้องแก้หรือไม่:** **ควรให้ Owner ตัดสินใจ (เกรด C)**
* **ทางเลือก:**
  * **Option 1 (สอดคล้องกับ OI-04 - แนะนำ):** ยกเลิกการ Masking ในหน้า Database Center เพื่อให้แสดงข้อมูลดิบจริงทั้งหมด (เนื่องจากหน้านี้เข้าถึงได้เฉพาะผู้มี Owner PIN เท่านั้น)
  * **Option 2:** คงการ Masking ไว้เป็นค่าเริ่มต้น แต่เพิ่มปุ่ม Toggle "แสดงข้อมูลดิบ (Reveal Raw Data)" บนหน้าเว็บ
  * **Option 3:** คงการ Masking ไว้ตามเดิมสำหรับหน้าภาพรวมฐานข้อมูลนี้

---

### 🟢 กลุ่ม B: AI ตัดสินใจเอง แต่ไม่มีปัญหาสำคัญ (Minor Architectural Additions)

#### รายการที่ 6: การเก็บ Voice Session แบบ Dual-Storage (MongoDB Persistence + SQLite Telemetry)
* **สิ่งที่ implement อยู่ตอนนี้:**  
  RAM (`sessions` Map) เป็น Live State ขณะทำงาน, MongoDB (`SessionModel`) เป็น Authoritative Persistence ตอนบูตบอท, และ SQLite (`voice_session_runtime` table) เขียนคู่ขนานเพื่อเป็น Telemetry Snapshot สำหรับหน้า Dashboard Center
* **ผลกระทบ:** ทำงานแบบ Non-blocking ไม่กระทบเสถียรภาพ และ MongoDB ยังคงเป็น Source of Truth สำหรับการกู้คืน Session เมื่อรีบูต
* **จำเป็นต้องแก้หรือไม่:** ไม่จำเป็นต้องแก้ (เกรด B)

#### รายการที่ 7: กลไกคัดทิ้งข้อมูล Telemetry เก่า (Write-Behind Buffer Dropping) เมื่อคิวล้น
* **สิ่งที่ implement อยู่ตอนนี้:**  
  เมื่อคิวสะสมใน RAM เกิน 2,000 รายการ ระบบจะตัดทิ้ง 500 รายการที่เก่าที่สุด และส่ง Webhook แจ้งเตือน Warning (`sqlite.telemetry.buffer_dropped`)
* **ผลกระทบ:** ป้องกันสภาวะ Out-Of-Memory (OOM) Crash สอดคล้องกับกรอบ Memory Profile ~210-230MB RSS ของโฮสติ้ง
* **จำเป็นต้องแก้หรือไม่:** ไม่จำเป็นต้องแก้ (เกรด B)

#### รายการที่ 8: การกำหนด Quota Storage เริ่มต้นที่ 4,000MB
* **สิ่งที่ implement อยู่ตอนนี้:**  
  ใน `database/sqlite/maintenance/quota.js` กำหนดเกณฑ์เริ่มต้น Hard Limit = 4,000MB (4GB) และ Soft Limit = 3,500MB
* **ผลกระทบ:** มี Guard ตรวจจับพื้นที่ดิสก์จริงของเครื่อง (`quota.filesystem.availableMb < 100MB`) คอยดักจับสภาวะฉุกเฉินอีกชั้นหนึ่ง และค่านี้สามารถ Override ได้ผ่าน `.env`
* **จำเป็นต้องแก้หรือไม่:** ไม่จำเป็นต้องแก้โค้ด (เกรด B)

#### รายการที่ 9: Distributed Transaction ใน Privacy Deletion Service
* **สิ่งที่ implement อยู่ตอนนี้:**  
  การลบข้อมูล `VerificationRecovery` ทำงานบน SQLite ผ่าน Facade ในขณะที่คอลเลกชันอื่นๆ ทำงานภายใน MongoDB Transaction Session
* **ผลกระทบ:** เนื่องจาก `VerificationRecovery` เป็นเพียง State กู้คืนชั่วคราว การถูกลบจึงไม่มีผลกระทบต่อความสมบูรณ์ของข้อมูลถาวร
* **จำเป็นต้องแก้หรือไม่:** ไม่จำเป็นต้องแก้ (เกรด B)

---

### ✅ กลุ่ม A: ตรงตาม Final Architecture และนโยบายความปลอดภัย 100%

#### รายการที่ 10: ระบบสำรองข้อมูลอัตโนมัติ SQLite พร้อม SHA-256 Checksum (`scheduler.js` & `backup.js`)
* **สิ่งที่ implement อยู่ตอนนี้:**  
  Snapshot สำรองข้อมูลทุก 24 ชม. คำนวณ SHA-256 Streaming Checksum จำกัด Retention 2 ชุดล่าสุด ส่ง Webhook แจ้งเตือนเฉพาะ Metadata ไม่ส่งไฟล์ดิบออกนอกเครื่อง

#### รายการที่ 11: การตรวจจับและแจ้งเตือนความเสียหายของฐานข้อมูล SQLite (`sqlite.integrity.corrupted`)
* **สิ่งที่ implement อยู่ตอนนี้:**  
  ผูกการตรวจสอบ `PRAGMA integrity_check`, `foreign_key_check` และ `quick_check(1)` เข้ากับ Webhook Alert ระดับ CRITICAL พร้อม Throttle 15 นาที

#### รายการที่ 12: วงจรแจ้งเตือนสถานะการเชื่อมต่อ MongoDB Atlas (`mongo.connection.*`)
* **สิ่งที่ implement อยู่ตอนนี้:**  
  ตรวจจับสถานะ `lost`, `error`, และ `restored` พร้อมแฟลก `isExplicitShutdown` ป้องกัน False Alarm เมื่อปิดบอทตามปกติ

---

## 4. ผลการแก้ไขและตรวจสอบคุณภาพหลังคำตัดสินใจของ Owner (Post-Resolution & Verification)

ตามคำตัดสินใจอย่างเป็นทางการของเจ้าของระบบ ระบบได้รับการปรับปรุงและทดสอบยืนยันผล 100%:

1. **Storage Guard (Phase 1A):** แก้ไขเป็น 3-Tier Check (Normal / Warning / Critical) เรียบร้อยแล้ว โฟลเดอร์ใน Source Tree จะส่งเฉพาะคำเตือน (Non-fatal) และไม่ทำให้บอท Crash ตอนสตาร์ท พื้นที่ดิสก์ < 100MB จึงจะสั่ง Critical
2. **SQLite Quota (Phase 1B):** ปรับเกณฑ์ Quota เป็น Soft 3,072MB / Critical 3,686MB / Hard 4,096MB ตามคำสั่งเรียบร้อย
3. **Mongoose Canonical Models (Phase 1C):** รวม Schema เป็น Single Source of Truth ที่ `database/mongo/models/*` (17 models) และให้ `discord/verification/models/*` ทำหน้าที่เป็น Compatibility Re-export Facades (Strict Equality Pass 100%)
4. **Scheduled Runner Store (Phase 2):** ล็อก Policy คงสถานะ SQLite Clean Start ไม่ทำ 2-way sync หรือ background migration จาก MongoDB
5. **Database Center Masking (Phase 2):** เพิ่มข้อกำหนดชัดเจนใน `docs/OWNER_INTENT_POLICY.md` รับรองว่า Database Center Table Preview จะ Mask ข้อมูลละเอียดอ่อนเป็น Default เพื่อความปลอดภัยในการแชร์หน้าจอ และไม่ถือเป็นการละเมิด OI-04
6. **Voice Session Ownership (Phase 3):** ยืนยันสิทธิ์ความเป็นเจ้าของข้อมูลตามนโยบาย: MongoDB = Persistent Recovery Identity, RAM = Live Runtime State, SQLite = Runtime/Telemetry/Audit
7. **Write-Behind Buffer Priority Eviction (Phase 3):** ติดตั้ง `bufferPolicy.js` รองรับการตัดข้อมูลแบบแยกตามความสำคัญ (P0 = Critical Security/Corruption/Backup Fail เขียนตรงไม่เข้าคิวและไม่ถูกดรอป, P1 = Session Lifecycle/Quarantine/429 พยายามเก็บ, P2 = Telemetry ทั่วไป ดรอปกลุ่มนี้ก่อนเมื่อคิวล้น)
8. **Voice 429 Isolation & Metadata (Phase 3):** แยกการตัดการเชื่อมต่อระหว่าง REST 429 ออกจาก Voice Gateway และเพิ่ม Metadata `source: "rest_api"`, `event: "rate_limit"`, `retryAfter: backoffSeconds`
9. **Quality Gates & Regression:** ผ่านการตรวจสอบทั้งหมด:
   - `npm run check:protected`: ผ่าน 100% (7/7 Protected Files ไม่ถูกแตะต้อง)
   - `npm run check`: ผ่าน Quality Gates ทั้ง 10 รายการ
   - `npm test`: ผ่าน 546/546 แบบทดสอบ (500 Core Tests + 46 Database Tests) 0 Failures

