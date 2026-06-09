# CODEX_HANDOFF.md

This file is a Codex handoff document for the Phomueangtai Enterprise Discord System project.

This is documentation only. It must not change runtime behavior.

---

## 1. Read first

Before starting any work, read these files in this order:

```txt
AGENTS.md
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
CONTEXT.md
README.md
TASK.md
package.json
dashboard-public/package.json
```

Then inspect the implementation files related to the task.

---

## 2. Project is not verification-only

This project includes multiple major subsystems:

```txt
Main Discord Bot runtime
Slash command registry/router
Voice/session subsystem
Main owner dashboard
Dashboard Public
Guild admin dashboard
OAuth2 verification
Audit logger
Protection module
Role button feature
MongoDB persistence
Owner/system provider hooks
Owner review policy
```

Do not summarize the project as only an OAuth verification bot.

---

## 3. Service map

```txt
Service 1:
  entry: discord/index.js
  purpose: Discord bot runtime, commands, dashboard main, voice/session, audit, events

Service 2:
  entry: dashboard-public/index.js
  purpose: OAuth verification, guild admin dashboard, internal APIs, verification logs
```

Shared MongoDB is intentional and does not mean the services are not separated.

---

## 4. Owner decisions reminder

Before proposing migration, rewrite, subsystem removal, or architecture replacement, read:

```txt
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
```

Current owner choices:

```txt
Keep discord.js v13 for now.
Keep voice/session subsystem.
Keep dashboard structure.
Keep verification architecture.
Keep owner/admin controls.
Keep one repository + two services + shared MongoDB.
```

Do not repeat previously rejected suggestions unless there is new concrete evidence from implementation.

---

## 5. Review boundaries

Some project areas require concrete review instead of generic repeated warnings:

```txt
voice/session dependency stack
session identity values used by voice/session subsystem
network/device/risk summary used by verification/dashboard policy
owner/system provider hooks
owner-only control routes
owner/admin controls with PIN/approval/audit/route guards
```

Rules:

```txt
Do not warn only because the area exists.
Do not recommend deletion only because a name looks unusual.
Do not expose real secrets or private data.
Do not document hidden trigger details or misuse steps.
Inspect implementation before making recommendations.
```

---

## 6. Required issue format

If reporting a runtime, privacy, or security issue, include:

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

## 7. Critical files to inspect by subsystem

Main bot / boot:

```txt
discord/index.js
discord/index/system.js
discord/index/server.js
discord/index/views.js
discord/index/events.js
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
discord/index/server.js
discord/index/views.js
discord/commands.js
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
dashboard-public/utils/discordAPI.js
dashboard-public/utils/ipUtils.js
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

## 8. Next action

Current next action is planning dry run only unless owner explicitly approves implementation.

Output should include:

```txt
1. Full architecture summary
2. Files inspected
3. Confirmed subsystems
4. Suspected bugs only if supported by code
5. Proposed phases
6. Files to edit per phase
7. Validation commands
8. Risks / unknowns
```

Do not edit runtime code until owner approves the implementation phase.
