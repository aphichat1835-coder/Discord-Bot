# GitHub Actions and security

## Contents

- Failure triage
- Workflow review
- Security boundaries
- Rules and required checks
- Proof

## Failure triage

Bind the run to workflow, event, branch, head SHA, job, step, attempt, conclusion, and provider. Find the first causal failure; later failures may be cascading. Classify deterministic code/test, flaky, environment, missing configuration/secret, dependency/provider outage, permission, rate limit, timeout, cancellation, runner, cache/artifact, or trigger/ruleset failure.

Read full logs through the CI workflow/`gh`, not connector summaries alone. Redact secrets and user payloads. Reproduce with the repository-native command when feasible. A rerun is diagnostic only when flakiness or infrastructure is plausible; bound reruns and never use them to hide deterministic failure.

After a push, require a new run for the new SHA. Separate local test, GitHub check, provider quality gate, deployment, and live Discord evidence.

## Workflow review

Inspect event triggers, branch/path filters, `pull_request` versus `pull_request_target`, `merge_group`, permissions, environment, secrets, fork boundaries, action references, shell interpolation, cache/artifact trust, matrix, timeouts, retries, `continue-on-error`, job dependencies, concurrency, deployments, and reusable-workflow contracts.

- Prefer explicit least-privilege `permissions` for `GITHUB_TOKEN`.
- Treat `pull_request_target` plus checkout/execution of untrusted PR code as critical.
- Treat `${{ }}` interpolation of untrusted titles, bodies, branch names, issue fields, or dispatch inputs into shell as injection risk; pass validated values through environment/input boundaries.
- Pin third-party actions according to repository security policy; a mutable tag is not immutable provenance.
- Use `timeout-minutes` for potentially hanging jobs.
- Use concurrency to prevent stale CI/deploy overlap where cancellation or serialization is safe.
- Use environments/approvals for sensitive deployment and keep production secrets out of ordinary PR jobs.

Official references:

- Workflow token permissions: https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication
- Secure use reference: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- Concurrency: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency

## Security boundaries

Inspect CodeQL/code scanning, SARIF, Dependabot alerts/updates, dependency review, secret scanning/push protection, vulnerable actions, excessive token permissions, OIDC/cloud trust, environment protection, workflow injection, cache/artifact poisoning, and sensitive logs when the repository plan and settings expose them.

Do not infer a feature is disabled because its data is unavailable. GitHub plan, organization policy, permissions, and Advanced Security configuration affect visibility and availability. Use authoritative alert state; never copy a secret value into an issue, PR, log, or final report.

## Rules and required checks

Inspect rulesets/branch protection for PR requirement, approvals, stale-review dismissal, CODEOWNERS, required checks, conversation resolution, signed commits, linear history, force-push/deletion, deployment, merge queue, and code-scanning/quality gates.

Required checks must apply to the current SHA. Path filters can leave a required workflow pending when no run is created. Actions used with merge queue may need the `merge_group` event. Do not change a ruleset without explicit repository-admin authority.

Official references:

- Required-check troubleshooting: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks
- Rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- Security settings: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-security-and-analysis-settings-for-your-repository

## Proof

For a CI/security change, provide current-SHA check evidence, focused reproduction/regression, workflow syntax/static validation when available, least-permission review, fork/untrusted-input case, and the remaining provider/plan/live boundary. A green check does not prove production or Discord behavior.
