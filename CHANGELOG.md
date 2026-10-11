# Changelog

## [Unreleased] - 2026-10-06

- **Join Campaign P0/P1/P2 Audit Closure & Production Safeguards:**
  - **P0 `seenUsers` Ownership Decoupling:** Replaced mutation of caller's `seenUsers` in `oauthTokenManager.listAccessTokenCandidates()` with a read-only exclusion check. The worker in `campaignWorker.js` is the sole owner of candidate deduplication, completely eliminating the bug where new candidates were skipped on first encounter.
  - **P1 Resumable Graceful Shutdown (`INTERRUPTED`):** When the bot receives a graceful shutdown signal (`SIGTERM` / `SIGINT`), the running campaign transitions to `INTERRUPTED` without setting `completedAt`. On restart, `startupRecovery` detects `INTERRUPTED` jobs via `findActiveRunningJob()` and auto-resumes them seamlessly toward remaining quota.
  - **P1 Isolated 429 vs 5xx Retry Budgets:** Separated rate limit retries (`rateLimitRetries`) from transient network retries (`networkRetries`), ensuring 5xx errors no longer deplete the 429 rate limit retry budget.
  - **P1 Systemic Alert Dispatch:** Wired `dispatchSystemicAlert()` via `sendWebhookEvent` with `severity: "CRITICAL"` for fatal worker errors, missing target guilds, and max recovery limits, directly dispatching to `ALERT_WEBHOOK_URL`.
  - **P1 Fail-Closed Confirmation Freshness:** `confirmAndStartCampaign()` strictly aborts and returns an error if live Discord member fetching or candidate counting fails right before campaign start, preventing jobs from being created with stale snapshots or broken states.
  - **P1 Interruptible 429 Sleep & Instant Wakeup:** Worker sleep during long 429 Retry-After backoffs (up to 300s) is now interruptible via `_interruptibleSleep()`. Calling `stopCurrentWorker()` triggers instant resolution within <100ms and smoothly persists `INTERRUPTED` state without process hang.
  - **P1 Quota Met Precedence over Guild Full (30005):** When concurrent worker tasks fulfill the requested quota (`joinedCount >= requestedQuota`), the final campaign status is strictly prioritized as `COMPLETED` even if an in-flight concurrent task received a guild full error (`code: 30005`).
  - **P2 Refresh Failure Count Query Alignment:** Aligned candidate query in `oauthTokenManager.listAccessTokenCandidates()` to exclude tokens with `refreshFailCount >= config.failMax`, matching `getAccessToken()` contract.
  - **P2 Confirmation-Time Fresh Membership Snapshot:** `confirmAndStartCampaign()` re-queries Discord REST API for live target guild members immediately before launching the job, guaranteeing 100% fresh membership deduction at the action boundary.
  - **P2 Critical Recovery Alerts:** Added `dispatchRecoveryAlert()` in `startupRecovery.js` across all failure scenarios (missing target guild, member fetch failure, and worker startup exception) to dispatch CRITICAL webhook alerts.
  - **P2 Dashboard Campaign Duration:** Added `durationMs` and `duration_ms` fields in `formatForDashboard()` and `getHistory()` in `JoinCampaignRepository.js` and `joinCampaignService.js`.
  - **P2 Snowflake Validation Placeholder & Batch Size:** Updated snowflake placeholder text to 17–22 digits in mode modals, and made candidate query batch size configurable (`Math.max(50, Number(config.batchSize || 200))`).
  - **P2 Candidate Token Scope Broadening:** Broadened candidate query in `oauthTokenManager.listAccessTokenCandidates()` to accept valid `encryptedAccessToken` alongside `encryptedRefreshToken`.
  - **P2 Accurate Insert Accounting & Repository Naming:** Updated `createItems()` in `JoinCampaignRepository.js` to return actual inserted row count (`info.changes > 0`) instead of raw array length, and introduced `getTrackedUserIds()` with backward-compatible alias.
  - **P2 Config & Operational Docs:** Documented Join Campaign runtime tuning variables in `.env.example`, added `maxConcurrency` option, corrected migration references in `JOIN_CAMPAIGN_BLUEPRINT.md`, and purged the dead `dryRun` placeholder from `joinCampaignPage.js`.
  - **Fail-Closed Target Guild Resolution:** Fixed cache miss handling in `campaignWorker.js` and `startupRecovery.js`. Target guilds are fetched directly from Discord REST API on cache miss; failure halts the worker and transitions job status to `FAILED` instead of continuing with an empty member set.
  - **Heuristic Cache Fallback Removal:** Removed dangerous `Math.abs(memberCount - cachedMembers) <= 5` heuristic from `getLiveTargetMemberIds()`. All queries require authoritative complete fetches or fail closed.
  - **Bounded 429 Rate-Limit Retries:** Introduced `JOIN_CAMPAIGN_MAX_RATE_LIMIT_RETRIES` (default 3) in `config.js` and `campaignWorker.js`. Rate-limited items are bounded and transition to `failed` (`rate_limited`) rather than causing infinite campaign execution loops.
  - **Full-Fidelity Retry-After Header:** Updated `discordAPI.parseRetryAfterMs()` to preserve full seconds up to 5 minutes without artificial 10,000ms truncation.
  - **Orphan Job Prevention & Safe Worker Startup:** Added try/catch and error cleanup around `campaignWorker.startWorker()` in `confirmAndStartCampaign()`, preventing orphan `RUNNING` jobs in SQLite.
  - **Startup Recovery Resilience:** `startupRecovery.js` catches worker resume errors, updates SQLite job with `status: 'FAILED'`, `lastError`, and `completedAt`, and returns `{ recovered: false }`. Added dual support for `updates.lastError` and `updates.last_error` in `JoinCampaignRepository.js`.
  - **Panel State Accuracy:** Fixed `_finishPanelUpdate()` in `campaignWorker.js` to preserve `panel?.lastReadyCount` on member fetch failures rather than faking 0 ready count.
  - **Worker Async Promise Safety:** Wrapped item execution IIFE with try/catch and chained `.then(cleanup, cleanup)` in `campaignWorker.js` to eliminate unhandled promise rejections.
  - **Phase 1 Fail-Closed Modal Query:** Replaced `catch(() => 0)` in `modalSubmitHandler.js` with fail-closed error messaging on candidate query errors.
  - **Strict Amount Validation:** `runPreflight` strictly rejects non-positive or non-integer inputs ("0", "-5", "abc", decimals), and defaults empty input to all eligible candidates.
  - **Target Guild Bot Permission Check:** Preflight validates that bot member exists in target guild and possesses `CreateInstantInvite` permission before allowing a campaign to be staged.
  - **Mode Strategy Blueprint Aliases:** Added `getBaseSetupFields` and `resolveCandidateFilter` aliases to mode strategies.
  - **Legacy Monolith Facade Migration:** Replaced the legacy 815-line `discord/features/joinCampaign.js` implementation with a clean backward-compatible facade delegating directly to `discord/features/joinCampaign/index.js`.
  - **P2 Candidate Query MongoDB Filter Hardening:** Wrapped token existence and refresh failure conditions inside `$and: [ { $or: ... }, { $or: ... } ]` in `oauthTokenManager.listAccessTokenCandidates()`, eliminating JavaScript object literal duplicate key collision and ensuring MongoDB filters both conditions.
  - **P2 Scan Cursor Real-Time Advancement:** Updated `candidateCursor` immediately upon receiving stream items in `campaignWorker.js`, guaranteeing the cursor advances past duplicate or skipped users and prevents redundant re-scans upon restart.
  - **P2 Queue Starvation Prevention:** Refactored `JoinCampaignRepository.countPendingItems()` to count unclaimed items (`status = 'pending'`) by default, preventing concurrent worker pools from stalling candidate top-ups.
  - **P2 Confirm-Time Zero Candidates Safeguard:** `confirmAndStartCampaign()` strictly rejects campaign start and creates no SQLite job if live preflight candidate count (`freshReadyCount`) evaluates to 0.
  - **P2 Dead State Map Elimination:** Removed unused `_activeWebhooks` and `_activeTargetMemberSets` from `JoinCampaignService`, ensuring single-source-of-truth job parameters and eliminating potential memory leak vectors.
  - **P2 Dashboard Duration Column & Status Color:** Added Duration (`ระยะเวลา`) column with human-readable formatting, Throughput (เฉลี่ย) clarification, and `interrupted` status badge color to `/join-campaign` history dashboard.
  - **Audit Quality & Test Coverage:** Comprehensive join campaign subsystem tests and full regression suites pass with 100% success; passes all quality, security, and release gates cleanly.

- **OAuth Token Lifecycle Consolidation & Audit Remediation (`discord/core/oauthTokenManager.js`, `discord/features/joinCampaign.js`):**
  - **P1 Consent Authorization Guard:** `listAccessTokenCandidates()` now enforces strict fail-closed consent filtering: requires explicit `targetGuildId` and filters `lastVerify.guildId === targetGuildId` alongside `lastVerify.result === "success"`, preventing unverified or failed verification users from being targeted by join campaigns.
  - **Single Authority Persistence:** Purged legacy `markTokenRefreshFailure()` and all direct `model.updateOne()` persistence logic from `joinCampaign.js`, delegating complete refresh failure, CAS versioning, and revocation lifecycle to `oauthTokenManager.getAccessToken()`.
  - **Strict Candidate DTO Contract:** Eliminated fallback guessing (`adminOAuth ? "adminOAuth" : "oauth"`) across `joinCampaign.js` (`handleJoinCandidate`, `getUsableAccessToken`, `summarizeJoinCandidates`); candidates missing explicit valid `tokenField` fail closed as invalid candidates without inspecting raw database subdocuments.
  - **Atomic CAS Version Lineage:** `commitVerificationActivation()` now fresh-reads the current document's token version from MongoDB inside `withTokenRefreshLock` instead of relying on the route's snapshot state, ensuring unbroken version sequence (e.g. version 7 -> 8) across re-verifications.
  - **API Normalization:** Fixed `getOwnerTokenMetadata()` to iterate and select over normalized `fields` array instead of raw `tokenFields`, preventing `TypeError` when a single string field is supplied.
  - Consolidated all fragmented OAuth2 token operations across verification, campaigns, and recovery into a Single Authority: `discord/core/oauthTokenManager.js`.
  - Serialized OAuth Activation Under Mutation Lock: `commitVerificationActivation()` now executes under `withOAuthTokenStateLock` (`withTokenRefreshLock(`${userId}:oauth`)`), guaranteeing strict sequential ordering with concurrent refreshes and revocations.
  - Candidate Page Object & Scan Statistics Contract: `listAccessTokenCandidates()` now returns a non-circular page object with `{ candidates, nextCursor, hasMore, scanned, statistics, get length() }` and Symbol.iterator, reporting rich scan metrics (`scannedRecords`, `uniqueUsers`, `usableUsers`, `missingScope`, `missingUserId`, `revoked`, `exhausted`, `byTokenField`). `joinCampaign.js` tracks cross-batch `seenUsers` and aggregates statistics using nullish coalescing (`??`) without double-counting.
  - Early Refresh Exhaustion Guard: `getAccessToken()` and `performTokenRefreshUnderLock()` proactively reject expired tokens with `oauth_refresh_exhausted` when `refreshFailCount >= failMax` before invoking Discord APIs.
  - Clean Absent Document Recovery: `getRecoveryStatuses()` handles non-existent or deleted `OAuthUser` documents by returning `{ status: "missing", reasons: ["record_missing"] }` instead of misleading parse errors.
  - Decoupled Serializers: `discord/verification/serializers/memberDetailSerializer.js` now evaluates `tokenStatus` using high-level boolean flags (`hasAccessToken`, `hasRefreshToken`) without direct coupling to encrypted storage fields.
  - Enhanced Lifecycle Diagnostics: `discord/verification/lifecycle.js` records `lastRunStatus`, `lastRunFailedCount`, and `lastRunPersistenceFailed` for granular observability during maintenance sweeps.
  - Resolved Join Campaign pagination defect: `listAccessTokenCandidates()` now returns cursor metadata derived from the last MongoDB document scanned (`nextCursor`), preventing premature campaign termination when early batches have 0 candidates.
  - Completely purged legacy token crypto, raw `OAuthUser` model imports, candidate query builder, and mock refresh routines from `joinCampaign.js`.
  - Fixed refresh margin propagation bug: `getAccessToken()` now forwards caller-specified `marginMs` and deterministic `now` into `performTokenRefreshUnderLock()`, ensuring margins like `JOIN_CAMPAIGN_REFRESH_MARGIN_MS` (1h) take effect accurately.
  - Closed revoke-vs-refresh concurrency race: `revokeToken()` acquires `withTokenRefreshLock` and applies unconditional fallback update if CAS misses, guaranteeing revocation precedence over in-flight refreshes.
  - Added strict whitespace token validation in `validateTokenData()`, rejecting empty or whitespace-only access and refresh tokens.
  - Enforced soft-delete isolation across `getOwnerTokenState()`, `getOwnerTokenMetadata()`, `getRecoveryStatuses()`, and `ownerService.js` queries (`deletedAt` check).
  - Added `refresh_exhausted` status reason and Thai label (`"Refresh ล้มเหลวถึงจำนวนสูงสุด"`) in `getRecoveryStatuses()` when `refreshFailCount >= failMax`.
  - Enhanced encryption migration tests in `verification-tests/encryptionMigration.test.js` to assert round-trip plaintext decryption for tokens and IPs.
  - Production dependency audit: 0 vulnerabilities. Dev-only @sonar/scan -> node-forge advisory remains as documented exception.
  - Refactored `discord/verification/routes/oauth.js` to execute `commitVerificationActivation` with payload validation and compensating snapshot rollback.
  - Refactored `discord/verification/ownerService.js` to use `oauthTokenManager.getRecoveryStatuses()` for recovery and `oauthTokenManager.getOwnerTokenMetadata()` for member detail, completely eliminating direct selection of `oauth/adminOAuth` subdocuments, while preserving full raw token visibility for Owner Detail via `oauthTokenManager.getOwnerTokenState()` in strict compliance with Owner Intent Policy (OI-03).
  - Refactored `discord/verification/services/encryptionMigration.js` to delegate `oauth_tokens` migration entirely to `oauthTokenManager.migrateStoredTokenEncryption()`, resolving plaintext re-encryption and adding CAS update filters.
  - Integrated `oauthTokenManager` into `discord/verification/lifecycle.js` with awaited startup, background timers, and safety-net maintenance sweeps.
  - Retired and deleted `discord/verification/utils/oauthTokenLifecycle.js`.
  - Updated `ARCHITECTURE.md` implementation verification date to 2026-10-04, documented Single Authority with zero legacy token crypto in Join Campaign, and added Discord Developer Policy guidance for `guilds.join`.


- **UI/UX Renovation — Cleanup & Polish Pass (all 9 guild commands):**
  - `/token-check`: Expanded batch embed display from 15 → 20 tokens (full coverage, no hidden results). Removed raw token file attachment (`createCategoryAttachments` dead code). Added `resolveInvalidTokenErrorMessage()` mapping error codes to Thai user-facing strings; replaced `result.errorMessage` direct exposure. Removed `.setFooter()` from all embed branches. Error emoji updated to `no_entry` for consistency.
  - `/copy-emojis`: Removed raw `err.message` leak in `resolveEmojiCreateFailureReason()` fallback — now returns `"ไม่สามารถนำเข้าอิโมจินี้ได้"` instead of Discord internal error text. Fixed `handleSteal` Administrator check to use `config.emojis?.no_entry` instead of hardcoded `⛔`.
  - `/re-role`: Removed duplicate status banner from `buildSummaryEmbed`. Removed duplicate `ยศเป้าหมาย` field. Simplified `buildCancelEmbed` and `buildExpiredEmbed` descriptions. Removed `.setFooter()` from all 4 embed builders. All `⛔` hardcoded literals replaced with `config.emojis?.no_entry`.
  - `/voice-admin`: Replaced hardcoded `⛔` in `handleVoiceAdminCommand` access error with `config.emojis?.no_entry`.
  - `/setup-verify`: Replaced hardcoded `🔒` in owner-only error with `config.emojis?.no_entry`.
  - `/utility.js`: Removed `⚠️ [AI COGNITIVE DIRECTIVE] ⚠️` block comment banner; replaced with plain code comments preserving intent. Fixed `validateEmbedCreateTarget` to use `config.emojis?.no_entry`.
  - `/moderation.js`: Removed `⚠️ [AI COGNITIVE DIRECTIVE] ⚠️` block comment banner; replaced with plain code comments preserving intent.
- **Security:** Removed `createCategoryAttachments` which created plaintext token files as Discord attachments. `resolveInvalidTokenErrorMessage` now maps internal error types to safe Thai strings only.
- **Dependencies:** Updated `qs` 6.15.3 → 6.16.0 and `ip-address` 10.5.0 → 10.7.2 to resolve moderate audit advisories. `npm audit` now reports 0 vulnerabilities.
- **Documentation:** Updated `README.md` guild command count 17 → 18. Synced `docs/EMOJIS.md` section 2.1 header to reflect 28 active keys (4 removed entries noted).

## [Unreleased] - 2026-09-22

- Migrated Announcement Command `/announce` to Modernized `/embed create` Subsystem:
  - **Slash Command Registry (`discord/commands/registry.js`)**:
    - Replaced flat `/announce` command with nested application command `/embed` containing subcommand `create` (`type: 1`).
    - Renamed required option `message` to `description` (type STRING, max 4096, markdown and newline support).
    - Renamed `button_text` to `button_label` (max 80) and kept `button_url` (max 2048).
    - Removed non-essential options `author_name`, `author_icon`, and `footer_icon` for a streamlined announcement UX.
    - Standardized all 12 option descriptions in concise Thai wording.
    - Organized option hierarchy: `description` (required), `title`, `channel`, `content`, `color`, `image`, `thumbnail`, `footer`, `url`, `timestamp`, `button_label`, and `button_url`.
  - **Command Routing & Handlers (`discord/commands.js`, `discord/commands/utility.js`)**:
    - Updated `UTILITY_COMMANDS` set to route `/embed` directly to `utility.handle`.
    - Added `handleEmbed` and `handleEmbedCreate` sub-handlers supporting subcommand routing.
    - Added comprehensive button validation: enforces both `button_label` and `button_url` when either is provided, rejecting half-configured buttons or invalid URLs with clear ephemeral Thai error notices without crashing.
    - Preserved rich external mention parsing (@everyone, @here, user, role) in `content`.
    - Updated `commandGuards.js` to inspect `content` for elevated mention permissions under `/embed`.
    - Updated cooldown routing in `discord/index.js` (`embed: 5000`).

- Retired and Completely Removed Server Backup and Restore Subsystem (`/backup` & `/restore`):
  - **Discord Commands & Interaction Cleanup**:
    - Removed `/backup` and `/restore` slash commands from `discord/commands/registry.js` (keeping the active registered guild command count at exactly 17 with `/token-check` and `/dm-panel`).
    - Removed backup/restore dispatch routing, `activeRestores`, `activeBackups`, and `handleRestoreConfirm` from `discord/commands/utility.js`.
    - Removed `BTN_RESTORE_CANCEL`, `RESTORE_CONFIRM`, and `isRestoreConfirm` from `discord/commands/customIds.js` and `discord/commands/panelInteractions.js`.
    - Deleted `discord/commands/guildBackup.js` completely from the repository.
  - **Database Persistence & Boot Cleanup (`discord/sessionManager.js`)**:
    - Removed `snapshotSchema`, `SnapshotModel`, `snapshotChunkSchema`, and `SnapshotChunkModel`.
    - Removed entire Region 11 (`chunkSnapshotItems`, `saveChunkedSnapshot`, `getLatestSnapshotForGuild`, `reconcileSnapshotPointers`, `readChunkedSnapshotItems`, `loadSnapshotData`, `saveSnapshot`, `getSnapshot`, `deleteSnapshot`).
    - Eliminated `reconcileSnapshotPointers` from database startup (`loadDatabase`), reducing startup queries and MongoDB boot latency.
  - **Configuration, Feature Flags & Tests**:
    - Removed `backup: true` feature flag from `discord/core/featureFlags.js`.
    - Removed `backup_icon` and `restore_icon` emojis from `discord/config.json`.
    - Deleted `discord/tests/backupRestore.test.js` test suite.
    - Updated `discord/tests/tokenCoordinator.test.js` dynamic activity test to use general activity name.
    - Updated `discord/tests/commandReliability.test.js` to assert `backup` and `restore` command removal.
    - Updated `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, and `ROADMAP.md` removing dead references to backup/restore.
  - **Dead Code, Router, Cooldowns & Custom IDs Remnant Cleanup**:
    - Removed `"backup"` and `"restore"` from `UTILITY_COMMANDS` in `discord/commands.js`.
    - Removed `backup: 30000, restore: 30000` from `COMMAND_COOLDOWNS_MS` in `discord/index.js`.
    - Removed `"backup"` and `"restore"` from `protectedCommands` in `discord/index/events.js`.
    - Removed `BACKUP: "สำรองและกู้คืน"` category from `EVENT_CATEGORY_LABELS` in `discord/core/webhooks.js`.
    - Consolidated `rolesweep:confirm` and `rolesweep:cancel` under `IDS` in `discord/commands/customIds.js` and updated `discord/commands/roleSweep.js`.
    - Removed unreferenced `PREFIXES.DM_PANEL` from `discord/commands/customIds.js`.

- Upgraded Secondary Bot DM Broadcast (`/dm-panel`) to Turbo High-Speed Engine:
  - **Turbo Adaptive Throttle**: Reduced base pacing throttle from `2000 - 3000ms` down to `1200 - 1500ms` (average 1.35s), cutting broadcast execution time for 422 members from ~38.5 minutes down to ~8-10 minutes.
  - **Fast-skip for Closed DMs**: Implemented immediate fast-skip delay (`400 - 600ms`) when encountering Discord error 50007 (user closed DMs or blocked bot), preventing unnecessary pacing waits for members where no message was dispatched.
  - **Robust 5-Attempt Rate Limit Retry Loop**: Upgraded `sendDmWithRetry` from single-retry to a resilient 5-attempt retry loop that strictly adheres to Discord's `retry_after` backoff, guaranteeing the broadcast finishes without dropping members on transient 429s.
  - **Asynchronous Non-blocking Webhook Logging**: Switched member log dispatch to fire-and-forget in `processMemberBroadcast`, eliminating 150-300ms of webhook HTTP latency per member and preventing webhook edge throttling from blocking the main DM loop.
  - **Unit Test Coverage**: Added unit tests in `discord/tests/dmBroadcast.test.js` validating Turbo throttling ranges, fast-skip behavior on error 50007, and the 5x 429 retry loop.

- Upgraded Master Token Coordinator and Token Checker for Seamless Dual-Token Support (User & Bot Tokens):
  - **Master Token Coordinator (`discord/core/tokenCoordinator.js`)**:
    - Added granular `tokenType` state tracking (`'user' | 'bot' | 'unknown'`) with `setTokenType(token, type)` and `getTokenType(token)` APIs.
    - Added `formatAuthHeader(token, explicitType)` supporting both standard User Tokens (raw header) and Discord Application Bot Tokens (`Authorization: Bot <token>`).
    - Added `options.bypassQuarantine` to `executeWithToken` enabling controlled probing and revalidation of quarantined tokens without throwing `TOKEN_QUARANTINED`.
    - Integrated `cacheTokenProfile` with token type resolution and profile metadata.
  - **Token Checker (`discord/features/tokenChecker.js`)**:
    - Implemented Auto Dual-Check: probes token initially as User Token; upon HTTP 401, seamlessly falls back to probing with `Authorization: Bot <token>` via `fetchDiscordBot`.
    - Automatically lifts false 401 quarantines with `tokenCoordinator.releaseQuarantine(token)` upon detecting valid Bot Tokens.
    - Added dedicated Bot Card Embed UI displaying bot name, `[BOT]` tag, bot ID, creation date, avatar, and verification state.
    - Enhanced Batch Check with a dedicated `🤖 Bot Tokens` summary section, categorized counts, and `tokens_bot.txt` attachment generator.
  - **Secondary Bot DM Broadcast Integration (`discord/features/dmBroadcast.js`)**:
    - Registered `dmBroadcast` subsystem with `tokenCoordinator` lifecycle hooks to abort active broadcasts if tokens become quarantined mid-job.
    - Automatically registers token type as `'bot'` and lifts pre-existing quarantines upon successful `validateSecondaryBot` login.
    - Enforced concurrency and activity lifecycle: acquires `dmBroadcast` activity on job start and safely releases on completion or error.
  - **Test Suite Coverage**:
    - Added unit tests in `discord/tests/tokenCoordinator.test.js` for `tokenType`, `formatAuthHeader`, and `bypassQuarantine`.
    - Added unit tests in `discord/tests/tokenChecker.test.js` for Bot Card Embed rendering, `tokens_bot.txt` export, and Auto Dual-Check 401 fallback.
    - Added unit tests in `discord/tests/dmBroadcast.test.js` for `tokenCoordinator` activity lifecycle, auto-unquarantine, and abort handling.

- Upgraded `/dm-panel` UX/UI and resolved modal submission bug:
  - Streamlined DM broadcast panel embed description to clean bulleted layout matching bot owner specifications.
  - Resolved `ReferenceError` on modal submission in `handleDmPanelModal` (`discord/commands/dmPanel.js`) by properly destructuring modal inputs.
  - Added unit test covering modal input extraction and validation in `discord/tests/dmBroadcast.test.js`.

- Added `auto_daily` toggle option to `/quest panel`:
  - Added optional boolean option `auto_daily` (default: `false`) to the `/quest panel` slash command.
  - When omitted or `false`, the panel renders 2 primary control buttons: `[ 🚀 START NOW ]` and `[ 🛑 STOP ]`.
  - When explicitly set to `true`, the panel renders all 3 buttons: `[ 🚀 START NOW ]`, `[ 🤖 AUTO DAILY ]`, and `[ 🛑 STOP ]`.
  - Updated command registry with recursive option validation, command handler, and unit tests in `discord/tests/questSubsystem.test.js` and `discord/tests/registry.test.js`.

- Enhanced `/re-role` sweep reliability and upgraded UX/UI:
  - Implemented seamless cache fallback in `executeSweep` (`discord/commands/roleSweep.js`) when fresh member fetch fails due to Discord Gateway rate limits or timeouts, preventing false aborts while strictly verifying role assignment fingerprints.
  - Eliminated redundant plain-text summary content above the preview embed in `buildPreviewPayload`, rendering a clean, uncluttered embed.
  - Ensured button interaction replies clear placeholder text upon completion, displaying only the final rich summary embed.
  - Added unit tests covering seamless cache fallback execution and verified all 56 role sweep test scenarios.

- Renamed slash command from `/rerole` to `/re-role`:
  - Updated registry in `discord/commands/registry.js` to register `/re-role` as the canonical command name.
  - Enforced strict slash command routing in `discord/commands.js` to accept `/re-role` only.
  - Updated test suites in `discord/tests/registry.test.js` and `discord/tests/roleSweep.test.js` to verify registration, rejection of legacy name, and strict routing.
  - Updated documentation in `README.md`.

- Renamed slash command from `/voiceadmin` to `/voice-admin`:
  - Updated registry in `discord/commands/registry.js` to expose `/voice-admin`.
  - Enforced strict command routing in `discord/commands.js` to accept `/voice-admin` only.
  - Aligned command cooldown configuration in `discord/index.js` and registry unit tests in `discord/tests/registry.test.js`.
  - Added unit regression test in `discord/tests/commandReliability.test.js` validating strict routing and rejection of legacy name.

- Prevented Crash Shield from terminating the process on transient Cloudflare and Discord gateway errors (`5db3d2b`):
  - Implemented `isTransientGatewayError` in `discord/index/system.js` to recognize Cloudflare 520–525 / 502–504 responses, WebSocket handshake timeouts, and gateway network socket blips (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`, `ECONNREFUSED`).
  - Intercepted these transient errors in `uncaughtException` and `unhandledRejection` handlers: logs a warning, alerts the operational webhook, and preserves the process so Discord clients can execute automatic `shardResume` instead of dropping all active voice sessions.
  - Added unit test suite in `discord/tests/systemCrashShield.test.js` validating that non-transient runtime exceptions (e.g. `TypeError`, MongoDB errors) continue to trigger graceful termination as expected.

- Implemented Master Token Coordinator (Token Hub) and Concurrency Controller (`81caa28`, `19643bf`):
  - Core subsystem (`discord/core/tokenCoordinator.js`) providing centralized concurrency control across voice sessions, quest runners, and profile lookups.
  - Dynamic subsystem registration: allows subsystems to register lifecycle hooks for quarantine events.
  - Automatic HTTP 429 rate-limit backoff: intercepts rate-limit responses and enforces per-token and global cooldowns.
  - Quarantine lifecycle: automatically quarantines invalid tokens (HTTP 401 / gateway invalidated) and signals registered subsystems to immediately stop tasks, protecting tokens and IPs from repeat bans.
  - Added Owner Dashboard Token Hub UI card (`/`) and REST management APIs (`GET /api/token-hub/status`, `POST /api/token-hub/quarantine/release`, `POST /api/token-hub/cache/clear`).
  - Pass raw token into `runTask` and tighten 401 detection to prevent false quarantine triggers.

- Expanded Discord Quest automation subsystem to full parity with reference architecture:
  - Command: `/quest panel` (interactive panel with Start Now, Auto Daily, and Stop buttons).
  - Auto Daily scheduling engine: MongoDB `ScheduledRunner` model, Bangkok time (00:00, 08:00, 16:00 UTC+7) recurring scheduler with jitter, and 3x 5-min verification recheck loop.
  - Live channel codeblock rendering with 2-second trailing throttle, status mutation tracking, and Thai status headers (`✅ LOGIN`, `🤖 AUTO DAILY ENABLED`, `🔎 พบ X QUESTS`, `🎉 ทำสำเร็จ Y QUESTS`, `🧹 QUEST ACTIVITY CLEARED`).
  - Admission control locks (`withAccountAdmissionLock`, `withOwnerAdmissionLock`) preventing race conditions and duplicated executions.
  - Lifecycle management: automatic scheduled runner restoration on bot startup and graceful termination on shutdown.
  - Owner Dashboard `/quests` enhancement: active scheduled runners monitoring and cancellation via `GET /api/quest-scheduled` and `DELETE /api/quest-scheduled/:id`.
  - Comprehensive unit testing suite covering all quest models, stores, scheduling, and UI components.

- Removed all member DMs from `/ban`, `/kick`, and `/timeout` while preserving
  the moderation action, ModCase lifecycle, and operational webhook behavior.
  The DM outbox now removes unsent legacy moderation records and refuses new
  moderation notifications.
- Rebuilt Verification DMs as concise server-first result cards: they now use
  the server icon as their thumbnail, show only relevant role/reason guidance,
  and keep request references internal for delivery deduplication.

- Fixed Voice Admin durable lock writes so MongoDB never receives overlapping
  update paths. Unlock actions now preserve and restore locks when a member
  leaves the source room during a state change, latest lock versions receive
  their own enforcement work, and result messages distinguish complete,
  partial, and failed bulk actions accurately.

- Moved the production bot Owner identities to required `OWNER_ID` environment
  configuration. It accepts one or more comma-separated Discord User IDs;
  startup rejects a missing or malformed value instead of using the
  source-config fallback.

- Reworked Voice Admin bulk work from one member plus a fixed 500ms pause at a
  time into eight bounded per-guild workers with a twelve-member shared runtime
  cap. Discord REST rate-limit handling now determines the pace; targets are
  checked again before action so a member who has already left the source voice
  channel is reported as skipped rather than being followed into another room.
  Final summaries include skipped targets and elapsed time, while the
  fourteen-minute cutoff applies only to members that have not started yet.

- Added owner-only `/rerole` and `//รียศ [ROLE_ID ...]` role-sweep entry points,
  along with dedicated `target_role` slash option and `//ถอดยศ [ROLE_ID/MENTION]`
  targeted removal shortcut. Each command fetches a complete member collection, scans
  first, reports aggregate role counts, requires the exact `ยืนยัน` text or button
  confirmation from the same owner in the same channel before an absolute 60-second
  deadline, and rechecks bot permission plus the member/role/bot-hierarchy fingerprint
  before removal. Role catalog, hierarchy, or member assignment changes cancel the work.
  Results report changed members and successful/failed role assignments via rich
  Modern Enterprise Embeds with dedicated fields, server thumbnail, and interactive
  confirmation controls. The command removes only eligible roles from manageable human
  members while preserving selected role exceptions and the invoker, and intentionally
  creates no snapshot or automatic restore path.

- Replaced the retired `/voicekickall` registration with an ephemeral,
  Administrator-only `/voiceadmin` panel for normal voice-channel chat. It
  snapshots the room at execution time, skips Administrators in panel mode,
  supports disconnect/move/server mute/server deafen actions, and persists
  non-Administrator voice locks across restart and voice reconnects. Added
  Owner-only `//` and `///` text controls, audit-log-aware lock enforcement,
  and bounded notices for unauthorized unlock attempts without changing the
  isolated Voice self-client or Owner Intent policies. The secret
  `///ปิดไมค์หมด` mode now persists its mute lock for Administrators as well as
  ordinary members and accepts release only from the configured bot Owner.

- Removed the unapproved `identify.premium` OAuth scope from every new
  verification entry point. Historical Owner records may still display an
  already-granted premium value, but new member verification no longer depends
  on that optional Discord permission.

- Repaired the Owner diagnostics path, routed fatal boot errors through the
  coordinated shutdown path, removed the unreachable duplicate OAuth-start
  route, and refreshed audited transitive lockfile dependencies without changing
  the owner-approved Voice self-client.
- Preserved full-fidelity private event values in storage and private webhook
  delivery by using continuation payloads rather than silent truncation.
- Corrected protected control safety, credential migration/session-secret,
  request-size, state-restore, and action-result contracts under explicit Owner
  approval; aligned release workflow and active operational documentation.

- Hardened the public OAuth start route with a friendly error boundary, preserved fatal shutdown exit-code escalation during overlapping graceful shutdown, and corrected privacy-deletion response totals to use the verified manifest counter.

- Removed JavaScript-side dynamic path construction from the Mongoose 9 compatibility gate by feeding fixed-root source files over stdin, added CLI regression coverage, simplified finding classification, and updated Voice plaintext validation to iterate Unicode code points.

- Closed the remaining Discord.js v14 permission boundary in event protection and invite handling, replaced the Mongoose 9 regex scanner with AST analysis, rejected unsupported legacy Store channels explicitly, escaped untrusted Discord Markdown in webhook events, and clarified dedupe diagnostics. Added degraded Discord-login coverage, bounded encryption-migration counting during recurring maintenance, and connected Node test LCOV output to CI-based Sonar analysis.

- Upgraded the primary runtime to Node.js 24.18 LTS, npm 12, `discord.js`
  14.27, Mongoose 9.8, and `express-rate-limit` 8.6. Added a narrow Discord v14
  compatibility boundary for existing Embed/component contracts, migrated
  interaction, activity, channel, emoji, backup, and restore APIs, and kept all
  slash-command names, custom IDs, routes, collections, and environment values
  unchanged.
- Replaced the Jest runner with Node's built-in test runner plus focused
  `expect` and `jest-mock` adapters. This removes the obsolete `glob@7` and
  `inflight` test dependency chain while preserving the 435 Verification
  regression contracts.
- Removed unused `tweetnacl` and the mismatched `opusscript` dependency. Voice
  has no audio-player/resource path, so no native Opus build is required for
  its connection-only lifecycle.
- Updated GitHub Actions to pinned `checkout` v6.0.2 and `setup-node` v6.3.0,
  added least-privilege workflow permissions, aligned Render and `.node-version`,
  pinned the CI/Render bootstrap to npm 12.0.1, and kept project dependency
  installation in lockfile-based `npm ci` mode.
- Hardened the npm bootstrap in CI and Render with lifecycle scripts disabled.
  Command toggles now persist the proposed state before mutating runtime state,
  return an unavailable response when MongoDB cannot acknowledge the write, and
  avoid recording a cooldown or audit event for a change that never committed.
- Bounded webhook event identifiers before normalization, replaced the
  backtracking edge-trim expressions with linear scanning, and split webhook and
  Join Campaign presentation builders into focused helpers without changing the
  emitted Discord payload contract.
- Restored Voice-session migration compatibility for legacy GCM records created
  before `ENCRYPTION_KEY` was configured, normalized numeric channel types in
  Backup/Restore planning and execution, preserved event-level metadata in
  duplicate webhook summaries, and restored structured reporting when a Restore
  result cannot be delivered privately.
- Removed the inactive duplicate Owner renderer implementation after the routed
  renderer module became authoritative, while preserving its protected-file
  digest and focused render/auth tests.
- Aligned the active documentation and agent instructions with the
  owner-approved `discord.js` v14 primary runtime, documented the separate AES
  and IP/device-correlation key contracts, removed a secret-like legacy test
  fixture in favor of a byte-level historical fallback compatibility vector,
  expanded duplicate-webhook metadata assertions, and made the 16-byte
  AES-GCM authentication-tag contract explicit during Voice token encryption
  and decryption.

- Upgraded new Verification and Voice secrets to versioned `v3:gcm` payloads
  derived from the full 32-byte SHA-256 digest. Existing Service-compatible
  GCM/CBC records remain readable and are conditionally re-encrypted after
  successful authenticated decryption. Verification maintenance now reports
  remaining legacy encrypted records, and Voice migrates loaded sessions
  without overwriting concurrent database changes.
- Added explicit graceful-shutdown cleanup for spam tracking, reveal-attempt,
  and IP lookup cache intervals; `.unref()` remains as a secondary safeguard.

- Standardized both operational webhooks behind one event envelope with stable
  codes, categories, severities, Thai presentation, impact/action fields,
  target-aware duplicate summaries, and legacy-payload compatibility. Routine
  activity remains in the audit webhook while process, security, persistence,
  and data-integrity failures route to the action-required webhook. Individual
  Voice disconnect/recovery/terminal outcomes and routine Backup/Restore-result
  delivery no longer notify the Owner webhook; Voice alerts only when durable
  state cannot be reconciled. Join Campaign no longer emits repeated progress
  webhooks between its start and finish summaries. Relevant guild and account
  events now include their Discord icon/avatar so Owner messages are easier to
  identify at a glance.

- Closed the remaining confirmed PR review defects in Owner member access and snapshot
  maintenance. OAuth profile/token reads now require a verification association
  with the selected guild, and cleanup shares the per-user snapshot mutation
  lock with OAuth writers while rechecking age, completion, and references at
  deletion time.

- Rebuilt `/userinfo`, `/serverinfo`, and `/ping` as Thai, mobile-readable
  information panels. User lookup now preserves the selected target when the
  guild member is not cached, account age is presented as context instead of a
  risk verdict, Server Info labels cache/fetch limitations, and Ping reports
  process RSS, V8 heap, sampled CPU, database metrics, shard state, and Voice
  session states without mixing their meanings. Each command now opens with a
  distinct animated, truthful loading panel that is replaced in place when the
  final result is ready.

- Retired the `/help` slash command from registration and runtime routing; the
  Owner Dashboard documentation page remains available separately.

- Unified Voice, moderation, verification, and restore-result DMs behind a
  profile-first Thai Embed system with mention suppression, Markdown-safe
  dynamic text, server-derived recipients, priority, event deduplication, and a
  30-day MongoDB outbox with bounded restart-safe retry. Critical Voice failures
  bypass routine digests, digest failures retain their items, inferred versus
  observed voice channels are labelled honestly, and error codes no longer
  replace the user-facing diagnosis.
- Made moderation DMs truthful across partial failure: ban/kick notifications
  start as unconfirmed and are edited after Discord succeeds or fails; timeout
  includes its end time and every result carries the member profile and Case
  reference. Verification now distinguishes a newly granted role, an existing
  role, a policy block, and an operational failure. Restore results no longer
  expose structural details in a public channel when private delivery fails.

- Replaced first-success IP geolocation with bounded multi-provider consensus.
  The verification record now preserves provider agreement, an explainable
  confidence level, provider-supplied accuracy radius, VPN/proxy/TOR/hosting/
  mobile/anycast context, browser-timezone corroboration, and comparison with
  the latest stored network. Optional MaxMind GeoIP support activates only when
  credentials are configured; OAuth continues safely when any provider fails.

- Resolved the SonarCloud follow-up set without changing public contracts:
  simplified Voice start/stop and Settings-page control flow, replaced nested
  conditionals and avoidable regular expressions, improved callback semantics
  and danger-button contrast, and documented the analyzer's known `node:test`
  assertion false positives at the affected declarations.
- Replaced the separate green Owner Verification pages with a newly rendered
  five-section module inside the purple Owner Dashboard. Server selection,
  configuration, panel editing, policy/role conditions, members, history, risk,
  and full member detail now share the Owner shell; the public OAuth callback
  remains unchanged.
- Fixed Dashboard scanner alerts to report blocked requests with the complete
  `/api/...` path and bounded deduplication instead of labelling every rejected
  request an intrusion. The advanced-tools entry now opens Shadow Portal
  directly, and Shadow authentication rejects unset PINs while accepting the
  Owner `DASHBOARD_PIN` as a timing-safe recovery credential.

- Synchronized all repository documentation with the current `ttt` runtime:
  exact boot/maintenance lifecycle, 15-command and 13-variable contracts,
  redacted versus audited Member Detail access, complete snapshot storage,
  backup/restore validation, and one-service deployment guidance.
- Rebuilt the Verification web experience as one responsive operations
  workspace with an in-page guild switcher, consistent callback/campaign
  surfaces, accessible state cues, restrained motion, and an isolated theme
  stylesheet layered over the shared component foundation.
- Classified Discord's `An invalid token was provided` login response as a
  terminal Voice token failure so stale sessions no longer remain active in the
  Owner Dashboard; fixed Session Detail response handling and idempotent stop.
- Changed disabled Natural/AutoDeaf logging from failure-red to informational
  pause state, and corrected Dashboard RAM to report process RSS with explicit
  V8 heap details. Replaced the misleading mixed-counter Success Rate card with
  the real process Error Events count.
- Made production `DASHBOARD_PIN` accept any non-empty Owner-chosen value while
  preserving PIN throttling and all session/CSRF protections.

### Changed

- Removed dynamic HTML injection sinks from the Verification dashboard, limited
  its HTTP helper to same-origin guild APIs, hardened Voice notification event
  records against computed-key injection while preserving restart deduplication,
  and made protected-file validation read only literal allowlisted paths.

- Reorganized every Owner, Verification, callback, campaign, and approved
  Shadow web surface around clearer Thai labels, grouped navigation, searchable
  guild selection, responsive touch targets, visible keyboard focus, semantic
  tabs/dialogs/live status, reduced-motion support, safer loading states, and
  background-aware refresh timers. OAuth callback feedback now starts promptly
  and tolerates malformed public error/hash input without stranding the page.

- Corrected verification preflight permission calculations to include the
  `@everyone` role, combine channel role overwrites using Discord's documented
  order, honor implicit View/Send/Embed denials, and exclude Forum containers
  that cannot receive a panel message directly. Verification maintenance now
  creates its recovery interval only after the initial startup run succeeds, so
  failed startup leaves no leaked timer and a later start can retry immediately.

- Closed the latest reliability, privacy, persistence, and review findings:
  Voice reconnect guards always release, panel rollback remains trackable on
  Discord cleanup failure, moderation DM evidence reconciles correctly,
  redacted member search/detail cannot infer OAuth email or token state,
  webhook deduplication remains destination-bound, restore payloads are bound
  to their guild metadata, IP history migration is transactionally idempotent,
  privacy deletion is atomic, snapshot chunk/index integrity is validated, and
  restore apply now requires an explicitly confirmed maintenance window.

- Hardened persistence consistency before merge: bounded internal-event storage,
  BSON-sized Snapshot documents, acknowledged rollback/recovery writes, panel
  rollback on database failure, durable recovery reporting, timeout-safe
  webhooks, Protection-case reconciliation, strict restore permissions,
  per-user OAuth activation ordering, bounded `/serverinfo` member loading, and
  Snapshot recovery backoff.

- Restored the original runtime probe contract: `/ping` remains the lightweight
  listener liveness endpoint, while `/health` again reports combined MongoDB,
  Discord, slash-command, Voice, and Verification readiness with 503 on
  important dependency degradation. `/ready` remains an alias of that combined
  readiness response.

- Restored the owner-approved protected compatibility import as a thin adapter
  over `internalEventStorage`; Enterprise Audit models, routes, channel logging,
  and `audit_event_*` storage remain retired.

- Hardened complete Snapshot persistence without adding an aggregate data cap:
  normal writes are measured using their full MongoDB `$set` envelope, oversized
  items/profile/member values fall back to checksum-protected Base64 chunks,
  Object chunks participate in permanent-history cleanup, rollback reports and
  persists sanitized recovery metadata, and Snapshot loading is split into pure
  compatibility helpers to reduce static-analysis complexity.

- Removed the complete Enterprise Audit / Advanced Audit Logger server-activity
  subsystem without replacing it: `/setup-log`, `/audit-logs`, `/api/audit/*`,
  Discord event listeners/intents/partials used only by Audit, channel delivery,
  queues, caches, retention/reconciliation, storage models/helpers, diagnostics,
  UI assets, focused docs and tests are gone. Existing MongoDB Audit collections
  and Discord channels are deliberately not deleted. Operational/Critical
  webhooks, Verification sensitive-access audit, ModCase persistence,
  Protection enforcement, Voice, and the remaining Owner Dashboard stay active.
  The immutable import path required by owner-locked code remains as a thin
  adapter to a separate internal namespace and cannot access the retired Audit
  model or key namespace.

- Completed the slash-command reliability pass: all registered commands are
  guild-only; Voice Panel sessions are isolated by the creating Discord user
  except for Bot Owner/Shadow Master global control; verification panels now
  enforce Discord limits, HTTPS resources, assignable roles, durable dual-store
  persistence and latest-panel Direct Role checks; moderation creates durable
  pending cases before Discord actions; backup snapshots use bounded chunks,
  retain every complete historical version, and select one reconciled active
  version with legacy restore compatibility and reauthorization; and command guidance,
  permissions, mention handling, result counts, cooldowns, locks and payload
  limits now match the registered command surface.

- Decoupled bounded slash-command registration retries from panel restore,
  protected initialization, and Voice auto-resume. Combined readiness now
  reports command-registration readiness, while approval database failures
  fail closed without escaping the interaction handler.

- Removed the redundant Discord `/stats` slash command, handler, router entry,
  and help text. Runtime status remains available through `/ping` and the Owner
  Dashboard `/status` page; verification statistics APIs remain unchanged.

- Upgraded `/clear` to fetch up to 100 messages, bulk-delete recent messages,
  and delete messages older than 14 days sequentially through Discord's
  single-message endpoint, with per-channel locking and accurate result counts.

- Reduced the supported production deployment contract to exactly 13
  owner-maintained environment values. Render and `.env.example` now expose
  only that canonical set, while advanced voice, verification, migration,
  cache, timeout, retention, and memory controls use code defaults.

- Removed the retired `/say` whitelist subsystem from slash commands, the
  Owner Dashboard, APIs, runtime state, diagnostics, and Mongoose registration.
  `/say` is now Administrator-only; the legacy MongoDB collection is left
  untouched for rollback and is no longer read or written by the runtime.

- Retired the obsolete Owner-only `/setup` Dashboard-link shortcut now
  that the unified Owner Dashboard link is delivered through the operations
  webhook; `/setup-verify` remains unchanged.

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
  delivery diagnostics, and graceful shutdown draining.

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
- Join Campaign continues to enforce owner, guild, live-membership, and quota validation; the optional `JOIN_CAMPAIGN_ALLOWED_GUILDS` list restricts targets when configured.
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
- Added protected owner/system hook safeguards for Trace Eraser policy modes, protected channel IDs, dry-run, kill-switch, rate limiting, metrics, startup diagnostics, internal event records, and focused guard tests.
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
- Historical note: a prior revision allowed an empty Join Campaign allow-list to target any cached guild. The hardened runtime no longer permits that behavior; an explicit allow-list is mandatory. Admin OAuth originally remained scoped to `identify guilds`; the later OAuth scope update above adds `guilds.join`.

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

## Owner-approved self-client dependency

`discord.js-selfbot-v13` is an intentional and necessary dependency of the isolated Voice account/session subsystem. The repository owner has explicitly approved its continued use because the current architecture has no compatible replacement that preserves the required behavior.

Do not remove, replace, migrate, rename, independently upgrade/downgrade, or convert its library-specific APIs unless the repository owner gives a new explicit instruction for that exact change. Main-bot Discord.js v14 work must remain isolated from the self-client package. See [`docs/SELF_CLIENT_POLICY.md`](docs/SELF_CLIENT_POLICY.md) for the binding maintenance policy.
