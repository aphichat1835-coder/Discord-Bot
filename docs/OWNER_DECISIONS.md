# Owner Decisions and Review Policy

This document is the source of truth for owner-approved architecture decisions, review boundaries, and do-not-re-suggest rules.

## Owner-approved architecture decisions

Preserve these decisions exactly:

- Keep discord.js v13 for now.
- Keep voice/session subsystem.
- Keep dashboard structure.
- Keep verification architecture.
- Keep owner/admin controls.
- Keep one repository + two services + shared MongoDB.

## Why these decisions matter

The project is a multi-subsystem Discord system. It includes the main bot runtime, slash commands, voice/session subsystem, main owner dashboard, Dashboard Public, guild admin dashboard, OAuth2 verification, MongoDB persistence, audit/protection, role buttons, moderation, utility/admin, information commands, approved guild flows, and owner/system provider hooks.

Do not reduce the project to a verification-only bot when reviewing or planning changes.

## Previously rejected suggestions

Do not re-suggest these without new evidence and owner approval:

- migrate immediately to discord.js v14
- rewrite the entire project
- remove the voice/session subsystem
- remove the dashboard structure
- remove the verification architecture
- remove owner/admin controls
- split the repository immediately
- replace the shared MongoDB design only because both services use the same database

## Review boundaries

The following areas require concrete review, not generic warnings:

- voice/session dependency stack
- session identity values used by the voice/session subsystem
- network/device/risk summaries used by verification/dashboard policy
- owner/system provider hooks
- owner-only control routes
- owner/admin controls with PIN/approval/audit/route guards

Do not warn only because an area exists. Inspect actual implementation, trace imports/routes/commands/events/models/dashboard usage, and report concrete issues only.

## Required issue format

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

## Do-not-re-suggest list

```txt
Migrate to discord.js v14 immediately.
Rewrite the whole project.
Delete voice/session subsystem.
Delete the existing dashboard.
Delete verification architecture.
Split the repository immediately.
Change architecture before inspecting implementation.
Remove owner/admin controls without owner approval.
```

## Bad review examples

```txt
This subsystem is unusual, remove it.
Rewrite the whole project without inspecting dependencies.
Migrate immediately without checking compatibility.
This architecture is wrong because both services share MongoDB.
```

## Good review example

```txt
File: dashboard-public/routes/oauth.js
Code path / route / command: callback failure response
Behavior found: public response includes internal debug field
Why it matters: public users do not need internal debug details
Concrete impact: browser may show information that should stay internal
Suggested minimal fix: map internal reason to safe public message, keep detailed reason in server log
Files affected: dashboard-public/routes/oauth.js, dashboard-public/views/callback.html
Validation: trigger failed verification and confirm public page shows safe message
```

## Protected file lock

`discord/systemProvider.js` is OWNER-LOCKED. Do not edit, move, delete, rename, reformat, split, lint-fix, comment-edit, summarize with sensitive details, or refactor this file unless the owner explicitly approves it in the current task.

For docs cleanup and normal maintenance, do not modify the file, its imports, or boot logic that initializes/references it. Do not document hidden operational details, internal trigger phrases, command names, misuse flows, or sensitive behavior. Do not include it in automatic formatting, lint fixes, refactor passes, or migration work.

If any change appears to require touching it, stop immediately and ask for direct approval: `Owner approves editing discord/systemProvider.js for [specific reason].` Without that approval, leave the file unchanged.
