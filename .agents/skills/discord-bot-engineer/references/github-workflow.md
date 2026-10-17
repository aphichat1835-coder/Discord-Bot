# GitHub-first Discord workflow

## Contents

- Operating context
- Tool routing
- Repository intake
- Diff and history
- Pull requests and reviews
- Quality findings
- Safe mutation

## Operating context

Resolve repository, owner, default branch, current branch, base/head SHA, PR/issue, fork status, local checkout, upstream, divergence, dirty files, and user authority before remote mutation. A phrase such as “this branch,” “latest commit,” or “fix the red checks” is not a repository identifier.

Keep three truths separate:

1. remote GitHub state: PR, issue, reviews, checks, rules, alerts;
2. local checkout state: branch, diff, untracked work, tests;
3. external provider state: Codacy, SonarCloud, CodeFactor, deployment.

Evidence belongs to an exact head SHA. Re-fetch after a push; do not reuse stale checks or reviews as proof for a new commit.

## Tool routing

- Use the connected GitHub app for structured repository, PR, issue, patch, comment, label, and reaction data.
- Route unresolved review threads/requested changes to the GitHub review-comments workflow.
- Route failing Actions checks/logs to the GitHub CI-fix workflow; the connector alone does not provide full Actions logs.
- Route branch creation, intentional staging, commit, push, and draft PR to the GitHub publish workflow.
- Use local `git` for merge-base, local diff, status, history, blame, and preserving user changes.
- Use `gh` only for gaps such as current-branch PR discovery, Actions logs, GraphQL thread state, or connector limitations.
- Use current official GitHub documentation for version-sensitive Actions, rulesets, APIs, and security behavior.

Do not create a parallel GitHub API client inside this Skill. If the repo cannot be resolved from the request, connector, or local remote, ask for `owner/repo`.

## Repository intake

Inspect manifests, lockfiles, source layout, `.github/workflows`, `CODEOWNERS`, PR/issue templates, Dependabot/CodeQL configuration, deployment files, default branch, branch rules when accessible, recent commits, active PR, required checks, and repository-native commands.

Record secret names/config requirements without reading or printing secret values. Treat absence of visible settings as unknown, not disabled.

## Diff and history

Compute changes from merge-base, not an arbitrary recent commit. Classify additions, deletions, renames, dependencies, lockfiles, workflows, permissions/intents, command registration, migrations, generated files, UX, and tests. Trace history only when it can explain intent or regression; blame identifies the introducing change, not guilt.

Raise risk for OAuth, economy, monetization, destructive moderation, database migrations, command registration, security configuration, Actions permissions, releases, and production deployment.

## Pull requests and reviews

Build a PR contract from issue intent, base/head, diff, protected behavior, risk, verification, configuration/migration, security, UX states, rollout/rollback, and unknowns. Compare PR claims with the actual diff.

For reviews:

1. read current unresolved threads and requested changes;
2. separate human review from automated quality findings;
3. collapse duplicates by source/rule/path/message meaning;
4. confirm the finding against current code and installed toolchain;
5. fix the earliest owning boundary and add focused regression proof;
6. re-read the diff and thread after implementation;
7. resolve/reply only when the concern is actually addressed.

Do not mark a thread resolved merely because its line moved. Do not fix style findings that alter behavior without a correctness reason.

## Quality findings

Normalize GitHub Actions, CodeQL, Dependabot, Codacy, SonarCloud, CodeFactor, and local checks into source, rule, severity, path/line, message, category, confidence, current-SHA status, impact, and verification. Provider severity is evidence, not final priority; a low-severity warning can reveal a Discord invariant, while a high-severity heuristic can be false positive.

For “test has no assertion,” inspect whether the file uses explicit assertions, thrown-error expectations, snapshot assertions, callback completion, or import/startup smoke behavior before editing. Preserve the real test purpose.

## Safe mutation

Before commit, confirm scoped diff, protected user changes, no credentials/debug artifacts, intentional lockfile/generated changes, relevant tests, and repository conventions. Stage explicit paths. Never force-push, discard user work, change rulesets, merge, release, deploy, delete branches, or rerun paid/external jobs without matching authority.

Create a draft PR by default when publication is requested and the repository convention does not say otherwise. Include goal, changes, Discord surfaces, permissions/intents/scopes, state/persistence, failure/concurrency cases, UX states, tests, configuration/migration, security, rollback, and unverified boundaries.

GitHub supports repository issue forms and PR templates on the default branch; use them to improve intake, not as a substitute for investigation: https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates
