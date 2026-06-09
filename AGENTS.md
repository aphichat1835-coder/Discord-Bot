# AGENTS.md — AI Coding Agent Rules

ไฟล์นี้คือกฎหลักสำหรับ AI coding agents ที่จะทำงานใน repository นี้ เช่น ChatGPT, Codex, Claude, Copilot หรือ automation agent อื่น ๆ

โปรเจกต์นี้เป็นระบบ Discord bot + voice/session + dashboard + OAuth verification + audit/protection หลาย subsystem ไม่ใช่ verification-only bot

---

## 1. Required Reading Order

ก่อนเริ่มงานทุกครั้ง AI ต้องอ่านตามลำดับนี้:

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

จากนั้นค่อย inspect source files ที่เกี่ยวข้องกับงานจริง

---

## 2. Project Reality

ระบบหลักของ repo นี้:

```txt
main bot runtime
slash command router
voice/session subsystem
main owner dashboard
Dashboard Public
guild admin dashboard
OAuth2 verification
MongoDB persistence
audit logger
protection module
role button feature
moderation commands
utility/admin commands
information commands
approved guild flows
owner/system provider hooks
owner review policy
AI full project map
```

AI ห้ามสรุปว่าโปรเจกต์นี้เป็นแค่ verification bot

---

## 3. Current Owner Decisions

```txt
Keep discord.js v13 for now.
Keep voice/session subsystem.
Keep dashboard structure.
Keep verification architecture.
Keep owner/admin controls.
Keep one repository + two services + shared MongoDB.
```

ก่อนเสนอ migration, rewrite, subsystem removal หรือ architecture replacement ต้องอ่าน `OWNER_DECISIONS.md`, `OWNER_REVIEW_POLICY.md`, และ `AI_FULL_PROJECT_MAP.md` ก่อน

---

## 4. Core Rules

```txt
Plan before complex edits.
Keep changes focused.
Do not rewrite unrelated files.
Do not remove existing features without owner approval.
Do not edit package/deploy/schema/OAuth behavior without approval.
Do not expose private configuration values.
Summarize diff after changes.
Provide validation commands.
Be honest if tests were not run.
```

---

## 5. Review Boundaries

พื้นที่ต่อไปนี้ต้องใช้ concrete review ไม่ใช่ generic warning:

```txt
voice/session dependency stack
session identity values used by voice/session subsystem
network/device/risk summary used by verification/dashboard policy
owner/system provider hooks
owner-only control routes
owner/admin controls with PIN/approval/audit/route guards
```

AI must not:

```txt
warn only because the area exists
recommend deletion only because a name looks unusual
expose real private configuration values
document hidden operational details
```

AI must:

```txt
inspect actual implementation
trace imports/routes/commands/events/models/dashboard usage
report concrete issues only
suggest minimal fixes when possible
```

---

## 6. Required Review Format

ถ้าจะรายงาน runtime, privacy, security หรือ maintainability issue ให้ใช้รูปแบบนี้:

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

## 7. Protected / High-Risk Files

แตะไฟล์เหล่านี้เมื่อจำเป็นและต้องมี plan ก่อน:

```txt
discord/voiceWorker.js
discord/sessionManager.js
discord/systemProvider.js
discord/index.js
discord/index/system.js
discord/index/events.js
discord/index/server.js
dashboard-public/routes/oauth.js
dashboard-public/models/*
package.json
package-lock.json
dashboard-public/package.json
dashboard-public/package-lock.json
render.yaml
.github/workflows/*
```

---

## 8. Validation Commands

Service 1:

```bash
node --check discord/index.js
node --check discord/commands.js
node --check discord/commands/information.js
node --check discord/commands/moderation.js
node --check discord/commands/utility.js
node --check discord/commands/verification.js
node --check discord/sessionManager.js
node --check discord/voiceWorker.js
node --check discord/auditLogger.js
node --check discord/index/server.js
node --check discord/index/views.js
node --check discord/index/events.js
node --check discord/index/system.js
```

Service 2:

```bash
cd dashboard-public
node --check index.js
node --check routes/oauth.js
node --check routes/guild.js
node --check routes/api.js
node --check utils/discordAPI.js
node --check utils/ipUtils.js
```

Docs:

```bash
git diff -- README.md CONTEXT.md AGENTS.md TASK.md CHANGELOG.md CODEX_HANDOFF.md OWNER_DECISIONS.md OWNER_REVIEW_POLICY.md AI_FULL_PROJECT_MAP.md .agents/memory/phomueangtai-bot.md
```

---

## 9. Output Format After Work

หลังทำงาน ให้ตอบตามนี้:

```txt
1. Summary
2. Files changed
3. What changed
4. Why changed
5. Validation
6. Risks / notes
7. Next step
```

ห้ามอ้างว่าทดสอบแล้วถ้าไม่ได้ทดสอบจริง
