# Audit v4 Scope

This document tracks the next audit logging upgrade. It is intentionally focused on logging, evidence, storage, search, reliability, and test coverage.

## Goals

- Capture gateway events already handled by the bot.
- Add a generic audit-entry renderer for administrative events not handled by gateway listeners.
- Avoid guessing executors when audit data is missing.
- Preserve discord.js v13 and the current dashboard/session architecture.
- Keep protection audit-only by default unless the owner explicitly changes policy later.

## Implementation phases

1. Coverage map.
2. Generic audit entry formatter.
3. Audit reconciler.
4. Persistent audit event storage.
5. Dashboard search and export.
6. Reliability hardening.
7. Fixture tests and runtime checklist.

## Current implementation status

All phases are implemented. Key points:

- Audit web/API routes mounted through `discord/index/auditWebBundle.js` and `discord/index/auditApiRoutes.js`.
- Audit runtime lifecycle wired through `discord/logging/auditRuntimeLifecycle.js`; startup/shutdown integrated in `discord/index.js`.
- Per-guild `GuildLogQueue` in `discord/logging/logCore.js` limits queue depth per guild (`AUDIT_MAX_QUEUE_PER_GUILD`, `LOG_CORE_MAX_QUEUE_PER_GUILD`).
- Circuit breaker on audit send failures (`AUDIT_CIRCUIT_FAILURES`, `AUDIT_CIRCUIT_OPEN_MS`).
- Reconciler runtime remains opt-in through `AUDIT_RECONCILER_ENABLED`; scheduler is in `discord/logging/auditReconcilerScheduler.js`.
- Gateway audit records save to persistent `AuditLogEvent` MongoDB documents before log delivery; dead letters track send failures.
- Audit export supports CSV, JSON, and Markdown via `discord/logging/auditExport.js`.
- Retention policy: default 90 days, guild-scoped; `discord/logging/auditRetention.js` performs bulk soft-delete.
- Message content controls available: `AUDIT_LOG_DELETED_MESSAGE_CONTENT`, `AUDIT_LOG_EDITED_MESSAGE_CONTENT`, `AUDIT_REDACT_LINKS`, `AUDIT_REDACT_MENTIONS`, `AUDIT_MAX_CONTENT_LENGTH`.
- Protection audit logging integrated with moderation cases via `discord/logging/protectionAudit.js` and `discord/logging/protectionPolicy.js`.
- 51+ tests cover rendering, fixtures, lifecycle, settings, retention, dead letters, dedup, health, and audit logger in `discord/tests/`.
- Production confidence still depends on real Discord server runtime testing per `docs/AUDIT_RUNTIME_CHECKLIST.md`.
