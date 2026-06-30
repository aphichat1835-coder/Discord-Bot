# Project Context

This is the quick context file for the Phomueangtai Personal Multi-Tool Discord Bot.

## Identity

```txt
Repository: aphichat1835-coder/Discord-Bot
Runtime: Node.js 24
Discord library: discord.js v13
Database: MongoDB / Mongoose
Web framework: Express
Architecture: one repository, two services, shared MongoDB
```

This project is not verification-only. Verification is one subsystem inside a broader personal multi-tool Discord bot.

Current dependency baseline:

- Service 1 keeps `discord.js` v13 and uses `@discordjs/voice` 0.19.x, Mongoose 8.x, and Express 5.x.
- Service 2 uses Express 5.x, Mongoose 8.x, `connect-mongo` 6.x, `express-rate-limit` 8.x, and Jest 30.
- `discord.js` v14 and Mongoose v9 are not current project targets without scoped owner approval.

## Non-Negotiable Owner Decisions

- Keep `discord.js` v13 for now.
- Keep the voice/session subsystem.
- Keep the current dashboard structure.
- Keep the current verification architecture.
- Keep owner/admin controls.
- Keep one repository with two services and shared MongoDB.
- Keep `discord/systemProvider.js` and all files inside `discord/systemProvider/` owner-locked.

## Service Map

### Service 1 - Main Discord Bot / Owner System

```txt
Entry: discord/index.js
Root directory: .
Start command: npm start
Health routes: /ping, /health
```

Responsibilities:

- Discord bot runtime and login.
- Slash command registration and routing.
- Voice/session lifecycle, resume, health, and control panel.
- Owner dashboard pages and JSON/control APIs.
- Owner Audit dashboard/API bundle at `/audit-logs` and `/api/audit/*`.
- Audit logging, protection hooks, role buttons, and guild approval flow.
- Owner verification/IP reveal review surface.
- Protected owner/system hook initialization at subsystem level.

### Service 2 - Dashboard Public / Verification Dashboard

```txt
Entry: dashboard-public/index.js
Root directory: dashboard-public/
Start command: npm start
Health routes: /ping, /health
```

Responsibilities:

- Discord OAuth2 verification callback.
- Admin OAuth login and guild selection.
- Guild admin dashboard.
- Verification panel management.
- Verification logs, members, stats, risk summaries, and reveal requests.
- Internal APIs consumed by Service 1 owner dashboard.

## Subsystem Map

### Main bot and boot

Start with:

```txt
discord/index.js
discord/core/env.js
discord/core/http.js
discord/core/webhooks.js
discord/core/safeLogger.js
discord/core/featureFlags.js
discord/core/loadEnv.js
discord/index/system.js
discord/index/events.js
discord/index/server.js
discord/index/auth.js
discord/index/views.js
discord/index/viewStyles.js
discord/index/viewHelpers.js
discord/index/dashboardState.js
discord/index/sessionSerializer.js
discord/index/memoryMonitor.js
discord/index/auditWebBundle.js
discord/index/auditApiRoutes.js
discord/index/auditDashboardPage.js
discord/index/joinCampaignRoutes.js
discord/index/joinCampaignPage.js
discord/index/verifyOwner.js
```

Important: boot order is Express first, MongoDB second, Discord login third. Do not reorder casually.

### Slash commands

Start with:

```txt
discord/commands.js
discord/commands/registry.js
discord/commands/customIds.js
discord/commands/panelViews.js
discord/commands/panelInteractions.js
discord/commands/information.js
discord/commands/moderation.js
discord/commands/moderationWorkflow.js
discord/commands/moderationHelpers.js
discord/commands/utility.js
discord/commands/verification.js
discord/commands/setupLog.js
```

Command areas:

- `/panel`
- `/help`
- `/stats`
- `/serverinfo`
- `/userinfo`
- `/ping`
- `/clear`
- `/ban`
- `/kick`
- `/timeout`
- `/voicekickall`
- `/say`
- `/announce`
- `/steal`
- `/backup`
- `/restore`
- `/setup-log`
- `/whitelist`
- `/setup`
- `/setup-verify`

### Voice/session

Start with:

```txt
discord/sessionManager.js
discord/voiceWorker.js
discord/voiceWorker/lifecycle.js
discord/voiceWorker/session.js
discord/voiceWorker/state.js
discord/voiceWorker/queue.js
discord/voiceWorker/cacheUtils.js
discord/commands.js
discord/index/server.js
discord/index/views.js
```

Preserve:

- Token encryption/decryption behavior.
- Session identity and active-session rules.
- One identity can run in multiple guilds.
- One identity should not be active in multiple voice channels inside the same guild.
- Multiple identities can be active in the same guild/channel.
- `voiceWorker` owns live lifecycle.
- `sessionManager` owns persistence, locks, metadata, and DB state.
- Dashboard/API starts should flow through the central `voiceWorker.ensureVoiceSession()` path instead of creating duplicate join logic.

### Owner dashboard

Start with:

```txt
discord/index/server.js
discord/index/auditWebBundle.js
discord/index/joinCampaignRoutes.js
discord/index/views.js
discord/index/auth.js
discord/index/verifyOwner.js
```

Surfaces:

- PIN login/logout.
- Home/status/session detail.
- Settings and presence.
- Natural/auto-deaf settings.
- Command toggles and audit.
- Whitelist management.
- Approved guild management.
- Join Campaign controls for eligible `guilds.join` OAuth users.
- Audit search/export/health/settings/dead-letter dashboard.
- Logs and voice logs.
- Token reveal controls.
- Owner verification/IP reveal review.

### Dashboard Public and verification

Start with:

```txt
dashboard-public/index.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/guildDashboard.js
dashboard-public/routes/api.js
dashboard-public/routes/adminSessionCompat.js
dashboard-public/models/
dashboard-public/utils/
dashboard-public/utils/verificationSnapshots.js
dashboard-public/views/
dashboard-public/public/
```

Preserve:

- Signed callback state.
- Panel revision freshness checks.
- Command-created and dashboard-created panel compatibility.
- Safe public callback responses.
- Role assignment through configured bot identity.
- Verification logs, risk summaries, and owner-approved raw IP reveal flow.
- Shared verification log serializers in `dashboard-public/utils/verificationSnapshots.js` keep guild route responses consistent while preserving sensitive-data redaction.

### Audit, protection, role buttons

Start with:

```txt
discord/auditLogger.js
discord/logging/
discord/features/protection.js
discord/features/roleButton.js
discord/index/events.js
```

These cover message/member/voice/server/security audit logging, anti-raid/anti-spam/link checks, and role button interactions.

## Active Documentation

- `README.md` - project entry point.
- `AGENTS.md` - AI/agent rules.
- `.github/copilot-instructions.md` - short Copilot rules.
- `CONTEXT.md` - this quick map.
- `ARCHITECTURE.md` - full implementation-backed architecture and file map.
- `ROADMAP.md` - approved minimal refactor and future work.
- `SECURITY.md` - security/privacy policy.
- `CHANGELOG.md` - change history.
- `docs/RUNBOOK.md` and focused `docs/AUDIT_*` files - operational/audit runbooks, not architecture source of truth.

## High-Risk Areas

Treat these as security-sensitive or behavior-sensitive:

- OAuth callback and signed state.
- Sessions, cookies, PIN auth, internal API auth.
- Token storage, token reveal, encryption/decryption.
- Raw IP reveal, device fingerprints, risk summaries.
- Discord role assignment and bot permissions.
- Owner dashboard controls and approved guild flows.
- Bot boot, event registration, shutdown, and voice/session lifecycle.
- `discord/systemProvider.js` and any boot/import reference to it.

## Validation Pointer

Use the validation commands in `ARCHITECTURE.md` and `SECURITY.md`. Report exact commands and results honestly.
