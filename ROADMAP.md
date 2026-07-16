# Roadmap

Last reviewed: 2026-07-16 (`tt`).

## Current architecture baseline

- One repository and one Node.js 24 runtime.
- One Express listener on `PORT || 3000`.
- One shared Mongoose connection.
- Main bot, voice/session, Owner Dashboard, OAuth verification, maintenance, and
  protection start through `npm start`.
- Verification management is Owner PIN only.
- Member OAuth callback remains public.
- Existing MongoDB collections and encryption compatibility are retained.
- `discord.js` remains v13.
- Protected owner/system files remain locked.

Changes that would reintroduce a second service, second port, second runtime
MongoDB connection, guild-admin OAuth sessions, or a new encryption format
require a new explicit owner decision.

## Completed in the unified-runtime milestone

- Moved active verification models/routes/utilities/views/assets into
  `discord/verification/`.
- Mounted `/auth/callback`, `/verification`, and guild management APIs on the
  main Express app.
- Replaced cross-service Owner HTTP requests with in-process service calls.
- Removed standalone Dashboard Public startup, dependencies, session storage,
  admin OAuth routes, and deployment definition.
- Kept `/setup-verify`, signed state, panel revision, `guilds.join`, Join
  Campaign, retention, join, and role assignment flows.
- Added combined `/health` readiness.
- Added full returned guild/connection/target-role persistence and
  failure-preserving snapshot updates.
- Replaced Join Campaign's total-user ceiling and embedded per-IP history caps
  with cursor batches and paginated canonical history collections.
- Added additive snapshot/data-quality fields and dry-run/apply migration.
- Added audited Owner raw-IP reveal while keeping normal APIs redacted.
- Added a separate audited full-detail POST while keeping the normal detail GET
  redacted and non-cacheable for sensitive responses.
- Made snapshot persistence complete-version based with per-document BSON
  sizing, oversized-object checksum chunks, rollback recovery, and no aggregate
  truncation ceiling.
- Made privacy deletion and IP-history backfill transactional/idempotent, and
  required a confirmed maintenance window for archive restore apply.
- Added guild-backup identity/chunk validation and permission-overwrite restore.
- Replaced the inherited Verification dashboard presentation with one
  mobile-first Operations Workspace and truthful callback/status states while
  preserving routes, management capabilities, and OAuth behavior.
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

- Add fixture-driven callback integration tests against a disposable MongoDB
  instance when CI provides one.
- Expand route-level tests for Owner PIN redirect, CSRF rejection, callback rate
  limiting, and readiness degradation without introducing production test
  dependencies.
- Add explicit metrics for optional-fetch failure rates by category.

### UI maintainability

- Split the remaining large verification browser script and base component
  stylesheet only as scoped behavior-preserving tasks. The Operations Workspace
  theme is already isolated from the shared component foundation.
- Continue focused accessibility and sensitive-review audits without exposing
  raw values in list endpoints or browser persistence.

### Operations

- Record each production release and any rollback result in `CHANGELOG.md`.
- Periodically run the verification migration in dry-run mode until all legacy
  documents contain current derived metadata.
- Review retention settings and privacy policy before changing data lifetime.

## Deferred decisions

These are not approved by this roadmap:

- `discord.js` v14 migration
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
- `npm run check`, `npm test`, dependency audit, secret scan, and protected-path
  guard pass.
- `/ping` and `/health` behave correctly during startup and ready state.
- Owner PIN/CSRF protections are verified for every management write.
- A real OAuth flow verifies profile, optional data, guild join, target member,
  role assignment, persistence, and redaction.
- Existing records remain readable before and after migration.
- If a legacy standalone service still exists, it is stopped only after the
  unified runtime passes; current installations otherwise deploy one service.
