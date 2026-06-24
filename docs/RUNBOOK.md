# Phomueangtai Bot Runbook

เอกสารนี้ใช้สำหรับไล่ปัญหาหน้างานโดยไม่เปิดเผย secret, token, webhook URL หรือข้อมูล owner-only ภายในระบบ

## RAM สูงหรือ process ใกล้ OOM

เรื่องนี้เป็น production-critical เพราะระบบออนช่องเสียงตั้งใจให้ session อยู่ได้นานเป็นสัปดาห์หรือเป็นเดือน ห้ามสรุปว่าแก้แล้วจากการ restart อย่างเดียว ต้องดูว่า counters คงที่และ heap ไม่โตต่อเนื่องหลัง boot, auto-resume, reconnect, dashboard traffic, audit traffic, และ verification traffic

1. เปิด owner dashboard แล้วเช็ค `/api/diagnostics`
2. ดู `memoryMonitor.lastSnapshot`, `memoryMonitor.lastSnapshot.v8`, `voiceWorker.clientPool`, `voiceWorker.selfClientCaches`, `voiceWorker.selfClientListeners`, `discordCaches`, `discordListeners`, `activeHandles`, `voiceWorker.loginQueue`, `voiceWorker.recoveryQueue`, `naturalTimers`, `autoDeafTimers`
3. ถ้า session ค้างเยอะ ให้เช็ค `sessions.byState`, `sessions.diagnostics`, และหน้า session list ว่ามี `failed/stopped/ghost suspected` หรือไม่
4. ปรับ env ได้โดยไม่แก้โค้ด:
   - `MEMORY_WARN_MB`
   - `MEMORY_CRITICAL_MB`
   - `MEMORY_CRITICAL_ROUNDS`
   - `MEMORY_TREND_MAX`
   - `MEMORY_CRITICAL_MODE=cleanup_only|graceful_exit`
   - `VOICE_LOG_MAX`
   - `DISCORD_MESSAGE_CACHE_MAX`
   - `DISCORD_MESSAGE_SWEEP_INTERVAL_SEC`
   - `DISCORD_MESSAGE_SWEEP_LIFETIME_SEC`
   - `VOICE_SELF_MESSAGE_CACHE_MAX`
   - `VOICE_SELF_MEMBER_CACHE_MAX`
   - `VOICE_SELF_USER_CACHE_MAX`
   - `VOICE_SELF_CACHE_CLEANUP_TTL_MS`
   - `RATE_LIMIT_MAX_BUCKETS`
   - `COMMAND_COOLDOWN_MAX_USERS`
   - `PIN_ATTEMPT_MAX_KEYS`
   - `ROTATE_MESSAGES_MAX`
   - `SESSION_LOAD_MAX`
   - `APPROVED_GUILDS_LOAD_MAX`
   - `PENDING_GUILDS_LOAD_MAX`
   - `WHITELIST_LOAD_MAX`
   - `BOT_SETTINGS_LOAD_MAX`
   - `PANEL_STATES_LOAD_MAX`
   - `OAUTH_CONNECTIONS_MAX`
   - `OAUTH_GUILDS_MAX`
   - `OAUTH_MEMBER_ROLES_MAX`
   - `OAUTH_USER_SUMMARY_MAX`
   - `ADMIN_GUILDS_SESSION_MAX`
   - `DISCORD_API_RESPONSE_MAX_BYTES`
   - `DISCORD_API_BODY_MAX_BYTES`
   - `DISCORD_API_ROLE_MAX`
   - `DISCORD_API_CHANNEL_MAX`
   - `DISCORD_API_PERMISSION_OVERWRITE_MAX`
   - `INTERNAL_OVERVIEW_GUILDS_MAX`
   - `RETENTION_CONFIG_SCAN_MAX`
   - `DEVICE_DUPLICATE_LOOKUP_MAX`
5. ถ้า memory เพิ่มเร็วหลัง Discord reconnect ให้ตรวจ queue, cooldown map, selfbot cache, main Discord cache, และ active handles ก่อน restart
6. ถ้าเพิ่ม RAM ใน Render แล้ว ต้องยังเก็บ snapshot หลัง auto-resume และ snapshot หลังรันต่อเนื่อง เพื่อยืนยันว่า RAM ไม่โตแบบ leak

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
2. ดู `memory`, `ipLookup`, `sessionCookie.policy`, `sessionCookie.maxAgeMs`, และ `retention.lastSummary`
3. ค่าเริ่มต้นของ admin session คือ absolute expiry 24 ชั่วโมง:
   - `ADMIN_SESSION_MAX_AGE_MS`
   - `ADMIN_SESSION_ROLLING=false`
4. สำหรับ diagnostics ภายใน ใช้:
   - `GET /internal/diagnostics`
   - ต้องส่ง `x-internal-secret`
5. ก่อน cleanup จริง สามารถเรียก internal dry-run:
   - `GET /internal/retention/dry-run`
   - ต้องส่ง `x-internal-secret`
6. Retention จะ soft-delete เฉพาะข้อมูล guild-scoped เช่น verify log และ IP identity link; `OAuthUser` เป็น account-level จึงไม่ลบทั้งบัญชีเพราะ guild เดียวหมด retention

## Long-running voice session checklist

ใช้ checklist นี้หลัง deploy หรือหลัง Render restart ทุกครั้งที่มี session auto-resume:

1. รอ auto-resume จบ แล้วเก็บ `[MEMORY] Snapshot after-auto-resume`
2. เช็คว่า `sessions.total`, `sessions.runnable`, `voiceWorker.clientPool`, `naturalTimers`, และ `autoDeafTimers` ตรงกับจำนวน session ที่ควรออนจริง
3. เช็คว่า `sessions.lastLoad.truncated` เป็น `false` หรือถ้าเป็น `true` ให้เพิ่ม `SESSION_LOAD_MAX` หลังตรวจว่าจำนวน session ที่ active/recoverable ถูกต้องจริง
4. เช็คว่า `voiceWorker.selfClientCaches.messages/users/guildMembers` ไม่โตต่อเนื่องโดยไม่มีเหตุผล
5. เช็คว่า `discord.messages`, `discord.users`, และ `discord.guildMembers` ไม่โตต่อเนื่องหลัง idle
6. เช็คว่า `audit.sendQueues`, `audit.auditCircuit`, `audit.warnThrottles`, `requestCounters.buckets`, `requestCounters.pinAttempts.tracked`, `requestCounters.revealAttempts.tracked`, และ `ipLookup.cacheSize` อยู่ในกรอบ
7. เช็ค Dashboard Public `/health` หรือ `/internal/diagnostics` ว่า `discordApi.inFlight`, `discordApi.responseTooLarge`, `discordApi.requestBodyTooLarge`, `ipLookup.cacheSize`, และ session settings อยู่ในกรอบ
8. หลัง 30-60 นาที ให้เทียบ `memoryMonitor.trend` กับ snapshot แรก ถ้า heap โตแต่ counters คงที่ ให้เก็บ `v8`, `activeHandles`, และ listener counts ก่อน restart
9. หลัง 24 ชั่วโมง ให้เทียบ RSS/heap อีกครั้งก่อนสรุปว่าระบบนิ่ง

ถ้า export response จาก `/api/diagnostics` เป็นไฟล์ JSON แล้ว สามารถเช็ค trend แบบไม่เปิดเผย token หรือ raw IP ได้ด้วย:

```bash
npm run check:memory-trend < diagnostics.json
```

ปรับ threshold ได้ผ่าน env เช่น `MEMORY_TREND_HEAP_GROWTH_MB`, `MEMORY_TREND_RSS_GROWTH_MB`, `MEMORY_TREND_LISTENER_GROWTH`, `MEMORY_TREND_HANDLE_GROWTH`, และ `MEMORY_TREND_CACHE_GROWTH`

`npm run check` จะรัน static memory guard ด้วย เพื่อกัน regression เช่น raw unbounded panel/approved-guild queries และ Discord API response buffering ที่ไม่มี byte cap

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
5. เปิด `/audit-logs` จาก owner dashboard เพื่อดู record ที่บันทึกไว้ใน audit storage
6. ดู `/api/audit/dead-letters` เพื่อแยกเคส `missing_log_channel`, send failure, หรือ queue/circuit issue
7. ถ้าต้องทดสอบ reconciler ให้เปิด `AUDIT_RECONCILER_ENABLED=true` เฉพาะ private test server ก่อน production

## Dependency audit หลังอัปเกรด package

1. เช็ค baseline production/high severity:
   - `npm audit --audit-level=high`
   - `npm --prefix dashboard-public audit --audit-level=high`
   - `npm --prefix dashboard-public audit --omit=dev`
2. ถ้า `npm --prefix dashboard-public audit` แบบไม่ใส่ level แจ้ง moderate จาก Jest chain ให้แยกก่อนว่าเป็น dev dependency หรือ production dependency
3. อย่าใช้ `npm audit fix --force` อัตโนมัติ ถ้ามันเสนอ downgrade หรือ major migration ที่กระทบ test runner/runtime
4. `discord.js` ยังอยู่ v13 ตาม owner decision และ Mongoose ยังอยู่ v8 เว้นแต่มีงาน migration แยกชัดเจน
