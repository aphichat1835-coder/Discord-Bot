# Phomueangtai Enterprise Discord System

Phomueangtai Enterprise Discord System is a two-service Discord project built around a main bot runtime, voice/session management, owner dashboards, public OAuth verification, guild administration, audit/protection features, and MongoDB-backed persistence.

## Important project reality

This repository is **not verification-only**. It includes:

- Main Discord bot runtime
- Slash command router
- Voice/session subsystem
- Main owner dashboard
- Dashboard Public and guild admin dashboard
- OAuth2 verification
- MongoDB persistence
- Audit logger
- Protection module and role button feature
- Moderation, utility/admin, and information commands
- Approved guild flows
- Owner/system provider hooks

## Two-service architecture

### Service 1 — Main Discord Bot / Owner System

- Entry: `discord/index.js`
- Root directory: repository root
- Start command: `npm start`
- Purpose: Discord bot runtime, slash commands, voice/session lifecycle, main owner dashboard, audit/protection events, approved guild flow, and owner/admin controls.

### Service 2 — Dashboard Public / Verification Dashboard

- Entry: `dashboard-public/index.js`
- Root directory: `dashboard-public/`
- Start command: `npm start`
- Purpose: Discord OAuth2 verification, guild admin dashboard, verification panel management, verification logs, risk summaries, and internal APIs used by the owner dashboard.

Both services intentionally share MongoDB. This is part of the current architecture and does not mean the services are incorrectly separated.

## Quick start — Service 1

```bash
npm install
npm start
```

Required Service 1 configuration is documented in `.env.example` and `docs/DEPLOYMENT.md`.

## Quick start — Service 2

```bash
cd dashboard-public
npm install
npm start
```

Required Dashboard Public configuration, OAuth redirect URIs, and Render notes are documented in `.env.example` and `docs/DEPLOYMENT.md`.

## Documentation map

- [Architecture](docs/ARCHITECTURE.md) — full project architecture and subsystem map.
- [AI guide](docs/AI_GUIDE.md) — required workflow and rules for AI coding agents.
- [Owner decisions](docs/OWNER_DECISIONS.md) — owner-approved architecture decisions and review policy.
- [Security and privacy](docs/SECURITY_PRIVACY.md) — secrets, tokens, OAuth data, IP/device/risk data, and production hardening guidance.
- [Deployment](docs/DEPLOYMENT.md) — Node, Render, service layout, env vars, and OAuth redirect URI notes.
- [Validation](docs/VALIDATION.md) — syntax checks, docs-only checks, tests, and manual review checklist.

Compatibility stubs remain at the repository root for older AI/tool workflows that still reference previous documentation file names.

## Security reminder

Never commit real tokens, Discord secrets, webhook URLs, MongoDB URLs, passwords, dashboard PINs, OAuth credentials, or private operational values. Use `.env.example` only as a placeholder template.

## Validation

See [docs/VALIDATION.md](docs/VALIDATION.md). Do not claim tests or checks passed unless the exact commands were actually run.
