# Roadmap

Last reviewed: 2026-07-04.

## Current architecture baseline

- One repository and one Node.js 24 runtime.
- One Express listener on `PORT || 3000`.
- One shared Mongoose connection.
- Main bot, voice/session, Owner Dashboard, OAuth verification, maintenance, and
  audit logging start through `npm start`.
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
- Added additive snapshot/data-quality fields and dry-run/apply migration.
- Added audited Owner raw-IP reveal while keeping normal APIs redacted.
- Consolidated CI and tests under the root package.

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

- Split the large verification browser script and stylesheet only as a scoped
  behavior-preserving task.
- Improve the Owner sensitive-review presentation without exposing raw values in
  list endpoints or browser persistence.

### Operations

- Record the production cutover and rollback result in `CHANGELOG.md`.
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
- exposing raw OAuth tokens or bulk raw-IP export
- changing protected owner/system hooks

Each requires separate implementation evidence, owner approval, compatibility
analysis, rollback planning, and full validation.

## Definition of done for production cutover

- MongoDB backup exists and restore steps are known.
- Unified callback URI is registered in Discord Developer Portal.
- All public URL aliases resolve to one HTTPS origin.
- `npm run check`, `npm test`, dependency audit, secret scan, and protected-path
  guard pass.
- `/ping` and `/health` behave correctly during startup and ready state.
- Owner PIN/CSRF protections are verified for every management write.
- A real OAuth flow verifies profile, optional data, guild join, target member,
  role assignment, persistence, and redaction.
- Existing records remain readable before and after migration.
- Retired service is stopped only after the new runtime passes.
