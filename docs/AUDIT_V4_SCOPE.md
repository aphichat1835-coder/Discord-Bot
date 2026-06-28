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

- Audit web/API routes are mounted through `discord/index/auditWebBundle.js`.
- Audit runtime lifecycle is wired through `discord/logging/auditRuntimeLifecycle.js`.
- Reconciler runtime remains opt-in through `AUDIT_RECONCILER_ENABLED`.
- Gateway audit records save to persistent audit storage for dashboard/API reads when category settings allow storage.
- Dead-letter visibility exists for missing channel and send-failure paths, but production confidence still depends on real Discord server testing.
