# AI Guide

This guide defines the required workflow for AI coding agents working in this repository. It links to the architecture map instead of repeating it.

## Required reading order

1. `AGENTS.md`
2. `CONTEXT.md`
3. `docs/OWNER_DECISIONS.md`
4. `docs/AI_GUIDE.md`
5. `docs/ARCHITECTURE.md`
6. `README.md`
7. `TASK.md`
8. `docs/SECURITY_PRIVACY.md`
9. `docs/VALIDATION.md`
10. `package.json`
11. `dashboard-public/package.json`
12. Relevant implementation files for the task

## Workflow

### Phase 1 — Inspect

- Read the required docs.
- Inspect relevant implementation files.
- Understand current implementation before editing.
- Do not start with generic migration, deletion, or rewrite suggestions.

### Phase 2 — Plan

- Explain the current behavior.
- List files to change.
- Explain risks and expected behavior changes.
- Ask before large, sensitive, or architecture-changing edits.

### Phase 3 — Implement

- Make focused edits only.
- Do not touch unrelated files.
- Do not add dependencies without owner approval.
- Stop if scope expands.

### Phase 4 — Review

- Summarize changed files.
- Explain what changed and why.
- Mention risks and uncertainty.

### Phase 5 — Validate

- Run relevant checks when possible.
- Report exact commands and results honestly.
- Do not claim tests passed unless they were run.

## Planning dry-run output format

For complex work, provide:

```txt
Understanding:
Files inspected:
Proposed files to change:
Behavior changes:
Risks:
Validation plan:
Questions / approval needed:
```

## Required issue format

When reporting runtime, privacy, security, or maintainability issues, use:

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

## Bad review examples

```txt
This subsystem is unusual, remove it.
Rewrite the whole project without inspecting dependencies.
Migrate immediately without checking compatibility.
This architecture is wrong because both services share MongoDB.
I have not inspected the route but recommend deleting the subsystem.
```

## Good review example

```txt
File: dashboard-public/routes/oauth.js
Code path / route / command: callback failure response
Behavior found: public response includes internal debug field
Why it matters: public users do not need internal debug details
Concrete impact: browser may show information that should stay internal
Suggested minimal fix: map internal reason to safe public message, keep detailed reason in server log
Files affected: dashboard-public/routes/oauth.js, dashboard-public/views/callback.html
Validation: trigger failed verification and confirm public page shows safe message
```

## Files to inspect by subsystem

### Main bot / boot

```txt
discord/index.js
discord/index/system.js
discord/index/server.js
discord/index/views.js
discord/index/events.js
discord/index/auth.js
discord/index/verifyOwner.js
```

### Commands

```txt
discord/commands.js
discord/commands/information.js
discord/commands/moderation.js
discord/commands/utility.js
discord/commands/verification.js
```

### Voice/session

```txt
discord/voiceWorker.js
discord/sessionManager.js
discord/commands.js
discord/index/server.js
discord/index/views.js
```

### Dashboard Public / verification

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

### Audit / protection / role buttons

```txt
discord/auditLogger.js
discord/features/protection.js
discord/features/roleButton.js
```

### Owner/system hooks

```txt
discord/systemProvider.js
```

## Validation commands

Use `docs/VALIDATION.md` as the canonical validation list.

## Stop conditions

Stop and ask for a new scoped task if the request requires:

- runtime JavaScript edits outside the approved scope
- package/dependency changes
- package lockfile changes
- OAuth behavior changes
- database schema changes
- Discord command behavior changes
- dashboard route changes
- session lifecycle changes
- voice/session lifecycle changes
- Render deployment behavior changes
- encryption logic changes
- token logic changes
- IP reveal runtime logic changes
- verification callback runtime logic changes
- bot boot logic changes
- systemProvider imports or initialization changes
- documenting hidden/internal systemProvider behavior
- edits to protected high-risk files without direct current-task owner approval

## Protected file handling

`discord/systemProvider.js` is OWNER-LOCKED. Do not edit, move, delete, rename, reformat, split, lint-fix, comment-edit, summarize with sensitive details, or refactor it without direct owner approval in the current task.

Do not change imports or boot logic that initializes/references it. Do not document hidden operational details, internal trigger phrases, command names, misuse flows, or sensitive behavior. Do not include it in automatic formatting, lint fixes, refactor passes, or migration work.

If a change appears to require touching this file, stop immediately and ask for explicit approval in this form: `Owner approves editing discord/systemProvider.js for [specific reason].` Without that approval, leave the file unchanged.
