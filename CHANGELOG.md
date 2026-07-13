# Changelog

## [Unreleased] - Unified Bot And Verification Runtime 2026-07-04

### Changed

- Upgraded `/clear` to fetch up to 100 messages, bulk-delete recent messages,
  and delete messages older than 14 days sequentially through Discord's
  single-message endpoint, with per-channel locking and accurate result counts.

- Reduced the supported production deployment contract to exactly 13
  owner-maintained environment values. Render and `.env.example` now expose
  only that canonical set, while advanced voice, verification, migration,
  audit, cache, timeout, retention, and memory controls use code defaults.

- Removed the retired `/say` whitelist subsystem from slash commands, the
  Owner Dashboard, APIs, runtime state, diagnostics, and Mongoose registration.
  `/say` is now Administrator-only; the legacy MongoDB collection is left
  untouched for rollback and is no longer read or written by the runtime.

- Retired only the obsolete Owner-only `/setup` Dashboard-link shortcut now
  that the unified Owner Dashboard link is delivered through the operations
  webhook; `/setup-log` and `/setup-verify` remain unchanged.

- Made legacy IP identity history migration isolate per-item failures, preserve
  retryable source data, continue later links, rotate failed attempts behind
  untouched links, and expose bounded redacted failure summaries instead of
  aborting an entire startup batch. Migration summary counters now use fixed
  category properties rather than dynamic object-key access.

- Fixed startup webhook links to use the canonical unified public origin instead
  of a stale retired-service URL, point Owner access at `/shadow` instead of a
  raw telemetry endpoint, and omit fake placeholder links when no valid public
  URL exists. The Shadow link is emitted only after its router mounts
  successfully. Repeated token-owner mismatch warnings now use the bounded
  shared webhook dedupe path. Webhook diagnostics use the native structured
  clone operation, and known Sonar `node:test` assertion false positives are
  documented at their test declarations without disabling other analysis
  rules.

- Hardened webhook reliability across the unified runtime with validated
  Discord-only HTTPS targets, mention-safe and size-bounded payloads, a shared
  priority queue, transient retry, bounded routine-event aggregation, Owner
  delivery diagnostics, and graceful shutdown draining. Webhook audit events
  now correlate create/update/delete actions by channel, preserve audit entry
  IDs for reconciler dedupe, flag repeated create/delete activity in audit-only
  mode, and report missing View Audit Log permission after `/setup-log`.

- Corrected Owner environment diagnostics to report the actual
  `TOKEN_MANAGER` runtime variable and aligned the Render runbook with the
  combined `/health` readiness probe while retaining `/ping` for HTTP liveness.

- Fixed the protected runtime master-check binding and isolated its message
  processing stages so subsystem failures no longer escape as unhandled
  rejections. Routine startup diagnostics now use the normal operations log.
- Added bounded duplicate aggregation for global critical alerts and labelled,
  sanitized gateway lifecycle diagnostics for the main Discord client and
  voice session clients, making future WebSocket handshake failures traceable
  without logging tokens or connection URLs.

- Closed the follow-up review findings: snapshot garbage deletion is scoped to
  the originating collection and document ID, restore skips newer live data
  unless explicitly forced, migration batch failures are isolated and counted,
  Join Campaign confirmation/deduplication stay bound across cursor batches,
  and Owner audit/status/redaction paths now report consistent results.

- Hardened the unified runtime review surface: public readiness now returns
  booleans instead of internal diagnostics; sensitive Owner routes use safe
  errors, audit/rate controls, and IP-history auditing; OAuth integration and
  migration snapshots remove token-shaped fields; failed device/member fetches
  remain failed in data-quality metadata; history replay counters, role-event
  idempotency, snapshot finalization, cleanup races, and shutdown persistence
  now have explicit safeguards and regression coverage.

- Replaced the final total-count ceilings with cursor/pagination storage:
  Join Campaign now scans every eligible OAuthUser in stable bounded batches,
  and per-IP users, devices, and role events use canonical unbounded history
  collections with additive legacy-array migration and Owner UI pagination.
- Added automatic bounded backfill from historical `VerifyLog` records into
  canonical IP identity collections. Deterministic event IDs and per-log
  migration markers recover available pre-migration history without duplicates.

- Closed the latest unified-runtime review findings: unconfigured-guild
  overview no longer fails on a missing audit target, oversized verification
  attempts retain an absolute-minimum audit record, voice/readiness reports
  real initialization and shutdown state, cleanup options use safe explicit
  floors, legacy badge fallback remains intact, provider messages share one
  bounded redactor, and redundant per-field IP correlation indexes were removed
  from the schema definition.

- Removed the verified-member 5,000-record visibility ceiling with database-side
  union/deduplicated pagination, bounded incomplete-snapshot deletion batches,
  persisted automatic-migration cursor progress, centralized public URL alias
  resolution with production mismatch rejection, and full-dataset risk/stats
  aggregation.

- Made the Render service probe combined readiness through `/health` and
  replaced retired sensitive-approval wording in the Owner verification UI
  with the actual one-click, audited Member Detail behavior.

- Hardened the unified verification runtime after full review: migration writes
  now use optimistic concurrency, sensitive reads fail closed when audit writes
  fail, reveal responses are non-cacheable, OAuth raw snapshots redact
  token-shaped fields, private IPs are not persisted, IP lookup bodies are
  streamed within a byte limit, lifecycle startup is concurrency-safe, and
  preflight/member pagination metadata remains accurate at edge cases.

- Added automatic bounded legacy verification migration on the shared MongoDB
  connection. Each eligible OAuthUser is archived once per migration version
  before modification, duplicate archives are skipped, failures leave the
  source untouched, hourly maintenance resumes remaining records, diagnostics
  report progress, and a dry-run-first restore CLI supports rollback.

- Aligned the integrated verification management pages with the established
  purple Owner Dashboard theme. Owner Member Detail now loads encrypted raw IP
  and OAuth token values as one CSRF-protected, internally audited action, and
  Join Campaign previews eligible users before a simple final confirmation.
- Added readable Owner Member Detail sections for snapshot data-quality metadata
  and the complete stored per-IP identity history, including linked users,
  device hashes, role snapshots, location, and risk signals.
- Added an inline OAuth readiness note to each Owner Member Detail card so the
  Owner can immediately see missing scopes, absent or undecryptable tokens,
  expiry, refresh failures, and revocation without adding another dashboard tab;
  complete users remain unlabelled so only actionable gaps draw attention.

- Moved the active OAuth verification models, routes, utilities, views, and
  assets into `discord/verification/` and mounted them in the main Express app.
- Changed deployment to one Node process, one `npm start`, one Mongoose runtime
  connection, and one public port for bot, voice/session, Owner Dashboard, and
  verification.
- Made `/verification` and `/verification/:guildId` Owner-PIN-only management
  pages for every guild in the bot cache; kept `/auth/callback` public and
  rate-limited.
- Replaced Owner cross-service HTTP calls with in-process model/service calls.
- Removed the standalone Dashboard Public server/package, admin OAuth
  login/session routes, guild-admin permission/session middleware,
  `connect-mongo`, and the second Render service.
- Preserved the existing verification collections, encryption compatibility,
  signed state, panel revisions, `guilds.join`, Join Campaign, retention, join,
  and role-assignment behavior.
- Historical encrypted `adminOAuth` fields remain refreshable, including an
  optional legacy redirect override; no route creates new admin grants.
- Removed arbitrary persistence caps for Discord-returned connections, guilds,
  connection integrations, and target-member roles after payload byte limits
  pass; bounded browser-controlled strings and language lists before storage.
- Added additive category-level data-quality metadata and failure-preserving
  writes so optional fetch failures do not clear successful snapshots.
- Restricted raw IP to a PIN + CSRF + reason + audit Owner action; normal
  list/detail APIs never decrypt or expose it.
- Added a dry-run/apply additive snapshot migration that never selects,
  decrypts, prints, or deletes token/raw-IP data.
- Consolidated root verification tests, CI, Render configuration, environment
  documentation, and operational documentation around the unified runtime.
- Added `.github/CODEOWNERS` and `scripts/checkProtectedPaths.js` coverage for both `discord/systemProvider.js` and the full `discord/systemProvider/` directory.
- Added the protected-path guard to local validation and CI, and excluded the protected directory from broad syntax scanning.
- Documented the five memory-trend diagnostic threshold variables already consumed by `scripts/checkMemoryTrend.js`.
- Added Owner-only per-user member detail and audited OAuth2 token reveal, plus read-only legacy verified-member listing from `OAuthUser.lastVerify`.
- Updated Join Campaign defaults so Owner can target any guild currently cached by the bot unless `JOIN_CAMPAIGN_ALLOWED_GUILDS` restricts it; this joins authorized users only and does not sync roles.
- Switched Render liveness to `/ping`, added `/ready`, `/guilds`, and `/guild/:guildId` compatibility aliases, and added production secret strength checks.
- Hardened verification review findings: degraded verification startup, dry-run
  diagnostics isolation, graceful verification shutdown drain, redacted member
  list fallbacks, per-request member fetch metadata, VerifyLog snapshot budget
  guard, explicit reveal audit status, and legacy verify-owner API redirects.
- Removed API/user-controlled `innerHTML` sinks from verification log rows and
  Owner detail/reveal modals by rendering DOM nodes with `textContent`, and
  simplified verification config merging to avoid nested conditional expressions.
- Replaced tainted compatibility redirects with direct Owner service responses,
  made the legacy guild alias redirect fixed, clarified Mongo equality lookup,
  removed dynamic test/tool paths, and restricted the deploy smoke CLI to exact
  hostnames in `SMOKE_ALLOWED_HOSTS`.
- Split Owner member/log DOM builders into focused card, row, header, notice,
  and metadata helpers, and documented a scoped Codacy exclusion for the
  administrator-only smoke CLI whose validated URL sink is a false positive.
- Replaced the remaining tainted embed-preview and risk-error HTML assignments
  with DOM construction, text-only rendering, and HTTP(S)-only preview URLs.
- Made raw-IP and OAuth-token reveal fail closed unless at least one bounded
  audit record is actually persisted; bounded reveal limiter state and
  per-log sensitive-access history.
- Added cursor-based retention scans, bounded verified-member scans with
  truncation metadata, minimal VerifyLog fallbacks for oversized snapshots,
  reduced-update budget rechecks, bounded device/IP-provider payloads, and
  startup/shutdown lifecycle guards.
- Restored the Shadow web hook mount on the shared Express application using
  its established external registration contract, without modifying the
  owner-locked provider implementation.
- Clamped verification snapshot budgets at both safe bounds and restored the
  20-entry cap for attacker-controlled `x-forwarded-for` chains.
- Replaced oversized OAuth array fallbacks with additive versioned chunk
  collections for guilds and connections plus a target-member snapshot. Member
  Detail now hydrates every finalized chunk, while VerifyLog stores core audit
  fields and snapshot references without discarding returned Discord data.
- Raised the bounded Discord response ingestion ceiling to 12 MB, added
  sanitized forward-compatible profile/provider snapshots, split target-member
  roles into ordered chunks, and extended the additive migration to backfill
  legacy embedded snapshots without deleting their source fields.
- Added bounded permanent-history snapshot garbage maintenance: referenced
  versions are kept forever, while stale incomplete and fully unreferenced
  versions are removed only after a grace period and fail-closed reference scan.

## [Unreleased] - Dashboard Public OAuth Runtime Fixes 2026-07-03

### Fixed

- Corrected the verification callback to call the implemented Discord guild-member join helper, retained a compatibility alias, and now stops before role assignment when joining the guild fails.
- Replaced the ambiguous `OAuthUser.connections` declaration with an explicit document-array schema and compatibility normalization for legacy string entries.
- Added structured Discord API errors and safe handling for expired or already-used OAuth authorization codes; the callback page now removes one-time OAuth credentials from the address bar after capture.
- Expanded Dashboard Public decryption compatibility across current and historical GCM/CBC encodings and key derivations, with payload-specific CBC validation for OAuth tokens, IPs, and JSON, without changing the current encrypted-write format.
- Restored the startup webhook Owner Dashboard link through a tested URL resolver that prioritizes the main Render service over Dashboard Public and uses a valid bare-URL fallback.
- Added focused Discord API, crypto, OAuth model, and callback integration regression tests.

## [Unreleased] - CI Fix And Test Coverage Expansion 2026-06-29

### Changed

- Upgraded Node.js runtime to 24.13.0 and regenerated both `package-lock.json` (497 packages, lockfileVersion 3) and `dashboard-public/package-lock.json` (420 packages, lockfileVersion 3) using npm 11 under Node 24.
- Fixed `.github/workflows/ci.yml`: removed `--omit=optional` from the `npm ci` install steps so `@snazzah/davey-linux-x64-gnu` (optional native binary required by `@discordjs/voice`) installs correctly in CI; `--omit=optional` is retained only on the lockfile-sync check and audit steps where optional packages must not affect results.
- Added three missing CI steps: `check:dashboard:all` (Dashboard Public JavaScript syntax), `check:scripts` (scripts/ syntax), and `check:memory-guards` (static memory guard checks).
- Updated `ARCHITECTURE.md` last-verified date to 2026-06-29, corrected Service 1 test runner from "Jest" to "Node.js built-in test runner (`node --test`)", updated Service 1 test file count from 51 to 53, and updated Service 2 test file count from 11 to 14.

### Added

- `discord/tests/voiceWorkerQueue.test.js` (9 tests): `OperationQueue` concurrency limits, size-cap rejection, serial execution ordering, and error recovery with queue drain.
- `discord/tests/voiceWorkerDisplay.test.js` (39 tests): `normalizeVoiceTarget`, `getUptimeString`, `isVoiceConnectionUsable`, `buildVoiceFields`, and Thai-language connection status label helpers.
- `dashboard-public/tests/csrf.test.js` (17 tests): CSRF token generation, SameSite cookie helpers, and middleware behavior for missing/wrong/correct tokens.
- `dashboard-public/tests/guildPermissions.test.js` (26 tests): PERMISSIONS flag constants, `hasPerm`, `normalizeGuildPermissions`, `canAccess`, and `canEdit` policy helpers.
- `dashboard-public/tests/panelBuilder.test.js` (34 tests): `sanitize`, `parseEmbedColor`, `normalizePanelInput`, `buildOAuthUrl`, `buildEmbed`, and `buildPanelPayload`.

## [Unreleased] - CI And Security Fixes 2026-06-28

### Changed

- Fixed `npm ci` failure: added `@emnapi/core` and `@emnapi/runtime` npm overrides pinned to `1.10.0` to prevent version drift between Replit package firewall and public registry causing "Missing from lock file" errors. Regenerated `package-lock.json`.
- Fixed logout redirect security issue in `dashboard-public/views/guilds.html`: replaced `.finally()` with `.then(res => { if (res.ok) redirect })` and `.catch()` so redirect to `/` only happens when the server confirms logout success. Previously, `.finally()` redirected even on CSRF rejection, giving a false impression of session termination.
- Tightened source contract test in `discord/tests/voiceSessionRegression.test.js`: changed `src.includes("17,19")` to `src.includes("\\d{17,19}")` to check for the actual regex pattern instead of any occurrence of the substring (which could match comments). Added explicit 20-digit boundary test for `PANEL_FIELD_ID_REGEX` to document that the panel field limit is 19 digits (unlike the worker which allows up to 22).
- All 42 regression tests pass after changes.

## [Unreleased] - Dependency Classification Fix 2026-06-28

### Changed

- Moved `jest` from `dependencies` to `devDependencies` in root `package.json`. Service 1 uses Node's built-in `node --test` runner; jest is only a test tool for Service 2 (dashboard-public), which manages it in its own `package.json`. This prevents jest and its transitive chain (including `inflight`) from appearing in production dependency scans.
- Regenerated `package-lock.json` via `npm install` to sync missing transitive entries (`@emnapi/core`, `@emnapi/runtime`) and resolve `npm ci` failures in CI.

## [Unreleased] - cacheUtils Complex Method Refactor 2026-06-28

### Changed

- Refactored `cleanupLeanClientCache` in `discord/voiceWorker/cacheUtils.js` to reduce cyclomatic complexity: extracted `pruneLeanCaches`, `buildLeanSummary`, and `logLeanCleanup` as private helpers. Behavior and return shape are unchanged. No new exports added.

## [Unreleased] - Documentation Sync 2026-06-28

### Changed

- Synced all root documentation files against the current codebase on 2026-06-28.
- Added missing Service 1 files to `ARCHITECTURE.md`: `discord/core/safeLogger.js`, `discord/core/featureFlags.js`, `discord/core/loadEnv.js`, `discord/commands/moderationWorkflow.js`, `discord/commands/moderationHelpers.js`, `discord/commands/setupLog.js`.
- Expanded `discord/voiceWorker.js` entry in `ARCHITECTURE.md` file table to list all voiceWorker sub-modules individually: `config.js`, `state.js`, `queue.js`, `session.js`, `lifecycle.js`, `display.js`, `cacheUtils.js`, `eventLog.js`, `autoDeaf.js`, `natural.js`, `dm.js`.
- Added missing Service 2 file to `ARCHITECTURE.md`: `dashboard-public/utils/csrf.js`.
- Added `scripts/` and `docs/` directories to `ARCHITECTURE.md` repository shape.
- Added eight missing audit logger env vars to `ARCHITECTURE.md` and `SECURITY.md`: `AUDIT_MAX_QUEUE_PER_GUILD`, `AUDIT_CIRCUIT_FAILURES`, `AUDIT_CIRCUIT_OPEN_MS`, `AUDIT_LOG_DELETED_MESSAGE_CONTENT`, `AUDIT_LOG_EDITED_MESSAGE_CONTENT`, `AUDIT_REDACT_LINKS`, `AUDIT_REDACT_MENTIONS`, `AUDIT_MAX_CONTENT_LENGTH`.
- Corrected `discord/commands/moderation.js` responsibility description: `/ban`, `/kick`, `/timeout` are implemented in `moderationWorkflow.js`, not `moderation.js`.
- Added extracted helper modules `discord/core/featureFlags.js`, `discord/core/loadEnv.js`, `discord/commands/moderationWorkflow.js`, `discord/commands/moderationHelpers.js`, `discord/commands/setupLog.js`, and `dashboard-public/utils/csrf.js` to the Approved Minimal Organization section in `ARCHITECTURE.md`.
- Updated `CONTEXT.md` slash-command, voice/session, and main-bot subsystem maps to list all current files.
- Updated `ARCHITECTURE.md` last-verified date to 2026-06-28.

## [Unreleased] - Documentation Consolidation And Minimal Organization Plan

### Added

- Added root `ARCHITECTURE.md` as the implementation-backed architecture source of truth.
- Added root `ROADMAP.md` with the owner-approved minimal Service 1 organization direction and future refactor phases.
- Added root `SECURITY.md` with secrets, OAuth, sessions, tokens, raw IP, logs, owner/admin, and protected-file guidance.
- Added `.github/copilot-instructions.md` for short GitHub Copilot guidance.
- Added low-risk Service 1 helper modules for command registry, custom IDs, voice panel views/interactions, token owner decoding, voice labels, owner-dashboard session serialization, and view helpers.
- Added Service 1 helper modules for env validation, Express app setup, command guards, dashboard guards, dashboard state payloads, session error messages, and token validation/redaction.
- Added `discord/index/viewStyles.js` to hold shared owner dashboard CSS while keeping route/page behavior in `views.js`.
- Added focused Service 1 tests for token utilities, session errors, dashboard guards, command guards, and command registry contracts.
- Added Service 1 webhook helper tests and centralized webhook routing helpers.
- Added per-guild owner approval gating for guild-admin sensitive verification data visibility.
- Added Dashboard Public sensitive access helper tests.
- Added owner dashboard CSRF helpers/tests for signed-cookie POST APIs.
- Added sensitive access expiry/access audit support and raw IP reveal view audit metadata.
- Added risk flag coverage for IP lookup/proxy/VPN/TOR/hosting/spoof signals and broader private/reserved IP detection tests.
- Added role button and direct-role hierarchy guard tests.
- Added GitHub Actions CI for syntax checks, tests, and npm audit across Service 1 and Dashboard Public.
- Added `docs/RUNBOOK.md` for RAM, voice session, IP reveal, restore, token rotation, and audit-log triage.
- Added owner-only `/api/diagnostics` with safe readiness, session state, voice worker, audit, and memory-monitor diagnostics.
- Added configurable memory monitor thresholds/mode, audit queue/circuit/content controls, IP lookup circuit breaker settings, and feature flag placeholders.
- Added Dashboard Public shared verification snapshot serializers to remove duplicate guild log serialization while preserving sensitive-data redaction and existing response shapes.
- Added protected owner/system hook safeguards for Trace Eraser policy modes, protected channel IDs, dry-run, kill-switch, rate limiting, metrics, startup diagnostics, auditStorage records, and focused guard tests.
- Added owner-dashboard rolling cookie refresh controls and Dashboard Public session-store touch controls to reduce unexpected login expiry during active use.
- Added persistent Discord OAuth token refresh lifecycle for verification and admin OAuth flows so encrypted refresh tokens can keep authorization usable beyond Discord's short-lived access token lifetime.
- Added owner-dashboard Join Campaign controls to dry-run and automatically add eligible `guilds.join` OAuth users into a selected bot guild with refresh-before-use behavior and Thai owner webhook summaries.

### Changed

- Refreshed active documentation against the current implementation on 2026-06-26, including owner audit routes, Join Campaign routes, central voice-session ensure API, bounded runtime environment variables, Dashboard Public rolling-session defaults, and remaining focused `docs/` runbooks.
- Updated `render.yaml` deployment defaults to match the Node.js 24 project baseline and enabled OAuth token storage by default for refresh-capable authorization flows.
- Hardened protected owner/system HTML rendering and reduced internal method complexity without splitting the owner-locked file or documenting sensitive behavior.
- Rebuilt `README.md` as a human-friendly entry point for the full personal multi-tool bot.
- Rebuilt `AGENTS.md` as the active AI/agent rulebook with the new root documentation set.
- Rebuilt `CONTEXT.md` as the quick project/service/subsystem map.
- Consolidated old `docs/` architecture, file map, roadmap, owner decisions, AI guide, deployment, security/privacy, and validation content into the active root docs.
- Documented Service 1 and Service 2 route groups, command groups, model groups, file responsibilities, hotspots, deployment shape, validation commands, and protected boundaries from current implementation.
- Kept `discord/commands.js`, `discord/index/server.js`, and `discord/index/views.js` as compatibility surfaces while moving pure/helper logic into focused modules.
- Completed the root config/deployment audit for `.env.example`, `.gitignore`, `package.json`, `package-lock.json`, `render.yaml`, and `.replit`.
- Upgraded current package baseline while preserving owner-approved major boundaries: `@discordjs/voice` to `^0.19.2`, `opusscript` to `^0.1.1`, Mongoose to `^8.24.1`, Dashboard Public `connect-mongo` to `^6.0.0`, `express-rate-limit` to `^8.5.2`, and Jest to `^30.4.2`.
- Updated Dashboard Public Jest invocation to `--testPathPatterns` for Jest 30 compatibility.
- Expanded `render.yaml` with non-secret environment variable placeholders for both Render services.
- Addressed PR #36 review feedback by normalizing owner-dashboard voice session timestamps, improving token fallback compatibility, reusing voice status custom ID prefixes, expanding validation docs, and adding Service 1 helper tests.
- Separated routine operations/security webhook messages from critical runtime alerts and simplified the startup webhook notice.
- Added webhook target diagnostics so Service 1 warns when routine log and critical alert webhooks are missing or accidentally point to the same target.
- Improved owner dashboard mobile layout for session cards, action buttons, token rows, detail grids, and wide tables.
- Added direct owner-dashboard session stop actions from the active session cards and tightened mobile card/table behavior.
- Hardened owner dashboard API auth so read APIs require the signed dashboard session or server-side secret.
- Removed API secret injection from owner dashboard browser HTML.
- Enforced production `DASHBOARD_PIN` configuration for Service 1.
- Scoped guild-admin voice panel controls to the current guild while preserving owner global control.
- Rechecked approved guild status on voice modal submit and revalidated direct-role hierarchy on button clicks.
- Made owner dashboard settings for max sessions and rate limits affect runtime behavior.
- Wired `/setup` guild dashboard links through signed admin OAuth state.
- Added Dashboard Public lifecycle maintenance for expired reveal requests and retention modes.
- Expanded member data deletion to cover guild-linked OAuth and IP identity data without deleting unrelated guild data.
- Expanded JS syntax validation scripts to cover all applicable Service 1 and Dashboard Public JavaScript files.
- Pinned Render and package engine runtime to Node.js 24 to match the current project target.
- Addressed PR #37 post-merge SonarCloud findings by removing duplicated Dashboard Public safe logger logic and keeping Dashboard Public on the shared Service 1 safe logger implementation.
- Reworked shared log redaction to avoid hotspot-prone regular expressions while preserving webhook URL, MongoDB URI, Discord token, IP, email, and secret-key redaction coverage.
- Cleared the latest SonarCloud quality gate issues, security hotspots, and new-code duplication findings after the webhook/dashboard/security cleanup work.
- Removed owner dashboard auth fallback secrets, hardened production detection/cookie parsing/PIN attribute escaping, and redacted command-toggle IP logging.
- Made raw IP reveal approval/rejection atomic for pending, unexpired requests and audited raw IP views.
- Made Dashboard Public IP lookup configurable and disableable, with an HTTPS default provider base URL.
- Hardened role button/select menu role assignment with Manage Roles, managed-role, and role hierarchy checks plus visible per-role failures.
- Hardened anti-spam/anti-raid ban and link-filter deletion permission checks.
- Added safe `/announce` mention opt-in with `allow_mentions=false` by default.
- Tightened voice/session runtime cleanup with bounded operation queues, cooldown cleanup, runnable-session filtering, unref timers, and dashboard diagnostics.
- Made Dashboard Public `/health` report DB/config readiness and guarded retention maintenance from overlapping runs.
- Hardened audit logging with queue depth limits, circuit breaker behavior, failure counters, cache shutdown cleanup, and optional message-content redaction.
- Added restore dry-run planning, backup validation reports, parent/category-aware restore matching, role-position restore attempts, and permission-overwrite restore reporting.
- Hardened protection config merging against prototype pollution and added audit logging for anti-spam/link-filter actions.
- Centralized OAuth state signing/decoding in `dashboard-public/utils/state.js` and reused it from command-created panels, guild dashboard panels, and OAuth callbacks.
- Added Dashboard Public guild permission policy helper so admin/manage capability normalization uses one shared policy.
- Added retention maintenance summaries and an internal retention dry-run endpoint protected by `x-internal-secret`.
- Documented and exposed Dashboard Public admin session cookie policy with configurable absolute/rolling expiry.
- Added bounded IP identity link arrays, IP risk breakdowns, periodic IP lookup cache cleanup, and stricter Cloudflare header trust requirements.
- Added audit logger queue/cache/embed tests and Dashboard Public state helper tests.
- Hardened Dashboard Public crypto and Discord API error messages with length-limited redaction.
- Marked RAM stability and long-running voice sessions as production-critical in active documentation and the runbook.
- Documented bounded cache/timer/queue/map expectations, memory diagnostics, and long-running voice session verification steps.
- Added caps/diagnostics for owner PIN attempts, rate-limit buckets, command/traffic volatile maps, presence rotate message lists, and Dashboard Public OAuth snapshot arrays.
- Added Dashboard Public Discord API body/response byte limits, API diagnostics, and compact capped admin guild session payloads.
- Added bounded Service 1 Mongo read limits/diagnostics for session boot loading, approved guilds, pending guilds, whitelist entries, and bot settings.
- Added Dashboard Public caps for Discord roles/channels/permission overwrites, internal overview guild scans, retention config scans, and device duplicate lookups.
- Added a static memory guard check to catch regressions in bounded panel/approved-guild loading and Discord API response buffering.
- Replaced Dashboard Public member-summary OAuth user reads with aggregate counts so large `connections` and `guilds` arrays are not loaded for dashboard list views.
- Mounted Audit dashboard/API runtime routes and audit reconciler lifecycle in the current Service 1 boot path with the reconciler remaining opt-in through settings/env.
- Updated active documentation to reflect the current dependency baseline, Dashboard Public shared serializers, Jest 30, and CI audit policy.
- Updated `.env.example`, `SECURITY.md`, and `ARCHITECTURE.md` with non-secret Trace Eraser guard controls while keeping hidden owner/system operational details out of public documentation.
- Updated session documentation and placeholders for owner dashboard and Dashboard Public rolling session controls.
- Updated OAuth token storage documentation and placeholders to reflect persistent encrypted token storage with refresh maintenance.
- Historical behavior: Join Campaign execution originally required an explicit target-guild allowlist. Current behavior is documented above: an empty `JOIN_CAMPAIGN_ALLOWED_GUILDS` permits any guild currently cached by the bot, under Owner-only controls. Admin OAuth originally remained scoped to `identify guilds`; the later OAuth scope update above adds `guilds.join`.

### Notes

- The intended active documentation set is now:

```txt
README.md
AGENTS.md
.github/copilot-instructions.md
CONTEXT.md
ARCHITECTURE.md
CHANGELOG.md
ROADMAP.md
SECURITY.md
```

- `discord/systemProvider.js` and all files inside `discord/systemProvider/` (`actions.js`, `auth.js`, `dashboardHtml.js`, `htmlUtils.js`, `renderers.js`) remain owner-locked and must not be edited or summarized with hidden details.
- Broad rewrites, dashboard replacements, verification rewrites, `discord.js` migration, repository split, shared MongoDB replacement, and voice/session redesign remain out of scope without explicit owner approval.
- Command names/options, custom IDs, owner dashboard route paths, and normal session serializer safety policy are intended to remain unchanged.

## Previous Work Summary

Historical work before this consolidation included:

- Dashboard Public foundation and guild admin dashboard planning.
- Voice/session metadata and dashboard detail improvements.
- Session lifecycle compatibility helpers.
- Safer dashboard serializers for normal session responses.
- Verification flow improvements including `/setup-verify`, OAuth callback success/failure behavior, repeat verification handling, and panel compatibility.
- Documentation baseline work for architecture, file responsibilities, owner decisions, AI workflow, security/privacy, deployment, and validation.
