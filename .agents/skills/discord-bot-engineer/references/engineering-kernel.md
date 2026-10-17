# Discord engineering kernel

## Contents

- Execution loop
- Intent and evidence
- Diagnosis and design
- Architecture and change control
- Verification and completion
- Fallbacks

## Execution loop

Use the model's general coding ability; add only Discord-specific control:

```text
Route → Model project → Preserve invariants → Implement → Attack → Prove
```

Select Fast, Standard, Deep, or Incident depth from risk and blast radius. Do not run a full architecture ritual for an isolated copy change. Do not use a shallow check for permissions, money, OAuth, destructive moderation, voice lifecycle, data migration, or distributed ownership.

## Intent and evidence

Resolve the observable user outcome, protected behavior, non-goals, authority, and acceptance evidence from the request and repository. Ask only when two plausible choices change user-visible behavior, security, destructive scope, billing, production, or architecture.

Maintain claims as confirmed, strong inference, tentative, or unknown. Repository/runtime evidence outranks a template. Installed source/types and resolved lockfiles outrank remembered APIs. Current official Discord/framework sources outrank community examples.

Trace the path relevant to the task:

```text
Discord ingress → router → authorization → domain invariant → persistence/integration
                → response → telemetry → cleanup/retry/recovery
```

## Diagnosis and design

For defects, form multiple plausible causes and seek evidence that can disprove them. Prefer the cause that explains all symptoms with the fewest unsupported assumptions. Fix at the earliest stable boundary that owns the violated invariant.

Trace backward from symptom to origin and forward from cause to side effects, retries, user-visible state, downstream systems, and recovery. Check duplicate delivery, reconnect, timeout, partial failure, stale state, missing permission, DM/guild context, shard/process ownership, and restart.

For material design choices compare a minimal compatible option with a structural option. Score correctness, version fit, coupling, operability, migration, and rollback. Do not manufacture alternatives for an obvious local correction.

## Architecture and change control

Preserve the repository's handler/router, module system, package manager, naming, formatting, and test conventions. Do not create a parallel architecture for one feature.

Create a file or abstraction only when it owns a stable responsibility, enables real reuse/testing, isolates a dependency, or materially improves navigation. Reject pass-through layers, one-function folders, and speculative service containers.

For cross-cutting work define state ownership, transitions, permissions, side effects, transactions/idempotency, concurrency, cleanup, configuration, migration, observability, rollout, and rollback before editing.

## Verification and completion

Use repository-native checks. Focus first, broaden with risk:

- Fast: deterministic check and diff review.
- Standard: regression behavior plus static/type/lint check.
- Deep: unit/integration, failure and concurrency cases, broader suite, recovery review.
- Incident: explicit authority, evidence preservation, staged mitigation, recovery validation, monitoring.

Attack the result with relevant Discord failures: late/double response, 403/404/429/5xx, forged component, permission/hierarchy denial, duplicate event, simultaneous action, partial write, restart, stale owner, unavailable dependency, and rollback failure.

Do not declare completion without an evidence receipt covering requirements, diff, checks, security, configuration, migrations, live boundaries, and blocked checks. Use `implemented_but_unverified`, `partial`, or `blocked` precisely.

## Fallbacks

Classify blockers as capability, access, environment, dependency, network, source, test, or authorization. Change the condition or method before retrying.

Fallback order:

1. target repository and installed source/types;
2. focused static/semantic analysis;
3. existing tests or minimal harness;
4. current official sources;
5. maintained compatible examples;
6. bounded provisional reasoning from memory.

When direct verification is impossible, implement only what remains safe, run the strongest simulation/static check, and provide the exact manual/live boundary. Never fabricate tool output, weaken an acceptance criterion silently, bypass security, or claim a live Discord test that did not occur.
