# GitHub Copilot Instructions

This repository is a personal multi-tool Discord bot, not verification-only.

Before suggesting changes, use the current implementation as source of truth and read:

- `AGENTS.md`
- `CONTEXT.md`
- `ARCHITECTURE.md`
- `ROADMAP.md`
- `SECURITY.md`
- `README.md`
- `CHANGELOG.md`
- `docs/RUNBOOK.md`
- `docs/SNAPSHOT_STORAGE.md`

Rules:

- Preserve `discord.js` v13 unless the owner explicitly approves migration.
- Preserve voice/session, Owner Dashboard, verification, owner controls, and shared MongoDB architecture.
- Preserve the single Node process, single HTTP port, and single Mongoose runtime connection.
- Do not rewrite the project or split the repository by default.
- Do not edit, move, rename, reformat, or summarize hidden details from `discord/systemProvider.js` or any file recursively below `discord/systemProvider/`; both paths are owner-locked and require explicit current-task owner approval.
- Do not change imports or boot references for either protected path.
- Do not change command names/options, route paths, JSON response shapes, database schemas, OAuth behavior, token/encryption behavior, or voice/session lifecycle unless the task explicitly asks for it.
- Prefer small helper extraction and compatibility layers over broad refactors.
- Never expose real tokens, webhook URLs, MongoDB URLs, OAuth secrets, dashboard PINs, raw IP values, or hidden operational details.
- Add or update documentation when adding routes, commands, models, env vars, or behavior that changes the architecture map.
- Production has exactly 13 owner-maintained values in `.env.example`; advanced runtime controls use code defaults and are not deployment requirements.
- Verification snapshot storage has no aggregate data-loss ceiling. Preserve per-document BSON safety, complete-version activation, integrity checks, and rollback recovery.
