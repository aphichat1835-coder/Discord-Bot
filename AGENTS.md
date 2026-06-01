# AI Agent Rules

This repository contains a Discord bot, OAuth2 verification service, dashboards, MongoDB models, environment-sensitive configuration, and security-sensitive user/session data.

AI coding agents must follow these rules strictly.

---

## Primary rule

Do not make broad code changes without understanding the current architecture and the active task.

Before editing, read:

1. `README.md`
2. `CONTEXT.md`
3. `AGENTS.md`
4. `package.json`
5. `dashboard-public/package.json`
6. Any file directly involved in the requested change

---

## Files agents may edit freely for documentation tasks

For documentation-only tasks, edit only:

```txt
README.md
CONTEXT.md
AGENTS.md
.env.example
.gitignore
```

Do not edit code files during documentation-only tasks.

---

## Never edit or expose secrets

Never edit, create, print, summarize, or commit real secrets.

Do not touch:

```txt
.env
.env.* with real values
local secret files
private keys
bot tokens
OAuth client secrets
database URLs
webhook URLs
API secrets
session secrets
```

Never place real values in:

```txt
README.md
CONTEXT.md
AGENTS.md
.env.example
logs
comments
commit messages
Pull Request bodies
```

Use fake placeholders only, for example:

```txt
TOKEN_MANAGER=YOUR_DISCORD_BOT_TOKEN
MONGO_URI=mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/database
DISCORD_CLIENT_SECRET=YOUR_DISCORD_CLIENT_SECRET
```

---

## Branch and commit safety

Preferred workflow:

```bash
git switch main
git pull
git switch -c feature/<short-task-name>
```

Rules:

- Prefer feature branches over direct `main` edits.
- Keep PRs small and reviewable.
- Do not force-push unless explicitly approved.
- Do not deploy unless explicitly asked.
- Do not push secrets.
- Do not rewrite unrelated files.

If the user explicitly asks to edit `main`, keep the change minimal and report exactly what was changed.

---

## Protected or high-risk areas

Do not modify these unless the task explicitly requires it and the change is narrow:

```txt
discord/voiceWorker.js
discord/systemProvider.js
discord/sessionManager.js
discord/index.js boot sequence
discord/index/system.js crash/shutdown behavior
discord/index/events.js event routing
dashboard-public/routes/oauth.js callback security logic
crypto/encryption utilities
models containing indexes or sensitive data
```

Important existing guardrails:

- `discord/index.js` boot order is Express → MongoDB → Discord.
- Render port binding must use `process.env.PORT` and `0.0.0.0`.
- `systemProvider.js` hooks are part of the owner/shadow system and should not be removed.
- `commands.js` should remain mostly a router/registry. Put command behavior in command modules.

---

## OAuth2 verification rules

The current verification system uses Discord OAuth2 Authorization Code Flow.

Allowed/current verification scopes:

```txt
identify
email
connections
guilds
guilds.members.read
guilds.join
```

Do not add sensitive or unusual OAuth scopes unless explicitly approved and documented.

Do not implement collection of private messages, unauthorized account control, credential capture, or user-token login flows.

Use the bot token only through approved server-side code paths. Do not expose bot tokens or OAuth tokens to the browser.

---

## Public debug and error handling

Do not expose raw internal debug details to normal users.

Public pages should show safe, user-readable errors only.

Internal details should go to:

```txt
Render logs
VerifyLog
Owner-only dashboard sections
```

If editing `dashboard-public/views/callback.html`, keep public debug disabled unless an owner-only server-controlled mechanism is added.

---

## Data privacy rules

This project may store Discord profile summaries, guild/member summaries, IP hashes, encrypted IP data, device summaries, and risk flags.

Rules:

- Do not expose raw IP addresses to guild administrators.
- Owner-only reveal features must require explicit owner control and logging.
- Public dashboard views should use summaries and hashes where possible.
- Data deletion and retention controls should be considered before expanding data collection.
- Avoid adding new personal-data fields unless necessary for the requested feature.

---

## Editing large files

Some files are large and mix multiple systems. Avoid full rewrites.

Use surgical changes when possible.

Especially avoid full rewrites of:

```txt
discord/commands.js
discord/index.js
dashboard-public/routes/oauth.js
discord/voiceWorker.js
discord/sessionManager.js
```

If a large rewrite is truly required:

1. Explain why.
2. List all affected behavior.
3. Ask for approval.
4. Prefer a feature branch.
5. Include a rollback plan.

---

## Dependency changes

Do not edit `package.json` or install new dependencies unless necessary.

If a dependency change is needed:

1. Explain the reason.
2. Explain the security impact.
3. Ask for approval before editing.
4. Update README/CONTEXT if approved.

---

## Testing expectations

Before claiming a code change is safe, run or recommend relevant checks.

Current basic checks:

```bash
node --check discord/index.js
node --check discord/commands.js
node --check discord/commands/verification.js

cd dashboard-public
node --check index.js
node --check routes/oauth.js
node --check routes/guild.js
node --check routes/api.js
```

Manual smoke tests for verification changes:

```txt
/setup-verify with channel + role only
/setup-verify with button_text
OAuth success path
Repeat verification path
New-account policy path
Failure page without public debug
Render logs without major runtime errors
```

Do not invent test results. If a test was not run, say it was not run.

---

## Deployment rules

Do not deploy unless the user explicitly asks.

When deployment is requested, state which service needs redeploying:

```txt
Service 1: root / discord bot
Service 2: dashboard-public
```

Deploy Service 1 after changes under `discord/`.
Deploy Service 2 after changes under `dashboard-public/`.

---

## Documentation update rules

When adding or changing features, update docs if behavior changes:

```txt
README.md
CONTEXT.md
.env.example if environment variables changed
AGENTS.md if agent safety rules changed
```

Do not document fake features as completed. Mark planned work as planned.

---

## Response style for future agents

When reporting work:

1. State exactly which files changed.
2. State what changed in each file.
3. State what was not touched.
4. State what tests/checks were run or not run.
5. State next recommended steps.

Be honest about uncertainty. Do not claim 100% safety without evidence.
