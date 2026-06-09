# CONTEXT.md — Project Context

This is the root context file for the Phomueangtai Personal Multi-Tool Discord Bot.

The project is **not verification-only**. Verification is one subsystem inside a broader personal multi-tool Discord bot that also includes voice/session management, slash commands, owner dashboards, public dashboards, moderation tools, utility/admin tools, information commands, audit/protection features, role buttons, approved guild flows, and owner/system hooks.

Use this file as the quick context entry point before reading the deeper docs in `docs/`.

## Project identity

```txt
Repository: aphichat1835-coder/Discord-Bot
Project type: Personal Multi-Tool Discord Bot
Runtime: Node.js 18+
Main Discord library: discord.js v13
Database: MongoDB / Mongoose
Web framework: Express
Architecture: one repository + two services + shared MongoDB
```

## Non-negotiable owner decisions

Preserve these decisions unless the owner explicitly approves a change:

- Keep discord.js v13 for now.
- Keep voice/session subsystem.
- Keep dashboard structure.
- Keep verification architecture.
- Keep owner/admin controls.
- Keep one repository + two services + shared MongoDB.

## Service map

### Service 1 — Main Discord Bot / Owner System

```txt
Entry: discord/index.js
Root directory: repository root
Start command: npm start
Health check: /ping
```

Primary responsibilities:

- Discord bot runtime and login
- slash command registry/router
- moderation commands
- utility/admin commands
- information commands
- voice/session subsystem
- main owner dashboard
- audit logger
- protection module
- role button feature
- approved guild and pending guild flows
- owner/admin controls
- owner/system hooks

### Service 2 — Dashboard Public / Verification Dashboard

```txt
Entry: dashboard-public/index.js
Root directory: dashboard-public/
Start command: npm start
Health check: /ping
```

Primary responsibilities:

- Discord OAuth2 verification
- guild admin dashboard
- verification panel management
- verification logs
- risk/device/network summaries
- internal API used by the owner dashboard

Both services intentionally share MongoDB. This is an owner-approved architecture decision, not a defect by itself.

## Main subsystem context

### Slash commands

The bot includes a slash command router and multiple command groups. Do not treat verification commands as the only command surface.

Important command areas:

- panel/session controls
- help/stats/ping/server/user information
- log setup
- public dashboard setup link
- message clear/say/announce utilities
- emoji import
- backup/restore helpers
- voice channel administration
- ban/kick/timeout moderation
- whitelist management
- verification panel setup

### Voice/session subsystem

The voice/session subsystem is a large owner-approved part of the project. It includes persistent session state, encrypted sensitive token handling, session locks, metadata, reconnect/health behavior, and owner dashboard visibility/control.

Do not remove, rewrite, or migrate this subsystem unless the owner explicitly approves that scope.

### Dashboard systems

The repository has two dashboard surfaces:

- Main owner dashboard in Service 1 for owner/admin controls, session visibility, settings, commands, whitelist, approved guilds, logs, and status.
- Dashboard Public in Service 2 for OAuth verification, guild admin management, panel setup, logs, members, risk summaries, and internal data used by the owner dashboard.

Do not rewrite dashboard structure or dashboard routes during docs-only work.

### Verification/OAuth subsystem

Verification is an important subsystem, but it is not the whole project. It includes Discord OAuth2 callback handling, signed state/panel freshness concepts, role assignment, guild admin settings, verification logs, and policy/risk summaries.

Do not edit OAuth behavior, verification callback runtime logic, database schemas, or Discord role assignment behavior during docs-only work.

### MongoDB persistence

MongoDB is shared by both services. It stores session-related data, dashboard/verification data, settings, logs, guild config, user verification records, risk/device/network summaries, and related state.

Do not change schemas or persistence behavior during docs-only work.

### Audit/protection/role button features

The bot includes audit logging, protection hooks, and role button features beyond verification. These features are part of the broader personal multi-tool bot design.

### Owner/system hooks

The owner/system hooks subsystem exists and is protected/high-risk. Its implementation file is `discord/systemProvider.js`, which is OWNER-LOCKED.

Do not edit, move, delete, rename, reformat, split, lint-fix, comment-edit, summarize with sensitive details, refactor, or document hidden operational details from `discord/systemProvider.js` unless the owner explicitly approves that exact action in the current task.

## Documentation map

Read these files for deeper detail:

- `README.md` — human entry point and quick start
- `AGENTS.md` — root AI coding agent rulebook
- `TASK.md` — current task/workflow note
- `docs/ARCHITECTURE.md` — detailed architecture and subsystem map
- `docs/AI_GUIDE.md` — AI workflow, review rules, stop conditions, validation guidance
- `docs/OWNER_DECISIONS.md` — source of truth for owner decisions and review policy
- `docs/SECURITY_PRIVACY.md` — security/privacy guidance
- `docs/DEPLOYMENT.md` — deployment and environment notes
- `docs/VALIDATION.md` — validation commands and manual review checklist

## Docs-only safety rules

For documentation consolidation and cleanup:

- Do not edit runtime JavaScript files.
- Do not edit package manifests or lockfiles.
- Do not edit `render.yaml` unless the task explicitly approves deploy config changes.
- Do not change OAuth behavior.
- Do not change database schemas.
- Do not change Discord command behavior.
- Do not change dashboard routes.
- Do not change session or voice/session lifecycle behavior.
- Do not change token, encryption, IP reveal, verification callback, or bot boot logic.
- Do not change `discord/systemProvider.js`, its imports, or initialization.
- Do not expose secrets or hidden operational details.

## Validation pointer

Use `docs/VALIDATION.md`. Do not claim tests or checks passed unless the exact command was actually run.
