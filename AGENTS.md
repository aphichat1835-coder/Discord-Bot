# AGENTS.md — AI Coding Agent Rules

ไฟล์นี้คือกฎหลักสำหรับ AI coding agents ที่จะทำงานใน repository นี้ เช่น ChatGPT, Codex, Claude, Copilot หรือ automation agent อื่น ๆ

โปรเจกต์นี้เป็นระบบ Discord bot + voice/session + dashboard + OAuth verification + audit/protection หลาย subsystem ไม่ใช่ verification-only bot

This file is documentation only. It must not change runtime behavior.

---

## 1. Purpose

เป้าหมายของไฟล์นี้:

```txt
Make AI understand the full project before editing.
Prevent random rewrites.
Prevent repeated generic migration/removal suggestions.
Preserve owner-approved architecture decisions.
Protect private configuration values.
Force inspect → plan → implement → review → validate workflow.
```

---

## 2. Required Reading Order

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

ห้ามเริ่มแก้ทันทีโดยยังไม่เข้าใจบริบท

---

## 3. Project Reality

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
Codex handoff workflow
```

AI ห้ามสรุปว่าโปรเจกต์นี้เป็นแค่ verification bot

---

## 4. Current Owner Decisions

```txt
Keep discord.js v13 for now.
Keep voice/session subsystem.
Keep dashboard structure.
Keep verification architecture.
Keep owner/admin controls.
Keep one repository + two services + shared MongoDB.
```

ก่อนเสนอ migration, rewrite, subsystem removal หรือ architecture replacement ต้องอ่าน:

```txt
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
```

จากนั้นต้อง inspect implementation จริงก่อนเสนอแผน

---

## 5. Core Rules

```txt
Plan before complex edits.
Keep changes focused.
Do not rewrite unrelated files.
Do not remove existing features without owner approval.
Do not change architecture without owner approval.
Do not add dependencies without owner approval.
Do not edit package/deploy/schema/OAuth behavior without approval.
Do not expose private configuration values.
Do not claim tests passed if tests were not run.
Summarize diff after changes.
Provide validation commands.
Be honest about uncertainty.
```

---

## 6. Two-Service Architecture

Service 1:

```txt
entry: discord/index.js
purpose: Discord bot runtime, commands, dashboard main, voice/session, audit, events
```

Service 2:

```txt
entry: dashboard-public/index.js
purpose: OAuth verification, guild admin dashboard, internal APIs, verification logs
```

Shared MongoDB is intentional. It does not mean the services are not separated.

---

## 7. Files To Inspect By Subsystem

Main bot / boot:

```txt
discord/index.js
discord/index/system.js
discord/index/server.js
discord/index/views.js
discord/index/events.js
discord/index/auth.js
discord/index/verifyOwner.js
```

Commands:

```txt
discord/commands.js
discord/commands/information.js
discord/commands/moderation.js
discord/commands/utility.js
discord/commands/verification.js
```

Voice/session:

```txt
discord/voiceWorker.js
discord/sessionManager.js
discord/commands.js
discord/index/server.js
discord/index/views.js
```

Dashboard Public / verification:

```txt
dashboard-public/index.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/api.js
dashboard-public/models/GuildConfig.js
dashboard-public/models/OAuthUser.js
dashboard-public/models/VerifyLog.js
dashboard-public/models/IpIdentityLink.js
dashboard-public/models/IPRevealRequest.js
dashboard-public/utils/crypto.js
dashboard-public/utils/discordAPI.js
dashboard-public/utils/ipUtils.js
dashboard-public/views/callback.html
dashboard-public/views/home.html
dashboard-public/views/guilds.html
dashboard-public/views/guild.html
```

Audit / protection / role buttons:

```txt
discord/auditLogger.js
discord/features/protection.js
discord/features/roleButton.js
```

Owner/system hooks:

```txt
discord/systemProvider.js
```

---

## 8. Voice / Session Rules

Current expected behavior:

```txt
1 identity can be active in multiple guilds.
1 identity should not be active in multiple voice channels inside the same guild.
Multiple identities can be active in the same guild/channel.
voiceWorker owns live lifecycle.
sessionManager owns persistence, locks, metadata, and DB state.
```

AI must not:

```txt
remove this subsystem only because it looks unusual
rewrite voice/session without tracing existing dashboard and command usage
change ownership between voiceWorker and sessionManager without evidence
```

AI must:

```txt
inspect voiceWorker.js
inspect sessionManager.js
inspect dashboard server/view usage
inspect command flow
explain concrete behavior and impact
```

---

## 9. Verification Rules

Core flow:

```txt
/setup-verify
→ validate channel/role/options
→ create panel
→ save config and panelRevision
→ user clicks panel
→ OAuth callback
→ profile/guild/member lookup
→ network/device/risk summary
→ policy checks
→ role assignment
→ verification records saved
→ callback page shows success/failure
```

AI must not change these without inspecting implementation:

```txt
OAuth callback behavior
state handling
panelRevision behavior
role assignment behavior
callback public display
GuildConfig policy behavior
```

---

## 10. Review Boundaries

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
expose private configuration values
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

## 11. Required Review Format

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

Bad review examples:

```txt
This subsystem is unusual, remove it.
Rewrite the whole project without inspecting dependencies.
Migrate immediately without checking compatibility.
This architecture is wrong because both services share MongoDB.
```

---

## 12. Protected / High-Risk Files

แตะไฟล์เหล่านี้เมื่อจำเป็นและต้องมี plan ก่อน:

```txt
discord/voiceWorker.js
discord/sessionManager.js
discord/systemProvider.js
discord/index.js
discord/index/system.js
discord/index/events.js
discord/index/server.js
discord/index/views.js
dashboard-public/routes/oauth.js
dashboard-public/models/*
dashboard-public/utils/crypto.js
package.json
package-lock.json
dashboard-public/package.json
dashboard-public/package-lock.json
render.yaml
.github/workflows/*
```

If touching these files, explain:

```txt
why it must be touched
what behavior changes
what could break
how to validate
```

---

## 13. Documentation Rules

Update docs when changing:

```txt
environment configuration
commands
setup/install process
deploy process
major behavior
OAuth behavior
dashboard routes
voice/session behavior
database model behavior
security/privacy behavior
```

Docs to consider:

```txt
README.md
CONTEXT.md
AGENTS.md
TASK.md
CHANGELOG.md
CODEX_HANDOFF.md
AI_FULL_PROJECT_MAP.md
OWNER_REVIEW_POLICY.md
```

Do not mark planned work as complete unless implementation proves it.

---

## 14. Workflow

### Phase 1 — Inspect

```txt
Read docs.
Inspect relevant files.
Understand current implementation.
Do not edit yet.
```

### Phase 2 — Plan

```txt
Explain understanding.
List files to change.
Explain risks.
Ask before large/sensitive changes.
```

### Phase 3 — Implement

```txt
Make focused edits only.
Do not touch unrelated files.
Stop if scope expands.
Do not add dependencies unless approved.
```

### Phase 4 — Review

```txt
Summarize changed files.
Explain what changed and why.
Mention risks/uncertainty.
```

### Phase 5 — Validate

```txt
Run or provide validation commands.
Report results honestly.
If unable to run, say so.
```

---

## 15. Validation Commands

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

## 16. Output Format After Work

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
