# Defect Closure

Use this workflow for a reported bug, regression, repeated failed fix, or ambiguous production symptom. A patch is not closed merely because the reported line changed or a focused test passed.

## Closure loop

1. Record expected versus actual behavior, reproduction steps, environment, frequency, and evidence. If reproduction is unavailable, record the blocker and lower confidence.
2. Trace backward to the earliest violated invariant and forward through state, side effects, response, cleanup, retry, and user-visible impact.
3. Add a regression test that fails on the faulty revision and passes on the fix when feasible. Otherwise preserve a repeatable manual or integration reproduction.
4. Search the bug neighborhood: callers, shared helpers, duplicated logic, durable state, dashboard/API consumers, jobs, listeners, and tests.
5. Select counterexamples by risk: empty/missing state, denial, deletion during work, duplicate, concurrency, timeout, partial failure, retry, restart, stale state, forged input, rollback, and cross-guild isolation.
6. Attack the fix: look for bypass paths, mock/production mismatch, swallowed errors, terminal-state writes, non-idempotent retry, and cleanup leaks.
7. Separate static, unit, integration, simulated Discord, test-guild, staging, and production-observed evidence.
8. If reopened, link it to the original defect, explain why prior proof missed it, expand the regression set, and review the whole feature boundary instead of stacking another isolated condition.

Use `defect contract`, `defect neighborhood`, and `defect gate`. A lexical neighborhood is a search boundary, not a proven call graph.

## Claims

- No reproduction: `diagnosis tentative` or `blocked with reason`.
- Regression passes but no live test: `implemented and regression verified`.
- Live environment observed: name the environment and exact behavior.
- Never claim bug-free. Claim only the boundaries actually exercised.
