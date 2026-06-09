# Architecture

This document is the consolidated architecture map for the Phomueangtai Personal Multi-Tool Discord Bot. It preserves the project reality that the repository is a Personal Multi-Tool Discord Bot, not a verification-only bot.

## Project identity

```txt
Repository: aphichat1835-coder/Discord-Bot
Runtime: Node.js 18+
Main Discord library: discord.js v13
Database: MongoDB / Mongoose
Web framework: Express
Architecture: one repository + two services + shared MongoDB
```

## Two-service architecture

### Service 1 — Main Discord Bot / Owner System

```txt
Entry: discord/index.js
Runtime directory: repository root + discord/
```

Primary responsibilities:

- Discord bot login/runtime
- slash command registry and router
- voice/session subsystem
- main owner dashboard routes, views, and APIs
- audit logger
- protection and role button features
- session panel restore and saved-session resume
- owner/admin controls
- approved guild and pending guild flows
- slash-command setup for verification panels

### Service 2 — Dashboard Public / Verification Dashboard

```txt
Entry: dashboard-public/index.js
Runtime directory: dashboard-public/
```

Primary responsibilities:

- Discord OAuth2 verification callback
- admin OAuth login for guild dashboard
- guild admin dashboard
- verification settings and panel management
- verification logs and member summaries
- network/device/risk summaries
- role assignment through the configured bot identity
- internal APIs consumed by the owner dashboard

## Shared MongoDB design

Shared MongoDB is intentional. Both services read and write compatible config, log, and state records. This does not mean the service separation is broken; it means the runtime processes are separated while persistence is centralized.

## Boot flow

Service 1 expected boot flow:

```txt
start Express early
→ connect MongoDB
→ load persisted bot state
→ login Discord client
→ register commands/events/audit/dashboard
→ restore panels
→ resume saved voice sessions
→ run cron/health/save/shutdown handlers
```

Service 2 expected boot flow:

```txt
validate required env vars
→ configure Express/session/static views
→ connect MongoDB
→ mount OAuth, guild dashboard, guild API, and internal API routes
→ expose health endpoint
```

## Command system

Main router:

```txt
discord/commands.js
```

Command modules:

```txt
discord/commands/information.js
discord/commands/moderation.js
discord/commands/utility.js
discord/commands/verification.js
```

Known command groups:

- Information: `/help`, `/stats`, `/serverinfo`, `/ping`, `/userinfo`
- Moderation: `/clear`, `/ban`, `/kick`, `/timeout`, `/voicekickall`
- Utility/admin: `/say`, `/announce`, `/steal`, `/backup`, `/restore`, `/setup-log`, `/setup`, `/whitelist`
- Verification: `/setup-verify`
- Panel/session: `/panel` and related modal/button flows

`discord/commands.js` is the router that touches many systems. Prefer surgical changes inside the command module that owns the behavior.

## Voice/session subsystem

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
→ user submits modal
→ sessionManager validates and persists session metadata
→ voiceWorker owns live client/connection lifecycle
→ dashboard reads status/detail from server APIs
→ stop/restart updates state
→ restart can auto-resume saved sessions
```

Owner-required behavior:

```txt
1 identity can be active in multiple guilds.
1 identity should not be active in multiple voice channels inside the same guild.
Multiple identities can be active in the same guild/channel.
voiceWorker owns live lifecycle.
sessionManager owns persistence, locks, metadata, and DB state.
```

Do not delete, rewrite, or replace this subsystem only because it looks unusual. Inspect the implementation and dashboard/command usage first.

## Verification/OAuth flow

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
dashboard-public/models/IPRevealRequest.js
dashboard-public/utils/discordAPI.js
dashboard-public/utils/ipUtils.js
dashboard-public/utils/crypto.js
dashboard-public/utils/verifyMode.js
dashboard-public/utils/panelBuilder.js
```

Setup flow:

```txt
/setup-verify
→ validate channel/role/options
→ create panel
→ save config and panelRevision
→ user clicks panel
→ OAuth callback
→ profile/guild/member lookup
→ network/device/risk summary
→ policy checks
→ role assignment
→ verification records saved
→ callback page shows success/failure
```

Important behavior to preserve:

- OAuth callback behavior
- signed state handling
- `panelRevision` freshness checks
- role assignment behavior
- callback public display
- `GuildConfig` policy behavior
- compatibility between command-created and dashboard-created panels

## Dashboard systems

### Main owner dashboard

Main files:

```txt
discord/index/server.js
discord/index/views.js
discord/index/auth.js
discord/index/verifyOwner.js
```

Responsibilities:

- PIN-gated owner dashboard
- session status and detail APIs
- session stop/reveal controls
- command status/toggle/audit views
- presence, naturalness, and auto-deaf settings
- whitelist and approved guild management
- owner verification overview via Dashboard Public internal APIs

### Dashboard Public and guild admin dashboard

Main files:

```txt
dashboard-public/index.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/guildDashboard.js
dashboard-public/routes/api.js
dashboard-public/views/home.html
dashboard-public/views/guilds.html
dashboard-public/views/guild.html
dashboard-public/views/callback.html
dashboard-public/public/js/home.js
dashboard-public/public/js/guilds.js
dashboard-public/public/js/guild-dashboard.js
dashboard-public/public/js/callback.js
dashboard-public/public/css/dashboard.css
```

Responsibilities:

- admin OAuth login
- guild selection
- guild settings UI
- panel preview/send/update/disable
- verification logs/members/risk views
- reveal-request creation
- callback result page

## Audit/protection/role button

Main files:

```txt
discord/auditLogger.js
discord/features/protection.js
discord/features/roleButton.js
```

Responsibilities:

- Discord audit-style event logging
- configured audit channel routing
- protection feature hooks
- role button feature handling

## Owner/system hooks summary

Main file:

```txt
discord/systemProvider.js
```

This is an owner/system hooks subsystem. The implementation file is OWNER-LOCKED: do not edit, move, format, refactor, lint-fix, or document sensitive operational details without direct current-task owner approval. Public docs should describe only that the subsystem exists and is protected/high risk.

## Data/state summary

Key state groups:

- Voice sessions and session metadata
- Reconnect tracking and session locks
- panel state and verification config
- approved/pending guild records
- whitelist records
- bot settings
- audit log channel maps
- verification logs
- OAuth user snapshots
- IP/device identity links
- IP reveal requests
- Express sessions for Dashboard Public

## Important files by subsystem

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
