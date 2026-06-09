# AGENTS.md

## Project Identity

This is a personal multi-tool Discord bot project with dashboard, verification, voice/session, authentication/session, role assignment, and database/session-related systems.

This project is not verification-only. It includes the main Discord bot runtime, slash commands, voice/session subsystem, owner dashboard, Dashboard Public, guild admin dashboard, OAuth2 verification, MongoDB persistence, audit logging, protection features, role buttons, moderation commands, utility/admin commands, information commands, approved guild flows, and owner/system hooks.

## Core Principle: Grill with Docs

Before changing code, inspect relevant implementation files and documentation.

Do not rely on generic assumptions. Treat the existing codebase as the source of truth.

**Do not recommend architectural changes until the actual implementation has been inspected.**

If docs and implementation disagree, report the mismatch and inspect the implementation before recommending changes.

## Suggested Reading Order

For non-trivial tasks, read these before editing:

1. `AGENTS.md`
2. `CONTEXT.md`
3. `docs/OWNER_DECISIONS.md`
4. `docs/AI_GUIDE.md`
5. `docs/ARCHITECTURE.md`
6. `README.md`
7. `TASK.md`
8. `docs/SECURITY_PRIVACY.md`
9. `docs/VALIDATION.md`
10. Relevant implementation files for the task

Do not stop at documentation. Use the docs to find the relevant implementation, then inspect the implementation directly.

## Required Agent Workflow

1. Inspect relevant files.
2. Summarize what currently exists.
3. Identify affected systems.
4. Separate facts from assumptions.
5. Explain risks.
6. Ask for clarification when the task conflicts with existing implementation.
7. Make the smallest safe change.
8. Report what changed.

## Architecture Protection

### 1. No Architecture Rewrite Without Permission

Do not rewrite, replace, migrate, or redesign core architecture unless the owner explicitly requests it.

Do not suggest replacing existing systems just because a newer, cleaner, or more common approach exists. This includes avoiding casual changes to:

- Discord bot core
- dashboard structure
- verification architecture
- voice/session subsystem
- authentication/session flow
- database/session logic
- role assignment logic
- discord.js major version

Architecture changes are acceptable only when:

- the owner explicitly asks for them,
- there is a concrete bug that requires it,
- there is a concrete security issue,
- or the current implementation cannot support the requested feature safely.

Project-specific protected decisions:

- The owner intentionally keeps discord.js v13.
- The owner intentionally keeps the voice/session subsystem.
- The owner intentionally keeps the existing dashboard structure.
- The owner intentionally keeps the current verification architecture.
- The owner intentionally keeps owner/admin controls.
- The owner intentionally keeps one repository with two services and shared MongoDB.

These systems must not be removed, replaced, or repeatedly questioned unless there is a concrete bug, security issue, or explicit owner request.

### 2. Preserve Existing Behavior

When fixing bugs or adding features, preserve current behavior unless the task clearly requires changing it.

Avoid breaking existing:

- dashboard pages and flows
- verification behavior
- session behavior
- login/authentication behavior
- Discord role assignment behavior
- existing commands
- existing database/session behavior
- existing user-facing behavior

Avoid unrelated cleanup, formatting, renaming, restructuring, or refactoring unless necessary for the task.

Make the smallest safe change that solves the requested problem.

### 3. Explain Impact Before Core Changes

Before changing core systems, explain the expected impact.

Identify:

- files likely to be affected
- subsystems likely to be affected
- behavior that may change
- possible risks
- possible tradeoffs
- whether the change touches security-sensitive areas
- whether the change may affect existing users or server behavior

Core systems include:

- verification
- OAuth/authentication
- sessions
- cookies
- permissions
- Discord roles
- dashboard routes
- database/session logic
- bot startup and event handling
- voice/session subsystem

Inspect the actual implementation before making claims about impact.

### Protected file lock — `discord/systemProvider.js`

`discord/systemProvider.js` is OWNER-LOCKED. Do not edit, move, delete, rename, reformat, split, lint-fix, comment-edit, summarize with sensitive details, or refactor this file unless the owner explicitly approves it in the current task.

Do not change imports related to `discord/systemProvider.js`. Do not change boot logic that initializes or references it. Do not document hidden operational details, internal trigger phrases, command names, misuse flows, or sensitive behavior.

If touching this file appears necessary, stop and ask for direct owner approval first. Required approval must be explicit, for example: `Owner approves editing discord/systemProvider.js for [specific reason].`

## Refactor Policy

Refactors must be minimal and task-related.

Avoid broad rewrites, dependency migrations, framework changes, or cleanups that are not required by the task.

Do not use formatting, linting, or cleanup as a reason to touch unrelated runtime files. Do not migrate discord.js, rewrite dashboards, remove the voice/session subsystem, replace verification architecture, or split the repository unless the owner explicitly requests that scope.

## Security Policy

For verification, OAuth, sessions, tokens, cookies, roles, permissions, and user data, inspect before changing and avoid weakening security.

Never expose real secrets, tokens, webhook URLs, database URLs, dashboard PINs, OAuth credentials, private keys, API keys, hidden operational details, or private configuration in code, docs, logs, summaries, or PR text.

For high-risk areas such as authentication/session handling, token handling, role assignment, IP/device/risk data, owner/admin controls, and protected owner/system hooks, make the smallest safe change and explain the risk clearly.

## Accuracy Rules

### 4. Do Not Invent Missing Systems

Do not claim that something exists unless it was actually found in the repository.

Do not invent:

- files
- folders
- routes
- commands
- database tables
- environment variables
- configs
- services
- middleware
- APIs
- subsystems
- documentation

If something is missing, say it is missing or not found, then propose the safest next step.

Clearly separate:

- facts found in the repository
- assumptions
- recommendations

## Documentation Policy

Docs should reflect the real implementation. Do not document imaginary architecture.

If documentation is outdated, update it based on inspected implementation. If implementation details are sensitive, summarize only at a safe subsystem level and do not reveal hidden operational details.

Keep documentation changes focused on the requested task. Preserve owner decisions and project reality: this is a personal multi-tool Discord bot, not verification-only.

## Owner Workflow

### 5. Mobile Owner Friendly

The owner often works from mobile. AI responses should be easy to read and easy to copy.

Agents should:

- keep instructions clear and step-by-step
- avoid unnecessarily long terminal-heavy workflows
- provide copy-ready commands when useful
- avoid vague explanations
- summarize important points clearly
- make final reports readable on a phone screen

This does not mean oversimplifying technical accuracy. It means presenting technical work clearly.

### 6. Final Report Format

After completing a task, final reports should include:

- Files inspected
- Files changed
- What changed
- Why it changed
- Checks performed
- Remaining risks or notes

If no tests or checks were run, say that clearly instead of pretending checks were performed.

If only `AGENTS.md` was changed, explicitly confirm that only `AGENTS.md` was modified.
