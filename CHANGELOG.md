# CHANGELOG

## [Unreleased] - Documentation Consolidation

### Changed

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

บันทึกการเปลี่ยนแปลงสำคัญของโปรเจกต์ Phomueangtai Enterprise Discord System

---

## [Unreleased] - Docs Consolidation / AI Handoff Upgrade

### Added

- Added `AI_FULL_PROJECT_MAP.md` as the full subsystem map for AI coding agents.
- Expanded `CODEX_HANDOFF.md` with full reading order, service map, subsystem map, review boundaries, critical files, and planning dry-run guidance.
- Expanded `OWNER_REVIEW_POLICY.md` with owner-aware areas, review boundaries, issue reporting format, and do-not-re-suggest rules.
- Refreshed `.agents/memory/phomueangtai-bot.md` with updated reading order and project reality.
- Replaced `AGENTS.md` with a current AI rulebook that points to owner decisions, review policy, and the full project map.

### Changed

- AI agents should now read these files before runtime edits:

```txt
AGENTS.md
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
CONTEXT.md
README.md
TASK.md
CODEX_HANDOFF.md
package.json
dashboard-public/package.json
```

- Project documentation now states clearly that the project is not verification-only.
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
