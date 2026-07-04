# AGENTS.md

This file is the rulebook for AI coding agents working in this repository.

## Project Identity

This is the Phomueangtai Personal Multi-Tool Discord Bot. It is not verification-only.

The project includes:

- Main Discord bot runtime.
- Slash commands.
- Voice/session subsystem.
- Owner dashboard.
- Owner-only verification dashboard integrated into the main web runtime.
- OAuth2 verification.
- MongoDB persistence.
- Audit logging.
- Protection features.
- Role buttons.
- Moderation, utility/admin, and information commands.
- Approved/pending guild flows.
- Owner/admin controls.
- Protected owner/system hooks.

## Source Of Truth

Before changing code, inspect the relevant implementation files and the current documentation. Do not rely on generic assumptions.

Required reading order for non-trivial work:

1. `AGENTS.md`
2. `CONTEXT.md`
3. `ARCHITECTURE.md`
4. `ROADMAP.md`
5. `SECURITY.md`
6. `README.md`
7. `CHANGELOG.md`
8. Relevant implementation files for the task

If documentation and implementation disagree, report the mismatch and inspect the implementation before recommending or applying changes.

## Required Workflow

1. Inspect relevant files.
2. Summarize what currently exists.
3. Identify affected systems.
4. Separate facts from assumptions.
5. Explain risks before core or security-sensitive changes.
6. Ask for clarification when the request conflicts with current implementation or protected decisions.
7. Make the smallest safe change that solves the approved task.
8. Validate with exact commands where possible.
9. Report files inspected, files changed, what changed, why, checks performed, and remaining risks.

## Owner-Approved Architecture Decisions

Preserve these decisions unless the owner explicitly approves a specific change:

- Keep `discord.js` v13 for now.
- Keep the voice/session subsystem.
- Keep the Owner Dashboard and integrated verification dashboard structure.
- Keep verification in the single main runtime unless the owner approves another change.
- Keep owner/admin controls.
- Keep one repository, one Node process, one public HTTP port, and one shared Mongoose connection.
- Keep `discord/systemProvider.js` protected.

Do not re-suggest these without new implementation evidence and explicit owner approval:

- Immediate migration to `discord.js` v14.
- Rewriting the entire project.
- Removing voice/session.
- Removing dashboards.
- Removing verification.
- Removing owner/admin controls.
- Splitting the repository or verification runtime.
- Adding a second MongoDB connection for verification.

## Protected File Lock

`discord/systemProvider.js` and all files inside `discord/systemProvider/` are OWNER-LOCKED.
The lock applies to the root file and the entire directory recursively, including future files added below that directory.

The protected set currently includes:

```txt
discord/systemProvider.js
discord/systemProvider/actions.js
discord/systemProvider/auth.js
discord/systemProvider/dashboardHtml.js
discord/systemProvider/htmlUtils.js
discord/systemProvider/renderers.js
```

Do not edit, move, delete, rename, reformat, split, lint-fix, comment-edit, summarize hidden details from, refactor, or document sensitive behavior from any file in this protected set unless the owner explicitly approves it in the current task.

Do not change imports related to `discord/systemProvider.js` or any file inside `discord/systemProvider/`. Do not change boot logic that initializes or references them. Do not document hidden operational details, internal trigger phrases, command names, misuse flows, private procedures, or sensitive behavior from any file in this set.

If touching any file in this protected set appears necessary, stop and ask for explicit approval using this form:

```txt
Owner approves editing discord/systemProvider[/filename] for [specific reason].
```

Without that approval, leave all files in the protected set and their boot/import references unchanged.

Repository enforcement:

- `.github/CODEOWNERS` requests owner review for both protected paths.
- `npm run check:protected` rejects protected-path changes in the current working tree or CI comparison range.
- `npm run check:all` excludes the protected root file and directory from broad syntax scanning.
- These checks are defense in depth and do not replace explicit current-task owner approval.

## Refactor Policy

Refactors must be minimal and task-related.

- Preserve public routes, command names, custom IDs, response shapes, database schemas, OAuth behavior, dashboard behavior, and voice/session lifecycle unless the task explicitly approves changing them.
- Prefer compatibility layers when splitting large files.
- Do not add dependencies without explicit owner approval.
- Do not run broad formatting or cleanup across unrelated runtime files.
- Do not create unused architecture layers just to make the tree look cleaner.
- For high-risk files, extract pure helpers first and validate behavior before moving side-effect code.

High-risk areas include:

- OAuth and verification callbacks.
- Sessions, cookies, auth, PIN handling, and internal API secrets.
- Token encryption/decryption and token reveal flows.
- Raw IP, device, risk, and owner approval data.
- Discord role assignment.
- Owner dashboard controls.
- Bot startup, event handling, shutdown, and voice/session lifecycle.

## Security Policy

Never expose real secrets, tokens, webhook URLs, MongoDB URLs, dashboard PINs, OAuth credentials, private keys, API keys, hidden operational details, or private configuration in code, docs, logs, summaries, or PR text.

Use `.env.example` only as a placeholder reference. Treat encrypted tokens, OAuth metadata, raw IP reveal records, device fingerprints, risk summaries, and owner/admin controls as sensitive.

## Accuracy Rules

Do not claim that a file, route, command, model, environment variable, middleware, service, or subsystem exists unless it was found in the repository.

When something is missing, say it is missing or not found and propose the smallest safe next step.

Clearly separate:

- Facts found in the repository.
- Assumptions.
- Recommendations.

## Documentation Policy

The active documentation set is:

- `README.md`
- `AGENTS.md`
- `.github/copilot-instructions.md`
- `CONTEXT.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `ROADMAP.md`
- `SECURITY.md`

Documentation must reflect the real implementation. Do not document imaginary architecture. If implementation details are sensitive, summarize at subsystem level without exposing hidden operational details.

## Review Output Format

When reporting runtime, privacy, security, or maintainability issues, use:

```txt
File:
Code path / route / command:
Behavior found:
Why it matters:
Concrete impact:
Suggested minimal fix:
Files affected:
Validation:
```

## Final Report Format

After completing a task, include:

- Files inspected.
- Files changed.
- What changed.
- Why it changed.
- Checks performed.
- Remaining risks or notes.

If no tests or checks were run, say that clearly.
