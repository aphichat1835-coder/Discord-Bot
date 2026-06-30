# Audit PR Status Update

## Current implementation

- Gateway audit logging foundation is implemented.
- `/setup-log` supports message/member/voice/server/security/moderation log channels.
- Moderation command workflow has been extracted and simplified.
- Mongo-backed audit storage plus fallback storage is implemented.
- Gateway audit logs are persisted into `auditStorage` before log delivery.
- Audit export, health, dead-letter, retention, dedup, settings, and channel repair helpers are implemented.
- Audit API routes are registered for logs, export, health, dead letters, and settings.
- `/audit-logs` dashboard page is registered.
- `/audit-logs` uses the dashboard PIN auth flow.
- `auditWebBundle` is mounted in `discord/index/server.js` after the existing `/api` middleware.
- `startAuditRuntime()` is hooked in `discord/index.js` after `auditLogger.register()`.
- Runtime startup passes settings-driven audit scheduler mode so saved reconciler opt-ins can resume after restart.
- Shutdown includes `auditReconcilerScheduler`.
- Dashboard navigation includes the Audit page.

## Remaining runtime checks

These checks are still required on a live Discord server before treating Audit v4 as fully production-verified:

- Runtime test gateway logs (message edit/delete, member join/leave, voice state changes) in a private test server.
- Runtime test audit API/dashboard routes on the deployed dashboard (`/audit-logs`, `/api/audit/logs`, `/api/audit/export`, `/api/audit/health`, `/api/audit/dead-letters`, `/api/audit/settings`).
- Runtime test audit settings POST with CSRF token.
- Runtime test dead-letter behavior by removing a configured log channel in a test server, then verifying the entry appears in `/api/audit/dead-letters`.
- Runtime test reconciler with `AUDIT_RECONCILER_ENABLED=true` on a private test server to confirm no duplicate log spam.
- Keep protection enforcement behavior (`audit_only` vs active punishment) scoped to explicit owner configuration until tested per guild.

## Completed implementation (as of 2026-06-28)

- All implementation phases described in `docs/AUDIT_V4_SCOPE.md` are complete.
- Per-guild queue limits, circuit breaker, content redaction controls, dead-letter store, export (CSV/JSON/MD), retention, reconciler, and protection audit are all implemented and unit-tested.
- See `docs/AUDIT_RUNTIME_CHECKLIST.md` for the full runtime test order.
