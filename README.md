# Phomueangtai Enterprise Discord System

ระบบนี้เป็นโปรเจกต์ **Discord bot + voice/session manager + owner dashboard + Dashboard Public + OAuth2 verification + audit/protection suite** แบบแยก 2 service และใช้ MongoDB เป็นฐานข้อมูลกลางร่วมกัน

เอกสารนี้เป็นคู่มือหลักสำหรับคนและ AI coding agents ที่จะอ่านก่อนทำงานกับ repository นี้

> ใช้ `.env.example` เป็น placeholder เท่านั้น อย่าใส่ค่าจริงของ private configuration ลง GitHub เช่น bot credential, API credential, database URL, session secret, webhook URL หรือค่า private อื่น ๆ

---

## 1. Project Identity

```txt
Repository: aphichat1835-coder/Discord-Bot
Runtime: Node.js >=18
Language: JavaScript / CommonJS
Package manager: npm
Main Discord library: discord.js v13
Database: MongoDB / Mongoose
Web framework: Express
Architecture: one repository + two services + shared MongoDB
```

โปรเจกต์นี้ **ไม่ใช่ verification-only bot** แต่เป็นระบบรวมหลาย subsystem ที่ทำงานร่วมกัน ได้แก่ bot runtime, command router, voice/session, dashboard, verification, audit, protection, role button และ owner/system hooks

---

## 2. Current Owner Decisions

อ่านรายละเอียดเพิ่มใน:

```txt
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
CODEX_HANDOFF.md
CONTEXT.md
AGENTS.md
TASK.md
```

การตัดสินใจปัจจุบันของเจ้าของโปรเจกต์:

```txt
Keep discord.js v13 for now.
Keep the current voice/session subsystem.
Keep the current dashboard structure.
Keep the current verification architecture.
Keep owner/admin controls.
Keep one repository + two services + shared MongoDB.
```

AI/coding agent ไม่ควรเสนอ migration, rewrite, subsystem removal หรือ architecture replacement ซ้ำ ๆ ถ้ายังไม่ได้ inspect implementation จริง

ถ้าจะรายงานปัญหา ต้องระบุจากโค้ดจริง เช่น file, code path, behavior, impact, minimal fix และ validation

---

## 3. Two-Service Architecture

### Service 1 — Main Discord Bot / Owner System

```txt
Entry: discord/index.js
Start: npm start
Dev: npm run dev
Actual command: node discord/index.js
Runtime directory: repository root + discord/
```

หน้าที่หลัก:

```txt
Discord bot login/runtime
slash command registration and routing
voice/session subsystem
main owner dashboard routes/views/APIs
audit logger
protection events
role button feature
panel restore
session resume
approved guild / pending guild flows
owner/admin controls
owner/system provider hooks
setup verification panel through slash command
```

Service 1 เป็นตัวหลักของบอท และเกี่ยวข้องกับ Discord client, commands, events, dashboard หลัก, voice/session, audit และระบบ owner/admin

### Service 2 — Dashboard Public / Verification Dashboard

```txt
Entry: dashboard-public/index.js
Start: cd dashboard-public && npm start
Dev: cd dashboard-public && npm run dev
Actual command: node index.js
Runtime directory: dashboard-public/
```

หน้าที่หลัก:

```txt
Discord OAuth2 verification callback
admin OAuth login
guild admin dashboard
verification settings
verification logs
member/profile/guild summary
network/device/risk summary
role assignment through configured bot identity
internal/public dashboard APIs
callback success/failure pages
```

Service 2 เป็นเว็บ public/guild dashboard ที่ใช้จัดการ verification และ admin dashboard ของเซิร์ฟเวอร์

### Shared MongoDB clarification

```txt
Shared MongoDB is intentional.
Both services can read compatible config/log/state.
This does not mean the service separation is broken.
```

การที่ Service 1 และ Service 2 ใช้ MongoDB ร่วมกันเป็น design เพื่อให้ bot runtime และ web dashboard เห็น state/config/log ที่เกี่ยวข้องกัน

---

## 4. Full System Map

Subsystem หลักที่ AI ต้องรู้ก่อนทำงาน:

```txt
1. Main bot boot/runtime
2. Slash command registry/router
3. Voice/session manager
4. Main owner dashboard
5. Dashboard Public
6. Guild admin dashboard
7. OAuth2 verification
8. MongoDB persistence
9. Audit logger
10. Protection module
11. Role button feature
12. Moderation commands
13. Utility/admin commands
14. Information commands
15. Approved guild / pending guild flows
16. Owner/system provider hooks
17. Owner decisions
18. Owner review policy
19. AI full project map
20. Codex handoff workflow
```

อ่าน logic แบบละเอียดใน:

```txt
AI_FULL_PROJECT_MAP.md
CONTEXT.md
CODEX_HANDOFF.md
AGENTS.md
TASK.md
```

---

## 5. Project Structure

```txt
.
├── package.json
├── package-lock.json
├── render.yaml
├── .env.example
├── .gitignore
├── README.md
├── CONTEXT.md
├── AGENTS.md
├── TASK.md
├── CHANGELOG.md
├── CODEX_HANDOFF.md
├── OWNER_DECISIONS.md
├── OWNER_REVIEW_POLICY.md
├── AI_FULL_PROJECT_MAP.md
├── .agents/
│   └── memory/
│       └── phomueangtai-bot.md
├── discord/
│   ├── index.js
│   ├── commands.js
│   ├── commands/
│   │   ├── information.js
│   │   ├── moderation.js
│   │   ├── utility.js
│   │   └── verification.js
│   ├── index/
│   │   ├── auth.js
│   │   ├── events.js
│   │   ├── server.js
│   │   ├── system.js
│   │   ├── verifyOwner.js
│   │   └── views.js
│   ├── features/
│   │   ├── protection.js
│   │   └── roleButton.js
│   ├── auditLogger.js
│   ├── sessionManager.js
│   ├── systemProvider.js
│   └── voiceWorker.js
└── dashboard-public/
    ├── package.json
    ├── package-lock.json
    ├── index.js
    ├── routes/
    │   ├── oauth.js
    │   ├── guild.js
    │   └── api.js
    ├── models/
    │   ├── GuildConfig.js
    │   ├── OAuthUser.js
    │   ├── VerifyLog.js
    │   ├── IpIdentityLink.js
    │   └── IPRevealRequest.js
    ├── utils/
    │   ├── crypto.js
    │   ├── discordAPI.js
    │   └── ipUtils.js
    ├── views/
    │   ├── callback.html
    │   ├── home.html
    │   ├── guilds.html
    │   └── guild.html
    └── public/
```

---

## 6. Root Documentation Files

```txt
README.md                         Main human-readable guide
CONTEXT.md                        Deep project context
AGENTS.md                         AI coding agent rules
TASK.md                           Current workflow/task tracker
CHANGELOG.md                      Change history
CODEX_HANDOFF.md                  Direct Codex handoff
OWNER_DECISIONS.md                Owner architecture decisions
OWNER_REVIEW_POLICY.md            AI review boundaries
AI_FULL_PROJECT_MAP.md            Full subsystem logic map
.agents/memory/phomueangtai-bot.md Compact agent memory
.env.example                      Placeholder environment template only
```

Recommended AI reading order:

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

---

## 7. Service 1 Important Files

```txt
discord/index.js                  Service 1 entry point
discord/commands.js               Slash command router
discord/sessionManager.js         Session persistence/metadata
discord/voiceWorker.js            Live voice/session lifecycle
discord/auditLogger.js            Audit log subsystem
discord/systemProvider.js         Owner/system hooks
discord/index/server.js           Main dashboard APIs
discord/index/views.js            Main dashboard views
discord/index/events.js           Discord event routing
discord/index/system.js           Cron/crash/shutdown helpers
discord/index/auth.js             Main dashboard auth helper
discord/index/verifyOwner.js      Owner approval / control helper
discord/commands/information.js   Information commands
discord/commands/moderation.js    Moderation commands
discord/commands/utility.js       Utility/admin commands
discord/commands/verification.js  /setup-verify logic
discord/features/protection.js    Anti-raid/spam/filter foundation
discord/features/roleButton.js    Role button/select feature
```

---

## 8. Service 2 Important Files

```txt
dashboard-public/index.js                 Service 2 entry point
dashboard-public/routes/oauth.js          OAuth callback/admin OAuth
dashboard-public/routes/guild.js          Guild admin dashboard routes/APIs
dashboard-public/routes/api.js            Internal/public APIs
dashboard-public/models/GuildConfig.js    Guild verification config
dashboard-public/models/OAuthUser.js      OAuth user summary
dashboard-public/models/VerifyLog.js      Verification logs
dashboard-public/models/IpIdentityLink.js Identity/risk summary links
dashboard-public/models/IPRevealRequest.js Request/approval model
dashboard-public/utils/crypto.js          Crypto helper
dashboard-public/utils/discordAPI.js      Discord REST helper
dashboard-public/utils/ipUtils.js         Network/device/risk helper
dashboard-public/views/callback.html      User callback page
dashboard-public/views/home.html          Public home page
dashboard-public/views/guilds.html        Guild list page
dashboard-public/views/guild.html         Guild dashboard page
```

---

## 9. Main Bot Boot Logic

Conceptual boot flow:

```txt
discord/index.js
→ validate/load configuration
→ start Express early
→ connect MongoDB
→ login Discord client
→ register ready handler
→ initialize commands
→ initialize audit logger
→ initialize event routing
→ initialize dashboard APIs/views
→ restore previous panel state
→ resume saved voice sessions
→ run health/save/cleanup routines
→ handle graceful shutdown
```

Hosting reason:

```txt
Express starts early so /ping and /health can respond before Discord login finishes.
```

---

## 10. Command System

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

## 11. Voice / Session Logic

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
→ sessionManager validates and persists metadata/state
→ voiceWorker owns live lifecycle
→ dashboard reads status and detail from server APIs
→ stop/restart updates state
→ restart can resume saved sessions
```

Current behavior requirement:

```txt
1 identity can be active in multiple guilds.
1 identity should not be active in multiple voice channels inside the same guild.
Multiple identities can be active in the same guild/channel.
voiceWorker owns live lifecycle.
sessionManager owns persistence, locks, metadata, and DB state.
```

AI review note:

```txt
Do not delete or replace this subsystem only because it looks unusual.
Inspect voiceWorker.js + sessionManager.js + dashboard/server usage first.
```

---

## 12. Verification Logic

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
→ callback service receives result
→ profile/connections/guild/member lookup
→ network/device/risk summary
→ GuildConfig policy checks
→ optional guild join
→ role assignment
→ verification records saved
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

## 13. Dashboard Systems

### Main dashboard

Main files:

```txt
discord/index/server.js
discord/index/views.js
discord/index/auth.js
discord/index/verifyOwner.js
```

Known pages/APIs:

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

## 14. Audit / Protection / Role Button

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

AI should inspect these before assuming event behavior, moderation behavior, or role interaction behavior

---

## 15. Owner/System Hooks

Main file:

```txt
discord/systemProvider.js
```

This is an owner-approved subsystem. It may include owner-level utilities, telemetry, alerting, protected controls, or system hooks

AI rule:

```txt
Do not remove, disable, or rewrite this file by default.
Do not document hidden operational details in public docs.
If touching this file, explain exact file path, behavior, impact, and minimal fix.
```

---

## 16. Environment Variables

Create local `.env` from `.env.example` for local development, or configure production values in the hosting provider

```bash
cp .env.example .env
```

Service 1 primary variables:

```txt
MONGO_URI
TOKEN_MANAGER
API_SECRET
ENCRYPTION_KEY
NODE_ENV
PUBLIC_DASHBOARD_URL or DASHBOARD_URL
VERIFY_STATE_SECRET
```

Service 2 primary variables:

```txt
MONGO_URI
TOKEN_MANAGER
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
SESSION_SECRET
ENCRYPTION_KEY
DASHBOARD_URL or PUBLIC_DASHBOARD_URL
INTERNAL_API_SECRET or API_SECRET
TRUST_PROXY=false
TRUST_PROXY_HOPS=1
ENABLE_CF_IP_HEADER=false
STORE_OAUTH_TOKENS=false unless storage is explicitly needed
```

Legacy raw OAuth snapshot cleanup manual only:

```bash
node dashboard-public/scripts/cleanupLegacyRawOAuthSnapshots.js --dry-run
node dashboard-public/scripts/cleanupLegacyRawOAuthSnapshots.js --apply
```

Discord Developer Portal OAuth2 Redirect URIs for Service 2:

```txt
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/callback
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/admin-callback
```

---

## 17. Running Locally

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

## 18. Validation

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

## 19. Manual Smoke Test Map

Voice/session:

```txt
/panel
start session
view status from Discord
view status from dashboard
open /session/:id
stop session
restart after stop
restart service and confirm saved session behavior
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

## 20. Deployment Notes

Deploy ได้แบบแยก 2 Render Web Services

Service 1:

```txt
Root Directory: repository root
Build Command: npm install
Start Command: npm start
```

Service 2:

```txt
Root Directory: dashboard-public
Build Command: npm install
Start Command: npm start
```

Render Blueprint:

```txt
render.yaml exists as a 2-service blueprint draft.
Check service names before using it so Render does not create duplicate services.
```

Docs-only changes do not require deploy

---

## 21. Troubleshooting

| Problem | Check |
|---|---|
| Bot does not start | Required Service 1 configuration, MongoDB connectivity, Node version |
| Dashboard Public does not start | Required Service 2 configuration, MongoDB connectivity, session setup |
| OAuth redirect fails | Redirect URI in Discord Developer Portal must match Service 2 URL |
| Role assignment fails | Bot permissions, role hierarchy, target role, guild configuration |
| Panel button invalid | dashboard URL, button text, emoji format, state size |
| Callback page shows too much detail | callback page and server response should use safe public messages |
| Render build fails | Node version, build command, root directory, environment setup |
| Blueprint creates new service | check service name in render.yaml against the real Render service name |

---

## 22. AI Review Boundaries

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

AI must not expose private operational values, document hidden operational details, or recommend removal without tracing imports/routes/models/dashboard usage

---

## 23. Maintainer Notes

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

Before major work, create a backup branch or tag

```bash
git branch backup/before-next-feature-phase
# or
git tag before-next-feature-phase
```

Before deploy, confirm:

```txt
no private config in diff
validation commands reviewed
manual smoke test plan ready
correct service selected for redeploy
```

---

## 24. Current Next Step

Recommended next step:

```txt
Agent/Codex planning dry run only.
Read docs, inspect source files, summarize architecture, propose phases, then stop before runtime edits.
```
