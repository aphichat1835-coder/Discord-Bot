# CODEX_HANDOFF.md

# Codex Handoff — Project Continuation Context

This file is a handoff document for Codex. It transfers the important context from the ChatGPT planning session into a stable repository file.

`AGENTS.md` is still the main rulebook. This file does not replace it.

---

## 1. Purpose of This File

This file exists so Codex can continue the project without reading the full chat history.

It explains:

- What the project is.
- What has already been completed.
- What is still pending.
- What the next safe steps are.
- What files matter for the next feature.
- What files should not be touched without approval.

Codex must read this file before Step 4.5.

---

## 2. Required Reading Order

Before doing any work, Codex must read:

1. `AGENTS.md`
2. `CONTEXT.md`
3. `README.md`
4. `TASK.md`
5. `CODEX_HANDOFF.md`
6. `package.json`
7. `dashboard-public/package.json`
8. Relevant source files for the approved task

Step 4.5 is planning-only. Codex must not edit files during Step 4.5.

---

## 3. Project Overview

Repository:

```txt
aphichat1835-coder/Discord-Bot
```

Project type:

```txt
Two-service Discord automation and verification platform
```

The project contains two services:

- **Service 1:** Main Discord bot / owner system.
- **Service 2:** Dashboard Public / verification dashboard.

Current high-level status:

```txt
Verification core = stable enough for current phase
/setup-verify renovation = completed and manually tested
Public callback debug display = disabled
Dashboard Public = work in progress
Owner Dashboard = planned / partially founded
Security hardening = ongoing
Audit Log improvements = planned later
```

Main technology:

- Node.js
- JavaScript / CommonJS
- Express
- MongoDB / Mongoose
- discord.js
- express-session / connect-mongo in Service 2
- Render or another Node-compatible hosting provider

---

## 4. Repository Context

### Service 1

Location:

```txt
repository root + discord/
```

Entry point:

```txt
discord/index.js
```

Start:

```bash
npm start
```

Important files:

```txt
discord/index.js
discord/commands.js
discord/commands/verification.js
discord/index/server.js
discord/index/views.js
discord/index/events.js
discord/index/system.js
discord/index/verifyOwner.js
discord/sessionManager.js
discord/systemProvider.js
discord/voiceWorker.js
discord/auditLogger.js
```

Notes:

- Do not change the Service 1 boot sequence without approval.
- Do not touch voice/session/system-provider files unless the approved task requires it.
- `/setup-verify` is already renovated and tested.

### Service 2

Location:

```txt
dashboard-public/
```

Entry point:

```txt
dashboard-public/index.js
```

Start:

```bash
cd dashboard-public
npm start
```

Important files:

```txt
dashboard-public/index.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/api.js
dashboard-public/views/callback.html
dashboard-public/views/home.html
dashboard-public/views/guilds.html
dashboard-public/views/guild.html
dashboard-public/models/GuildConfig.js
dashboard-public/models/OAuthUser.js
dashboard-public/models/VerifyLog.js
dashboard-public/models/IpIdentityLink.js
dashboard-public/models/IPRevealRequest.js
dashboard-public/utils/crypto.js
dashboard-public/utils/discordAPI.js
dashboard-public/utils/ipUtils.js
```

Notes:

- `dashboard-public/routes/guild.js` is the safest first target for Step 5 Phase 1.
- `dashboard-public/routes/oauth.js` is security-sensitive. Avoid editing it unless necessary and approved.
- `dashboard-public/models/*` are high-risk because schema/index changes affect stored data.

---

## 5. Documentation State

| File | Status | Purpose |
|---|---|---|
| `README.md` | Active | Human-readable project guide. |
| `CONTEXT.md` | Active | Deep architecture and current-state context. |
| `AGENTS.md` | Active | Main AI-agent rulebook. |
| `.env.example` | Active | Placeholder-only environment template. |
| `.gitignore` | Active | Prevents local/generated/sensitive files from being tracked. |
| `TASK.md` | Active | Current task tracker for Codex. |
| `CODEX_HANDOFF.md` | Active | Detailed handoff for Codex. |
| `my-project/` | Needs confirmation | Earlier docs draft/staging area. |

Do not treat old draft files as source of truth over the root docs.

---

## 6. Workflow History

### Step 1 — Pause and summarize current state

Status: Done

Purpose: regain control before continuing large work.

### Step 2 — Backup / safety checkpoint

Status: Needs confirmation

Purpose: confirm a safe recovery point before large changes.

### Step 3.1 — Documentation hardening draft

Status: Done / current draft-folder existence needs confirmation

Purpose: draft docs before applying them to root.

### Step 3.1.1 — Thai + technical English conversion

Status: Done

Purpose: use Thai explanations while keeping exact technical identifiers.

### Step 3.2 — Review / compare docs

Status: Done

Purpose: review drafts before root application.

### Step 3.3 — Apply docs to root project

Status: Done

Files updated:

```txt
README.md
CONTEXT.md
AGENTS.md
.gitignore
.env.example
```

### Step 4 — Read updated docs and plan feature continuation

Status: Done

Main findings:

- Verification core is stable for the current phase.
- Dashboard Public is still work in progress.
- Owner Dashboard is partially founded.
- Security hardening is ongoing.
- Dashboard Public likely has a session/auth mismatch.
- No automated tests exist.
- Data deletion/retention behavior is not complete.

### Step 4.4 — Create handoff files

Status: Done

Files:

```txt
TASK.md
CODEX_HANDOFF.md
```

### Step 4.5 — Codex planning dry run

Status: Pending

Rules:

- Inspect only.
- Plan only.
- No file edits.
- No extra file creation.
- No push.
- No deploy.
- Stop after planning.

### Step 5 — Implement feature

Status: Pending

Rules:

- Requires user approval.
- Work one phase at a time.
- Stop and report after each phase.

### Step 6 — GitHub Actions test workflow

Status: Pending

Do not create workflow files yet.

### Step 7 — Render deploy preparation

Status: Pending

Do not deploy or edit deploy config yet.

### Step 8 — Final pass

Status: Pending

Final review/checkpoint after implementation and validation.

---

## 7. Decisions Already Made

- `AGENTS.md` is the main AI-agent rulebook.
- `CONTEXT.md` is the deep project context file.
- `README.md` is the human-readable guide.
- `.env.example` must use placeholders only.
- `.gitignore` must protect `.env` and generated/local files.
- `TASK.md` and `CODEX_HANDOFF.md` are the handoff files.
- Work must happen in small phases with checkpoints.
- Verification core should not be heavily touched because it passed manual tests.
- Dashboard Public is the next feature focus.
- Phase 1 should fix Dashboard Public session/auth foundation before UI renovation.

---

## 8. Current Feature Continuation Plan

### Immediate focus

```txt
Dashboard Public renovation
```

But first, fix the foundation.

### Phase 1 — Fix Dashboard Public session/auth foundation

Goal:

- Make admin dashboard access work correctly after Discord admin login.

Important finding:

```txt
oauth.js appears to store manageable guilds in req.session.adminGuilds.
guild.js appears to read req.session.adminUser.adminGuilds.
```

Codex should inspect and confirm this before editing.

Likely file:

```txt
dashboard-public/routes/guild.js
```

Expected behavior:

- `/guilds` loads manageable guilds.
- `/guild/:guildId` only allows access to allowed guilds.
- Unauthorized guild access returns 403.

### Phase 2 — Renovate Dashboard Public UI/UX

Likely files:

```txt
dashboard-public/views/home.html
dashboard-public/views/guilds.html
dashboard-public/views/guild.html
```

Expected sections:

- Overview
- Verification Settings
- Security Policy
- Verified Members
- Logs
- Data & Privacy
- Panel Manager

### Phase 3 — Improve Guild Admin API quality

Likely file:

```txt
dashboard-public/routes/guild.js
```

Goals:

- Better response shape.
- Pagination metadata.
- Safer summaries.
- More user-friendly errors.

### Phase 4 — Owner Dashboard foundation

Likely files need confirmation.

Potential areas:

```txt
dashboard-public/routes/api.js
discord/index/verifyOwner.js
owner dashboard views/routes if confirmed
```

### Phase 5 — Security/data hardening

Needs explicit approval because it may touch high-risk files.

Potential areas:

```txt
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/api.js
dashboard-public/utils/crypto.js
dashboard-public/models/*
```

---

## 9. Rules for Codex

Codex must:

- Read required docs first.
- Inspect relevant source files before editing.
- Plan before implementation.
- Work in small phases.
- Stop after each phase.
- Summarize changed files and reasons.
- Provide validation commands.
- Ask before expanding scope.
- Ask before touching protected files.

Codex must not:

- Edit feature code before Step 5 approval.
- Push.
- Deploy.
- Modify `.env`.
- Expose secrets.
- Add dependencies without approval.
- Rewrite the whole project.
- Remove existing features without approval.
- Change architecture without approval.
- Create GitHub Actions before Step 6 approval.
- Create or edit `render.yaml` before Step 7 approval.
- Touch deployment settings without approval.
- Change OAuth scopes without approval.
- Automate user accounts.
- Collect user credentials.
- Create misleading verification flows.

---

## 10. Security and Privacy Rules

Follow `AGENTS.md` as the source of truth.

Important reminders:

- Do not expose real secret values in code, docs, comments, logs, commits, or examples.
- Use placeholders only in docs.
- If a secret is found, stop and warn the user.
- Do not edit `.env`.
- Do not commit local secret/config files.
- Keep OAuth scopes minimal and transparent.
- Do not collect personal data unless clearly required, documented, and owner-approved.
- Sensitive reveal data must be owner-only and audited.
- Do not show debug details to public users.

---

## 11. Environment Variables

Use `.env.example` as the source of truth for placeholder names and required variables.

Do not add real values here.

Important groups:

- Shared runtime/database/security variables.
- Service 1 bot and owner-system variables.
- Service 2 dashboard/OAuth/session variables.
- Optional future provider variables.

If new variables are needed later:

- Ask user first.
- Update `.env.example` with placeholders only.
- Update `README.md` and `CONTEXT.md` if behavior changes.

---

## 12. Commands and Validation

### Install

Service 1:

```bash
npm install
```

Service 2:

```bash
cd dashboard-public
npm install
```

### Start

Service 1:

```bash
npm start
```

Service 2:

```bash
cd dashboard-public
npm start
```

### Tests/lint/build

```txt
No automated test script detected.
No lint script detected.
No build script detected.
```

### Syntax validation

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

### Manual validation

Verification smoke test:

- Use `/setup-verify` with required options only.
- Use `/setup-verify` with `button_text`.
- Confirm panel sends without Invalid Form Body.
- Click verify.
- Confirm callback.
- Confirm role assignment.
- Confirm repeat verification behavior.
- Confirm failure page does not show debug details.

Dashboard Public manual test:

- Open `/`.
- Login with Discord admin OAuth.
- Confirm `/guilds` loads.
- Confirm guild list shows manageable guilds.
- Open `/guild/:guildId`.
- Load config.
- Save settings.
- Switch all tabs.
- Load stats/logs/members.
- Request sensitive reveal approval.
- Delete data.
- Confirm unauthorized guild access is blocked.

---

## 13. Files Expected to Change Later

| File | Why it may change | Risk | Needs approval? |
|---|---|---:|---:|
| `dashboard-public/routes/guild.js` | Fix session/auth mismatch and improve guild admin APIs | Medium | Yes |
| `dashboard-public/views/home.html` | Landing UI renovation | Low/Medium | Yes |
| `dashboard-public/views/guilds.html` | Guild list UI renovation | Low/Medium | Yes |
| `dashboard-public/views/guild.html` | Main dashboard UI renovation | Medium | Yes |
| `dashboard-public/routes/api.js` | Owner/internal dashboard improvements | Medium/High | Yes |
| `dashboard-public/routes/oauth.js` | Security/session hardening if required | High | Explicit approval |
| `dashboard-public/utils/crypto.js` | Crypto audit/hardening | High | Explicit approval |
| `dashboard-public/models/*` | Index/data retention/schema audit | High | Explicit approval |
| `discord/index/verifyOwner.js` | Owner reveal approval UI/route work | High | Yes |
| `README.md` | Docs update if behavior changes | Low | If needed |
| `CONTEXT.md` | Docs update if architecture/flow changes | Low | If needed |
| `.env.example` | Placeholder-only env update | Medium | Explicit approval |
| `package.json` | Scripts/dependencies only if approved | High | Explicit approval |
| `.github/workflows/*` | Future CI workflow | High | Explicit approval |
| `render.yaml` | Future deploy config | High | Explicit approval |

---

## 14. Files That Must Not Be Touched Yet

Do not touch during Step 4.5 and before Step 5 approval:

```txt
.env
.env.*
package.json
package-lock.json
dashboard-public/package.json
dashboard-public/package-lock.json
render.yaml
.github/workflows/*
discord/voiceWorker.js
discord/systemProvider.js
discord/sessionManager.js
discord/index.js boot sequence
discord/index/system.js crash/shutdown behavior
discord/index/events.js event routing
dashboard-public/routes/oauth.js callback core
dashboard-public/utils/crypto.js
dashboard-public/models/*
node_modules/
logs/
local cache/temp/generated files
```

---

## 15. Step 4.5 Prompt for Codex

```txt
Read AGENTS.md, CONTEXT.md, README.md, TASK.md, CODEX_HANDOFF.md, package.json, dashboard-public/package.json, and relevant source files.

Perform Step 4.5 only: planning dry run.

Do not edit files.
Do not create files.
Do not commit.
Do not push.
Do not deploy.
Do not create GitHub Actions.
Do not create or edit render.yaml.
Do not edit .env.
Do not add dependencies.

Review the Step 4 plan, identify risks, and break Step 5 into phases.

Pay special attention to Dashboard Public session/auth foundation, especially the relationship between dashboard-public/routes/oauth.js and dashboard-public/routes/guild.js.

Stop after planning and wait for user approval before implementation.
```

---

## 16. Step 5 Prompt for Codex

Use only after user approval:

```txt
Start Step 5.

Follow the approved Step 4.5 workflow.

Implement only Phase 1 first:
Fix Dashboard Public session/auth foundation.

Edit only files required for Phase 1.
Prefer editing dashboard-public/routes/guild.js only unless inspection proves another file is necessary.

Do not push.
Do not deploy.
Do not touch .env or secrets.
Do not add dependencies.
Do not change package.json.
Do not rewrite unrelated code.
Do not touch verification core unless required and approved.

After Phase 1, summarize:
- Files changed
- What changed
- Why changed
- Validation commands
- Manual validation steps
- Risks or uncertainty

Stop and wait for approval before Phase 2.
```

---

## 17. Open Questions

No critical open questions detected for Step 4.5.

Questions for later phases:

- Should Dashboard Public continue using vanilla HTML/CSS/JS?
- Should data deletion remain guild-scoped soft deletion only, or expand to related summaries?
- Should backend remove technical failure details from production JSON responses?
- Should owner dashboard live in Service 1, Service 2, or both?
- Should existing `render.yaml` be used later, updated later, or ignored in favor of manual Render setup?
- Should GitHub Actions be added in Step 6 with syntax checks first?
- Should model/index warnings be fixed in a separate phase?

---

## 18. Final Handoff Summary

Current position:

```txt
Step 4 done.
Step 4.4 done.
Step 4.5 is next.
Step 4.5 must be planning-only.
Step 5 has not started.
Codex must wait for user approval before editing code.
```

Most important next action:

```txt
Run Step 4.5 planning dry run in Codex.
Do not edit files during Step 4.5.
After Step 4.5, user must approve Step 5 before implementation.
```

Most important technical finding:

```txt
Dashboard Public likely has an admin session/auth mismatch:
oauth.js stores manageable guilds in req.session.adminGuilds,
while guild.js appears to read req.session.adminUser.adminGuilds.
This should be inspected and fixed first in Step 5 Phase 1 if confirmed.
```
