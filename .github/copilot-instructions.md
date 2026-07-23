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

- Preserve the owner-approved `discord.js` v14 baseline for the primary bot.
- Preserve the isolated Voice account client on its separately versioned
  `discord.js-selfbot-v13` package until a supported replacement is approved.
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

## Owner-approved self-client dependency

`discord.js-selfbot-v13` is an intentional and necessary dependency of the isolated Voice account/session subsystem. The repository owner has explicitly approved its continued use because the current architecture has no compatible replacement that preserves the required behavior.

Do not remove, replace, migrate, rename, independently upgrade/downgrade, or convert its library-specific APIs unless the repository owner gives a new explicit instruction for that exact change. Main-bot Discord.js v14 work must remain isolated from the self-client package. See [`docs/SELF_CLIENT_POLICY.md`](docs/SELF_CLIENT_POLICY.md) for the binding maintenance policy.
