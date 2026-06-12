# Changelog

## [Unreleased] - Documentation Consolidation And Minimal Organization Plan

### Added

- Added root `ARCHITECTURE.md` as the implementation-backed architecture source of truth.
- Added root `ROADMAP.md` with the owner-approved minimal Service 1 organization direction and future refactor phases.
- Added root `SECURITY.md` with secrets, OAuth, sessions, tokens, raw IP, logs, owner/admin, and protected-file guidance.
- Added `.github/copilot-instructions.md` for short GitHub Copilot guidance.
- Added low-risk Service 1 helper modules for command registry, custom IDs, voice panel views/interactions, token owner decoding, voice labels, owner-dashboard session serialization, and view helpers.

### Changed

- Rebuilt `README.md` as a human-friendly entry point for the full personal multi-tool bot.
- Rebuilt `AGENTS.md` as the active AI/agent rulebook with the new root documentation set.
- Rebuilt `CONTEXT.md` as the quick project/service/subsystem map.
- Consolidated old `docs/` architecture, file map, roadmap, owner decisions, AI guide, deployment, security/privacy, and validation content into the active root docs.
- Documented Service 1 and Service 2 route groups, command groups, model groups, file responsibilities, hotspots, deployment shape, validation commands, and protected boundaries from current implementation.
- Kept `discord/commands.js`, `discord/index/server.js`, and `discord/index/views.js` as compatibility surfaces while moving pure/helper logic into focused modules.

### Notes

- The intended active documentation set is now:

```txt
README.md
AGENTS.md
.github/copilot-instructions.md
CONTEXT.md
ARCHITECTURE.md
CHANGELOG.md
ROADMAP.md
SECURITY.md
```

- `discord/systemProvider.js` remains owner-locked and must not be edited or summarized with hidden details.
- Broad rewrites, dashboard replacements, verification rewrites, `discord.js` migration, repository split, shared MongoDB replacement, and voice/session redesign remain out of scope without explicit owner approval.
- Command names/options, custom IDs, owner dashboard route paths, and normal session serializer safety policy are intended to remain unchanged.

## Previous Work Summary

Historical work before this consolidation included:

- Dashboard Public foundation and guild admin dashboard planning.
- Voice/session metadata and dashboard detail improvements.
- Session lifecycle compatibility helpers.
- Safer dashboard serializers for normal session responses.
- Verification flow improvements including `/setup-verify`, OAuth callback success/failure behavior, repeat verification handling, and panel compatibility.
- Documentation baseline work for architecture, file responsibilities, owner decisions, AI workflow, security/privacy, deployment, and validation.
