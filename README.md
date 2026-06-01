# Phomueangtai Enterprise Discord System

A two-service Discord system for bot management, OAuth2 verification, role assignment, logging, and web dashboards.

This repository currently contains:

- **Service 1 — Main Discord bot**: slash commands, owner/admin dashboard routes, voice/session subsystems, audit logging, panels, and command routing.
- **Service 2 — Dashboard Public / Verification Dashboard**: Discord OAuth2 verification flow, guild-admin dashboard foundation, internal APIs, verification logs, risk/device/IP summaries, and role assignment through the bot token.

> Security note: never commit real tokens, API keys, database URLs, passwords, webhook URLs, or `.env` files. Use `.env.example` only as a template with fake placeholder values.

---

## Current project status

The current stable feature is the **Discord OAuth2 verification system**:

1. An administrator runs `/setup-verify`.
2. The bot sends a verification panel to a selected channel.
3. A member clicks the button and authorizes through Discord OAuth2.
4. Service 2 handles `/auth/callback`.
5. The system checks the user profile, member status, configured policy, IP/device summary, and role state.
6. The bot assigns the configured role when verification succeeds.
7. The system writes verification logs and tracking summaries.
8. The user sees a success/failure page and may receive a DM notification.

Recently completed work:

- `/setup-verify` now uses `button_text` instead of separate `button_label` and `button_emoji` options.
- Button text can include emoji in one field, for example `✅ ยืนยันตัวตน ✅`.
- The verification panel validates bot permissions, role hierarchy, and managed roles before sending.
- The public callback page no longer exposes debug output through URL query parameters.

Planned future work:

- Full Dashboard Public renovation: Overview, Settings, Verified Users, Logs, Risk & Network, Panel Manager, Data & Privacy.
- Owner Dashboard expansion: global monitoring, guild control, user intelligence, sensitive reveal approval, data deletion, security center.
- Security/data audit: environment checks, AES-GCM verification, route guard review, schema/index cleanup, dead-code review.
- Audit Log improvements after verification/dashboard systems are stable.

---

## Repository structure

```txt
.
├── package.json                     # Service 1 package, root app entry: discord/index.js
├── .env.example                     # Safe fake environment template
├── README.md                        # Human + AI setup guide
├── CONTEXT.md                       # Project architecture/context for AI agents
├── AGENTS.md                        # Rules for AI coding agents
├── discord/
│   ├── index.js                     # Service 1 boot sequence: Express → MongoDB → Discord
│   ├── commands.js                  # Slash command registry/router only
│   ├── commands/
│   │   ├── moderation.js
│   │   ├── information.js
│   │   ├── utility.js
│   │   └── verification.js          # /setup-verify logic
│   ├── index/
│   │   ├── server.js                # Service 1 API routes
│   │   ├── views.js                 # Service 1 HTML view routes
│   │   ├── system.js                # System utilities / crash / cron helpers
│   │   ├── events.js                # Discord event registration
│   │   └── verifyOwner.js           # Owner-only reveal approval route foundation
│   ├── features/                    # Feature modules
│   ├── auditLogger.js
│   ├── sessionManager.js
│   ├── systemProvider.js
│   └── voiceWorker.js
└── dashboard-public/
    ├── package.json                 # Service 2 package, entry: index.js
    ├── index.js                     # Service 2 Express app
    ├── routes/
    │   ├── oauth.js                 # OAuth2 callback + admin OAuth
    │   ├── guild.js                 # Guild admin dashboard routes/API foundation
    │   └── api.js                   # Internal/public dashboard APIs
    ├── models/
    │   ├── GuildConfig.js
    │   ├── OAuthUser.js
    │   ├── VerifyLog.js
    │   ├── IpIdentityLink.js
    │   └── IPRevealRequest.js
    ├── utils/
    │   ├── crypto.js
    │   ├── discordAPI.js
    │   └── ipUtils.js
    ├── views/
    │   ├── callback.html
    │   ├── home.html
    │   ├── guilds.html
    │   └── guild.html
    └── public/
```

---

## Requirements

- Node.js `>=18.0.0`
- npm
- MongoDB connection string
- Discord bot application + bot token
- Discord OAuth2 application settings
- Render or another Node-compatible hosting provider

---

## Install dependencies

### Service 1 — Main bot

Run from the repository root:

```bash
npm install
```

### Service 2 — Dashboard Public

Run from the `dashboard-public` directory:

```bash
cd dashboard-public
npm install
```

---

## Environment setup

Copy `.env.example` as a reference only. Do not commit real `.env` files.

Service 1 requires at minimum:

```txt
MONGO_URI
TOKEN_MANAGER
API_SECRET
ENCRYPTION_KEY
NODE_ENV
```

Service 2 requires at minimum:

```txt
MONGO_URI
TOKEN_MANAGER
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
ENCRYPTION_KEY
SESSION_SECRET
DASHBOARD_URL or PUBLIC_DASHBOARD_URL
```

Discord Developer Portal OAuth2 Redirect URIs for Service 2:

```txt
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/callback
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/admin-callback
```

Use real values only in Render Environment Variables or local `.env` files that are ignored by Git.

---

## Run locally

### Service 1 — Main bot

```bash
npm start
```

Equivalent:

```bash
npm run dev
```

Both run:

```bash
node discord/index.js
```

### Service 2 — Dashboard Public

```bash
cd dashboard-public
npm start
```

Equivalent:

```bash
cd dashboard-public
npm run dev
```

Both run:

```bash
node index.js
```

---

## Basic syntax checks

There is currently no automated `npm test` script. Use these basic checks before deploying code changes.

Service 1:

```bash
node --check discord/index.js
node --check discord/commands.js
node --check discord/commands/verification.js
```

Service 2:

```bash
cd dashboard-public
node --check index.js
node --check routes/oauth.js
node --check routes/guild.js
node --check routes/api.js
```

HTML files such as `dashboard-public/views/callback.html` should be checked by opening the page in a browser or with an HTML validator.

---

## Smoke test checklist

After deploying verification changes:

1. Run `/setup-verify` with only `channel` and `role`.
2. Run `/setup-verify` with `button_text: ✅ ยืนยันตัวตน ✅`.
3. Confirm the bot sends a panel without `Invalid Form Body`.
4. Click the verification button with a normal account.
5. Confirm OAuth redirects back to Service 2.
6. Confirm success page appears.
7. Confirm the configured role is assigned.
8. Confirm DM notification behavior is correct.
9. Click again with an account that already has the role.
10. Confirm no duplicate DM and no role removal.
11. Test a new account if account-age policy is enabled.
12. Confirm failure pages do not show debug details.
13. Check Render logs for major errors.

---

## Render deployment overview

### Service 1 — Main bot

- Root Directory: repository root
- Build Command: `npm install`
- Start Command: `npm start`
- Required environment variables: see `.env.example`

### Service 2 — Dashboard Public

- Root Directory: `dashboard-public`
- Build Command: `npm install`
- Start Command: `npm start`
- Required environment variables: see `.env.example`

Deploy Service 1 after changing files under `discord/`.
Deploy Service 2 after changing files under `dashboard-public/`.

---

## Safe development workflow

Recommended workflow for future work:

```bash
git switch main
git pull
git switch -c feature/dashboard-public-renovation
```

Then work in a feature branch, open a Pull Request, let review bots run, inspect the diff, and merge only after smoke tests are planned.

Before large changes, create a local backup branch or tag:

```bash
git branch backup/verify-core-stable-before-next-phase
# or
git tag verify-core-stable-before-next-phase
```

Do not push secrets. Do not deploy automatically after a large refactor unless the change has been reviewed.

---

## AI agent notes

AI coding agents must read these files before editing:

1. `README.md`
2. `CONTEXT.md`
3. `AGENTS.md`
4. `package.json`
5. `dashboard-public/package.json`

Important guardrails:

- Do not edit `.env`.
- Do not add real secrets to any file.
- Do not expand OAuth scopes or sensitive data collection without explicit review.
- Do not rewrite large mixed-responsibility files unless required and reviewed.
- Prefer feature branches and small Pull Requests.
- Do not touch `voiceWorker.js`, `systemProvider.js`, or legacy session behavior unless the task explicitly requires it.

---

## Troubleshooting

| Issue | Check |
|---|---|
| Bot will not start | `TOKEN_MANAGER`, `MONGO_URI`, `API_SECRET`, `ENCRYPTION_KEY` |
| Dashboard Public will not start | `MONGO_URI`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_MANAGER` |
| OAuth redirect fails | Discord Developer Portal Redirect URI must match Service 2 URL exactly |
| Role not assigned | Bot token, bot role position, target role hierarchy, `TOKEN_MANAGER` in Service 2 |
| Panel button invalid | OAuth URL length, `PUBLIC_DASHBOARD_URL`, emoji format |
| Debug visible to users | `callback.html` should keep public debug disabled |

---

## Documentation files

- `README.md`: install/run/deploy/use guide.
- `CONTEXT.md`: detailed project context and architecture for future agents.
- `AGENTS.md`: rules for safe AI coding agent work.
- `.env.example`: fake placeholder environment template.
- `.gitignore`: prevents secrets and generated files from being committed.
