# Verification Planner

Inspect repository-native scripts and workspace conventions before selecting commands. Prefer the existing package manager and configuration. Do not install or rewrite tooling merely to satisfy the gate.

Run the smallest credible set, then expand with risk and evidence:

- low: focused behavior plus diff review;
- medium: lint/type/static checks, focused regression, and failure path;
- high: unit, integration, denial, duplicate, timeout, partial failure, restart/recovery, security, and rollback review;
- critical: staged/live boundary, concurrency, reconciliation, monitoring, and incident/recovery evidence.

For UI, include state matrix, narrow/mobile layout, accessibility, locale expansion, screenshot or client review, and visual regression when available. For Discord, validate interaction state and current platform/framework contracts.

Record every command, exit code, bounded output, exact revision, and skipped/blocked check. A missing runner, dependency, token, service, browser, test guild, or production permission is an explicit boundary—not a pass.
