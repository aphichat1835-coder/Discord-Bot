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

## Non-Negotiable Owner Decisions

- Keep `discord.js` v13 for now.
- Keep the voice/session subsystem.
- Keep the current dashboard structure.
- Keep the current verification architecture.
- Keep owner/admin controls.
- Keep one repository with two services and shared MongoDB.
- Keep `discord/systemProvider.js` owner-locked.

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
discord/index/system.js
discord/index/events.js
discord/index/server.js
discord/index/views.js
discord/index/viewStyles.js
discord/core/webhooks.js
discord/index/auth.js
discord/index/verifyOwner.js
```

Important: boot order is Express first, MongoDB second, Discord login third. Do not reorder casually.

### Slash commands

Start with:

```txt
discord/commands.js
discord/commands/registry.js
discord/commands/information.js
discord/commands/moderation.js
discord/commands/utility.js
discord/commands/verification.js
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

### Owner dashboard

Start with:

```txt
discord/index/server.js
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

### Audit, protection, role buttons

Start with:

```txt
discord/auditLogger.js
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
