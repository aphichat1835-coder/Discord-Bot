# 🐛 Bug Report — Phomueangtai Enterprise v4.0.1
## วันที่วิเคราะห์: 2026-05-24
## วิเคราะห์โดย: เปรียบเทียบ index.js เดิม (3,098 + 2,632 บรรทัด) กับโครงสร้าง modular ใหม่

---

## ⛔ BUG #1 — FATAL — events.js: interactionCreate brace structure ผิด

**ไฟล์:** `discord/index/events.js`
**บรรทัด:** 113–153
**ความรุนแรง:** FATAL — บอท crash หรือ slash command ทุกตัวไม่ทำงาน

**สาเหตุ:**
AI ที่ refactor โค้ดใส่ `if (disabledCommands.has(...))` ซ้ำสองชั้น แล้วโค้ด cooldown
และ `handleInteraction` ตกอยู่ใน if-block ชั้นนอก ทำให้ทั้งหมดทำงานเฉพาะตอน
command ถูก **ปิด** เท่านั้น — command ที่เปิดปกติไม่มีทางถูกเรียก

**โครงสร้างที่ผิด:**
```
if (disabled) {           ← เปิด OUTER if (บรรทัด 114)
    const reply = {...};
    if (disabled) {       ← ซ้ำ! INNER if (บรรทัด 119) — AI ใส่มาผิด
        return;
    }                     ← ปิด INNER if (บรรทัด 126)
    // cooldown code      ← ยังอยู่ใน OUTER if!
    handleInteraction()   ← ยังอยู่ใน OUTER if!
});                       ← } ปิด OUTER if, ); ปิด client.on — callback body ไม่ถูกปิด!
```

**การแก้ไข:** ลบ if-block ซ้ำออก ให้โครงสร้างตรงตามไฟล์เดิม (ยืนยันจาก index.js บรรทัด 2787–2817)

---

## ❌ BUG #2 — MEDIUM — views.js + server.js: Route /ping และ /health ซ้ำ

**ไฟล์:** `discord/index/server.js` (บรรทัด 112-120) และ `discord/index/views.js` (บรรทัด 1834-1842)
**ความรุนแรง:** MEDIUM — ไม่ crash แต่ views.js version ไม่มีทางทำงานได้

**สาเหตุ:**
Express ใช้ route แรกที่ลงทะเบียนเสมอ server.js ลงทะเบียนก่อน ดังนั้น
`/ping` และ `/health` ใน views.js จะไม่มีวันถูกเรียกใช้งาน
โค้ดใน views.js version ยังคำนวณ uptime ต่างจาก server.js ด้วย ทำให้สับสน

**การแก้ไข:** ลบ `/ping` และ `/health` ออกจาก views.js เก็บไว้แค่ใน server.js

---

## ✅ สิ่งที่ตรวจสอบแล้วว่าปกติดี (ไม่เป็นบัค)

| จุด | สถานะ |
|---|---|
| `startRotateTimer()` | ✅ อยู่ใน index.js บรรทัด 145, ส่งให้ server.js ถูกต้อง |
| Cron cleanup ทุก Map | ✅ system.js รับ Maps ครบผ่าน parameter |
| `sayTracking` + cleanup | ✅ events.js รับมา, system.js ล้างให้ |
| `antiRaidLogDebounce` cleanup | ✅ system.js บรรทัด 127-128 |
| `/api/settings/natural` GET ไม่ต้อง auth | ✅ ตรงกับ original |
| Boot sequence Express→Mongo→Discord | ✅ ครบ |
| Graceful Shutdown SIGTERM/SIGINT | ✅ ครบ |
| disabledCommands โหลดจาก DB ตอน boot | ✅ ครบ |
| checkApproval gate | ✅ อยู่ใน events.js |
| Panel Persistence (restorePanels) | ✅ ครบ |
| Webhook startup message | ✅ ครบ |
| guildCreate + guildDelete | ✅ ครบ |
| setupTelemetryRouter / initializeSystemHooks | ✅ export ครบใน systemProvider.js |
| isProtected (Shadow Protocol) | ✅ export ครบ บรรทัด 1125 |
| setProtectedChecker (voiceWorker) | ✅ เพิ่มใหม่ถูกต้อง |
| การเชื่อมต่อทุกไฟล์ | ✅ ครบทุกคู่ |

---

## 📊 สรุปสถิติ

| ระดับ | จำนวน | แก้แล้ว |
|---|---|---|
| ⛔ FATAL | 1 | ✅ |
| ❌ MEDIUM | 1 | ✅ |
| รวม | 2 | 2/2 |
