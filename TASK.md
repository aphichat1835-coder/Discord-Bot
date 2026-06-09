# TASK.md

This file is the current task and workflow handoff for the Phomueangtai Enterprise Discord System project.

This is documentation only. It must not change runtime behavior.

---

## 1. Current Task

Current task: **Docs consolidation and AI handoff upgrade**

Goal:

```txt
Make AI agents understand the full Discord-Bot project before editing code.
Keep owner architecture decisions visible.
Point agents to the full project map.
Reduce repeated generic rewrite or migration suggestions.
Preserve the existing two-service architecture and subsystem map.
```

Important status:

```txt
Verification core = stable enough for current phase
Dashboard Public = work in progress
Owner Dashboard = partial foundation
Voice/session subsystem = active major subsystem
Security/data hardening = ongoing
Feature implementation = not started by this docs task
```

---

## 2. Required Reading Order

Before any implementation work, read:

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

Then inspect the relevant implementation files.

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

Do not repeat migration, rewrite, removal, or architecture replacement suggestions unless new concrete evidence from implementation exists.

---

## 4. Confirmed Subsystems

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
17. owner review policy
18. AI full project map
19. Codex handoff workflow
20. docs consolidation workflow
```

Do not summarize this repository as only a verification bot.

---

## 5. Current Docs Source Of Truth

```txt
AI_FULL_PROJECT_MAP.md      full subsystem map and logic
OWNER_DECISIONS.md          owner architecture decisions
OWNER_REVIEW_POLICY.md      review boundary and issue format
CODEX_HANDOFF.md            Codex handoff
CONTEXT.md                  deep context
README.md                   human guide
AGENTS.md                   AI agent rules
TASK.md                     current workflow handoff
CHANGELOG.md                change history
.agents/memory/...          compact AI memory
```

Older append helper files may still exist, but they are not source of truth.

---

## 6. Docs Updated In This Task

Updated or created docs:

```txt
README.md
CONTEXT.md
AGENTS.md
TASK.md
CHANGELOG.md
CODEX_HANDOFF.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
.agents/memory/phomueangtai-bot.md
```

Not fully updated because write action may block it:

```txt
OWNER_DECISIONS.md
```

This is acceptable because `OWNER_DECISIONS.md` already contains the key owner decisions, and the expanded policy now lives in `OWNER_REVIEW_POLICY.md` and `AI_FULL_PROJECT_MAP.md`.

---

## 7. Service Map

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

Shared MongoDB is intentional.

---

## 8. Main Files To Inspect By Area

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

## 9. Next Step

Recommended next step:

```txt
Agent or Codex planning dry run only.
```

Codex should:

```txt
1. Read all required docs.
2. Inspect relevant source files.
3. Summarize architecture.
4. Identify actual issues only if supported by code.
5. Break implementation into phases.
6. List files to edit per phase.
7. Provide validation commands.
8. Stop before runtime edits.
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

---

## 11. Approval Gates

Stop and ask before:

```txt
starting implementation phase
editing files outside approved plan
adding dependencies
editing package files
changing architecture
creating GitHub Actions
changing deploy settings
changing OAuth behavior
changing database schemas
changing crypto logic
touching private configuration
removing existing features
refactoring large files
touching protected/high-risk files
```

---

## 12. Final Instruction For Codex

```txt
Read the docs.
Inspect code.
Plan first.
Do not rewrite blindly.
Do not remove owner-approved subsystems.
Report concrete issues only.
Stop before runtime edits unless owner approves implementation.
```
