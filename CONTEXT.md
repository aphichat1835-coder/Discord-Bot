# Project Context

ไฟล์นี้เป็นบริบทเชิงลึกสำหรับเจ้าของโปรเจกต์และ AI coding agents ที่จะทำงานใน repository นี้

โปรเจกต์นี้ไม่ใช่ verification-only bot แต่เป็นระบบ Discord bot + voice/session + dashboard + OAuth verification + audit/protection หลาย subsystem

This is documentation only. It must not change runtime behavior.

---

## 1. Project Summary

```txt
Repository: aphichat1835-coder/Discord-Bot
Architecture: one repository + two services + shared MongoDB
Service 1: Main Discord Bot / Owner System
Service 2: Dashboard Public / Verification Dashboard
Primary library: discord.js v13
Runtime: Node.js 18+
Database: MongoDB / Mongoose
Web framework: Express
Language: JavaScript / CommonJS
```

Current owner decisions:

```txt
Keep discord.js v13 for now.
Keep voice/session subsystem.
Keep dashboard structure.
Keep verification architecture.
Keep owner/admin controls.
Keep one repository + two services + shared MongoDB.
```

---

## 2. Required Reading Order For AI

Before editing code, read:

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

Then inspect the files related to the task.

---

## 3. System Scope

Confirmed subsystems:

```txt
1. main bot runtime
2. slash command router
3. voice/session manager
4. main dashboard
5. Dashboard Public
6. guild admin dashboard
7. OAuth2 verification
8. MongoDB persistence
9. audit logger
10. protection module
11. role button feature
12. moderation commands
13. utility/admin commands
14. information commands
15. approved guild flows
16. owner/system provider hooks
17. owner decisions
18. owner review policy
19. AI full project map
20. Codex handoff workflow
```

AI must not summarize this repository as only a verification bot.

---

## 4. Service 1 — Main Bot / Owner System

Entry point:

```txt
discord/index.js
```

Runtime:

```txt
repository root + discord/
npm start
node discord/index.js
```

Main responsibilities:

```txt
Discord bot runtime
slash command registration and routing
voice/session subsystem
main dashboard routes and APIs
audit logger
protection events
role button handling
panel restore
session resume
approved guild / pending guild flows
owner/system provider hooks
```

Important Service 1 files:

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
discord/index/auth.js
discord/index/verifyOwner.js
discord/commands/information.js
discord/commands/moderation.js
discord/commands/utility.js
discord/commands/verification.js
discord/features/protection.js
discord/features/roleButton.js
```

Boot logic:

```txt
start Express early
→ connect MongoDB
→ login Discord client
→ register commands/events/audit/dashboard
→ restore panels
→ resume saved sessions
→ run cron/health/save/shutdown handlers
```

Express starts early so basic health endpoints can answer before Discord login finishes.

---

## 5. Service 2 — Dashboard Public / Verification Dashboard

Entry point:

```txt
dashboard-public/index.js
```

Runtime:

```txt
dashboard-public/
cd dashboard-public
npm start
node index.js
```

Main responsibilities:

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
callback success/failure page
```

Important Service 2 files:

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

Shared MongoDB is intentional. It does not mean the two services are not separated.

---

## 6. Main Bot Boot / Runtime Detail

Expected startup sequence:

```txt
load environment/configuration
→ create Express app
→ bind health/dashboard routes
→ connect MongoDB
→ initialize Discord client
→ register Discord events
→ register slash commands
→ initialize audit/protection helpers
→ initialize owner/system hooks
→ restore configured panels
→ resume saved sessions when allowed
→ start periodic save/cleanup tasks
→ handle graceful shutdown
```

AI note:

```txt
Do not reorder boot sequence without checking Render/hosting behavior.
Do not assume that Express-before-Discord is wrong.
```

---

## 7. Command System Detail

Main router:

```txt
discord/commands.js
```

Modules:

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

AI note:

```txt
commands.js touches many systems.
Prefer module-level surgical edits when possible.
Do not rewrite the command router just because it is large.
```

---

## 8. Voice / Session Logic

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
→ modal submit
→ sessionManager validates input and persists metadata/state
→ voiceWorker owns live client/connection lifecycle
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

AI note:

```txt
Do not delete or replace this subsystem only because it looks unusual.
Inspect voiceWorker.js + sessionManager.js + dashboard/server usage first.
```

---

## 9. Verification Logic

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

panelRevision:

```txt
latest panel has panelRevision
OAuth state carries panelRevision
callback only accepts latest matching revision
old panel/link should fail with panel_revision_mismatch
```

AI note:

```txt
Do not change OAuth scopes, state signing, panelRevision behavior, role assignment, or callback public display without inspecting oauth.js, verification.js, GuildConfig, and callback.html.
```

---

## 10. Dashboard Systems

### Main Dashboard

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

## 11. Audit / Protection / Role Button

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

## 12. Owner/System Hooks

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

## 13. Data / State Summary

State lives in several places:

```txt
MongoDB collections through Mongoose models
Express sessions for Dashboard Public
in-memory maps/sets for runtime tracking
Discord API state through guild/member/role/channel data
rendered HTML views and browser-side dashboard state
hosting environment configuration
```

Verification/dashboard summaries may include:

```txt
Discord profile summary
connection summary
guild/member summary
verification result
risk flags/score
network/device/timezone/screen summary
role snapshots
same-network identity correlation summary
```

Do not expose unnecessary private details in public UI or public API responses.

---

## 14. Environment Context

Service 1 primary configuration:

```txt
MONGO_URI
TOKEN_MANAGER
API_SECRET
ENCRYPTION_KEY
NODE_ENV
PUBLIC_DASHBOARD_URL or DASHBOARD_URL
VERIFY_STATE_SECRET
```

Service 2 primary configuration:

```txt
MONGO_URI
TOKEN_MANAGER
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
SESSION_SECRET
ENCRYPTION_KEY
DASHBOARD_URL or PUBLIC_DASHBOARD_URL
INTERNAL_API_SECRET or API_SECRET
TRUST_PROXY
TRUST_PROXY_HOPS
ENABLE_CF_IP_HEADER
STORE_OAUTH_TOKENS
```

`.env.example` should contain placeholders only.

---

## 15. AI Review Policy Context

For architecture review, agents must use:

```txt
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
```

Review boundaries require concrete evidence. Do not warn only because a subsystem exists.

Required issue format:

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

Bad review style:

```txt
This subsystem is unusual, remove it.
Rewrite the whole project without inspecting dependencies.
Migrate immediately without checking compatibility.
This architecture is wrong because both services share MongoDB.
```

---

## 16. Current Work State

```txt
Verification core = stable enough for current phase
Dashboard Public = work in progress
Owner Dashboard = partial foundation
Voice/session subsystem = active major subsystem
Security/data hardening = ongoing
Step 5 feature implementation = not started by this docs task
```

Recommended next step:

```txt
Agent/Codex planning dry run only.
Read docs, inspect files, summarize architecture, propose phases, then stop before runtime edits.
```

---

## 17. Validation Commands

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
