# Join Campaign — Production Rebuild / Full Architecture Blueprint
## Repository: `zzzxxxaszzzxxas-cyber/discordbot4`
## Status: Owner Approved & Locked via /grill-me

---

# 1. Executive Summary & Core Decisions Locked

ระบบ **Join Campaign** ได้รับการออกแบบใหม่ทั้งระบบในระดับ Production โดยแปลงจาก Monolithic Script เดิมใน `discord/features/joinCampaign.js` เข้าสู่ **Modular Subsystem Architecture** ที่มีโฟลเดอร์ของตัวเอง แยกความรับผิดชอบชัดเจน รองรับสมาชิกระดับหมื่นคน พร้อมฟังก์ชันการทำงานที่ผ่านการตกลงทุกมิติ:

1. **Control Plane Authority**:
   - **Discord (`/join-panel`) = ศูนย์ควบคุมเดียว (Sole Control Plane)** ในการตั้งค่าและเริ่มงาน
   - **Owner Dashboard (`/join-campaign`) = Read-only Monitoring & History** (ไม่มีปุ่ม Start, Stop, Pause หรือ Dry-run เพื่อป้องกัน Dual Control Plane และ Race Condition)
2. **Mode Strategy Registry**:
   - **Default Mode: ทั้งระบบ → เซิร์ฟปลายทาง (All System → Target Guild)** กวาดสมาชิกที่พร้อมใช้งานจากทั่วทั้งฐานข้อมูล (ไม่จำกัด Source)
   - **Specific Mode: เฉพาะเซิฟดึงเซิฟ (Guild-to-Guild / Source → Target)** ดึงเฉพาะผู้ใช้ที่ผ่าน verification ตาม Source Guild ที่ระบุ
   - ออกแบบด้วย Strategy Pattern เพื่อให้เพิ่ม Mode ใหม่ในอนาคตได้ง่ายโดยไม่แตะ Core Worker
3. **Interactive Panel & 2-Phase Setup**:
   - หน้า Join Panel มี **แท็บเลือกโหมด (Dropdown)** และปุ่ม **[ 🚀 เริ่มดึงสมาชิก ]**
   - **Phase 1 (Base Setup)**: เลือกโหมดจาก Dropdown -> เปิด Modal ให้กรอกเฉพาะ Server ID พื้นฐาน (Mode 1: Target Guild / Mode 2: Source + Target Guild) -> บันทึกและนำข้อมูลมาอัปเดต Panel แสดงชื่อ/ID เซิร์ฟเวอร์จริง พร้อมตัวเลข Ready Count ที่คำนวณสด
   - **Phase 2 (Start Execution)**: กดปุ่ม `[ 🚀 เริ่มดึงสมาชิก ]` -> เปิด Modal ให้กรอกเฉพาะข้อมูลที่เหลือ (Requested Amount, Webhook URL) โดย **ห้ามถาม Server ID ซ้ำเด็ดขาด**
   - **Preflight Confirmation**: แสดง Embed สรุปข้อมูล (Mode, Target, Source, Ready Count, Amount, Webhook) แบบ Ephemeral พร้อมปุ่มเดียว **[ ✅ ยืนยันเริ่มดึงสมาชิก ]** (ไม่มีปุ่มยกเลิก หากไม่ต้องการเริ่มให้ Dismiss ปิดหน้าต่างไป)
4. **Target Membership Deduplication (Live Discord Query)**:
   - ไม่เก็บสถานะว่า user คนไหนอยู่ Target Guild ลงฐานข้อมูลอย่างถาวร (ป้องกันข้อมูล stale)
   - ก่อนเริ่ม Campaign ระบบจะดึงรายชื่อสมาชิกปัจจุบันจาก Discord Target Guild สดๆ แล้วหักคนที่อยู่ในเซิร์ฟเวอร์ออก เพื่อให้ได้ตัวเลข **Ready Count ที่แท้จริง**
5. **Joined Quota Completion**:
   - `requested_amount` คือเป้าหมาย **จำนวนสมาชิกที่ต้องเข้าเซิร์ฟเวอร์สำเร็จจริง (Joined Quota)**
   - หากมี Candidate ที่ Token ล้มเหลว หรือติด Error ระบบจะหยิบ Candidate คนถัดไปจากคิวมาเติมแทน จนกว่าจะครบ Quota หรือ Candidate ในระบบหมด
6. **Running State & Panel Protection**:
   - ขณะทำงาน ปุ่มเปลี่ยนเป็น `[ ⏳ กำลังดำเนินการ... ]` (Disabled) และปิดการใช้งาน Dropdown ชั่วคราว
   - แสดง Progress แบบ Real-time บน Panel Embed
   - ห้ามมีปุ่ม Stop, Pause, Cancel, หรือ Refresh
   - เมื่อจบงาน ปลดล็อกกลับมา พร้อมคงค่า Mode และ Server ID เดิมไว้บน Panel เพื่อให้กดเริ่มรอบถัดไปได้ทันที (แต่ต้องผ่าน Preflight ใหม่ทุกครั้ง)
7. **Webhook & Reporting Contract**:
   - รายงาน Batch ทุก 50 คน (แสดง Mention Pills `<@userId>` แบบ Silent Mention ไม่ส่งเสียงรบกวน พร้อมยอดสถานะใน Batch)
   - ส่ง **Final Summary Embed** ปิดท้ายเสมอเมื่อจบ Campaign (Requested, Joined, Already Member, Failed, Retries, Duration)
   - Webhook ล่มไม่ทำให้ Campaign หยุด; Systemic Error ส่งแจ้งเตือนที่ `ALERT_WEBHOOK_URL` กลาง
8. **Auto-Resume Process Restart Recovery**:
   - บันทึกสถานะงานลง SQLite (`join_campaign_jobs`, `join_campaign_items`, `join_campaign_panels`)
   - หากบอทรีสตาร์ตหรือโฮสต์รีบูต ระบบจะตรวจพบงานที่ค้างอยู่ตอน Startup แล้ว **Auto-Resume ทำงานต่อจากจุดเดิมอัตโนมัติ** โดยใช้ `campaign_id` เดิม รักษา progress และมุ่งสู่ Quota ที่เหลืออยู่
9. **Duplicate Panel Handling & Slash Options**:
   - หากรัน `/join-panel` ซ้ำในห้องเดิม ระบบจะลบ Panel เก่าทิ้งแล้วส่ง Panel ใหม่ต่อท้าย
   - คำสั่ง `/join-panel` รองรับ Optional Arguments: `[target_guild]` และ `[source_guild]` เพื่อสร้าง Panel ที่มีข้อมูลพร้อมใช้งานทันที หรือพิมพ์คำสั่งสั้นๆ เพื่อไปตั้งค่าผ่าน Dropdown/Modal
10. **Subsystem Architecture & Isolation**:
    - Subsystem โฟลเดอร์ `discord/features/joinCampaign/` แบ่งเป็น `modes/`, `ui/`, `handlers/`, `services/`, `worker/`, `recovery/`
    - Token lifecycle ใช้ `discord/core/oauthTokenManager.js` เป็น single authority เท่านั้น
    - ห้ามเก็บ Access Token / Refresh Token ลง SQLite
    - ห้ามแก้ไข `discord/systemProvider.js` หรือ `discord/systemProvider/*`
    - ห้ามกระทบ `discord.js-selfbot-v13` voice subsystem

---

# 2. Subsystem File & Folder Layout

```text
discord/features/joinCampaign/
├── index.js                     # Facade & Public API (getStatus, preflight, start, recovery, router)
├── config.js                    # Subsystem Config (ENV, limits, defaults, allowlist)
├── modes/                       # Extensible Campaign Modes Strategy
│   ├── modeRegistry.js          # Registry mapping modeId -> ModeStrategy
│   ├── allToTargetMode.js       # Strategy: ทั้งระบบ → เซิร์ฟปลายทาง (Default)
│   └── guildToGuildMode.js      # Strategy: เฉพาะเซิฟดึงเซิฟ (Source -> Target)
├── ui/                          # Discord UI Builders & Renderers
│   ├── panelBuilder.js          # Main Panel Embed & Components (Dropdown, Start Button, Live Progress)
│   ├── modals.js                # Discord Modals (Mode Setup Modal & Start Options Modal)
│   └── confirmationBuilder.js   # Ephemeral Preflight Confirmation Embed Builder
├── handlers/                    # Discord Interaction Handlers
│   ├── commandHandler.js        # /join-panel slash command execution & deduplication
│   ├── interactionRouter.js     # Routes selectMenu, button, modalSubmit by customId
│   └── modalSubmitHandler.js    # Handles setup modal & start modal submissions
├── services/                    # Core Business Logic & Orchestration
│   ├── joinCampaignService.js   # Campaign lifecycle orchestration, single active job lock
│   ├── preflightService.js      # Discord permission checks, live Target membership query, live ready count
│   └── candidateQueryService.js # Streams valid candidate tokens from MongoDB via central oauthTokenManager
├── worker/                      # Execution Worker & Logging
│   ├── campaignWorker.js        # Worker loop, Joined Quota tracking, JIT token refresh, rate limits
│   └── batchLogger.js           # Batch webhook sender (every 50 users, silent mentions) & Final Summary Embed
└── recovery/                    # Resilience & Startup Recovery
    └── startupRecovery.js       # Boot sweep: recovers SQLite jobs, releases expired leases, auto-resumes

database/sqlite/
├── migrations/
│   ├── 005_join_campaign.sql              # Initial schema: jobs, candidate items, panels
│   ├── 006_join_campaign_hardening.sql    # Recovery count and leasing indices
│   └── 007_join_campaign_clean_schema.sql # Drop webhook_url, add current_throughput, single active index
└── repositories/core/
    └── JoinCampaignRepository.js # SQLite Repository for all job checkpoints, items, and panel states

discord/index/
├── joinCampaignRoutes.js        # Updated routes (Read-only: /status, /history, /metrics; removed POST /start, /stop, /dry-run)
└── joinCampaignPage.js          # Updated HTML dashboard (Read-only Monitoring, Mode display, History table, Metrics cards)
```

---

# 3. Campaign Mode Strategy Contract (`modes/`)

แต่ละ Mode ต้อง Implement Strategy Interface เดียวกัน:

```js
class CampaignModeStrategy {
    get id()             // e.g. 'ALL_TO_TARGET', 'GUILD_TO_GUILD'
    get label()          // Thai display label for Dropdown
    get description()    // Description in Dropdown
    get emoji()          // Emoji icon
    
    // Schema of required base fields for Modal Phase 1
    getBaseSetupFields(currentState)
    
    // Validates inputs submitted from Phase 1 Modal
    validateBaseSetup(inputs, client)
    
    // Resolves candidate query criteria for MongoDB
    resolveCandidateFilter(baseConfig)
    
    // Calculates ready count taking into account Target Guild members from Discord
    async calculateReadyCount({ baseConfig, targetMemberIds, candidateQueryService, oauthTokenManager })
    
    // Formats the panel embed fields specific to this mode
    formatPanelEmbed({ embed, panelState, jobState })
}
```

### 3.1 Mode 1: `ALL_TO_TARGET` (Default Mode)
- **Label**: ทั้งระบบ → เซิร์ฟปลายทาง (ค่าเริ่มต้น)
- **Description**: ดึงสมาชิกที่พร้อมใช้งานทั้งหมดในฐานข้อมูลเข้าสู่เซิร์ฟเวอร์ปลายทาง
- **Base Modal Fields**:
  - `Target Guild ID` (Required)
- **Candidate Query**:
  - ดึงผู้ใช้ทั้งหมดที่มีสิทธิ์ `guilds.join` และมีสถานะ verification สมบูรณ์ โดยไม่จำกัด Source Guild

### 3.2 Mode 2: `GUILD_TO_GUILD` (Specific Mode)
- **Label**: เฉพาะเซิฟดึงเซิฟ (Source → Target)
- **Description**: ดึงเฉพาะสมาชิกที่ยืนยันตัวตนจากเซิร์ฟเวอร์ต้นทาง ไปยังเซิร์ฟเวอร์ปลายทาง
- **Base Modal Fields**:
  - `Source Guild ID` (Required)
  - `Target Guild ID` (Required)
- **Candidate Query**:
  - ดึงเฉพาะผู้ใช้ที่ผูกกับ `lastVerify.guildId === sourceGuildId` ที่มีสิทธิ์ `guilds.join`

---

# 4. User Experience & Interaction State Machine (`ui/` + `handlers/`)

```text
[/join-panel Command]
       │
       ▼
[Check Existing Panel in Channel] ──► Delete Old Message
       │
       ▼
[Render Fresh Join Panel] ──► Mode: ALL_TO_TARGET (Default)
  ├─ Dropdown: [ 🌐 ทั้งระบบ → ปลายทาง ] / [ 🎯 เฉพาะเซิฟดึงเซิฟ ]
  └─ Button: [ 🚀 เริ่มดึงสมาชิก ] (Active if Target set, or prompts setup)
       │
       ├─► (User changes Mode in Dropdown)
       │     └─► Discord triggers Modal: Phase 1 Setup
       │           ├─ Mode 1: Target Guild ID
       │           └─ Mode 2: Source Guild ID + Target Guild ID
       │           ▼
       │         (Submit Modal Phase 1)
       │           ├─ Validate IDs (Snowflake, Bot membership, Bot permissions)
       │           ├─ Query live Target Guild members from Discord
       │           ├─ Calculate Live Ready Count (Deduct existing members)
       │           ├─ Save Panel State to SQLite
       │           └─ Edit Panel Message: Display real Server Info & Live Ready Count!
       │
       └─► (User clicks [ 🚀 เริ่มดึงสมาชิก ])
             └─► Discord triggers Modal: Phase 2 Start Options
                   ├─ Requested Amount (Optional, blank = all ready)
                   └─ Campaign Webhook URL (Optional)
                   ▼
                 (Submit Modal Phase 2)
                   ├─ Run Preflight Revalidation (Fresh live check)
                   └─ Send Ephemeral Preflight Confirmation Embed
                         ├─ Mode, Target, Source (if applicable)
                         ├─ Live Ready Count, Target Quota (Requested Amount)
                         ├─ Campaign Webhook Status
                         └─ Button: [ ✅ ยืนยันเริ่มดึงสมาชิก ]
                               │
                               ▼ (Owner clicks Confirm)
                             [Transition to Active Campaign]
                               ├─ Acquire System-Wide Single Job Lock
                               ├─ Create Job in SQLite (Status: RUNNING)
                               ├─ Update Panel: Button becomes [ ⏳ กำลังดำเนินการ... ] (Disabled)
                               ├─ Update Panel: Dropdown becomes Disabled
                               ├─ Start Worker Loop in Background
                               └─ Ephemeral response: Campaign started!
```

---

# 5. Live Target Membership Check & Deduplication

เพื่อให้ตรงตามคำสั่งของเจ้าของระบบ:
1. **No Permanent Membership DB State**: ไม่เก็บตาราง mapping ถาวรว่า user คนไหนอยู่ server ไหนลง Database
2. **Authoritative Source of Truth**:
   - `MongoDB` = Authorized users, OAuth tokens, verification credentials.
   - `Discord Target Guild` = Current membership truth.
3. **Execution during Preflight & Panel Setup**:
   ```js
   async function getLiveTargetMemberIdSet(targetGuild) {
       // Target Guild members fetched via Discord.js / REST
       if (targetGuild.memberCount <= 1000) {
           const members = await targetGuild.members.fetch();
           return new Set(members.keys());
       }
       const memberIds = new Set();
       let after = '0';
       while (true) {
           const batch = await targetGuild.members.list({ limit: 1000, after });
           if (!batch || batch.size === 0) break;
           for (const [id] of batch) memberIds.add(id);
           if (batch.size < 1000) break;
           after = Array.from(batch.keys())[batch.size - 1];
       }
       return memberIds;
   }
   ```
4. **Candidate Ready Filtering**:
   - Candidate ถูกนับว่า Ready ก็ต่อเมื่อ `!targetMemberIds.has(candidate.userId)` และ Token ผ่านเกณฑ์ความพร้อม

---

# 6. Worker Execution & Joined Quota Engine (`worker/`)

### 6.1 Joined Quota Logic
- `requested_amount` = จำนวนสมาชิกที่ต้องเข้าร่วมสำเร็จจริง (เป้าหมาย `joined_count`)
- หากไม่ระบุ `requested_amount` = `ready_count` ทั้งหมด
- ลูปการทำงาน:
  ```js
  while (job.joined_count < job.requested_amount && candidatePool.hasNext()) {
      const candidate = await candidatePool.next();
      job.processed_count++;
      
      // JIT Token Refresh via central manager
      const token = await oauthTokenManager.getAccessToken({
          userId: candidate.userId,
          tokenField: candidate.tokenField
      });
      if (!token) {
          job.failed_count++;
          continue; // หยิบคนถัดไปมาเติม quota
      }
      
      const res = await discordApi.addMemberToGuild(job.target_guild_id, candidate.userId, token);
      if (res.status === 201) {
          job.joined_count++; // นับเข้า Quota สำเร็จ!
      } else if (res.status === 204) {
          job.already_count++; // อยู่ในเซิร์ฟแล้ว ไม่นับเข้า Joined Quota -> หยิบคนถัดไปมาเติม
      } else if (res.status === 429) {
          await handleRateLimitBackoff(res);
          // Retry candidate
      } else {
          job.failed_count++; // ล้มเหลวถาวร ไม่นับเข้า Joined Quota -> หยิบคนถัดไปมาเติม
      }
      
      // Batch Logging & Telemetry Debounce
      maybeLogBatch50(job, candidate);
      maybeUpdatePanelProgressDebounced(job);
      await checkpointToSQLite(job);
  }
  ```

### 6.2 Rate Limit & Throughput Safety
- Discord Guild Member Add REST API: 10 req / 10 sec per guild bucket.
- Worker base delay: `1,200ms - 1,500ms` per user request.
- Automatic 429 backoff reading `Retry-After` header + Token Coordinator integration.
- Bounded concurrency = 1 active worker thread per guild target.

### 6.3 Webhook Reporting
- **Batch 50**: เมื่อสะสมครบ 50 คน ส่ง webhook payload ที่มี mention pills `<@userId>` (ตั้งค่า `allowed_mentions: { parse: [] }` เพื่อเป็น silent mention ไม่ส่งเสียง ping) พร้อมสรุปจำนวน Joined, Already, Failed ในชุดนั้น
- **Final Summary Embed**: เมื่อจบงาน ส่ง Embed ปิดท้าย:
  - หัวข้อ: `[emoji] สรุปผลการดึงสมาชิก (Campaign Completed)`
  - โหมด: `ALL_TO_TARGET` หรือ `GUILD_TO_GUILD`
  - เป้าหมาย: Target Guild Name (ID)
  - จำนวนที่ขอ: `Requested Quota`
  - เข้าสำเร็จจริง: `Joined Count`
  - อยู่ในเซิร์ฟเวอร์แล้ว: `Already Member`
  - ล้มเหลว: `Failed Count`
  - ประมวลผลรวม: `Processed Count`
  - เวลาที่ใช้ทั้งหมด: `Duration (e.g. 4m 12s)`
  - สถานะสุดท้าย: `Completed` (หรือ `Quota Met`)

---

# 7. Database Persistence & Crash Shield Recovery (`database/` + `recovery/`)

### 7.1 SQLite Schema (Reflected with Migration 007 & Production Hardening)
```sql
CREATE TABLE IF NOT EXISTS join_campaign_jobs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'ALL_TO_TARGET',
    source_guild_id TEXT,
    source_guild_name TEXT,
    target_guild_id TEXT NOT NULL,
    target_guild_name TEXT,
    status TEXT NOT NULL, -- 'STAGE', 'RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL'
    requested_amount INTEGER NOT NULL,
    selected_amount INTEGER NOT NULL,
    joined_count INTEGER NOT NULL DEFAULT 0,
    already_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    processed_count INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    current_concurrency INTEGER NOT NULL DEFAULT 8,
    current_throughput REAL NOT NULL DEFAULT 0.0,
    recovery_count INTEGER NOT NULL DEFAULT 0,
    candidate_cursor TEXT,
    last_error TEXT,
    started_by_user_id TEXT,
    started_by_channel_id TEXT, -- เพิ่มใน migration 008 สำหรับ panel reconnect และ recovery
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
    -- หมายเหตุ: migration 007 ถอดคอลัมน์ webhook_url ออกจาก SQLite อย่างถาวรเพื่อความปลอดภัย
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_join_campaign_single_active 
ON join_campaign_jobs((1))
WHERE status IN ('RUNNING', 'STAGE', 'INTERRUPTED'); -- อัปเดตใน migration 009 ให้ครอบคลุม INTERRUPTED

CREATE TABLE IF NOT EXISTS join_campaign_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_field TEXT NOT NULL DEFAULT 'oauth',
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'joined', 'already_member', 'failed'
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    leased_until INTEGER NOT NULL DEFAULT 0,
    processing_started_at INTEGER, -- เพิ่มใน migration 009 สำหรับ crash consistency tracking
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(campaign_id, user_id)
);

CREATE TABLE IF NOT EXISTS join_campaign_panels (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'ALL_TO_TARGET',
    source_guild_id TEXT,
    target_guild_id TEXT,
    active_job_id TEXT, -- เพิ่มใน migration 006 สำหรับ tracking active campaign บน panel
    last_ready_count INTEGER,
    last_status_summary TEXT,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_join_jobs_status ON join_campaign_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_join_items_claim ON join_campaign_items(campaign_id, status, leased_until);
```

### 7.2 Crash Window 201/204 Reconciliation & Idempotent Resume
หากบอทแครชหลังจาก Discord REST API รับการเข้าเซิร์ฟเวอร์เรียบร้อยแล้ว (201 Created หรือ 204 Already Member) แต่ระบบแครชก่อน SQLite transaction จะ commit สถานะ:
1. ตอนที่ `runStartupRecovery` ทำงาน Item ดังกล่าวจะหมดอายุ lease (`leased_until` หมดอายุ) และถูกคืนสถานะเป็น `pending`
2. เมื่อ worker ทำการ resume งานต่อ ระบบจะตรวจสอบสมาชิกปัจจุบันของ Target Guild (Live target query หรือ Discord API `Add Guild Member` รอบใหม่):
   - หากผู้ใช้เข้าเซิร์ฟเวอร์ไปแล้ว Discord จะตอบกลับ **204 No Content (Already Member)**
   - Worker จะตรวจจับสถานะ 204 และบันทึก item เป็น `already_member` ทันที โดย**ไม่เพิ่ม** `joined_count` ซ้ำสอง
    - ระบบจะหยิบ candidate คนถัดไปมาประมวลผล เพื่อให้เข้าตาม Joined Quota ที่เหลืออยู่ได้อย่างแม่นยำ

### 7.3 Boot Recovery & Startup Safety
1. **Always-Available Campaign Flow**:
   - `/join-panel`, panel interactions, preflight, worker และ startup recovery ไม่มี feature toggle; ยังคงตรวจ Owner, permission, guild และเงื่อนไขการทำงานตามปกติ
2. **Fail-Closed Target Guild Resolution**:
   - หาก Target Guild ไม่อยู่ใน Discord.js cache ระบบจะทำการ fetch สดจาก Discord API
   - หาก fetch ไม่สำเร็จหรือไม่พบบอทใน Target Guild Worker จะหยุดทันที ปรับสถานะงานเป็น `FAILED` และไม่ทำการยิงเพิ่มสมาชิก
3. **Bounded 429 Rate-Limit Retry**:
   - เคารพ header `Retry-After` สดจาก Discord ได้สูงสุดถึง 5 นาที (ไม่ตัดเหลือ 10 วินาทีแบบเดิม)
   - จำกัดจำนวนครั้งการ retry เมื่อติด 429 ไม่เกิน `JOIN_CAMPAIGN_MAX_RATE_LIMIT_RETRIES` (ค่าเริ่มต้น 3 ครั้ง) หากเกินจะปรับสถานะเป็น `failed` (`rate_limited`) เพื่อให้ Campaign จบงานได้ตามปกติ ไม่ค้าง loop
4. **Startup Recovery Failure Handling**:
   - หาก worker resume ล้มเหลว (เช่น Target Guild ถูกลบไประหว่างบอทดับ) `runStartupRecovery` จะบันทึกสถานะงานเป็น `FAILED` พร้อมบันทึก `lastError` และ `completedAt` และคืนค่า `recovered: false` ป้องกันงานค้างในสถานะ `RUNNING` ตลอดกาล
5. **Fail-Closed Confirmation Freshness**:
   - `confirmAndStartCampaign` ตรวจสอบสมาชิกสดจาก Discord REST API ทันทีก่อนเริ่มงาน
   - หาก fetch สมาชิกล้มเหลว หรือไม่พบสมาชิกพร้อมดึง (`freshReadyCount === 0`) จะปฏิเสธการเริ่มงานและไม่สร้าง Job ลงฐานข้อมูล
6. **Interruptible Shutdown (`_interruptibleSleep`)**:
   - Worker รองรับสัญญาณ Graceful Shutdown ทันที แม้อยู่ระหว่าง sleep backoff 429 โดยปลุกตัวภายใน <100ms เพื่อบันทึกสถานะ `INTERRUPTED`
7. **Quota vs Server Full Precedence**:
   - เมื่อจำนวนสมาชิกที่ดึงได้ครบโควตา (`joinedCount >= requestedQuota`) สถานะงานจะถูกตัดสินเป็น `COMPLETED` เสมอ แม้จะมี concurrent task ได้รับ code 30005 ก็ตาม

---

# 8. Owner Dashboard Alignment (Read-Only Monitoring)

เพื่อให้สอดคล้องกับคำสั่งของเจ้าของระบบ:
- **Discord = Control Plane**
- **Dashboard (`/join-campaign`) = Read-only Monitoring & History**
- ถอดปุ่ม `Start`, `Stop`, `Pause`, `Dry-run` ออกจาก UI
- ถอด POST routes: `/api/join-campaign/start`, `/api/join-campaign/stop`, `/api/join-campaign/dry-run`
- คงไว้และปรับปรุง GET routes:
  - `GET /api/join-campaign/status`: สถานะ Real-time ของ Campaign ที่กำลังวิ่ง (Mode, Target, Source, Progress, Throughput)
  - `GET /api/join-campaign/history`: ประวัติ Campaign ย้อนหลัง ดึงจาก SQLite
  - `GET /api/join-campaign/metrics`: สถิติภาพรวม (Total Campaigns, Total Joined, Success Rate)
- หน้าเว็บแสดงตาราง History สวยงาม และแสดง Card สถิติเรียลไทม์

---

# 9. Acceptance Criteria & Definition of Done

1. `/join-panel` โพสต์ได้ในช่องแชท, หากใช้ซ้ำในห้องเดิมจะลบอันเก่าทิ้งและส่งอันใหม่
2. รองรับ Option `/join-panel [target_guild] [source_guild]`
3. แถบ Dropdown สามารถเลือกสลับระหว่าง `ทั้งระบบ → ปลายทาง` และ `เฉพาะเซิฟดึงเซิฟ` ได้
4. การเลือกโหมดเปิด Modal Phase 1 กรอก Server ID -> Panel อัปเดตแสดงข้อมูลจริงและคำนวณ Ready Count สด
5. กด `[ 🚀 เริ่มดึงสมาชิก ]` เปิด Modal Phase 2 ถามเฉพาะจำนวนและ Webhook (ไม่ถาม Server ID ซ้ำ)
6. Preflight ตรวจสอบสมาชิกใน Target Guild สดๆ จาก Discord และหักคนที่อยู่แล้วออก
7. Confirmation Embed เป็น Ephemeral มีปุ่มเดียว `[ ✅ ยืนยันเริ่มดึงสมาชิก ]`
8. ระหว่างวิ่ง ปุ่มเป็น `[ ⏳ กำลังดำเนินการ... ]` (Disabled) และ Dropdown Disabled
9. รันตาม `Joined Quota` จนกว่าคนเข้าสำเร็จจะครบจำนวนที่ขอ หรือคนในระบบหมด
10. Webhook ส่ง Batch ทุก 50 คนแบบ silent mention pills และส่ง Final Summary Embed เมื่อจบ
11. เมื่อจบงาน Panel คงค่า Server ID และ Mode เดิมไว้ พร้อมสถานะ "เสร็จสิ้นแล้ว"
12. หากเกิด Process Restart งานที่ค้างอยู่จะถูกกู้คืนและรันต่ออัตโนมัติ (Auto-Resume)
13. หน้าเว็บ Owner Dashboard เป็น Read-only แสดง Live Status และ History ไม่มีปุ่มสั่งงาน
14. ผ่าน `npm run check` (9 gates) และ `npm test` ทั้งหมด 100%