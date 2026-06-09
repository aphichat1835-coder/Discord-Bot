# Phomueangtai Enterprise Discord System

โปรเจกต์นี้เป็นระบบ **Discord bot + voice/session + dashboard + OAuth verification + audit/protection** แบบแยก 2 service และใช้ MongoDB ร่วมกัน

เอกสารนี้เป็นคู่มือภาพรวมสำหรับคนและ AI coding agents

> ใช้ `.env.example` เป็น placeholder เท่านั้น และอย่าใส่ค่าจริงของ private configuration ลง GitHub

---

## 1. Project Identity

```txt
Repository: aphichat1835-coder/Discord-Bot
Runtime: Node.js >=18
Language: JavaScript / CommonJS
Main Discord library: discord.js v13
Database: MongoDB / Mongoose
Web framework: Express
Architecture: one repository + two services + shared MongoDB
```

โปรเจกต์นี้ **ไม่ใช่ verification-only bot** แต่เป็นระบบรวมหลาย subsystem

---

## 2. Current Owner Decisions

อ่านรายละเอียดเพิ่มใน:

```txt
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
CODEX_HANDOFF.md
```

การตัดสินใจปัจจุบัน:

```txt
Keep discord.js v13 for now.
Keep the current voice/session subsystem.
Keep the current dashboard structure.
Keep the current verification architecture.
Keep owner/admin controls.
Keep one repository + two services + shared MongoDB.
```

AI ไม่ควรเสนอ migration, rewrite, subsystem removal หรือ architecture replacement ซ้ำ ๆ ถ้ายังไม่ได้ inspect implementation จริง

---

## 3. Two-Service Architecture

### Service 1 — Main Discord Bot / Owner System

```txt
Entry: discord/index.js
Start: npm start
Actual command: node discord/index.js
```

หน้าที่หลัก:

```txt
Discord bot runtime
slash command routing
voice/session subsystem
main owner dashboard
audit logger
protection events
role button engine
panel restore
session resume
owner/admin controls
setup verification panel
```

### Service 2 — Dashboard Public / Verification Dashboard

```txt
Entry: dashboard-public/index.js
Start: cd dashboard-public && npm start
Actual command: node index.js
```

หน้าที่หลัก:

```txt
Discord OAuth verification callback
admin OAuth login
guild admin dashboard
verification settings
verification logs
member/profile/guild summary
network/device/risk summary
role assignment through configured bot identity
internal/public dashboard APIs
```

Shared MongoDB is intentional and does not mean the service separation is broken.

---

## 4. Full System Map

Subsystem หลัก:

```txt
main bot boot/runtime
slash command registry/router
voice/session manager
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

อ่าน logic รายละเอียดใน:

```txt
AI_FULL_PROJECT_MAP.md
CONTEXT.md
CODEX_HANDOFF.md
```

---

## 5. Key Runtime Logic

### Main bot boot

```txt
discord/index.js
→ starts Express early
→ connects MongoDB
→ logs in Discord client
→ registers commands/events/audit/dashboard
→ restores panels
→ resumes saved sessions
→ runs health/save/shutdown handlers
```

### Voice/session

```txt
/panel
→ user submits modal
→ sessionManager persists metadata and state
→ voiceWorker owns live lifecycle
→ dashboard reads status and detail
→ stop/restart updates state
→ restart can resume saved sessions
```

Current requirement:

```txt
1 identity can be active in multiple guilds.
1 identity should not be active in multiple voice channels inside the same guild.
Multiple identities can be active in the same guild/channel.
voiceWorker owns live lifecycle.
sessionManager owns persistence, locks, metadata, and DB state.
```

### Verification

```txt
/setup-verify
→ validates channel/role/options
→ creates verification panel
→ saves config and panelRevision
→ user clicks verification panel
→ Discord OAuth callback
→ profile/connections/guild/member lookup
→ network/device/risk summary
→ GuildConfig policy checks
→ role assignment
→ verification records saved
→ callback page shows success/failure
```

### panelRevision

```txt
latest panel has panelRevision
OAuth state carries panelRevision
callback only accepts latest matching revision
old panel/link should fail with panel_revision_mismatch
```

---

## 6. Important Files

Root docs:

```txt
README.md
CONTEXT.md
AGENTS.md
TASK.md
CHANGELOG.md
CODEX_HANDOFF.md
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
.agents/memory/phomueangtai-bot.md
```

Service 1:

```txt
discord/index.js
discord/commands.js
discord/sessionManager.js
discord/voiceWorker.js
discord/auditLogger.js
discord/systemProvider.js
discord/index/server.js
discord/index/views.js
discord/index/events.js
discord/index/system.js
discord/commands/information.js
discord/commands/moderation.js
discord/commands/utility.js
discord/commands/verification.js
discord/features/protection.js
discord/features/roleButton.js
```

Service 2:

```txt
dashboard-public/index.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/api.js
dashboard-public/models/GuildConfig.js
dashboard-public/models/OAuthUser.js
dashboard-public/models/VerifyLog.js
dashboard-public/models/IpIdentityLink.js
dashboard-public/utils/discordAPI.js
dashboard-public/utils/ipUtils.js
dashboard-public/views/callback.html
dashboard-public/views/home.html
dashboard-public/views/guilds.html
dashboard-public/views/guild.html
```

---

## 7. Running Locally

Service 1:

```bash
npm install
npm start
# or
npm run dev
```

Service 2:

```bash
cd dashboard-public
npm install
npm start
# or
npm run dev
```

---

## 8. Validation

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

Docs only:

```bash
git diff -- README.md CONTEXT.md AGENTS.md TASK.md CHANGELOG.md CODEX_HANDOFF.md OWNER_DECISIONS.md OWNER_REVIEW_POLICY.md AI_FULL_PROJECT_MAP.md .agents/memory/phomueangtai-bot.md
```

---

## 9. Manual Smoke Test Map

Voice/session:

```txt
/panel
start session
view status from Discord
view status from dashboard
open /session/:id
stop session
restart after stop
confirm one identity can run across multiple guilds
confirm one identity is blocked from duplicate voice sessions in the same guild
confirm multiple identities can run in same guild/channel
```

Verification:

```txt
/setup-verify required options only
/setup-verify with button_text
OAuth callback success
repeat verification
account age policy
network/device/risk policy if enabled
role hierarchy check
managed role check
panelRevision mismatch from old panel
callback failure page does not expose debug details
```

Dashboard Public:

```txt
/
/oauth/admin
/guilds
/guild/:guildId
settings load/save
stats/logs/members load
panel validate/send/update/disable
unauthorized guild access blocked
```

---

## 10. Deployment Notes

Deploy ได้แบบแยก 2 Render Web Services

```txt
Service 1 root: repository root
Service 1 start: npm start
Service 2 root: dashboard-public
Service 2 start: npm start
```

Docs-only changes do not require deploy

---

## 11. AI Review Boundaries

Some project areas require concrete review, not generic repeated warnings:

```txt
voice/session dependency stack
session identity values used by voice/session subsystem
network/device/risk summary used by verification/dashboard policy
owner/system provider hooks
owner-only control routes
owner/admin controls with PIN/approval/audit/route guards
```

Issue reports should include:

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

## 12. Maintainer Notes

Before asking AI/Codex to work, tell it to read:

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

Before major work, create a backup branch or tag.

Before deploy, confirm docs, validation plan, and correct service target.
