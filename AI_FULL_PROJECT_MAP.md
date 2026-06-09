# AI_FULL_PROJECT_MAP.md

ไฟล์นี้เป็น full project map สำหรับ AI coding agents ที่จะอ่านก่อนแก้ Discord-Bot repo

จุดประสงค์:

- อธิบายภาพรวมทั้งโปรเจกต์ ไม่ใช่เฉพาะ verification
- บอก logic การทำงานของ subsystem หลัก
- ลดการเดา ลดการ rewrite มั่ว และลดการเสนอ migration/removal ซ้ำ
- ให้ AI รู้ว่าต้อง inspect implementation จริงก่อนเสนอแก้

ไฟล์นี้เป็น docs-only และไม่เปลี่ยน runtime behavior

---

## 1. Project identity

```txt
Repository: aphichat1835-coder/Discord-Bot
Runtime: Node.js 18+
Main Discord library: discord.js v13
Database: MongoDB / Mongoose
Web framework: Express
Architecture: one repository + two services + shared MongoDB
```

โปรเจกต์นี้ไม่ใช่ verification-only bot แต่เป็นระบบรวมหลาย subsystem

---

## 2. Two-service architecture

### Service 1 — Main Discord Bot / Owner System

```txt
Entry: discord/index.js
Runtime directory: repository root + discord/
```

หน้าที่หลัก:

- Discord bot login/runtime
- slash command registry/router
- voice/session subsystem
- main owner dashboard routes/views/APIs
- audit logger
- protection events
- panel restore
- session resume
- owner/admin controls
- approved guild / pending guild logic
- setup verification panel through slash command

### Service 2 — Dashboard Public / Verification Dashboard

```txt
Entry: dashboard-public/index.js
Runtime directory: dashboard-public/
```

หน้าที่หลัก:

- Discord OAuth verification callback
- guild admin dashboard
- verification settings
- verification logs
- member/profile/guild summary
- network/device/risk summary
- role assignment through configured bot identity
- internal/public dashboard APIs

Important:

```txt
Shared MongoDB is intentional.
Both services can read compatible config/log/state.
This does not mean the service separation is broken.
```

---

## 3. Main bot boot logic

Main files:

```txt
discord/index.js
discord/index/system.js
discord/index/server.js
discord/index/views.js
discord/index/events.js
```

Expected boot logic:

```txt
start Express early
→ connect MongoDB
→ login Discord client
→ register commands/events/audit/dashboard
→ restore panels
→ resume saved voice sessions
→ run cron/health/save/shutdown handlers
```

Hosting reason:

```txt
Express starts early so /ping and /health can respond before Discord login finishes.
```

---

## 4. Command system logic

Main router:

```txt
discord/commands.js
```

Command modules:

```txt
discord/commands/information.js
discord/commands/moderation.js
discord/commands/utility.js
discord/commands/verification.js
```

Known command groups:

```txt
information: /help /stats /serverinfo /ping /userinfo
moderation: /clear /ban /kick /timeout /voicekickall
utility/admin: /say /announce /steal /backup /restore /setup-log /setup /whitelist
verification: /setup-verify
panel/session: /panel and related modal/button flows
```

Rule for AI:

```txt
Do not rewrite commands.js unless needed.
It is a router touching many systems.
Prefer surgical changes inside modules when possible.
```

---

## 5. Voice/session subsystem logic

Main files:

```txt
discord/voiceWorker.js
discord/sessionManager.js
discord/commands.js
discord/index/server.js
discord/index/views.js
```

Conceptual flow:

```txt
/panel
→ user submits modal
→ sessionManager validates/persists session metadata
→ voiceWorker owns live client/connection lifecycle
→ dashboard reads status/detail from server APIs
→ stop/restart updates state
→ restart can auto-resume saved sessions
```

Current owner requirement:

```txt
1 identity can be active in multiple guilds.
1 identity should not be active in multiple voice channels inside the same guild.
Multiple identities can be active in the same guild/channel.
voiceWorker owns live lifecycle.
sessionManager owns persistence, locks, metadata, and DB state.
```

AI rule:

```txt
Do not delete or replace this subsystem only because it looks unusual.
Inspect voiceWorker.js + sessionManager.js + dashboard/server usage first.
```

---

## 6. Verification subsystem logic

Main files:

```txt
discord/commands/verification.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/api.js
dashboard-public/models/GuildConfig.js
dashboard-public/models/OAuthUser.js
dashboard-public/models/VerifyLog.js
dashboard-public/models/IpIdentityLink.js
dashboard-public/utils/discordAPI.js
dashboard-public/utils/ipUtils.js
```

Setup flow:

```txt
Admin runs /setup-verify
→ command validates channel/role/options
→ panel is created
→ config is saved
→ panelRevision is saved
→ user-facing button/link is sent
```

User verification flow:

```txt
User clicks verification panel
→ Discord OAuth authorize
→ /auth/callback receives result
→ backend exchanges OAuth code
→ profile/connections/guild/member lookup
→ network/device/risk summary
→ GuildConfig policy checks
→ optional guild join
→ role assignment
→ VerifyLog/OAuthUser/IpIdentityLink saved
→ callback page shows success/failure
```

panelRevision logic:

```txt
latest panel has panelRevision
OAuth state carries panelRevision
callback only accepts latest matching revision
old panel/link should fail with panel_revision_mismatch
```

---

## 7. Dashboard systems

### Main dashboard

Main files:

```txt
discord/index/server.js
discord/index/views.js
discord/index/auth.js
discord/index/verifyOwner.js
```

Known pages/APIs include:

```txt
/status
/settings
/commands
/whitelist
/approved
/logs
/logs/voice
/session/:id
/docs
/api/status
/api/session/:sessionId
/api/stop-session
/api/settings
/api/commands/toggle
/api/whitelist/*
/api/approved/*
```

### Dashboard Public

Main files:

```txt
dashboard-public/index.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/api.js
dashboard-public/views/home.html
dashboard-public/views/guilds.html
dashboard-public/views/guild.html
dashboard-public/views/callback.html
```

Known responsibilities:

```txt
admin OAuth login
guild list
guild dashboard
verification settings
panel manager
member/log/stat APIs
owner-only request flow
policy/risk summaries
```

---

## 8. Audit / protection / role button

Audit logger:

```txt
discord/auditLogger.js
```

Protection module:

```txt
discord/features/protection.js
```

Role button module:

```txt
discord/features/roleButton.js
```

AI should inspect these before assuming event behavior, moderation behavior, or role interaction behavior.

---

## 9. Owner/system hooks

Main file:

```txt
discord/systemProvider.js
```

This is an owner-approved subsystem. It may include owner-level utilities, telemetry, alerting, protected controls, or system hooks.

AI rule:

```txt
Do not remove, disable, or rewrite this file by default.
Do not document hidden operational details in public docs.
If touching this file, explain exact file path, behavior, impact, and minimal fix.
```

---

## 10. Review boundaries

These areas require concrete review, not generic repeated warnings:

```txt
voice/session dependency stack
session identity values used by voice/session subsystem
network/device/risk summary used by verification/dashboard policy
owner/system provider hooks
owner-only control routes
owner/admin controls with PIN/approval/audit/route guards
```

Required format:

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

Do not:

```txt
Do not expose real secrets or private data.
Do not document hidden trigger details or misuse steps.
Do not repeatedly warn only because a subsystem exists.
Do not propose removal without tracing imports/routes/models/dashboard usage.
```

---

## 11. Validation map

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

Docs-only:

```bash
git diff -- README.md CONTEXT.md AGENTS.md TASK.md CHANGELOG.md CODEX_HANDOFF.md OWNER_DECISIONS.md OWNER_REVIEW_POLICY.md AI_FULL_PROJECT_MAP.md .agents/memory/phomueangtai-bot.md
```
