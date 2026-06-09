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

## 3. Service 1 — Main Bot / Owner System

Entry point:

```txt
discord/index.js
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

---

## 4. Service 2 — Dashboard Public / Verification Dashboard

Entry point:

```txt
dashboard-public/index.js
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
dashboard-public/utils/discordAPI.js
dashboard-public/utils/ipUtils.js
dashboard-public/views/callback.html
dashboard-public/views/home.html
dashboard-public/views/guilds.html
dashboard-public/views/guild.html
```

Shared MongoDB is intentional. It does not mean the two services are not separated.

---

## 5. Confirmed Subsystems

```txt
main bot runtime
slash commands
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

AI must not summarize the project as only a verification bot.

---

## 6. Voice / Session Logic

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
→ sessionManager persists metadata and state
→ voiceWorker owns live lifecycle
→ dashboard reads status and detail
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

---

## 7. Verification Logic

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
→ VerifyLog/OAuthUser/IpIdentityLink saved
→ callback page shows success/failure
```

panelRevision:

```txt
latest panel has panelRevision
OAuth state carries panelRevision
callback only accepts latest matching revision
old panel/link should fail with panel_revision_mismatch
```

---

## 8. AI Review Policy Context

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

## 9. Current Work State

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

## 10. Validation Commands

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
