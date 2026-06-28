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

- Runtime test gateway logs in a private test server.
- Runtime test audit API/dashboard routes on the deployed dashboard.
- Runtime test audit settings POST with CSRF.
- Runtime test dead-letter behavior by removing a configured log channel in a test server.
- Keep any future enforcement behavior disabled until tested separately.
