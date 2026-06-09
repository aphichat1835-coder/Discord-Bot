# TASK.md

This file is the current task and workflow handoff for the Phomueangtai Enterprise Discord System project.

This is documentation only. It must not change runtime behavior.

---

## Current Task

Docs consolidation and AI handoff upgrade.

Goal:

```txt
Make AI agents understand the full Discord-Bot project before editing code.
Keep owner architecture decisions visible.
Point agents to the full project map.
Reduce repeated generic rewrite or migration suggestions.
```

---

## Required Reading Order

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

## Current Owner Decisions

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

## Confirmed Subsystems

```txt
main bot runtime
slash commands
voice/session manager
main dashboard
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

Do not summarize this repository as only a verification bot.

---

## Current Docs Source Of Truth

```txt
AI_FULL_PROJECT_MAP.md      full subsystem map and logic
OWNER_DECISIONS.md          owner architecture decisions
OWNER_REVIEW_POLICY.md      review boundary and issue format
CODEX_HANDOFF.md            Codex handoff
CONTEXT.md                  deep context
README.md                   human guide
AGENTS.md                   AI agent rules
```

---

## Next Step

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

## Validation Commands

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
