# Risk-scaled SDLC

Select ceremony by the work, not by habit.

- **Patch:** requirements → implementation → focused/regression verification → completion.
- **High-risk patch:** add design review, failure paths, UAT, and rollback reasoning.
- **Feature:** planning → requirements → design → implementation → verification → UAT → release → maintenance.
- **Migration:** discovery → compatibility → staged implementation → verification → rollout/rollback → maintenance.
- **Incident:** detect → contain → reproduce → diagnose → recover → verify → monitor → prevent recurrence.
- **Retirement:** inventory → dependency review → deprecate → dispose/retain data safely → remove → verify → monitor.

## Traceability

Assign stable requirement IDs. Map each to design decisions, changed paths, tests, evidence, and status. Do not mark a requirement verified from implementation alone.

## Change control

Record new evidence that changes scope, architecture, destructive behavior, production, privacy, billing, or external effects. Ask for approval where authority changes; otherwise adapt the plan and preserve the reason.

## Environments and acceptance

Keep local, test, preview/staging, and production evidence separate. Include environment variables, secrets source, Discord application/guild, database, migrations, feature flags, and production-only behavior. UAT validates the real flow, copy, permissions, recovery, and acceptance criteria—not merely test status.

## Release and retirement

Bind evidence to an exact revision. Define rollout, monitoring, rollback triggers, recovery, deprecation, data retention/deletion, command/webhook/job cleanup, and secret revocation as applicable.

Use `sdlc plan` and `sdlc gate`; keep project-management budgeting and staffing outside this Discord engineering Skill unless directly required.
