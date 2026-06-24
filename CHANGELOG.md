# Changelog

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

### Changed

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

- `discord/systemProvider.js` remains owner-locked and must not be edited or summarized with hidden details.
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
