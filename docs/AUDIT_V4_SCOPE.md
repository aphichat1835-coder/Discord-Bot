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
