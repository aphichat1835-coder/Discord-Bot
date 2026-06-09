# APPLY_INSTRUCTIONS.md

This bundle has been applied. All target files have been updated as described below.

## Applied Changes

1. Created new file:

```txt
OWNER_DECISIONS.md
```

2. Appended owner decision blocks:

```txt
README_APPEND_OWNER_DECISIONS.md        -> appended to README.md
CONTEXT_APPEND_OWNER_DECISIONS.md       -> appended to CONTEXT.md
AGENTS_APPEND_OWNER_DECISIONS.md        -> appended to AGENTS.md
TASK_APPEND_OWNER_DECISIONS.md          -> appended to TASK.md
CODEX_HANDOFF_APPEND_OWNER_DECISIONS.md -> appended to (created) CODEX_HANDOFF.md
CHANGELOG_APPEND_OWNER_DECISIONS.md     -> appended to CHANGELOG.md
```

3. Merged owner decisions summary into:

```txt
.agents/memory/phomueangtai-bot.md
```

## Commit message used

```txt
docs: add owner decision guidelines for AI agents
```

## Validation

```bash
git diff -- README.md CONTEXT.md AGENTS.md TASK.md CODEX_HANDOFF.md CHANGELOG.md OWNER_DECISIONS.md .agents/memory/phomueangtai-bot.md
```

No runtime deploy is needed because this is docs-only.

---

## Actual Content Applied

### 1. OWNER_DECISIONS.md (new file)

```md
# OWNER_DECISIONS.md

ไฟล์นี้บันทึกการตัดสินใจของเจ้าของโปรเจกต์ เพื่อให้ AI coding agents เข้าใจบริบทก่อนรีวิวหรือแก้โค้ด

## Owner Decisions

เจ้าของโปรเจกต์เข้าใจโครงสร้างของระบบนี้แล้ว และตั้งใจคงระบบหลักต่อไปนี้ไว้:

- ใช้ `discord.js` v13 เป็นฐานหลักในตอนนี้
- คง voice/session subsystem เดิมไว้
- คง dashboard structure เดิมไว้
- คง verification architecture เดิมไว้
- คง owner/admin controls ที่มีอยู่เดิมไว้
- คงการออกแบบแบบ one repository + two services + shared MongoDB ไว้

AI ไม่ควรเสนอให้ลบ ย้าย หรือ rewrite ระบบเหล่านี้ซ้ำ ๆ เว้นแต่พบ bug จริง, security issue ที่อธิบายได้ชัดเจน, หรือเจ้าของโปรเจกต์สั่งให้แก้โดยตรง

## Architecture Decisions

โปรเจกต์นี้ตั้งใจออกแบบเป็น: one repository, two services, shared MongoDB, shared Discord application/bot identity, separate Express apps.

Service 1 (discord/index.js): ดูแล Discord bot, commands, voice/session, dashboard main, audit, events และระบบ owner/admin ที่เกี่ยวข้อง

Service 2 (dashboard-public/index.js): ดูแล OAuth verification, guild admin dashboard, internal APIs และ verification logs

## Previously Rejected Suggestions

AI ไม่ควรเสนอเรื่องเหล่านี้ซ้ำในการรีวิวทั่วไป: เปลี่ยนจาก discord.js v13 ไป v14 ทันที, rewrite โปรเจกต์ใหม่ทั้งก้อน, ลบ voice/session subsystem, ลบ dashboard structure เดิม, ลบ verification architecture เดิม, แยก repository ออกจากกันทันที, เปลี่ยน architecture โดยยังไม่ได้อ่าน implementation จริง

## Security Review Style

รูปแบบที่ควรใช้เมื่อรายงาน bug หรือ security issue:

File: / Behavior found: / Why it matters: / Concrete impact: / Suggested minimal fix: / Files affected: / Validation:
```

### 2. Content appended to README.md

```md
---

## Owner Decisions / Architecture Notes

อ่านรายละเอียดเต็มใน `OWNER_DECISIONS.md`

สรุปสั้น:

This project intentionally keeps discord.js v13 for now.
This project intentionally keeps the current voice/session subsystem.
This project intentionally keeps the current dashboard and verification architecture.
This project intentionally uses one repository, two services, and shared MongoDB.

AI/coding agent ไม่ควรเสนอ migration, rewrite, removal หรือ architecture replacement ซ้ำ ๆ โดยยังไม่ได้อ่าน implementation จริง

ถ้าจะเสนอการเปลี่ยนใหญ่ ต้องอ้างอิงจาก: ไฟล์ที่ตรวจแล้ว / behavior ที่พบจริง / impact ที่ชัดเจน / minimal fix ที่ไม่ลบระบบเดิมโดยไม่จำเป็น
```

### 3. Content appended to CONTEXT.md

```md
---

## Owner Decision Context

โปรเจกต์นี้มี `OWNER_DECISIONS.md` เพื่อบันทึกการตัดสินใจที่ AI ไม่ควรแนะนำซ้ำโดยไม่มีหลักฐานใหม่

Current owner decisions: Keep discord.js v13 for now. Keep voice/session subsystem. Keep current dashboard structure. Keep current verification architecture. Keep owner/admin controls. Keep one repo + two services + shared MongoDB.

AI ต้องไม่สรุปว่าระบบใดควรถูกลบเพียงเพราะดูไม่ปกติ ต้อง inspect ก่อนว่า: Where is it imported? / Where is it called? / Which route/command/event/dashboard depends on it? / Which MongoDB/config data depends on it? / What breaks if removed? / Did owner explicitly choose to keep it?

Security review ยังทำได้ แต่ต้องเป็น concrete review ที่ชี้ file/behavior/impact/fix ไม่ใช่ generic warning ซ้ำ ๆ
```

### 4. Content appended to AGENTS.md

```md
---

## Owner Decisions / Do Not Re-Suggest Rules

AI ต้องอ่าน `OWNER_DECISIONS.md` ก่อนเสนอให้ลบ, rewrite, migrate หรือเปลี่ยน architecture ใหญ่ของโปรเจกต์

เจ้าของโปรเจกต์ตัดสินใจแล้วว่าในเฟสนี้: ใช้ discord.js v13 เป็นฐานหลักก่อน / คง voice/session subsystem เดิมไว้ / คง dashboard structure เดิมไว้ / คง verification architecture เดิมไว้ / คง owner/admin controls ที่มีอยู่เดิมไว้ / คง one repository + two services + shared MongoDB ไว้

ห้ามเสนอซ้ำโดยไม่มีหลักฐานใหม่: migrate เป็น discord.js v14 ทันที / rewrite โปรเจกต์ใหม่ทั้งก้อน / ลบ voice/session subsystem / ลบ dashboard เดิมทั้งหมด / ลบ verification architecture เดิม / แยก repository ทันที / เปลี่ยน architecture โดยยังไม่ได้ inspect implementation จริง

ถ้าพบ bug หรือ security issue ให้รายงานแบบมีหลักฐาน: File: / Behavior found: / Why it matters: / Concrete impact: / Suggested minimal fix: / Files affected: / Validation:

ห้ามใช้คำแนะนำ generic เช่น "ดูแปลก ให้ลบทิ้ง" หรือ "ไม่ใช่ best practice ให้ rewrite ทั้งหมด" โดยยังไม่ได้อ่านไฟล์จริง
```

### 5. Content appended to TASK.md

```md
---

## Owner Decision Patch Task

Add `OWNER_DECISIONS.md` and link it from docs so AI agents stop repeating already-declined architecture suggestions.

Files updated: OWNER_DECISIONS.md / README.md / CONTEXT.md / AGENTS.md / CODEX_HANDOFF.md / CHANGELOG.md / .agents/memory/phomueangtai-bot.md

Do not use this file to tell AI to ignore real security bugs. The goal is to stop generic repeated warnings and architecture rewrites, not to suppress concrete bug reports.
```

### 6. CODEX_HANDOFF.md (new file created)

```md
# CODEX_HANDOFF.md

This file is a Codex handoff document for the Phomueangtai Enterprise Discord System project.

Read TASK.md, AGENTS.md, CONTEXT.md, README.md, package.json, and dashboard-public/package.json before starting any work.

---

## Owner Decisions Reminder

Before proposing migration, rewrite, subsystem removal, or architecture replacement, read OWNER_DECISIONS.md.

Current owner choices: Keep discord.js v13 for now. Keep voice/session subsystem. Keep dashboard structure. Keep verification architecture. Keep one repository + two services + shared MongoDB.

Do not repeat previously rejected suggestions unless there is new concrete evidence from implementation.

If reporting a security or runtime issue, include: file / behavior / impact / minimal fix / validation
```

### 7. Content appended to CHANGELOG.md

```md
---

## [Unreleased] - Owner Decisions Documentation

### Added

- Added `OWNER_DECISIONS.md` to document architecture decisions and previously rejected suggestions.
- Added guidance for AI agents to avoid repeating migration/rewrite/removal suggestions without inspecting implementation.
- Added concrete security review format so issues are reported with file, behavior, impact, minimal fix, and validation.

### Changed

- Docs should now point AI agents to owner decisions before broad architecture recommendations.
- Reviews should focus on concrete bugs and maintainability issues instead of generic warnings.

### Notes

- This is docs-only.
- This does not suppress real bug or security reports.
- This is intended to reduce repeated generic warnings and unrequested architecture rewrites.
```

### 8. Line merged into .agents/memory/phomueangtai-bot.md

```txt
**Owner decisions (do not re-suggest without new evidence):** Keep discord.js v13. Keep voice/session subsystem. Keep dashboard structure. Keep verification architecture. Keep one repo + two services + shared MongoDB. Read OWNER_DECISIONS.md before proposing migration, rewrite, or subsystem removal.
```
