# Production-proof protocol

Use the smallest honest claim level from `assets/manifests/production-proof.json`. Deterministic tests prove only their modeled boundary. Repository-native checks add evidence for an exact revision. Experience proof needs applicable state snapshots or renders plus human/client review. Live proof needs the named Discord, staging, or production environment and observation details.

## Real-repository evaluation

1. Resolve repository, branch, head SHA, framework versions, entrypoints, test commands, and dirty state.
2. Run `inspect`, `semantic`, applicable `domain analyze`, `verification-plan`, and `ux audit` read-only.
3. Select a sanitized representative task. Run baseline and Skill-assisted attempts in clean, equivalent worktrees without sharing answers.
4. Have an independent reviewer score intent, correctness, security, verification, experience, and evidence integrity. Record raw artifacts and exact SHA.
5. Use `compare-artifacts`; investigate every regression. Do not tune only to one repository—add a reviewed, sanitized regression case when a general failure is found.

The engine does not execute language models or substitute static signals for control-flow proof. A connected GitHub repository may be inspected read-only as evaluation evidence, but no repository mutation follows from evaluation alone.

## Discord UX payload proof

`ux payload` compiles a REST-shaped snapshot for plain, embed, legacy component, or Components V2 surfaces. Validate it with current official Discord documentation and installed framework builders/types, then inspect it in an actual Discord client. Components V2 snapshots use the message flag and component structures, but Discord behavior remains version-sensitive.
