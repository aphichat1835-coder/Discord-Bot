# AGENTS.md — AI Coding Agent Rulebook

This repository is a multi-subsystem Discord project, not a verification-only bot. Keep analysis and edits focused, evidence-based, and respectful of owner-approved architecture decisions.

## Required reading order

Before editing, read:

1. `AGENTS.md`
2. `docs/OWNER_DECISIONS.md`
3. `docs/AI_GUIDE.md`
4. `docs/ARCHITECTURE.md`
5. `README.md`
6. `TASK.md`
7. `docs/SECURITY_PRIVACY.md`
8. `docs/VALIDATION.md`
9. `package.json`
10. `dashboard-public/package.json`

Then inspect the implementation files relevant to the requested task.

## Non-negotiable owner decisions

Preserve these decisions unless the owner explicitly approves a change:

- Keep discord.js v13 for now.
- Keep voice/session subsystem.
- Keep dashboard structure.
- Keep verification architecture.
- Keep owner/admin controls.
- Keep one repository + two services + shared MongoDB.

## Strict rules

- Inspect implementation before recommending migration, rewrite, subsystem removal, or architecture replacement.
- Plan before complex or sensitive edits.
- Keep changes focused on the requested scope.
- Do not rewrite unrelated files.
- Do not expose secrets, tokens, private configuration, webhook URLs, database URLs, dashboard PINs, or hidden operational details.
- Do not claim tests passed unless the exact tests/checks were run.
- Do not add dependencies without owner approval.
- Do not edit package files, deploy config, schemas, OAuth behavior, command behavior, dashboard routes, or voice/session lifecycle unless the task explicitly requires it.

## Protected file lock — `discord/systemProvider.js`

`discord/systemProvider.js` is **OWNER-LOCKED**. Do not edit, move, delete, rename, reformat, split, lint-fix, comment-edit, summarize with sensitive details, or refactor this file unless the owner explicitly approves it in the current task.

For documentation cleanup and normal maintenance:

- Do not modify `discord/systemProvider.js`.
- Do not change imports related to `discord/systemProvider.js`.
- Do not change boot logic that initializes or references it.
- Do not document hidden operational details, internal trigger phrases, command names, misuse flows, or sensitive behavior.
- Do not propose removing it only because it looks unusual.
- Do not include it in automatic formatting, lint fixes, refactor passes, or migration work.

If any change appears to require touching this file, stop immediately. Required approval must be direct and specific, for example: `Owner approves editing discord/systemProvider.js for [specific reason].` Without that approval, leave the file unchanged.

## Current docs-only workflow

For this documentation consolidation task, edit documentation only. Stop before runtime code edits. See `TASK.md` for the active task scope and `docs/VALIDATION.md` for validation commands.
