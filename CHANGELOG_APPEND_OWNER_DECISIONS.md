---

## [Unreleased] - Owner Decisions Documentation

### Added

- Added `OWNER_DECISIONS.md` to document architecture decisions and previously rejected suggestions.
- Added guidance for AI agents to avoid repeating migration/rewrite/removal suggestions without inspecting implementation.
- Added concrete security review format so issues are reported with file, behavior, impact, minimal fix, and validation.

### Changed

- Docs should now point AI agents to owner decisions before broad architecture recommendations.
- Reviews should focus on concrete bugs and maintainability issues instead of generic warnings.

### Notes

- This is docs-only.
- This does not suppress real bug or security reports.
- This is intended to reduce repeated generic warnings and unrequested architecture rewrites.
