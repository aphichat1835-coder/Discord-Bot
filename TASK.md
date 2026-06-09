# TASK.md

# Step 4.4 — Current Task Handoff

This file is a task handoff for Codex. It summarizes the current project state, the workflow position, what is complete, what is not complete, and what must happen next.

This is documentation only. It must not change runtime behavior.

---

## 1. Current Task Summary

Current step: **Step 4.4 — Create TASK.md and CODEX_HANDOFF.md for Codex handoff**.

Current feature direction:

- Dashboard Public renovation
- Owner Dashboard expansion
- Security/data hardening
- Data deletion and retention controls
- Owner-only sensitive reveal controls
- Future audit log improvements

Current goal:

- Prepare Codex to continue safely.
- Summarize the project and pending work.
- Preserve the approved workflow.
- Do not start code implementation yet.

Important status:

- Verification core was tested and is stable enough for the current phase.
- Dashboard Public is still work in progress.
- Owner Dashboard is partially founded but not complete.
- Security hardening is ongoing.
- Step 5 implementation has not started.

---

## 2. Current Workflow Position

| Step | Status | What happened | Notes |
|---|---|---|---|
| Step 1 | Done | Paused and summarized current state | Used to stop random editing and regain control. |
| Step 2 | Needs confirmation | Backup / safety checkpoint | A backup branch or tag was recommended. Confirm before large edits. |
| Step 3.1 | Done | Documentation hardening draft | Draft docs were prepared before root application. |
| Step 3.1.1 | Done | Thai + technical English conversion | Thai explanations with exact technical terms. |
| Step 3.2 | Done | Review / compare docs | Draft docs were reviewed. |
| Step 3.3 | Done | Apply docs to root project | `README.md`, `CONTEXT.md`, `AGENTS.md`, `.gitignore`, `.env.example` were updated. |
| Step 4 | Done | Read updated docs and plan feature continuation | Project was inspected and next feature plan was created. |
| Step 4.4 | Done | Create `TASK.md` and `CODEX_HANDOFF.md` | Documentation-only handoff step. |
| Step 4.5 | Pending | Codex planning dry run | Inspect-only / plan-only. No edits. |
| Step 5 | Pending | Implement feature in phases | Requires user approval before starting. |
| Step 6 | Pending | GitHub Actions test workflow | Do not start yet. |
| Step 7 | Pending | Render deploy preparation | Do not start yet. |
| Step 8 | Pending | Final pass | Final review after implementation and validation. |

---

## 3. Completed Work

### Documentation work

Completed docs:

- `README.md`
- `CONTEXT.md`
- `AGENTS.md`
- `.gitignore`
- `.env.example`

Purpose:

- `README.md`: human-readable project guide.
- `CONTEXT.md`: deep context for humans and AI agents.
- `AGENTS.md`: main rules for AI coding agents.
- `.gitignore`: protects local files, generated files, and sensitive local artifacts.
- `.env.example`: placeholder-only environment template.

Result:

- Project now has clear AI-agent rules.
- Environment variables are documented with placeholders only.
- The current status is documented as: verification core stable, Dashboard Public WIP, Owner Dashboard partial/planned, security hardening ongoing.

### Planning work

Step 4 produced the following staged plan:

1. Fix Dashboard Public session/auth foundation.
2. Renovate Dashboard Public UI/UX.
3. Improve Guild Admin API quality.
4. Build Owner Dashboard foundation.
5. Perform security/data hardening.

### Project analysis work

The project was confirmed as a two-service system:

- Service 1: Main Discord Bot / Owner System.
- Service 2: Dashboard Public / Verification Dashboard.

Important inspected areas:

- `discord/index.js`
- `discord/commands.js`
- `discord/commands/verification.js`
- `dashboard-public/index.js`
- `dashboard-public/routes/oauth.js`
- `dashboard-public/routes/guild.js`
- `dashboard-public/routes/api.js`
- `dashboard-public/views/home.html`
- `dashboard-public/views/guilds.html`
- `dashboard-public/views/guild.html`
- `dashboard-public/views/callback.html`
- `dashboard-public/models/*`

### Safety work

Completed:

- Public callback debug display was disabled.
- Documentation now warns against exposing secrets.
- `.env.example` uses placeholders only.
- `.gitignore` protects `.env` and local/generated files.

### Code work completed before this handoff

Completed and manually tested:

- `/setup-verify` button text renovation.
- OAuth2 callback flow.
- Role assignment after verification.
- Repeat verification handling.
- New account policy block.
- Public debug suppression.

Known manual test result:

- OAuth flow works.
- Role assignment works.
- DM success works.
- Repeat verification does not remove role.
- New account policy block works.
- Failure page does not expose public debug details.

---

## 4. Not Done Yet

Not done:

- Step 4.5 has not started.
- Step 5 has not started.
- Feature code has not been changed after Step 4 planning.
- Dashboard Public renovation is not complete.
- Owner Dashboard expansion is not complete.
- Security Center / env checker is not complete.
- Full route guard / crypto / model index audit is not complete.
- Data deletion / retention controls are not complete.
- Owner-only sensitive reveal controls are not fully complete.
- Audit Log improvements are not complete.
- GitHub Actions workflow has not been created for this phase.
- Render deploy preparation has not started.
- Final validation has not been completed for the next feature phase.

---

## 5. Do Not Do Yet

Codex must not do these yet:

- Do not edit feature code before Step 5 approval.
- Do not push.
- Do not deploy.
- Do not create GitHub Actions yet.
- Do not create or edit `render.yaml` yet.
- Do not edit `.env`.
- Do not add dependencies.
- Do not rewrite the project.
- Do not remove existing features.
- Do not change architecture.
- Do not touch real credentials or secrets.
- Do not modify `package.json` or lock files without explicit approval.
- Do not modify database schemas without explicit approval.
- Do not change OAuth scopes without explicit approval.

Discord/platform safety:

- Use only official bot/OAuth flows.
- Do not automate user accounts.
- Do not collect user credentials.
- Do not create misleading verification flows.
- Keep OAuth scopes minimal and documented.
- Do not collect IP or personal data unless clearly required, documented, and owner-approved.
- Raw IP or sensitive reveal data must remain owner-only and audited.

Protected/high-risk areas:

- `discord/voiceWorker.js`
- `discord/systemProvider.js`
- `discord/sessionManager.js`
- `discord/index.js` boot sequence
- `discord/index/system.js`
- `discord/index/events.js`
- `dashboard-public/routes/oauth.js` callback security logic
- `dashboard-public/utils/crypto.js`
- `dashboard-public/models/*`
- `package.json`
- `package-lock.json`
- `render.yaml`
- `.github/workflows/*`
- `.env`

---

## 6. Files Created or Updated So Far

| File | Status | Purpose | Codex should read? | Notes |
|---|---|---|---:|---|
| `README.md` | Updated | Main human-readable guide | Yes | Do not mark planned work as complete unless code confirms it. |
| `CONTEXT.md` | Updated | Deep project context | Yes | Source of architecture and risk notes. |
| `AGENTS.md` | Updated | AI coding agent rules | Yes, first | Main rulebook. |
| `.gitignore` | Updated | Ignore secrets/local/generated files | Yes if creating files | Confirm no sensitive file is already tracked. |
| `.env.example` | Updated | Placeholder env template | Yes | Never insert real values. |
| `TASK.md` | Created | Current task tracker | Yes | Step 4.4 output. |
| `CODEX_HANDOFF.md` | Created | Detailed Codex handoff | Yes | Step 4.4 output. |
| `my-project/` | Needs confirmation | Earlier docs draft/staging area | Maybe | Do not treat as source of truth over root docs. |

---

## 7. Feature Plan From Step 4

### Phase 1 — Fix Dashboard Public session/auth foundation

Goal:

- Make guild admin dashboard access work correctly after Discord admin OAuth login.

Reason:

- Planning found a likely session mismatch between `dashboard-public/routes/oauth.js` and `dashboard-public/routes/guild.js`.
- `oauth.js` appears to store manageable guilds in `req.session.adminGuilds`.
- `guild.js` appears to read from `req.session.adminUser.adminGuilds`.

Likely files:

- `dashboard-public/routes/guild.js`
- `dashboard-public/routes/oauth.js` only if inspection proves necessary
- `dashboard-public/views/guilds.html` only if response shape changes

Target behavior:

- Admin login redirects to `/guilds`.
- `/api/guilds` returns manageable guilds.
- `/guild/:guildId` only works for allowed guilds.
- Unauthorized guild access returns 403.

Validation:

```bash
cd dashboard-public
node --check routes/guild.js
node --check routes/oauth.js
node --check index.js
```

Manual:

- Login through `/oauth/admin`.
- Confirm `/guilds` loads guild cards.
- Open a guild dashboard.
- Confirm settings, stats, logs, members load.
- Confirm unauthorized guild access is blocked.

### Phase 2 — Renovate Dashboard Public UI/UX

Goal:

- Improve the dashboard for guild admins without changing architecture or adding dependencies.

Likely files:

- `dashboard-public/views/home.html`
- `dashboard-public/views/guilds.html`
- `dashboard-public/views/guild.html`

Expected sections:

- Overview
- Verification Settings
- Security Policy
- Verified Members
- Logs
- Data & Privacy
- Panel Manager

Risks:

- Large HTML rewrite may break event handlers.
- Keep vanilla HTML/CSS/JS unless dependency changes are approved.
- Do not expose raw IP or sensitive data to guild admins.

### Phase 3 — Improve Guild Admin API quality

Goal:

- Improve response consistency, pagination metadata, safe summaries, and user-friendly errors.

Likely file:

- `dashboard-public/routes/guild.js`

Risks:

- Avoid schema changes unless approved.
- Do not return sensitive raw data to guild admins.
- Keep owner approval flow for sensitive reveal.

### Phase 4 — Owner Dashboard foundation

Goal:

- Improve owner-level monitoring and sensitive reveal approval flow.

Likely files:

- `dashboard-public/routes/api.js`
- `discord/index/verifyOwner.js`
- Owner view/routes if confirmed

Risks:

- Owner-only controls must remain protected.
- Internal secrets must not be exposed to public browser code.

### Phase 5 — Security/data hardening

Goal:

- Harden public/internal routes, debug behavior, data deletion, crypto usage, and model indexes.

Likely files:

- `dashboard-public/routes/oauth.js`
- `dashboard-public/routes/guild.js`
- `dashboard-public/routes/api.js`
- `dashboard-public/utils/crypto.js`
- `dashboard-public/models/*` only with approval
- Docs if behavior/env changes

Risks:

- This phase touches high-risk code.
- Must be planned and approved separately.

---

## 8. Next Step: Step 4.5

Step 4.5 is **Agent/Codex Planning Dry Run**.

This step is plan-only and inspect-only.

Codex should:

- Read `AGENTS.md`.
- Read `CONTEXT.md`.
- Read `README.md`.
- Read `TASK.md`.
- Read `CODEX_HANDOFF.md`.
- Read `package.json`.
- Read `dashboard-public/package.json`.
- Inspect relevant source files.
- Review the Step 4 plan.
- Break Step 5 into phases.
- Identify files to edit.
- Identify files not to touch.
- Identify validation commands.
- Identify risks.
- Ask the user before editing code.

Codex must not:

- Edit files.
- Create files.
- Commit.
- Push.
- Deploy.
- Create GitHub Actions.
- Create or edit `render.yaml`.
- Edit `.env`.
- Add dependencies.
- Change architecture.

---

## 9. Step 5 Preview

Step 5 is actual implementation, but it has not started.

Step 5 must run in phases with checkpoint reports after each phase.

### Phase 1

Fix Dashboard Public auth/session foundation.

Expected file:

- `dashboard-public/routes/guild.js`

After Phase 1, report:

- Files changed.
- What changed.
- Why changed.
- Validation commands.
- Manual validation steps.
- Risks.

Then stop and wait for approval before Phase 2.

### Phase 2

Renovate Dashboard Public UI/UX.

Expected files:

- `dashboard-public/views/home.html`
- `dashboard-public/views/guilds.html`
- `dashboard-public/views/guild.html`

Then stop and report.

### Phase 3

Improve Guild Admin API quality.

Expected file:

- `dashboard-public/routes/guild.js`

Then stop and report.

### Phase 4

Owner Dashboard foundation.

Expected files need confirmation.

Then stop and report.

### Phase 5

Security/data hardening.

Expected files need explicit approval because several are high-risk.

Then stop and report.

---

## 10. Validation Plan

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

### Start/dev

Service 1:

```bash
npm start
npm run dev
```

Actual Service 1 command:

```bash
node discord/index.js
```

Service 2:

```bash
cd dashboard-public
npm start
npm run dev
```

Actual Service 2 command:

```bash
node index.js
```

### Automated test/lint/build

```txt
No automated test script detected.
No lint script detected.
No build script detected.
Manual validation is required.
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

Dashboard Public:

- Open `/`.
- Login with Discord admin OAuth.
- Confirm `/guilds` loads.
- Confirm guild cards render.
- Open `/guild/:guildId`.
- Load settings.
- Save settings.
- Load stats/logs/members.
- Request sensitive reveal approval.
- Delete guild-scoped member data.
- Confirm unauthorized guild access is blocked.

Verification smoke test:

- Use `/setup-verify` with required options only.
- Use `/setup-verify` with `button_text`.
- Confirm panel button works.
- Confirm OAuth callback works.
- Confirm role assignment works.
- Confirm repeat verification does not spam DM.
- Confirm failure page does not show debug details.

Environment checks:

Service 1:

- `MONGO_URI`
- `TOKEN_MANAGER`
- `API_SECRET`
- `ENCRYPTION_KEY`
- `NODE_ENV`
- `PUBLIC_DASHBOARD_URL` or `DASHBOARD_URL`
- `VERIFY_STATE_SECRET`

Service 2:

- `MONGO_URI`
- `TOKEN_MANAGER`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `SESSION_SECRET`
- `ENCRYPTION_KEY`
- `PUBLIC_DASHBOARD_URL` or `DASHBOARD_URL`
- `INTERNAL_API_SECRET` or `API_SECRET`
- `STORE_OAUTH_TOKENS=false` unless storage is explicitly needed

Render:

- If files under `discord/` change, redeploy Service 1 after approval.
- If files under `dashboard-public/` change, redeploy Service 2 after approval.

---

## 11. Risks and Warnings

- No automated tests.
- No lint script.
- No build script.
- Dashboard Public may have session/auth mismatch.
- Env vars may be incomplete in Render.
- Backend may still return technical debug fields in JSON failure responses.
- Data deletion may only soft-delete logs and may not clean all related collections.
- Render deploy config should not be touched yet.
- AI may confuse old voice/session subsystem with new OAuth/dashboard subsystem.
- Protected files must not be touched without approval.
- Model/index warning should be audited later, not rushed.

---

## 12. Approval Gates

Stop and ask before:

- Starting Step 5.
- Editing files outside the approved plan.
- Adding dependencies.
- Editing package files.
- Changing architecture.
- Creating GitHub Actions.
- Creating or editing `render.yaml`.
- Changing deploy settings.
- Pushing.
- Deploying.
- Changing OAuth scopes.
- Changing database schemas.
- Changing crypto logic.
- Touching secrets or env config.
- Removing existing features.
- Refactoring large files.
- Touching protected/high-risk files.

---

## 13. Immediate Instruction for Codex

Read `TASK.md`, `CODEX_HANDOFF.md`, `AGENTS.md`, `CONTEXT.md`, `README.md`, `package.json`, and `dashboard-public/package.json` first.

Then perform **Step 4.5 only**.

Do not edit code files.
Do not create additional files.
Do not commit.
Do not push.
Do not deploy.
Do not create GitHub Actions.
Do not create or edit `render.yaml`.
Do not edit `.env`.

Stop after planning and wait for user approval before Step 5.

---

## Owner Decision Patch Task

Add `OWNER_DECISIONS.md` and link it from docs so AI agents stop repeating already-declined architecture suggestions.

Files to update:

```txt
OWNER_DECISIONS.md
README.md
CONTEXT.md
AGENTS.md
CODEX_HANDOFF.md
CHANGELOG.md
.agents/memory/phomueangtai-bot.md
```

Do not use this file to tell AI to ignore real security bugs. The goal is to stop generic repeated warnings and architecture rewrites, not to suppress concrete bug reports.
