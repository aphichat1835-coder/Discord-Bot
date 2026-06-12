# GitHub Copilot Instructions

This repository is a personal multi-tool Discord bot, not verification-only.

Before suggesting changes, use the current implementation as source of truth and read:

- `AGENTS.md`
- `CONTEXT.md`
- `ARCHITECTURE.md`
- `ROADMAP.md`
- `SECURITY.md`

Rules:

- Preserve `discord.js` v13 unless the owner explicitly approves migration.
- Preserve voice/session, dashboards, verification, owner/admin controls, and shared MongoDB architecture.
- Do not rewrite the project or split the repository by default.
- Do not edit or summarize hidden details from `discord/systemProvider.js`.
- Do not change command names/options, route paths, JSON response shapes, database schemas, OAuth behavior, token/encryption behavior, or voice/session lifecycle unless the task explicitly asks for it.
- Prefer small helper extraction and compatibility layers over broad refactors.
- Never expose real tokens, webhook URLs, MongoDB URLs, OAuth secrets, dashboard PINs, raw IP values, or hidden operational details.
- Add or update documentation when adding routes, commands, models, env vars, or behavior that changes the architecture map.
