# Phomueangtai Personal Multi-Tool Discord Bot

This repository contains a personal multi-tool Discord bot with two Node.js services and shared MongoDB persistence. It is not a verification-only bot. The supported deployment runtime is Node.js 24.

## What This Project Includes

- Main Discord bot runtime using `discord.js` v13.
- Slash commands for information, moderation, utility/admin work, backup/restore, audit log setup, dashboard setup, and verification panel setup.
- Voice/session subsystem with persistent session state, token encryption, reconnect handling, health recovery, owner dashboard visibility, and session controls.
- Production memory stability is a first-class requirement: voice sessions are expected to run long term, so caches, timers, queues, log buffers, and dashboard diagnostics must remain bounded.
- Voice sessions run with a target-only lean cache mode by default so a token used for one voice session does not keep unnecessary guild/channel/message/role/emoji caches from unrelated servers.
- Main owner dashboard served by Service 1 for status, sessions, settings, command toggles, whitelist, approved guilds, Join Campaign controls, logs, and owner controls.
- Dashboard Public served by Service 2 for Discord OAuth2 verification, guild admin configuration, verification panels, logs, members, stats, risk summaries, and internal APIs.
- MongoDB/Mongoose persistence shared by both services.
- Audit logging, protection checks, role buttons, approved/pending guild flows, and protected owner/system hook integration.

## Runtime Baseline

Both services target Node.js 24.

Current major dependency decisions:

- Keep `discord.js` v13 unless the owner explicitly approves a v14 migration.
- Keep Mongoose on v8 unless a scoped persistence migration is approved.
- Service 1 uses `@discordjs/voice` 0.19.x and `opusscript` 0.1.x.
- Service 2 uses `connect-mongo` 6.x, `express-rate-limit` 8.x, and Jest 30.

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
- [docs/RUNBOOK.md](docs/RUNBOOK.md) - operational triage for RAM, voice sessions, IP reveal, retention, restore, token rotation, audit logs, and dependency audit.
- [docs/AUDIT_RUNTIME_TEST_PLAN.md](docs/AUDIT_RUNTIME_TEST_PLAN.md) and related `docs/AUDIT_*` files - focused Audit v4 runtime/manual verification references.

## Safety Rules

- Do not migrate `discord.js` v13 without explicit owner approval.
- Do not remove or redesign the voice/session subsystem, dashboard structure, verification architecture, owner/admin controls, or shared MongoDB layout without explicit owner approval.
- Do not edit, move, rename, format, summarize hidden details from, or refactor `discord/systemProvider.js` or any file inside `discord/systemProvider/` (`actions.js`, `auth.js`, `dashboardHtml.js`, `htmlUtils.js`, `renderers.js`) unless the owner explicitly approves that exact action in the current task.
- Treat OAuth, sessions, tokens, cookies, permissions, Discord roles, raw IP/device/risk data, and owner routes as high-risk areas.
- Treat RAM growth as production-critical. Long-running voice/session changes must keep Discord/selfbot caches, timers, queues, maps, sets, and log buffers bounded and visible through diagnostics.

## Validation

Common checks:

```bash
npm run check
npm run check:dashboard
npm test
npm audit --audit-level=high
npm --prefix dashboard-public audit --audit-level=high
```

`npm run check` runs the full project syntax/static guard chain:

```txt
Service 1 JavaScript syntax, excluding the owner-locked protected file
Dashboard Public JavaScript syntax
scripts/*.js syntax
static memory guard checks
```

Run only checks that match the change. Report exact commands and results; do not claim a check passed unless it was actually run.

Dashboard Public production dependencies can also be checked with:

```bash
npm --prefix dashboard-public audit --omit=dev
```

Running Dashboard Public audit without an audit level may show moderate dev-only Jest-chain advisories. CI currently gates high severity and above.
