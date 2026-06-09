# CHANGELOG

## [Unreleased] - Documentation Consolidation

### Changed

- Restored `CONTEXT.md` as the root project context file instead of a redirect-only stub.
- Updated project wording to describe the repository as a Personal Multi-Tool Discord Bot, not verification-only.
- Consolidated deep documentation into `docs/`.
- Shortened and cleaned `README.md` for human-friendly project onboarding.
- Reduced `AGENTS.md` to the root AI coding agent rulebook.
- Reduced `TASK.md` to the current docs-only workflow note.
- Merged architecture context into `docs/ARCHITECTURE.md`.
- Merged Codex handoff and AI workflow guidance into `docs/AI_GUIDE.md`.
- Merged owner decisions and owner review policy into `docs/OWNER_DECISIONS.md`.
- Added `docs/SECURITY_PRIVACY.md`, `docs/DEPLOYMENT.md`, and `docs/VALIDATION.md`.
- Archived/superseded obsolete append helper documentation in `docs/archive/OBSOLETE_DOCS.md`.
- Retained obsolete append/apply helper files as redirect stubs for compatibility.

### Notes

- Docs-only change.
- No runtime behavior changed.
- No OAuth behavior, database schemas, command behavior, dashboard routes, voice/session lifecycle, Render deployment behavior, dependencies, or package manifests changed.

บันทึกการเปลี่ยนแปลงสำคัญของโปรเจกต์ Phomueangtai Personal Multi-Tool Discord Bot

---

## [Unreleased] - Docs Consolidation / AI Handoff Upgrade

### Historical note

This earlier docs-upgrade section is retained for history. Its detailed project-map, handoff, and owner-review content has since been consolidated into the current source-of-truth docs:

- `CONTEXT.md`
- `docs/ARCHITECTURE.md`
- `docs/AI_GUIDE.md`
- `docs/OWNER_DECISIONS.md`
- `docs/SECURITY_PRIVACY.md`
- `docs/VALIDATION.md`

Root legacy files such as `AI_FULL_PROJECT_MAP.md`, `CODEX_HANDOFF.md`, and `OWNER_REVIEW_POLICY.md` are now compatibility stubs that point to the current docs.

### Changed

- AI agents should now read these files before runtime edits:

```txt
AGENTS.md
CONTEXT.md
docs/OWNER_DECISIONS.md
docs/AI_GUIDE.md
docs/ARCHITECTURE.md
README.md
TASK.md
docs/SECURITY_PRIVACY.md
docs/VALIDATION.md
package.json
dashboard-public/package.json
```

- Project documentation now states clearly that the project is a Personal Multi-Tool Discord Bot, not verification-only.
- Documentation now preserves current owner decisions:

```txt
Keep discord.js v13 for now.
Keep voice/session subsystem.
Keep dashboard structure.
Keep verification architecture.
Keep owner/admin controls.
Keep one repository + two services + shared MongoDB.
```

- Review reports should use this format:

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

### Notes

- This is docs-only.
- No runtime behavior changed.
- No deploy required for these docs-only changes.
- Some older append helper files may still exist in the repository, but the current source of truth is the main docs listed above.

---

## Previous Work Summary

### Added / Changed Before This Docs Upgrade

- Dashboard Public foundation and guild admin dashboard planning.
- Voice/session metadata improvements.
- Voice/session dashboard detail improvements.
- Session lifecycle compatibility helpers.
- Safer normal dashboard serializers that avoid returning unnecessary sensitive session fields in normal responses.
- Verification flow improvements including `/setup-verify`, callback success/failure handling, repeat verification handling, and panel behavior.
- Workflow guidance for AI agents and Codex planning dry run.

### Known Ongoing Work

```txt
Dashboard Public renovation
Owner Dashboard expansion
Data deletion / retention controls
Route guard / model index review
Audit log improvements
Manual validation checklist before merge/deploy
```

### Validation Reminder

Service 1:

```bash
node --check discord/index.js
node --check discord/commands.js
node --check discord/commands/information.js
node --check discord/commands/moderation.js
node --check discord/commands/utility.js
node --check discord/commands/verification.js
node --check discord/sessionManager.js
node --check discord/voiceWorker.js
node --check discord/auditLogger.js
node --check discord/index/server.js
node --check discord/index/views.js
node --check discord/index/events.js
node --check discord/index/system.js
```

Service 2:

```bash
cd dashboard-public
node --check index.js
node --check routes/oauth.js
node --check routes/guild.js
node --check routes/api.js
node --check utils/discordAPI.js
node --check utils/ipUtils.js
```
