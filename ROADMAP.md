# Roadmap

Last reviewed: 2026-09-22.

## Current architecture baseline

- One repository and one Node.js 24.18 LTS runtime.
- One Express listener on `PORT || 3000`.
- One shared Mongoose connection.
- Main bot, voice/session, Dashboard ควบคุมบอท, Token Hub, Quest automation, OAuth verification, maintenance, and
  protection start through `npm start`.
- Verification management is Owner PIN only.
- Member OAuth callback remains public.
- Existing MongoDB collections and encryption compatibility are retained.
- The primary bot runs `discord.js` v14; the isolated Voice account client is
  retained until a supported replacement can preserve that lifecycle.
- Protected owner/system files remain locked.

Changes that would reintroduce a second service, second port, second runtime
MongoDB connection, guild-admin OAuth sessions, or a new encryption format
require a new explicit owner decision.

## Completed in recent milestones

- **Master Token Coordinator (Token Hub)** (`discord/core/tokenCoordinator.js`):
  Implemented centralized token governance with dynamic subsystem registration, per-token activity locking, exponential backoff on HTTP 429, quarantine lifecycle with automatic subsystem alerts, and Dashboard Token Hub UI (`/api/token-hub/*`).
- **Transient Gateway Error Shielding** (`discord/index/system.js`):
  Added `isTransientGatewayError` classifier in Crash Shield to intercept Cloudflare 520–525/502–504 responses, socket blips, and WebSocket handshake timeouts. Keeps the process alive for auto-reconnect and `shardResume` instead of fatal exit.
- **Discord Quest Automation Subsystem** (`discord/quest/`):
  Full parity with reference architecture: `/quest` slash command, interactive panel, Bangkok time (UTC+7) recurring scheduler with jitter, MongoDB `ScheduledRunner`, admission control locks, live channel codeblock progress, and Owner Dashboard controls.
- **Voice Lean Mode & Memory Monitoring** (`discord/index/memoryMonitor.js`):
  Bounded cache limits (`SELF_CLIENT_CACHE_LIMITS`), aggressive pruning of non-target guild channels/members/states, and 1:1 paired AutoDeaf and Natural timers, keeping production RSS steady at ~210–230MB under 13+ concurrent sessions.
- **Comprehensive Test Suite & Quality Gates**:
  500 automated tests across 63 suites passing 100%, with 9 automated safety and AST compatibility checks (`npm run check`).
- Moved active verification models/routes/utilities/views/assets into
  `discord/verification/`.
- Mounted `/auth/callback`, `/verification`, and guild management APIs on the
  main Express app.
- Replaced cross-service Owner HTTP requests with in-process service calls.
- Removed standalone Dashboard Public startup, dependencies, session storage,
  admin OAuth routes, and deployment definition.
- Kept `/setup-verify`, signed state, panel revision, `guilds.join`, Join
  Campaign, retention, join, and role assignment flows.
- Added lightweight `/ping` liveness plus combined `/health` and `/ready` readiness.
- Added full returned guild/connection/target-role persistence and
  failure-preserving snapshot updates.
- Replaced Join Campaign's total-user ceiling and embedded per-IP history caps
  with cursor batches and paginated canonical history collections.
- Added additive snapshot/data-quality fields and dry-run/apply migration.
- Owner Dashboard full detail now returns Token, raw IP, and the complete
  Owner-visible record directly after normal authentication; no reason,
  repeated PIN, separate reveal action, or approval queue is required.
- Made snapshot persistence complete-version based with per-document BSON
  sizing, oversized-object checksum chunks, rollback recovery, and no aggregate
  truncation ceiling.
- Added a resumable, guild-scoped privacy-deletion manifest with post-delete reference verification, while keeping IP-history backfill idempotent and requiring a confirmed maintenance window for archive restore apply.
- Retired and decommissioned the legacy /backup and /restore guild snapshot subsystem to simplify bot architecture and minimize attack surface.
- Replaced the inherited Owner Verification presentation with a five-section,
  mobile-first module inside the purple Owner Dashboard while preserving routes,
  APIs, management capabilities, and the existing public OAuth callback page.
- Consolidated CI and tests under the root package.
- Retired Enterprise Audit server-activity capture, `/setup-log`, its Owner
  routes/UI, channel delivery, and runtime storage while preserving historical
  database records and Discord channels for separate cleanup.

## Near-term work

### Runtime observation

- Run a production-like single-port smoke test after environment secrets and a
  test guild are available.
- Observe memory, Discord API byte-limit counters, IP lookup circuit state,
  token refresh summaries, and voice queue diagnostics during the first deploy.
- Verify graceful shutdown on the actual host.

### Verification quality

- Run the failure-injection callback suite against a disposable MongoDB instance when CI provides one.
- Keep route-level tests for Owner PIN redirect, CSRF rejection, callback rate limiting, protected-session revocation, and readiness degradation current.
- Add explicit metrics for optional-fetch failure rates by category.

### UI maintainability

- Split the remaining large verification browser controller only as a scoped
  behavior-preserving task. Owner page structure/styles are already separated
  from the unchanged public callback surface.
- Continue focused accessibility and sensitive-review audits without exposing
  raw values in list endpoints or browser persistence.

### Operations

- Record each production release and any rollback result in `CHANGELOG.md`.
- Periodically run the verification migration in dry-run mode until all legacy
  documents contain current derived metadata.
- Review retention settings and privacy policy before changing data lifetime.

## Deferred decisions

These are not approved by this roadmap:

- reverting the primary bot from the approved `discord.js` v14 baseline
- replacing the isolated `discord.js-selfbot-v13` Voice client without a
  supported lifecycle-compatible alternative
- replacement of MongoDB
- rewrite of voice/session
- splitting the repository or verification runtime again
- new guild-admin dashboard/login
- exposing raw OAuth tokens outside the audited per-user Owner reveal action or
  adding bulk raw-IP export
- changing protected owner/system hooks

Each requires separate implementation evidence, owner approval, compatibility
analysis, rollback planning, and full validation.

## Definition of done for a production release

- MongoDB backup exists and restore steps are known.
- Unified callback URI is registered in Discord Developer Portal.
- Canonical `PUBLIC_BASE_URL` resolves to the deployed HTTPS origin; any
  retained legacy aliases match it exactly.
- `npm run check`, `npm test`, LCOV thresholds, dependency audit, secret scan, and the externally approved protected-path guard pass.
- `/ping` remains live during startup while `/health` and `/ready` report degraded until dependencies are ready.
- Owner PIN/CSRF protections are verified for every management write.
- A real OAuth flow verifies profile, optional data, guild join, target member,
  role assignment, persistence, and redaction.
- Existing records remain readable before and after migration.
- If a legacy standalone service still exists, it is stopped only after the
  unified runtime passes; current installations otherwise deploy one service.

## Owner-approved self-client dependency

`discord.js-selfbot-v13` is an intentional and necessary dependency of the isolated Voice account/session subsystem. The repository owner has explicitly approved its continued use because the current architecture has no compatible replacement that preserves the required behavior.

Do not remove, replace, migrate, rename, independently upgrade/downgrade, or convert its library-specific APIs unless the repository owner gives a new explicit instruction for that exact change. Main-bot Discord.js v14 work must remain isolated from the self-client package. See [`docs/SELF_CLIENT_POLICY.md`](docs/SELF_CLIENT_POLICY.md) for the binding maintenance policy.
