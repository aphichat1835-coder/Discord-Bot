# Phomueangtai Personal Multi-Tool Discord Bot

This repository contains a personal multi-tool Discord bot with two Node.js services and shared MongoDB persistence. It is not a verification-only bot.

## What This Project Includes

- Main Discord bot runtime using `discord.js` v13.
- Slash commands for information, moderation, utility/admin work, backup/restore, audit log setup, dashboard setup, and verification panel setup.
- Voice/session subsystem with persistent session state, token encryption, reconnect handling, health recovery, owner dashboard visibility, and session controls.
- Main owner dashboard served by Service 1 for status, sessions, settings, command toggles, whitelist, approved guilds, logs, and owner controls.
- Dashboard Public served by Service 2 for Discord OAuth2 verification, guild admin configuration, verification panels, logs, members, stats, risk summaries, and internal APIs.
- MongoDB/Mongoose persistence shared by both services.
- Audit logging, protection checks, role buttons, approved/pending guild flows, and protected owner/system hook integration.

## Services

### Service 1 - Main Discord Bot / Owner System

```txt
Entry: discord/index.js
Root directory: repository root
Start command: npm start
Health routes: /ping, /health
```

Primary responsibilities:

- Discord client login and bot lifecycle.
- Slash command registry and interaction routing.
- Voice/session lifecycle and panel controls.
- Owner dashboard HTML and JSON/control APIs.
- Audit logger, protection hooks, role buttons, guild approval flow, and protected owner/system hook initialization.

### Service 2 - Dashboard Public / Verification Dashboard

```txt
Entry: dashboard-public/index.js
Root directory: dashboard-public/
Start command: npm start
Health routes: /ping, /health
```

Primary responsibilities:

- Discord OAuth2 verification callback.
- Admin OAuth login and guild selection.
- Guild verification settings, panel send/update/disable, logs, members, stats, and risk views.
- Internal owner-dashboard APIs for overview, members, stats, and owner-approved raw IP reveal workflow.

Both services intentionally share MongoDB. This is an owner-approved architecture decision.

## Quick Start

Install and run Service 1:

```bash
npm install
npm start
```

Install and run Service 2:

```bash
cd dashboard-public
npm install
npm start
```

Use `.env.example` as a placeholder reference only. Never commit real secrets.

## Required Documentation

- [AGENTS.md](AGENTS.md) - AI/agent rules, protected boundaries, review workflow, and owner decisions.
- [CONTEXT.md](CONTEXT.md) - quick project context, service map, subsystem map, and reading guide.
- [ARCHITECTURE.md](ARCHITECTURE.md) - full implementation-backed architecture, route map, file map, data model map, validation, and hotspots.
- [ROADMAP.md](ROADMAP.md) - approved minimal refactor direction and future work guardrails.
- [SECURITY.md](SECURITY.md) - secrets, OAuth, sessions, tokens, raw IP, logs, and owner/admin security policy.
- [CHANGELOG.md](CHANGELOG.md) - project documentation and structural change history.
- [.github/copilot-instructions.md](.github/copilot-instructions.md) - short GitHub Copilot guidance.

## Safety Rules

- Do not migrate `discord.js` v13 without explicit owner approval.
- Do not remove or redesign the voice/session subsystem, dashboard structure, verification architecture, owner/admin controls, or shared MongoDB layout without explicit owner approval.
- Do not edit, move, rename, format, summarize hidden details from, or refactor `discord/systemProvider.js` unless the owner explicitly approves that exact action in the current task.
- Treat OAuth, sessions, tokens, cookies, permissions, Discord roles, raw IP/device/risk data, and owner routes as high-risk areas.

## Validation

Common checks:

```bash
npm run check
npm run check:dashboard
npm test
```

`npm run check` covers the Service 1 entrypoints and extracted helper modules, including:

```txt
discord/commands/registry.js
discord/commands/customIds.js
discord/commands/panelViews.js
discord/commands/panelInteractions.js
discord/index/sessionSerializer.js
discord/index/viewHelpers.js
discord/sessions/tokenUtils.js
discord/sessions/voiceLabels.js
```

Run only checks that match the change. Report exact commands and results; do not claim a check passed unless it was actually run.
