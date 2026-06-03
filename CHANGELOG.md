# CHANGELOG

บันทึกการเปลี่ยนแปลงสำคัญของโปรเจกต์นี้ โดยเน้นสิ่งที่แก้ใน branch `dashboard-public-foundation-fix` และงานที่คุย/ทำร่วมกันในรอบนี้

รูปแบบนี้อิงแนวทาง Keep a Changelog แบบอ่านง่าย: แยกเป็น Added / Changed / Fixed / Security / Validation / Notes

---

## [Unreleased] - 2026-06-03

### Added

- เพิ่มไฟล์ `CHANGELOG.md` เพื่อเก็บประวัติการแก้ไขโปรเจกต์อย่างเป็นระบบ
- เพิ่ม/ปรับเอกสารพื้นฐานของโปรเจกต์ที่ใช้เป็นบริบทก่อนเริ่มงาน ได้แก่:
  - `README.md`
  - `CONTEXT.md`
  - `AGENTS.md`
  - `.gitignore`
  - `.env.example`
- เพิ่ม foundation สำหรับ Dashboard Public ของแอดมินเซิร์ฟอื่นใน branch นี้
- เพิ่ม/ปรับระบบ dashboard ฝั่ง public guild admin เพื่อให้ใช้ตั้งค่าระบบยืนยันตัวตนและดูข้อมูลเซิร์ฟเวอร์ได้ละเอียดขึ้น
- เพิ่ม route/helper ฝั่ง dashboard public เพื่อรองรับ compatibility ของ admin session
- เพิ่มระบบ metadata ของ voice session เพื่อเก็บและแสดงข้อมูลบัญชีที่เอาไปออน ได้แก่:
  - `accountId`
  - `accountUsername`
  - `accountGlobalName`
  - `accountTag`
  - `accountAvatar`
  - `voiceName`
  - `guildIcon`
  - `tokenHash`
- เพิ่ม helper สำหรับ voice/session identity ใน `discord/sessionManager.js` เช่น:
  - `hashToken`
  - `buildVoiceSessionId`
  - `findActiveVoiceSessionByTokenGuild`
  - `countActiveSessionsByTokenHash`
  - `getSessionToken`
  - `getSessionTokenHash`
  - `getSessionByTokenGuild`
  - `hasActiveTokenGuildSession`
  - `getActiveSessionsByTokenHash`
  - `getActiveSessionsByGuild`
  - `getSessionShortId`
- เพิ่ม compatibility exports ใน `discord/sessionManager.js` เพื่อไม่ให้ไฟล์เก่าพัง:
  - `lockSession`
  - `unlockSession`
  - `addReconnect`
  - `clearReconnect`
  - `getToken`
- เพิ่ม `pauseSession` กลับเข้า `sessionManager` เพื่อรองรับ flow เดิมที่ไฟล์อื่นอาจเรียกใช้งาน
- เพิ่ม `setLogChannelMap` กลับเข้า `sessionManager` เพื่อรองรับ `/setup-log`
- เพิ่ม `getAllWhitelist` กลับเข้า `sessionManager` เพื่อรองรับหน้าเว็บ whitelist และคำสั่ง `/whitelist list`
- เพิ่ม export `systemMetrics` กลับเข้า `sessionManager` เพื่อรองรับไฟล์เดิมที่เรียก `sessionManager.systemMetrics`
- เพิ่ม serializer ฝั่ง `discord/index/server.js` สำหรับส่งข้อมูล voice session แบบปลอดภัยขึ้น โดยไม่ส่ง token/tail/hash ออกไปใน API ปกติ
- เพิ่มหน้า Dashboard voice/session detail แบบใหม่ใน `discord/index/views.js`
- เพิ่มปุ่มดู Token ผ่าน PIN แทนการโชว์ท้าย Token ในหน้า session list/status

### Changed

- เปลี่ยน logic ระบบออนช่องเสียงจากเดิมที่ token หนึ่งถูกมองว่า active ได้แค่ชุดเดียว ให้รองรับการใช้งานตาม requirement ใหม่:
  - 1 token สามารถออนได้หลายเซิร์ฟเวอร์พร้อมกัน
  - 1 token ไม่ควรเข้าได้หลายช่องในเซิร์ฟเวอร์เดียวกันพร้อมกัน
  - หลาย token สามารถเข้าเซิร์ฟเวอร์เดียวกันหรือช่องเสียงเดียวกันได้โดยไม่ชนกัน
- ปรับ `discord/voiceWorker.js` ให้ใช้ client pool แยกตาม `tokenHash`
- ปรับ `joinVoiceChannel` ให้ใช้ `group: ${client.user.id}:${guild.id}` เพื่อลดโอกาส connection registry ชนกันเมื่อหลาย token เข้า guild/channel เดียวกัน
- ปรับ logic stop/start session เพื่อแก้เคสหยุดแล้ว state ค้างจนเริ่ม token เดิมในอีกเซิร์ฟเวอร์ไม่ได้
- ปรับหน้า status ใน `discord/commands.js`:
  - เอา `Token (ท้าย)` ออกจาก embed
  - แสดงบัญชีที่ออนแทน owner
  - แสดง avatar ของบัญชีที่ออน
  - แสดงชื่อช่องเสียง `voiceName` พร้อม mention ช่องเสียง
  - แสดง reconnect count
- ปรับข้อความ error ของ voice start ให้รองรับ `ALREADY_ACTIVE_IN_GUILD`
- ปรับ dashboard API `/api/status` และ `/api/session/:sessionId` ให้ส่งข้อมูลบัญชี/ช่องเสียงแทน token tail
- ปรับ `discord/index/views.js`:
  - ไม่โชว์ `tokenTail` หรือ token masked ใน session list แล้ว
  - session list แสดงบัญชีที่ออน, avatar, server, voice channel, owner, status
  - session detail แสดงข้อมูลบัญชีที่ออนและ token health
  - การดู token ต้องกดปุ่มและใส่ PIN
- ปรับหน้า docs ใน dashboard ให้มีคำอธิบายระบบ voice/session ใหม่
- ปรับหน้า settings ให้ยังคงรองรับ Natural Blink และ Auto Deaf โดยไม่ลบฟังก์ชันเดิม

### Fixed

- แก้ปัญหา `clearAllSessions()` ซ้ำใน `sessionManager.js`
- แก้ missing export ที่ทำให้ runtime อาจพัง:
  - `systemMetrics`
  - `getAllWhitelist`
  - `setLogChannelMap`
- แก้ปัญหา compatibility กับไฟล์เดิมที่ยังเรียกชื่อเก่า เช่น:
  - `sessionManager.getToken`
  - `sessionManager.lockSession`
  - `sessionManager.unlockSession`
  - `sessionManager.addReconnect`
  - `sessionManager.clearReconnect`
- แก้ status embed ที่ยังโชว์ท้าย token
- แก้ dashboard API ที่ยังส่ง `tokenTail` ใน response ปกติ
- แก้ UI dashboard ที่ยังโชว์ token masked ใน session list
- แก้ voice status หลัง stop session ให้ render ด้วย embed รูปแบบใหม่แทนรูปแบบเก่า
- แก้ flow ที่อาจทำให้ token เดิมถูก block ทั้งระบบ ทั้งที่ requirement คือ block เฉพาะ token เดิมใน guild เดิม

### Security / Privacy

- เอา token tail ออกจาก UI/status/API ปกติ เพื่อลดการเปิดเผยข้อมูล token โดยไม่จำเป็น
- ยังคงระบบ reveal token ไว้สำหรับ admin แต่ต้องผ่าน PIN
- `/api/reveal-token` และ `/api/reveal-all-tokens` ยังใช้ lockout/PIN guard เดิม
- `/api/status` และ `/api/session/:sessionId` ไม่ส่ง token, encrypted token, tokenTail, tokenHash ใน serializer ปกติ
- เพิ่ม/คงการแจ้งเตือนผ่าน webhook สำหรับบางเหตุการณ์ เช่น token mismatch, intrusion, token invalid, guild approval/kick

### Validation

- ตรวจด้วย `node --check` แล้วผ่านทุกไฟล์หลักที่แก้ในรอบ voice/dashboard ได้แก่:
  - `discord/sessionManager.js`
  - `discord/voiceWorker.js`
  - `discord/commands.js`
  - `discord/index/server.js`
  - `discord/index/views.js`
- เช็ก branch เทียบกับ `main` แล้ว branch `dashboard-public-foundation-fix` นำหน้า `main` และไม่ได้ตามหลัง `main` ในช่วงที่ตรวจ
- เช็ก keyword สำคัญเกี่ยวกับงาน voice/session แล้วพบว่าจุด runtime compatibility ที่เจอก่อนหน้าได้รับการแก้แล้ว

### Manual test checklist ก่อน merge/deploy

- ทดสอบ 1 token ออนเซิร์ฟเวอร์ A ได้
- ทดสอบ token เดิมออนเซิร์ฟเวอร์ B พร้อมกันได้
- ทดสอบ token เดิมพยายามออนอีกช่องในเซิร์ฟเวอร์ A แล้วต้องถูกกันด้วย `ALREADY_ACTIVE_IN_GUILD`
- ทดสอบหลาย token เข้าเซิร์ฟเวอร์เดียวกันพร้อมกัน
- ทดสอบหลาย token เข้า voice channel เดียวกันพร้อมกัน
- ทดสอบกด stop แล้ว token เดิมสามารถ start ใหม่ในอีกเซิร์ฟเวอร์ได้ ไม่ค้างว่า active
- ทดสอบปุ่ม status ใน Discord ต้องไม่โชว์ท้าย token
- ทดสอบหน้า dashboard ต้องไม่โชว์ท้าย token/token masked ใน session list
- ทดสอบปุ่มดู Token ต้องขอ PIN และแสดง Token เฉพาะช่วงเวลาที่ unlock
- ทดสอบ `/setup-log` ว่ายังสร้าง/บันทึก log channel map ได้
- ทดสอบ `/whitelist list` และหน้า `/whitelist` ว่ายังโหลดข้อมูลได้
- ทดสอบหน้า `/settings` ว่ายังบันทึก Natural Blink และ Auto Deaf ได้
- ทดสอบหน้า `/session/:sessionId` ว่าสั่ง stop session ได้จริง

### Notes

- งานรอบนี้มีการ rewrite บางไฟล์ใหญ่ โดยเฉพาะ `discord/index/views.js` และ `discord/index/server.js` เพื่อปรับ dashboard และ privacy ของ token
- จุดที่ตั้งใจไม่ลบ:
  - ระบบ reveal token ผ่าน PIN
  - Natural Blink
  - Auto Deaf
  - Dashboard settings
  - Commands toggle
  - Whitelist
  - Approved guilds
  - Logs / Voice logs
  - Session detail
  - Audit log setup
- ยังไม่ควร merge เข้า `main` จนกว่าจะผ่าน manual test checklist ด้านบน
