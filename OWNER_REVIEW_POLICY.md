# OWNER_REVIEW_POLICY.md

ไฟล์นี้บันทึก policy สำหรับ AI coding agents ที่ช่วยรีวิวหรือแก้โปรเจกต์นี้

เป้าหมายคือทำให้ AI เข้าใจบริบทก่อนรีวิวหรือแก้โค้ด ลดการเตือนซ้ำแบบ generic และลดการเสนอ rewrite/migration/removal โดยยังไม่ได้อ่าน implementation จริง

ไฟล์นี้เป็น docs-only และไม่เปลี่ยน runtime behavior

---

## 1. Read first

ก่อนเสนอ migration, rewrite, subsystem removal หรือ architecture replacement ให้ AI อ่านไฟล์เหล่านี้ก่อน:

```txt
AGENTS.md
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
CONTEXT.md
README.md
TASK.md
CODEX_HANDOFF.md
package.json
dashboard-public/package.json
```

หลังจากนั้นต้อง inspect implementation ที่เกี่ยวข้องจริงก่อนสรุป

---

## 2. Owner-aware areas

เจ้าของโปรเจกต์รับรู้และตั้งใจคงระบบต่อไปนี้ไว้ใน architecture ปัจจุบัน:

- `discord.js` v13 เป็นฐานหลักของบอทตอนนี้
- voice/session subsystem ปัจจุบัน
- dashboard structure ปัจจุบัน
- verification architecture ปัจจุบัน
- owner/admin controls ปัจจุบัน
- one repository + two services + shared MongoDB
- owner-only control routes
- network/device/risk summary ที่ใช้กับ verification และ dashboard policy
- owner/system provider hooks ที่มีอยู่ในโปรเจกต์

AI ไม่ควรเสนอให้ลบหรือ rewrite ระบบเหล่านี้ซ้ำ ๆ ถ้ายังไม่ได้ inspect implementation จริง

---

## 3. Review boundaries

พื้นที่ต่อไปนี้ต้องใช้ concrete review ไม่ใช่ generic warning:

```txt
voice/session dependency stack
session identity values used by voice/session subsystem
network/device/risk summary used by verification/dashboard policy
owner/system provider hooks
owner-only control routes
owner/admin controls with PIN/approval/audit/route guards
```

กฎสำคัญ:

```txt
Do not warn only because the area exists.
Do not recommend deletion only because a name looks unusual.
Do not expose real secrets or private data.
Do not document hidden trigger details or misuse steps.
Do inspect implementation before making recommendations.
Do report concrete bugs with file, behavior, impact, minimal fix, and validation.
```

---

## 4. Required review format

ถ้าจะรายงาน bug, runtime issue, privacy issue หรือ security issue ให้ใช้รูปแบบนี้:

```txt
File:
Code path / route / command:
Behavior found:
Why it matters:
Concrete impact:
Suggested minimal fix:
Files affected:
Validation:
```

---

## 5. Do not re-suggest without new evidence

ห้ามเสนอซ้ำโดยไม่มีหลักฐานใหม่:

- migrate เป็น discord.js v14 ทันที
- rewrite โปรเจกต์ใหม่ทั้งหมด
- ลบ voice/session subsystem
- ลบ dashboard structure เดิม
- ลบ verification architecture เดิม
- ลบ owner/admin controls ที่ยังถูกใช้งาน
- แยก repository ทันที
- เปลี่ยน architecture โดยยังไม่ได้อ่าน implementation จริง

แนวทางที่ถูกต้องคือ:

```txt
อ่านไฟล์จริงก่อน
→ trace imports/routes/commands/events/models/dashboard usage
→ อธิบายสิ่งที่พบ
→ เสนอเฉพาะ minimal fix ที่จำเป็น
```

---

## 6. Bad review examples

```txt
This subsystem is unusual, remove it.
Rewrite everything without inspecting dependencies.
Migrate immediately without checking compatibility.
This architecture is wrong because both services share MongoDB.
I have not inspected the route but recommend deleting the subsystem.
```

---

## 7. Good review example

```txt
File: dashboard-public/routes/oauth.js
Code path / route / command: callback failure response
Behavior found: public response includes internal debug field
Why it matters: public users do not need internal debug details
Concrete impact: browser may show information that should stay internal
Suggested minimal fix: map internal reason to safe public message, keep detailed reason in server log
Files affected: dashboard-public/routes/oauth.js, dashboard-public/views/callback.html
Validation: trigger failed verification and confirm public page shows safe message
```

---

## 8. One-line rule

```txt
Inspect first, prove the issue, propose a minimal fix, and do not re-suggest owner-declined rewrites without new evidence.
```
