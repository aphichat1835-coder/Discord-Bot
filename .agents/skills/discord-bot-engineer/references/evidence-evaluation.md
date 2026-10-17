# Evidence and evaluation

## Contents

- Evidence receipt
- Evaluation cases
- Failure taxonomy
- Context efficiency
- Upgrade loop

## Evidence receipt

Record mode, depth, profiles, confirmed stack, requirements, analyzers, checks, blocked checks, live boundaries, and completion. The receipt supports the final report; it must not contain source code, secrets, or personal payloads.

Completion states are done, implemented-but-unverified, partial, and blocked. A check counts only when command/result evidence exists.

## Evaluation cases

Benchmark observable behavior, not use of vocabulary. Score route/scope, repository evidence, Discord invariants, root cause/design, architecture fit, implementation safety, experience truth, verification, completion honesty, and efficiency.

Critical failures override scores: secret exposure, authorization bypass, destructive action without authority, false live-test claim, duplicate money/entitlement, or irreversible data risk without recovery.

Use baseline without the Skill versus candidate with the Skill when the environment supports it. Otherwise validate deterministic route/analyzer/harness outcomes and disclose the model-evaluation boundary.

## Failure taxonomy

Classify the earliest failed boundary: trigger, route, context, Discord knowledge, reasoning, tool/source, architecture, implementation, experience, verification, or reporting. Fix the earliest transferable boundary and add a contrasting case so a hard-case guardrail does not damage simple work.

## Context efficiency

Measure the loaded control text, initial references, tool-output view, and retained evidence separately. Smaller is better only while intent, security, failures, unknowns, traceability, and completion accuracy remain unchanged. Store full machine-readable artifacts outside the conversation and expose a compact index with blockers and causal failures. A passing check needs no raw log; a failing check retains a bounded causal tail. Escalation is a correctness feature, not a budget failure.

Run the token-budget cases and the capability-preservation gate with every Skill change. Reject an optimization if an old behavior/evidence case regresses, even when byte or token estimates improve.

## Upgrade loop

1. Preserve the raw request, fixture, output/diff/log, and expected invariant.
2. Reproduce or encode a failing scenario/mutation.
3. Change the smallest manifest, reference, analyzer, harness, or asset.
4. Run original and contrasting cases.
5. Measure critical failures, quality, context cost, and ceremony.
6. Keep only improvements that generalize.

Do not bloat the Skill for unavailable credentials/tools, missing project evidence, or model capability limits. Treat those as environment boundaries.
