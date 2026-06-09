# TASK.md

## Current task

Documentation consolidation.

## Scope

Docs-only. Consolidate duplicated root documentation into `docs/`, keep root entrypoint files short, and preserve owner-approved context.

## Files expected to change

- `README.md`
- `CHANGELOG.md`
- `AGENTS.md`
- `TASK.md`
- `CONTEXT.md`
- `CODEX_HANDOFF.md`
- `AI_FULL_PROJECT_MAP.md`
- `OWNER_DECISIONS.md`
- `OWNER_REVIEW_POLICY.md`
- `docs/ARCHITECTURE.md`
- `docs/AI_GUIDE.md`
- `docs/OWNER_DECISIONS.md`
- `docs/SECURITY_PRIVACY.md`
- `docs/DEPLOYMENT.md`
- `docs/VALIDATION.md`
- `docs/archive/OBSOLETE_DOCS.md`
- obsolete append/helper documentation files, if archived or removed

## Files not to touch

Do not edit:

- `discord/systemProvider.js`
- runtime JavaScript files
- `package.json`
- `package-lock.json`
- `dashboard-public/package.json`
- `dashboard-public/package-lock.json`
- Discord command behavior
- OAuth behavior
- database schemas
- session lifecycle
- voice/session lifecycle
- dashboard routes
- Render deploy behavior
- encryption logic
- token logic
- IP reveal runtime logic
- verification callback runtime logic
- bot boot logic
- systemProvider imports
- systemProvider initialization
- hidden/internal behavior from systemProvider

No automatic formatting or lint fixes on JavaScript files.

## Stop condition

Stop before runtime edits. If the task appears to require code behavior changes, report the issue and ask for a new scoped task.

## Validation

Use `docs/VALIDATION.md`. Do not claim tests/checks passed unless the exact command was actually run.
