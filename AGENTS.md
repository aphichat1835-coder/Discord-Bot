# AGENTS.md

## Project Identity

This is a personal multi-tool Discord bot project with dashboard, verification, voice/session, authentication/session, and database-related systems.

This project is not verification-only. It includes the main Discord bot runtime, slash commands, voice/session subsystem, owner dashboard, Dashboard Public, guild admin dashboard, OAuth2 verification, MongoDB persistence, audit logging, protection features, role buttons, moderation commands, utility/admin commands, information commands, approved guild flows, and owner/system hooks.

## Core Principle: Grill with Docs

Before changing code, inspect relevant implementation files and documentation.

Do not rely on generic assumptions. Treat the existing codebase as the source of truth.

**Do not recommend architectural changes until the actual implementation has been inspected.**

If docs and implementation disagree, report the mismatch and inspect the implementation before recommending changes.

## Required Agent Workflow

1. Inspect relevant files.
2. Summarize what currently exists.
3. Identify affected systems.
4. Separate facts from assumptions.
5. Explain risks.
6. Ask for clarification when the task conflicts with existing implementation.
7. Make the smallest safe change.
8. Report what changed.

## Protected Architecture

The following systems are owner-approved and protected from casual removal, replacement, repeated questioning, or broad rewrites:

- The owner intentionally keeps discord.js v13.
- The owner intentionally keeps the voice/session subsystem.
- The owner intentionally keeps the existing dashboard structure.
- The owner intentionally keeps the current verification architecture.
- The owner intentionally keeps owner/admin controls.
- The owner intentionally keeps one repository with two services and shared MongoDB.

These systems must not be removed, replaced, or repeatedly questioned unless there is a concrete bug, security issue, or explicit owner request.

Before proposing migration, rewrite, subsystem removal, dependency replacement, or architecture replacement, inspect the actual implementation and provide concrete evidence.

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

## Documentation Policy

Docs should reflect the real implementation. Do not document imaginary architecture.

If documentation is outdated, update it based on inspected implementation. If implementation details are sensitive, summarize only at a safe subsystem level and do not reveal hidden operational details.

Keep documentation changes focused on the requested task. Preserve owner decisions and project reality: this is a personal multi-tool Discord bot, not verification-only.

## Final Response Requirements

Future AI agents should state:

- files inspected,
- facts found,
- assumptions,
- changes made,
- checks run,
- remaining risks.

Do not claim tests or checks passed unless the exact command was actually run.
