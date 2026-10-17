# GitHub evidence, readiness, and release

## Contents

- Evidence receipt
- Readiness gate
- Release plan
- Deployment and rollback

## Evidence receipt

Record repository, default/current branch, base/head SHA, PR/issue, merge-base diff, commits, review decision, unresolved blocking threads, checks with SHA/status/source, normalized findings, local commands, configuration/migration, security, deployment/live evidence, unknowns, and collection time.

Never collapse these into one “tests passed” flag:

- local command result;
- GitHub required check;
- external quality/security gate;
- deployment health;
- live Discord smoke test.

## Readiness gate

Use these states precisely:

- `ready_for_review`: implementation and local proof exist; review/remote checks may remain.
- `changes_requested`: current blocking review exists.
- `ci_failed`: current required check failed.
- `blocked_by_configuration`: permissions, secret, plan, environment, or external setup blocks proof.
- `implemented_but_unverified`: code exists without sufficient test/check evidence.
- `ready_to_merge`: current-SHA required checks, review, mergeability, security, scope, and unknown gates pass.
- `merged_unverified_in_production`: merge occurred but deployment/live proof is incomplete.
- `merged_verified_in_production`: the merged SHA, deployment health, and representative live Discord checks are confirmed.

Never equate a local pass with CI, changed lines with addressed review, a stale check with current head, draft release with publication, or successful deploy with correct Discord behavior.

## Release plan

Resolve version source and repository convention before choosing SemVer, calendar version, package version, tag, or release title. Compare the release target with the previous authoritative tag and classify breaking behavior, features, fixes, security, dependencies, migrations, commands/intents/scopes, configuration, and operations.

Prepare changelog/release notes from verified PRs and commits; do not invent user-visible changes. Verify immutable target SHA, artifacts/provenance where available, dependencies, build/tests, migrations, environment variables, command registration policy, staged rollout, observability, and rollback. Create a draft release unless the user explicitly authorizes publication.

## Deployment and rollback

Separate release creation from deployment. Before production require explicit authority, protected environment/approval when configured, secret/config readiness, migration order, backup where relevant, concurrency/ownership, health checks, Discord gateway/REST/database/API signals, and a tested rollback or forward-fix boundary.

After deployment verify the exact version/SHA, startup, command registration without destructive global churn, interaction acknowledgement, permissions, database health, queue/voice ownership where relevant, error rate, and representative live smoke tests. Never claim live validation without performing it.

GitHub exposes Actions runs/artifacts through its API, but availability is not proof of artifact integrity: https://docs.github.com/en/rest/actions
