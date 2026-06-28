# Architecture

Last verified against implementation: 2026-06-28.

This is the implementation-backed architecture reference for the Phomueangtai Personal Multi-Tool Discord Bot. It describes the current project reality and the approved minimal direction for organization. It does not approve broad rewrites, dependency migrations, behavior changes, schema changes, or protected-file edits.

## Project Identity

```txt
Project type: Personal Multi-Tool Discord Bot
Runtime: Node.js 24
Discord library: discord.js v13
Database: MongoDB / Mongoose
Web framework: Express
Architecture: one repository, two services, shared MongoDB
```

The project includes bot runtime, slash commands, voice/session management, owner dashboard, Dashboard Public, guild admin dashboard, OAuth2 verification, MongoDB persistence, audit logging, protection, role buttons, moderation, utility/admin commands, information commands, approved guild flows, owner/admin controls, and protected owner/system hooks.

## Evidence Inspected

Current architecture was derived from these sources:

- Root docs and config: `AGENTS.md`, `CONTEXT.md`, `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `SECURITY.md`, `.github/copilot-instructions.md`, `.env.example`, `package.json`, `dashboard-public/package.json`, `render.yaml`.
- Service 1: `discord/index.js`, `discord/index/system.js`, `discord/index/server.js`, `discord/index/views.js`, `discord/index/events.js`, `discord/index/auth.js`, `discord/index/verifyOwner.js`, `discord/commands.js`, `discord/commands/*.js`, `discord/sessionManager.js`, `discord/voiceWorker.js`, `discord/voiceWorker/*.js`, `discord/auditLogger.js`, `discord/logging/*.js`, `discord/core/*.js`, `discord/guards/*.js`, `discord/sessions/*.js`, `discord/features/*.js`.
- Service 2: `dashboard-public/index.js`, `dashboard-public/routes/*.js`, `dashboard-public/models/*.js`, `dashboard-public/utils/*.js`, `dashboard-public/views/*.html`, `dashboard-public/public/js/*.js`, `dashboard-public/public/css/dashboard.css`, `dashboard-public/tests/*.test.js`.

Protected handling: `discord/systemProvider.js` and all files inside `discord/systemProvider/` (`actions.js`, `auth.js`, `dashboardHtml.js`, `htmlUtils.js`, `renderers.js`) exist and are referenced by boot logic, but hidden implementation details are intentionally not summarized. Do not edit or document sensitive behavior from any file in this protected set without explicit current-task owner approval.

## Repository Shape

```txt
.
├── discord/                 # Service 1: bot runtime and owner system
├── dashboard-public/        # Service 2: public/guild verification dashboard
├── scripts/                 # maintenance and diagnostic scripts
├── docs/                    # operational runbooks
├── .github/                 # GitHub Actions CI and Copilot instructions
├── README.md
├── AGENTS.md
├── CONTEXT.md
├── ARCHITECTURE.md
├── ROADMAP.md
├── SECURITY.md
├── CHANGELOG.md
├── package.json             # Service 1 package
├── dashboard-public/package.json
├── render.yaml
└── .env.example
```

## Runtime And Dependency Baseline

Current package manifests target Node.js 24 for both services.

Service 1 runtime dependencies:

```txt
@discordjs/voice ^0.19.2
discord.js ^13.17.1
discord.js-selfbot-v13 ^3.7.1
express ^5.2.1
libsodium-wrappers ^0.8.4
mongoose ^8.24.1
opusscript ^0.1.1
tweetnacl ^1.0.3
```

Service 2 runtime/test dependencies:

```txt
connect-mongo ^6.0.0
express ^5.2.1
express-rate-limit ^8.5.2
express-session ^1.18.1
mongoose ^8.24.1
jest ^30.4.2
```

`discord.js` remains intentionally on v13 by owner decision. Do not upgrade it to v14 without explicit owner approval. `mongoose` remains on v8; a v9 migration requires a scoped persistence review.

## Service 1 - Main Discord Bot / Owner System

```txt
Entry: discord/index.js
Root directory: .
Start command: npm start
Health routes: /ping, /health
```

### Boot Flow

Implementation shape:

```txt
validate required env vars
load protected owner/system hook module reference
initialize log capture and crash shield
create shared maps/sets
create Express app
create Discord client
link voiceWorker to main client
register API routes
register owner dashboard HTML routes
register owner verification/IP reveal routes
register Discord event handlers
register cron and shutdown handlers
start memory monitor
listen on process.env.PORT
connect MongoDB
load persisted state and disabled command settings
login Discord client
on ready: apply settings, register audit logger, register slash commands, restore panels, initialize protected hooks, resume voice sessions
```

Important invariant: Express starts first, MongoDB connects second, Discord login happens third. Do not reorder casually.

### Service 1 Files

| File | Responsibility |
| --- | --- |
| `discord/index.js` | Service 1 composition, Discord client, route/event/cron/shutdown registration, boot sequence, ready handler |
| `discord/core/env.js` | Service 1 required environment validation and boot-safe env derivation |
| `discord/core/http.js` | Service 1 Express app creation, trust proxy, body limits, x-powered-by disable, and security headers |
| `discord/core/webhooks.js` | Service 1 webhook routing helpers for operations/security logs and critical runtime alerts |
| `discord/core/safeLogger.js` | shared log redaction helpers; strips tokens, webhook URLs, MongoDB URIs, IPs, emails, and secret keys from all log output |
| `discord/core/featureFlags.js` | feature flag toggle evaluation, default flag definitions, and env-override mapping for voice/audit/protection subsystems |
| `discord/core/loadEnv.js` | manual `.env` file parser with comment and quote handling for local development outside Render |
| `discord/index/system.js` | log capture, crash shield, cron cleanup/health/save loop, graceful shutdown |
| `discord/index/server.js` | owner dashboard JSON/control APIs, settings/presence, token reveal controls, command toggles, whitelist, approved guild APIs |
| `discord/index/auditWebBundle.js` | owner-authenticated audit dashboard and audit API bundle registration |
| `discord/index/auditApiRoutes.js` | `/api/audit/*` log search, export, health, settings, and dead-letter routes |
| `discord/index/auditDashboardPage.js` | owner audit dashboard page HTML |
| `discord/index/joinCampaignRoutes.js` | owner Join Campaign target/status/dry-run/start/stop APIs |
| `discord/index/joinCampaignPage.js` | owner Join Campaign page HTML |
| `discord/index/dashboardState.js` | owner dashboard command status, command audit, runtime status, and safe JSON payload helpers |
| `discord/index/sessionSerializer.js` | safe owner-dashboard voice session JSON serialization and token lookup compatibility helper |
| `discord/index/views.js` | PIN-protected owner dashboard HTML pages, generated markup/styles/scripts, view route registration |
| `discord/index/viewHelpers.js` | reusable server-side owner dashboard HTML helpers |
| `discord/index/viewStyles.js` | shared owner dashboard CSS consumed by `views.js` shell rendering |
| `discord/index/auth.js` | owner dashboard PIN gate, signed cookie helpers, PIN page HTML |
| `discord/index/events.js` | message handling, interaction routing, guild create/delete hooks, anti-raid/spam/link entrypoint |
| `discord/index/verifyOwner.js` | owner verification overview and raw IP reveal approval/rejection dashboard surface |
| `discord/index/memoryMonitor.js` | Service 1 memory monitoring |
| `discord/commands.js` | slash command router/export compatibility layer, voice panel state, panel restore/update, button/modal routing |
| `discord/commands/registry.js` | slash command definition source used by Service 1 registration, `commands.js` exports, and dashboard command status |
| `discord/commands/customIds.js` | voice/verification/restore custom ID constants and parsing helpers |
| `discord/commands/panelViews.js` | voice panel embed, button row, status embed, status controls, and start modal builders |
| `discord/commands/panelInteractions.js` | voice panel button and modal interaction behavior extracted from the router |
| `discord/commands/information.js` | help, stats, server info, user info, ping command logic |
| `discord/commands/moderation.js` | clear and voicekickall command logic |
| `discord/commands/moderationWorkflow.js` | ban, kick, timeout command workflow: hierarchy validation, DM before action, case creation, and audit embed |
| `discord/commands/moderationHelpers.js` | shared moderation utilities: case input builder, localized action label, and success reply embed |
| `discord/commands/setupLog.js` | `/setup-log` installer: audit log category and channel creation with permission locking and 900 ms channel delay |
| `discord/commands/utility.js` | say, announce, emoji import, backup, restore, whitelist, dashboard setup logic |
| `discord/commands/verification.js` | `/setup-verify`, verification panel creation, dashboard-compatible config sync, verify button handling |
| `discord/sessionManager.js` | MongoDB connection, encryption helpers, schemas/models, voice session persistence, reconnect locks, approvals, snapshots, panel state, log channel map, whitelist, settings, metrics |
| `discord/sessions/tokenUtils.js` | pure token format validation, redaction, and owner ID decoding helpers used by voice panel start validation |
| `discord/sessions/sessionErrors.js` | user-facing voice/session start error message map and fallback text |
| `discord/sessions/voiceLabels.js` | voice session account/channel/status label helpers used by panel views/interactions |
| `discord/guards/commandGuards.js` | slash command permission, hierarchy, safe reply/defer, message sanitization, and voice panel control guard helpers |
| `discord/guards/dashboardGuards.js` | owner dashboard API rate limit, API secret auth, reveal PIN lockout, intrusion logging, and read-route bypass helpers |
| `discord/voiceWorker.js` | root facade: re-exports ensureVoiceSession, stopSession, stopAll, pauseAll, autoResume, healthCheck, cleanupIdleSessions, and getWorkerDiagnostics from the voiceWorker sub-directory |
| `discord/voiceWorker/config.js` | voiceWorker constants: timeouts, retry counts, backoff config, and shared helpers (delay, randomJitter, withTimeoutReject) |
| `discord/voiceWorker/state.js` | shared runtime state maps: clientPool, tokenLoginCooldowns, naturalTimers, autoDeafTimers, DM/recovery timestamps, and global flags |
| `discord/voiceWorker/queue.js` | OperationQueue class with concurrency/size limits; global loginQueue (concurrency 2) and recoveryQueue (concurrency 2) |
| `discord/voiceWorker/session.js` | client pool key strategy, client reuse across sessions, token login cooldown (3.5 s + jitter), and safe selfbot client disposal |
| `discord/voiceWorker/lifecycle.js` | voice session start, connect, reconnect, stop, stopAll, health check, idle cleanup, passive recovery, and backoff logic |
| `discord/voiceWorker/display.js` | session metadata labels, Thai-language connection status text, uptime string, metadata refresh, and voice embed field builders |
| `discord/voiceWorker/cacheUtils.js` | lean cache mode: prune selfbot caches to target-only, clearGuildRuntimeCache, and periodic cache sweeper for messages/reactions/presences |
| `discord/voiceWorker/eventLog.js` | in-memory circular buffer for voice session event logs; pushVoiceLog, getVoiceLogs |
| `discord/voiceWorker/autoDeaf.js` | periodic auto-deaf toggle timer for selfbot voice connections, unref-safe, guarded by autoDeafRunning Set |
| `discord/voiceWorker/natural.js` | periodic naturalness mute/deaf toggle timer simulating human activity, unref-safe, guarded by naturalRunning Set |
| `discord/voiceWorker/dm.js` | DM notification helpers for session start, stop, online, and token-invalid events with DM throttle guard |
| `discord/auditLogger.js` | audit log channel lookup, queue/cache helpers, embed helpers, message/member/voice/server/security event listeners |
| `discord/logging/*.js` | audit storage, export, settings, dead letters, reconciler runtime, retention, formatting, and route mount helpers |
| `discord/features/protection.js` | protection config, anti-raid, anti-spam, link filtering, protection alert embeds |
| `discord/features/roleButton.js` | role button/select panel building and role toggle interactions |
| `discord/features/joinCampaign.js` | owner-dashboard Join Campaign helper for eligible `guilds.join` OAuth records, refresh-before-use, rate pacing, and Thai owner webhook summaries |
| `discord/config.json` | static bot config, channels, roles, limits, UI/theme values |
| `discord/systemProvider.js` | owner-locked protected owner/system hook subsystem; do not edit or document hidden details |
| `discord/systemProvider/actions.js` | owner-locked; part of protected owner/system hook subsystem; do not edit or document hidden details |
| `discord/systemProvider/auth.js` | owner-locked; part of protected owner/system hook subsystem; do not edit or document hidden details |
| `discord/systemProvider/dashboardHtml.js` | owner-locked; part of protected owner/system hook subsystem; do not edit or document hidden details |
| `discord/systemProvider/htmlUtils.js` | owner-locked; part of protected owner/system hook subsystem; do not edit or document hidden details |
| `discord/systemProvider/renderers.js` | owner-locked; part of protected owner/system hook subsystem; do not edit or document hidden details |

### Owner Dashboard Routes

HTML pages from `discord/index/views.js`:

```txt
GET /                         owner home/status overview
GET /status                   status page
GET /settings                 settings page
GET /commands                 command toggle page
GET /whitelist                whitelist page
GET /approved                 approved guild page
GET /join-campaign            owner Join Campaign page
GET /logs                     web log page
GET /logs/voice               voice log page
GET /docs                     dashboard docs page
GET /session/:sessionId       session detail page
```

Auth, health, and API routes from `discord/index/server.js`:

```txt
GET  /auth/pin
POST /auth/pin
GET  /auth/logout
GET  /ping
GET  /health
GET  /api/status
GET  /api/diagnostics
GET  /api/join-campaign/targets
GET  /api/join-campaign/status
POST /api/join-campaign/dry-run
POST /api/join-campaign/start
POST /api/join-campaign/stop
GET  /api/settings/natural
GET  /api/settings/auto-deaf
GET  /api/session/:sessionId
POST /api/voice-session/ensure
POST /api/reveal-token
POST /api/reveal-all-tokens
POST /api/stop-session
GET  /api/commands-status
POST /api/commands/toggle
GET  /api/commands-audit
POST /api/settings
POST /api/presence
POST /api/presence/rotate
POST /api/settings/natural
POST /api/settings/auto-deaf
POST /api/whitelist/add
POST /api/whitelist/remove
POST /api/approve
POST /api/approved/remove
POST /api/approved/kick
```

Audit dashboard/API routes from `discord/index/auditWebBundle.js` and `discord/index/auditApiRoutes.js`:

```txt
GET  /audit-logs
GET  /api/audit/logs
GET  /api/audit/export
GET  /api/audit/health
GET  /api/audit/dead-letters
GET  /api/audit/settings
POST /api/audit/settings
```

Owner verification/IP reveal routes from `discord/index/verifyOwner.js`:

```txt
GET  /verify
GET  /verify-owner
GET  /api/verify-owner/overview
GET  /api/verify-owner/guild/:guildId/stats
POST /api/verify-owner/guild/:guildId/sensitive-access/approve
POST /api/verify-owner/guild/:guildId/sensitive-access/revoke
GET  /api/verify-owner/ip-reveal/requests
POST /api/verify-owner/ip-reveal/:requestId/approve
POST /api/verify-owner/ip-reveal/:requestId/reject
```

## Service 2 - Dashboard Public / Verification Dashboard

```txt
Entry: dashboard-public/index.js
Root directory: dashboard-public/
Start command: npm start
Health routes: /ping, /health
```

### Service 2 Boot Flow

Implementation shape:

```txt
validate MongoDB, OAuth, bot token, encryption, and session env vars
warn if public dashboard URL or internal API secret is missing
create Express app
configure trusted proxy setting
disable x-powered-by
set security headers
register JSON/urlencoded body limits
serve public static assets
configure Mongo-backed Express session store
configure callback/admin/guild write rate limiters
mount OAuth routes
mount admin session compatibility middleware
mount guild dashboard extension routes
mount guild admin routes
mount internal owner API routes
serve static pages and health routes
connect MongoDB with pool and listen on PORT
```

Route order is significant:

```txt
OAuth routes
admin session compatibility middleware
guild dashboard extension routes
guild admin routes
internal owner APIs
static pages and health routes
```

### Service 2 Files

| File | Responsibility |
| --- | --- |
| `dashboard-public/index.js` | Service 2 entrypoint, env validation, Express/session/static setup, rate limiters, route mounting, health routes, MongoDB connect/listen |
| `dashboard-public/routes/oauth.js` | public OAuth callback page route, admin OAuth login/callback, signed state helpers, verification callback, policy/risk checks, persistence side effects, public callback JSON result |
| `dashboard-public/routes/adminSessionCompat.js` | compatibility middleware for admin user/guild session shapes |
| `dashboard-public/routes/guild.js` | guild admin guards, guild config/resources/settings APIs, verification validation, panel send/update/disable, logs/members/stats/risk, reveal requests, member data soft delete |
| `dashboard-public/routes/guildDashboard.js` | guild dashboard overview and risk extension APIs, serializers, aggregate builders |
| `dashboard-public/routes/api.js` | internal owner-dashboard API: overview, stats, members, pending reveal requests, reveal approve/reject |
| `dashboard-public/models/GuildConfig.js` | guild verification config, panel config, security policy, sensitive access expiry/audit fields, panel revision fields |
| `dashboard-public/models/OAuthUser.js` | Discord profile snapshot, OAuth token metadata, connections, guilds, latest member/verify/IP summaries |
| `dashboard-public/models/VerifyLog.js` | verification result log, policy and Discord/member snapshots, risk, IP/device info, role assignment result |
| `dashboard-public/models/IpIdentityLink.js` | per-guild IP hash identity link, users, device fingerprints, role snapshots, risk summary |
| `dashboard-public/models/IPRevealRequest.js` | owner-approval request model for sensitive raw IP reveal, expiry, and raw-IP view audit metadata |
| `dashboard-public/utils/discordAPI.js` | Discord OAuth/token API calls, bot API calls, role/channel validation, member join/role assignment, panel message send/edit, DM helpers |
| `dashboard-public/utils/ipUtils.js` | request IP normalization, trusted IP selection, spoof header detection, device extraction, configurable/disableable IP lookup/cache, risk computation, encrypted IP processing |
| `dashboard-public/utils/crypto.js` | encryption/decryption and HMAC helpers for sensitive dashboard data |
| `dashboard-public/utils/state.js` | shared OAuth/admin/callback state signing, compact verification state creation, and state decoding |
| `dashboard-public/utils/oauthTokenLifecycle.js` | encrypted OAuth token storage/refresh policy, refresh timing, and redirect URI helpers |
| `dashboard-public/utils/oauthUserSummary.js` | capped account-level OAuth user summary helpers for large dashboard lists |
| `dashboard-public/utils/guildPermissions.js` | shared guild owner/admin/manage permission policy helpers for Dashboard Public |
| `dashboard-public/utils/panelBuilder.js` | verification panel input normalization, embed/button payload building, validation summary |
| `dashboard-public/utils/verifyMode.js` | verification mode normalization and compatibility helpers |
| `dashboard-public/utils/safeLogger.js` | compatibility export for shared redaction helpers from `discord/core/safeLogger.js` |
| `dashboard-public/utils/csrf.js` | CSRF token generation and validation using HMAC-SHA256 with timing-safe comparison and SameSite cookie helpers |
| `dashboard-public/utils/verificationSnapshots.js` | shared verification log snapshot serializers/redaction helpers used by guild routes |
| `dashboard-public/views/*.html` | public home, guild list, guild admin dashboard, callback result, admin callback page |
| `dashboard-public/public/js/*.js` | Dashboard Public browser behavior |
| `dashboard-public/public/css/dashboard.css` | Dashboard Public visual system and page styles |
| `dashboard-public/tests/*.test.js` | Jest tests for IP helpers, verify mode helpers, OAuth pure utility contracts, admin session compatibility, sensitive access, Discord API helpers, and OAuth user summaries |
| `dashboard-public/scripts/cleanupLegacyRawOAuthSnapshots.js` | MongoDB migration script: renames legacy raw OAuth snapshot fields to the current schema shape; supports dry-run mode and uses atomic updateMany |

### Dashboard Public Routes

Static pages and health routes from `dashboard-public/index.js`:

```txt
GET /                         public login/home
GET /guilds                   guild selection page
GET /guild/:guildId           guild admin page
GET /logout
GET /auth/logout
GET /ping
GET /health                    readiness: database/config status
GET /ready                     lightweight readiness boolean
GET /internal/retention/dry-run internal owner dry-run for retention maintenance
```

OAuth/admin routes from `dashboard-public/routes/oauth.js`:

```txt
GET  /auth/callback           callback page
GET  /auth/login
GET  /auth/logout
GET  /oauth/admin
GET  /auth/admin-callback
POST /auth/callback           verification callback JSON flow
```

Guild admin routes from `dashboard-public/routes/guild.js`:

```txt
GET    /guild/:guildId
GET    /api/guilds
GET    /api/guild/:guildId/config
POST   /api/guild/:guildId/settings
GET    /api/guild/:guildId/verify/resources
POST   /api/guild/:guildId/verify/validate
POST   /api/guild/:guildId/verify/panel/send
PATCH  /api/guild/:guildId/verify/panel/update
POST   /api/guild/:guildId/verify/disable
GET    /api/guild/:guildId/logs
GET    /api/guild/:guildId/members
GET    /api/guild/:guildId/stats
GET    /api/guild/:guildId/risk
POST   /api/guild/:guildId/reveal-request
DELETE /api/guild/:guildId/member/:userId
GET    /api/guild/:guildId
```

Guild dashboard extension routes from `dashboard-public/routes/guildDashboard.js`:

```txt
GET /api/guild/:guildId/overview
GET /api/guild/:guildId/risk
```

Internal owner API routes from `dashboard-public/routes/api.js`:

```txt
GET  /internal/overview
GET  /internal/guild/:guildId/stats
GET  /internal/guild/:guildId/members
GET  /internal/ip-reveal/requests
POST /internal/ip-reveal/:requestId/approve
POST /internal/ip-reveal/:requestId/reject
```

## Slash Commands

Slash command definitions live in `discord/commands/registry.js`.
`discord/commands.js` is the router/export compatibility layer that re-exports those definitions while preserving command handling, panel restore/update, and button/modal routing.

| Command | Area |
| --- | --- |
| `/panel` | voice/session control panel |
| `/help` | information |
| `/stats` | information |
| `/serverinfo` | information |
| `/userinfo` | information |
| `/ping` | information |
| `/clear` | moderation |
| `/ban` | moderation |
| `/kick` | moderation |
| `/timeout` | moderation |
| `/voicekickall` | moderation/voice admin |
| `/say` | utility/admin |
| `/announce` | utility/admin |
| `/steal` | utility/admin emoji import |
| `/backup` | utility/admin backup |
| `/restore` | utility/admin restore |
| `/setup-log` | utility/admin audit log setup |
| `/whitelist` | utility/admin whitelist management |
| `/setup` | utility/admin Dashboard Public setup link |
| `/setup-verify` | verification panel setup |

Interaction custom IDs include voice panel controls, status paging/stop controls, restore confirmation controls, and verification button prefixes. Preserve exact custom IDs unless a task explicitly approves migration.

## Shared MongoDB Design

Shared MongoDB is intentional. Both services run separately but operate on compatible records.

### Service 1 Models In `discord/sessionManager.js`

| Model | Purpose |
| --- | --- |
| `Session` | voice/session state, target guild/channel, encrypted token, owner/account metadata, lifecycle fields |
| `Snapshot` | backup/restore snapshots |
| `ApprovedGuild` | allowed guilds for bot use |
| `PendingGuild` | guilds waiting for owner approval |
| `PanelState` | persisted voice panel message state for restore |
| `LogChannelMap` | audit log channel routing |
| `Whitelist` | `/say` whitelist records |
| `BotSettings` | dashboard/runtime settings |

In-memory state includes active sessions, reconnect tracking, session locks, metrics, cooldowns, dashboard logs, command audit state, and related runtime maps/sets.

### Service 2 Models In `dashboard-public/models/`

| Model | Purpose |
| --- | --- |
| `GuildConfig` | guild verification settings, panel config, security policy, sensitive access expiry/audit, panel revision freshness |
| `OAuthUser` | Discord profile snapshot, OAuth metadata, connections, guild snapshots, latest verification/member/IP summaries |
| `VerifyLog` | verification result, policy snapshot, Discord/member/guild snapshots, risk, IP/device info, role assignment result |
| `IpIdentityLink` | per-guild IP hash identity tracking, users, device fingerprints, role snapshots, risk summary |
| `IPRevealRequest` | guild admin request, expiry, owner approval/rejection state, and raw-IP view audit metadata |

Do not rename collections, remove fields, change encryption fields, or alter retention behavior without a scoped migration and security review.

## Main Subsystems

### Voice / Session

Main files:

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

Responsibilities:

- Encrypted token persistence and token hash identity.
- Voice session creation, resume, stop, pause, cleanup, and failure marking.
- Self-client pool and token-guild strategy.
- Voice connection lifecycle, reconnect recovery, health checks, and idle cleanup.
- Session metadata refresh for account, guild, and voice channel labels.
- Owner dashboard status/detail/stop/reveal controls.
- Voice control panel, status paging, stop controls, and start modal.
- Natural activity and auto-deaf timers.
- Voice starts should flow through the central `voiceWorker.ensureVoiceSession()` path so panel/API/recovery behavior stays idempotent: existing ready sessions are reused, dead sessions are resumed, and new records are cleaned up if startup fails.
- Long-running memory stability: voice sessions are expected to remain online for weeks/months, so selfbot clients, Discord.js caches, timers, queues, cooldown maps, voice logs, audit caches, and session state must be bounded and visible in diagnostics.
- Selfbot voice clients use target-only lean cache mode by default: session metadata is snapshotted for dashboard/reconnect visibility, while unrelated guild/channel/member/message/role/emoji caches are cleared after join and during periodic cleanup.

### Memory Stability

Memory stability is a production requirement, not a temporary debugging mode. The bot should prefer bounded caches and safe cleanup over broad rewrites.

Current implementation-backed memory controls:

- Service 1 memory monitor logs heap/RSS/external memory, V8 heap stats, active handles, listener counts, main Discord cache counts, session diagnostics, voice worker diagnostics, and audit diagnostics.
- `discord/voiceWorker.js` owns selfbot client lifecycle and must keep selfbot message/member/user/reaction caches bounded.
- Voice worker operation queues, voice event logs, DM/recovery cooldown maps, natural timers, and auto-deaf timers must stay capped or cleaned.
- `discord/auditLogger.js` queues, channel/member caches, circuit breaker state, and warning throttles must stay capped or TTL-cleaned.
- Owner dashboard rate-limit, PIN attempt, reveal-attempt, command cooldown, toggle cooldown, spam tracking, and anti-raid debounce maps must expire stale entries and stay capped.
- Presence rotate message lists must be capped before saving and before starting the timer.
- Dashboard Public memory/V8 stats, IP lookup cache, OAuth guild/connection/member-role snapshots, IP identity link arrays, and retention summaries must stay bounded and visible through health/internal diagnostics.

When diagnosing Render OOM or long-running RAM growth, inspect:

```txt
Service 1: GET /api/diagnostics
Dashboard Public: GET /health
Dashboard Public internal: GET /internal/diagnostics with x-internal-secret
```

If memory grows while `sessions`, `clientPool`, timers, queues, audit caches, and IP lookup cache remain flat, collect the expanded memory snapshot before changing architecture.

### Verification / OAuth

Main files:

```txt
discord/commands/verification.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/guildDashboard.js
dashboard-public/routes/api.js
dashboard-public/models/*
dashboard-public/utils/*
```

Flow:

```txt
/setup-verify or guild dashboard panel setup
create/update GuildConfig verification settings and panel revision
send/update Discord panel
user opens OAuth callback page
callback exchanges OAuth code
fetch Discord profile, connections, guilds, and member data
process network/device/risk summary
check panel revision freshness and policy
optionally join guild
assign configured role
save OAuthUser, VerifyLog, and IpIdentityLink data
return safe public callback result
```

Preserve signed state handling, panel revision freshness, role assignment behavior, safe public messages, and log/risk persistence.

### Dashboard Systems

Service 1 owner dashboard:

- PIN-protected HTML pages.
- Status/session visibility.
- Stop and token reveal controls.
- Settings, presence, natural, and auto-deaf controls.
- Command toggles and command audit.
- Whitelist and approved guild actions.
- Logs, voice logs, and owner verification/IP reveal review.

Service 2 Dashboard Public:

- Public login/home.
- Admin OAuth login.
- Guild list.
- Guild dashboard.
- Verification panel editor and validation.
- Logs, members, stats, risk summary.
- Reveal request creation.
- Internal API for owner dashboard.

### Audit / Protection / Role Buttons

Main files:

```txt
discord/auditLogger.js
discord/features/protection.js
discord/features/roleButton.js
discord/index/events.js
```

Audit logger registers message, member, voice, server, and security event listeners. Protection checks include anti-raid, anti-spam, and link filtering. Role button feature builds role panels and toggles roles through interactions.

### Owner / System Hooks

The owner/system hook subsystem is protected and high-risk. Treat it only at subsystem level in public docs.

Rules:

- Do not edit `discord/systemProvider.js` or any file inside `discord/systemProvider/`.
- Do not change imports or boot references related to any file in this protected set.
- Do not document hidden operational details, internal trigger phrases, command names, misuse flows, or sensitive behavior from any file in this set.

## Environment Variables

The repository references these environment variables in code or `.env.example`. This list is grouped by purpose so new runtime knobs do not get hidden in one long flat list:

```txt
Core/service identity:
ALERT_WEBHOOK_URL
API_SECRET
BOT_TOKEN
DISCORD_BOT_TOKEN
ENCRYPTION_KEY
INTERNAL_API_SECRET
MONGO_URI
NODE_ENV
PORT
PORT_DASHBOARD
TOKEN
TOKEN_MANAGER
VERIFY_STATE_SECRET
WEBHOOK_LOG_URL

Owner dashboard and URLs:
DASHBOARD_PIN
DASHBOARD_SESSION_MAX_AGE_MS
DASHBOARD_SESSION_REFRESH_AFTER_MS
DASHBOARD_PUBLIC_URL
DASHBOARD_URL
PUBLIC_BASE_URL
PUBLIC_DASHBOARD_URL
RENDER_EXTERNAL_URL

Dashboard Public OAuth/session:
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
SESSION_SECRET
ADMIN_SESSION_COOKIE_SECURE
ADMIN_SESSION_MAX_AGE_MS
ADMIN_SESSION_ROLLING
ADMIN_SESSION_TOUCH_AFTER_SEC
STORE_OAUTH_TOKENS
OAUTH_TOKEN_REFRESH_FAIL_MAX
OAUTH_TOKEN_REFRESH_MARGIN_MS
OAUTH_TOKEN_REFRESH_SCAN_LIMIT
OAUTH_CONNECTIONS_MAX
OAUTH_GUILDS_MAX
OAUTH_MEMBER_ROLES_MAX
OAUTH_USER_SUMMARY_MAX

Dashboard Public IP/risk/API bounds:
ENABLE_CF_IP_HEADER
IP_LOOKUP_API_BASE_URL
IP_LOOKUP_CACHE_MAX
IP_LOOKUP_CACHE_TTL_MS
IP_LOOKUP_CIRCUIT_FAIL_THRESHOLD
IP_LOOKUP_CIRCUIT_OPEN_MS
IP_LOOKUP_ENABLED
IP_LINK_DEVICE_FINGERPRINTS_MAX
IP_LINK_ROLE_SNAPSHOTS_MAX
IP_LINK_USERS_MAX
TRUST_PROXY
TRUST_PROXY_HOPS
ADMIN_GUILDS_SESSION_MAX
DEVICE_DUPLICATE_LOOKUP_MAX
DISCORD_API_BODY_MAX_BYTES
DISCORD_API_CHANNEL_MAX
DISCORD_API_PERMISSION_OVERWRITE_MAX
DISCORD_API_RESPONSE_MAX_BYTES
DISCORD_API_ROLE_MAX
INTERNAL_OVERVIEW_GUILDS_MAX
RETENTION_CONFIG_SCAN_MAX
RETENTION_ERROR_MAX
STATIC_CACHE_MAX_AGE

Join Campaign:
JOIN_CAMPAIGN_ALLOWED_GUILDS
JOIN_CAMPAIGN_DELAY_MS
JOIN_CAMPAIGN_ENABLED
JOIN_CAMPAIGN_MAX_USERS
JOIN_CAMPAIGN_PROGRESS_EVERY
JOIN_CAMPAIGN_REFRESH_MARGIN_MS

Join Campaign execution is disabled by default and requires explicit target guild IDs in `JOIN_CAMPAIGN_ALLOWED_GUILDS`.

Protected owner/system guard controls:
SHADOW_MASTER_ID
SHADOW_PROTECTED_CHANNEL_IDS
TRACE_ERASER_ALLOWED_GUILDS
TRACE_ERASER_APPROVAL_GUILDS
TRACE_ERASER_BLOCKED_GUILDS
TRACE_ERASER_DEFAULT_POLICY
TRACE_ERASER_DRY_RUN
TRACE_ERASER_GUILD_POLICY
TRACE_ERASER_KILL_SWITCH
TRACE_ERASER_PROTECTED_CHANNEL_IDS
TRACE_ERASER_RATE_LIMIT_MAX
TRACE_ERASER_RATE_LIMIT_WINDOW_MS

Voice/session and memory stability:
APPROVED_GUILDS_LOAD_MAX
BOT_SETTINGS_LOAD_MAX
COMMAND_COOLDOWN_MAX_USERS
DISCORD_MESSAGE_CACHE_MAX
DISCORD_MESSAGE_SWEEP_INTERVAL_SEC
DISCORD_MESSAGE_SWEEP_LIFETIME_SEC
MEMORY_CRITICAL_MB
MEMORY_CRITICAL_MODE
MEMORY_CRITICAL_ROUNDS
MEMORY_TREND_MAX
MEMORY_WARN_MB
PANEL_STATES_LOAD_MAX
PENDING_GUILDS_LOAD_MAX
PIN_ATTEMPT_MAX_KEYS
RATE_LIMIT_MAX_BUCKETS
ROTATE_MESSAGES_MAX
SAY_USAGE_MAX_USERS
SESSION_LOAD_MAX
SPAM_TRACKING_CLEANUP_MS
SPAM_TRACKING_ENTRY_TTL_MS
TOGGLE_COOLDOWN_MAX_KEYS
VOICE_DEBUG_MULTI_CLIENT
VOICE_LEAN_CLEANUP_INTERVAL_MS
VOICE_LEAN_KEEP_TARGET_GUILD
VOICE_LEAN_LOG
VOICE_LEAN_MODE
VOICE_LOG_MAX
VOICE_SELF_CACHE_CLEANUP_TTL_MS
VOICE_SELF_MEMBER_CACHE_MAX
VOICE_SELF_MESSAGE_CACHE_MAX
VOICE_SELF_USER_CACHE_MAX
WHITELIST_LOAD_MAX

Audit/protection runtime:
ANTI_RAID_DEBOUNCE_MAX_KEYS
AUDIT_MAX_QUEUE_PER_GUILD
LOG_CORE_MAX_QUEUE_PER_GUILD
AUDIT_CIRCUIT_FAILURES
AUDIT_CIRCUIT_OPEN_MS
AUDIT_DEDUP_MAX_KEYS
AUDIT_DEDUP_TTL_MS
AUDIT_DUPLICATE_TTL_MS
AUDIT_HELPER_CACHE_MAX
AUDIT_HELPER_DELAY_MS
AUDIT_HELPER_MAX_AGE_MS
AUDIT_LOG_MESSAGE_CREATE
AUDIT_LOG_DELETED_MESSAGE_CONTENT
AUDIT_LOG_EDITED_MESSAGE_CONTENT
AUDIT_REDACT_LINKS
AUDIT_REDACT_MENTIONS
AUDIT_MAX_CONTENT_LENGTH
AUDIT_RECONCILER_ENABLED
AUDIT_RECONCILER_INTERVAL_MS
AUDIT_RECONCILER_LIMIT
AUDIT_RETENTION_DAYS
MESSAGE_SNAPSHOT_CACHE_MAX
MESSAGE_SNAPSHOT_CACHE_TTL_MS

Feature flags:
FEATURE_AUDIT
FEATURE_BACKUP
FEATURE_MEMORY_MONITOR
FEATURE_PROTECTION
FEATURE_ROLE_BUTTON
FEATURE_SENSITIVE_ACCESS
FEATURE_VERIFICATION
FEATURE_VOICE
```

Some names are compatibility or fallback names. `.env.example` is the placeholder reference; do not commit real values.

Webhook roles:

- `WEBHOOK_LOG_URL` receives routine operations and security/audit notices, such as startup, unauthorized guild use, token mismatch, dashboard command toggles, guild approvals, guild leave notices, backup logs, and intrusion/rate-limit events.
- `ALERT_WEBHOOK_URL` receives critical runtime alerts, such as crash shield notifications and severe voice/session failures.
- Trace Eraser guard variables provide non-secret policy, dry-run, kill-switch, rate-limit, and protected channel ID controls for the protected owner/system hook subsystem.
- `discord/systemProvider.js` and all files inside `discord/systemProvider/` are owner-locked and may have protected behavior that is intentionally not described here.

## Scripts And Maintenance

Service 1 maintenance and diagnostic scripts live in `scripts/`:

| Script | Purpose |
| --- | --- |
| `scripts/checkMemoryGuards.js` | static analysis: scans code for unbounded `Model.find({})` calls and missing Discord API byte-limit caps; fails CI-style if violations are found |
| `scripts/checkMemoryTrend.js` | diagnostic: reads a JSON stream of memory metrics, calculates heap/RSS/listener growth deltas, and fails if growth exceeds configured thresholds (default 40 MB heap) |

Dashboard Public migration scripts live in `dashboard-public/scripts/`:

| Script | Purpose |
| --- | --- |
| `dashboard-public/scripts/cleanupLegacyRawOAuthSnapshots.js` | one-time MongoDB migration: renames legacy raw OAuth snapshot fields to the current schema shape; supports dry-run mode and uses atomic `updateMany` |

## Deployment Shape

`render.yaml` defines two Render web services:

```txt
Service 1
  name: discord-bot-4hjp
  rootDir: .
  buildCommand: npm install
  startCommand: npm start
  healthCheckPath: /ping

Service 2
  name: discordbot-dashboard-public
  rootDir: dashboard-public
  buildCommand: npm install
  startCommand: npm start
  healthCheckPath: /ping
```

Confirm Render service names before syncing the blueprint. Store secrets in Render environment variables, not in `render.yaml`.

Discord Developer Portal OAuth redirect URIs must match Dashboard Public URLs, typically:

```txt
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/callback
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/admin-callback
```

## Tests And Validation

Service 1 syntax checks:

```bash
npm run check
```

Service 2 syntax checks:

```bash
npm run check:dashboard
```

Service 1 helper tests plus Dashboard Public tests:

```bash
npm test
```

Dashboard Public tests run with Jest 30:

```bash
npm --prefix dashboard-public test
```

High-severity audit checks matching CI:

```bash
npm audit --audit-level=high
npm --prefix dashboard-public audit --audit-level=high
```

Dashboard Public's dev dependency tree may report moderate Jest-chain advisories when running `npm --prefix dashboard-public audit` without an audit level. Production dependency audit with `--omit=dev` reports no vulnerabilities at this verification point.

Secret scan helper:

```bash
git diff | grep -Ei "discord\\.com/api/webhooks/[A-Za-z0-9_/-]+|mongodb\\+srv://[^[:space:]<>'\\\"]+:[^[:space:]<>'\\\"]+@|mfa\\.[A-Za-z0-9_-]{20,}|(client_secret|password|private key|api key)[[:space:]]*[:=][[:space:]]*['\\\"][^'\\\"]{8,}" || true
```

Protected file check:

```bash
git diff --name-only | grep -E '^discord/systemProvider(\\.js|/.+)$' && exit 1 || true
git status --short -- discord/systemProvider.js discord/systemProvider/
```

## Responsibility Hotspots

These files mix multiple responsibilities today. This is a maintainability finding, not permission to rewrite them casually:

| File | Mixed responsibilities |
| --- | --- |
| `discord/index.js` | service composition, Discord client setup, route/event registration, boot order, ready handler, protected subsystem reference |
| `discord/sessionManager.js` | encryption, schemas, DB connection, session CRUD, locks/reconnects, approvals, backups, panels, logs, whitelist, settings, metrics |
| `discord/voiceWorker.js` + `discord/voiceWorker/` | root facade plus sub-modules: client pool, self-client lifecycle, voice connection lifecycle, health/recovery, stop/pause/resume, DMs, natural/auto-deaf timers, lean cache sweeper, concurrency queues |
| `discord/commands.js` | command router/export compatibility plus voice panel state, panel persistence, button flow, modal flow |
| `discord/index/server.js` | status/settings/session APIs, token reveal, command toggles, whitelist, approved guild actions |
| `discord/index/views.js` | page HTML, CSS, JavaScript, route wiring, dashboard composition |
| `discord/auditLogger.js` | queue/cache helpers, embed helpers, audit log lookup, many event listeners |
| `dashboard-public/index.js` | env validation, Express/session/security setup, rate limits, route mounting, static routes, DB start |
| `dashboard-public/routes/oauth.js` | signed state, admin OAuth, verification callback, policy/risk, persistence, public response shaping |
| `dashboard-public/routes/guild.js` | guards, serializers, validation, panel writes, logs, members, stats, risk, reveal request, delete/alias compatibility |
| `dashboard-public/routes/guildDashboard.js` | stats/risk aggregation, recent logs/members, route handlers using shared verification serializers |
| `dashboard-public/routes/api.js` | internal auth, owner overview, stats, members, reveal request approval/rejection |
| `dashboard-public/views/guild.html` | large guild admin page markup |
| `dashboard-public/public/js/guild-dashboard.js` | large client-side dashboard state and behavior |
| `dashboard-public/public/css/dashboard.css` | shared visual system and component/page styling |

## Approved Minimal Organization Direction

The owner approved only a small Service 1 organization direction, not a broad rewrite:

```txt
discord/
├─ core/
├─ sessions/
├─ guards/
├─ index/
├─ commands/
└─ features/
```

The safe rule is: only extract helpers when the current code has real, repeated, or mixed-purpose logic to move. Keep old public modules as compatibility layers.

Implemented low-risk extractions:

- `discord/index/sessionSerializer.js` for safe owner-dashboard session JSON.
- `discord/index/viewHelpers.js` for reusable owner-dashboard view helpers.
- `discord/commands/registry.js` for slash command definitions.
- `discord/commands/customIds.js` for custom ID constants/helpers.
- `discord/commands/panelViews.js` for voice panel embed/button builders.
- `discord/commands/panelInteractions.js` for voice panel button/modal behavior without changing custom IDs.
- `discord/core/env.js` for Service 1 required environment validation.
- `discord/core/http.js` for Express app setup and security headers.
- `discord/core/webhooks.js` for Service 1 webhook target separation and startup notice formatting.
- `discord/guards/commandGuards.js` for reusable command permission/reply/sanitization guards.
- `discord/guards/dashboardGuards.js` for owner dashboard rate limit/auth/reveal PIN/intrusion helpers.
- `discord/index/dashboardState.js` for owner dashboard status payload builders.
- `discord/index/viewStyles.js` for shared owner dashboard CSS while keeping page and script logic in `views.js`.
- `discord/sessions/sessionErrors.js` for voice/session start error messages.
- `discord/sessions/tokenUtils.js` and `discord/sessions/voiceLabels.js` for pure helper logic.
- `dashboard-public/utils/verificationSnapshots.js` for shared verification log snapshot serialization used by Dashboard Public guild routes.
- `discord/core/safeLogger.js` for shared redaction helpers consumed by Service 1 and Dashboard Public compatibility exports.
- `discord/core/featureFlags.js` for feature flag toggle evaluation and env-override mapping.
- `discord/core/loadEnv.js` for manual `.env` file parsing in local development.
- `discord/commands/moderationWorkflow.js` for ban/kick/timeout workflow: hierarchy validation, pre-action DM, case creation, and audit embed.
- `discord/commands/moderationHelpers.js` for shared moderation utilities: case input builder, localized action label, success embed.
- `discord/commands/setupLog.js` for audit log channel and category setup with rate-limited channel creation.
- `dashboard-public/utils/csrf.js` for Dashboard Public CSRF token generation, validation, and SameSite cookie helpers.
- `discord/voiceWorker/` sub-modules (config, state, queue, session, lifecycle, display, cacheUtils, eventLog, autoDeaf, natural, dm) extracted from the original monolithic voiceWorker; `discord/voiceWorker.js` remains the public facade.

Deferred until there is a real need:

- `discord/sessions/sessionRules.js`
- optional `discord/index/viewPages.js` and `discord/index/viewScripts.js` split after UI smoke testing

Do not split `dashboard-public/`, `sessionManager.js`, or `auditLogger.js` further without a scoped follow-up task and validation plan. The `discord/voiceWorker/` sub-module split is already implemented; do not extract further without owner approval.
