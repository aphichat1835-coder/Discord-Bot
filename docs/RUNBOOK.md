# Phomueangtai Bot Runbook

เอกสารนี้ใช้สำหรับไล่ปัญหาหน้างานโดยไม่เปิดเผย secret, token, webhook URL หรือข้อมูล owner-only ภายในระบบ

## RAM สูงหรือ process ใกล้ OOM

1. เปิด owner dashboard แล้วเช็ค `/api/diagnostics`
2. ดู `memoryMonitor.lastSnapshot`, `voiceWorker.clientPool`, `voiceWorker.loginQueue`, `voiceWorker.recoveryQueue`, `naturalTimers`, `autoDeafTimers`
3. ถ้า session ค้างเยอะ ให้เช็ค `sessions.byState` และหน้า session list ว่ามี `failed/stopped/ghost suspected` หรือไม่
4. ปรับ env ได้โดยไม่แก้โค้ด:
   - `MEMORY_WARN_MB`
   - `MEMORY_CRITICAL_MB`
   - `MEMORY_CRITICAL_ROUNDS`
   - `MEMORY_CRITICAL_MODE=cleanup_only|graceful_exit`
   - `VOICE_LOG_MAX`
5. ถ้า memory เพิ่มเร็วหลัง Discord reconnect ให้ตรวจ queue และ cooldown map ก่อน restart

## Voice session ค้าง

1. เช็ค `/api/diagnostics` และหน้า Voice Worker Diagnostics
2. ดู `loginQueue`, `recoveryQueue`, `clientPool`, `tokenLoginCooldowns`, `naturalTimers`, `autoDeafTimers`
3. ถ้า queue เต็ม ผู้ใช้จะเห็นระบบโหลดหนักแทนการสะสม queue ไม่จำกัด
4. ใช้ owner dashboard ปิด session ที่ไม่ต้องการ แล้วดูว่าจำนวน timer ลดตามหรือไม่
5. ถ้า session เป็น `stop_cleanup_failed` ให้ตรวจ permission/voice connection ก่อนลบข้อมูลเอง

## IP reveal หรือ verification ผิดปกติ

1. เช็ค Dashboard Public `/health` ว่า database/config พร้อมหรือ degraded
2. เช็ค env:
   - `TRUST_PROXY`
   - `TRUST_PROXY_HOPS`
   - `ENABLE_CF_IP_HEADER`
   - `IP_LOOKUP_ENABLED`
   - `IP_LOOKUP_API_BASE_URL`
3. ถ้า external lookup ช้า/ล่ม ระบบมี circuit breaker:
   - `IP_LOOKUP_CIRCUIT_FAIL_THRESHOLD`
   - `IP_LOOKUP_CIRCUIT_OPEN_MS`
4. ถ้าข้อมูล sensitive ถูกซ่อน ให้ดู owner approval state ก่อนสรุปว่าข้อมูลหาย
5. `cf-connecting-ip` จะถูกเชื่อเฉพาะเมื่อเปิดทั้ง `ENABLE_CF_IP_HEADER=true` และ `TRUST_PROXY=true`

## Dashboard Public session หรือ retention ผิดปกติ

1. เช็ค Dashboard Public `/health`
2. ดู `sessionCookie.policy`, `sessionCookie.maxAgeMs`, และ `retention.lastSummary`
3. ค่าเริ่มต้นของ admin session คือ absolute expiry 24 ชั่วโมง:
   - `ADMIN_SESSION_MAX_AGE_MS`
   - `ADMIN_SESSION_ROLLING=false`
4. ก่อน cleanup จริง สามารถเรียก internal dry-run:
   - `GET /internal/retention/dry-run`
   - ต้องส่ง `x-internal-secret`
5. Retention จะ soft-delete เฉพาะข้อมูล guild-scoped เช่น verify log และ IP identity link; `OAuthUser` เป็น account-level จึงไม่ลบทั้งบัญชีเพราะ guild เดียวหมด retention

## Restore พังหรือเสี่ยง

1. รัน `/restore server_id:<id> dry_run:true` ก่อน restore จริงเสมอ
2. อ่านแผน restore:
   - role/channel ที่จะสร้าง
   - ชื่อซ้ำหรือ ambiguous
   - permission overwrites ที่ map ไม่ได้
3. ตรวจ role hierarchy ของบอทก่อนกด confirm
4. ถ้า restore timeout ระบบจะหยุดหลังเวลาป้องกันเพื่อเลี่ยง interaction/runtime ค้าง
5. Backup ไม่ restore ข้อความ, thread, webhook หรือ invite

## Token หรือ secret หลุด

1. Revoke/rotate token หรือ secret ที่เกี่ยวข้องใน provider ต้นทางทันที
2. เปลี่ยน host environment variables
3. Restart services ทั้งสองตัว
4. ตรวจ log ว่าไม่มี secret ถูกพิมพ์ออกมา
5. ถ้าเป็น Discord bot token ให้ regenerate ใน Discord Developer Portal และ redeploy

## Audit log หายหรือส่งไม่ออก

1. เช็ค log channel mapping ใน dashboard หรือ `/setup-log`
2. เช็ค permission ของบอทใน channel ปลายทาง
3. ดู `/api/diagnostics.audit`:
   - `auditSendFailed`
   - `auditDroppedQueueFull`
   - `auditDroppedCircuitOpen`
   - `lastAuditSendError`
4. ถ้า channel หายหรือ permission ผิด ระบบจะพักส่งชั่วคราวด้วย circuit breaker เพื่อลด spam
