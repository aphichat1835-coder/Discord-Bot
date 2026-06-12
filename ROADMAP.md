# Roadmap

This roadmap is the owner-approved planning reference. It does not grant permission for broad rewrites or behavior changes.

## Guardrails

- Keep `discord.js` v13 unless the owner explicitly approves a migration task.
- Keep the voice/session subsystem.
- Keep the current dashboard structure.
- Keep the current verification architecture.
- Keep owner/admin controls.
- Keep one repository, two services, and shared MongoDB.
- Do not edit `discord/systemProvider.js` or its boot/import references without explicit current-task owner approval.
- Treat OAuth, sessions, tokens, cookies, roles, permissions, IP/device/risk data, owner routes, and raw IP reveal as high-risk.

## Current Completed Work

### Documentation consolidation

The active documentation set is intentionally small:

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

Old scattered docs, stubs, append helpers, and duplicate `docs/` content should stay removed once their important content is merged into the active set.

### Architecture baseline

`ARCHITECTURE.md` now contains:

- Project identity.
- Two-service architecture.
- Service 1 and Service 2 boot shapes.
- Route maps.
- Slash command map.
- Data model map.
- File responsibility map.
- Subsystem map.
- Deployment shape.
- Validation commands.
- Responsibility hotspots.
- Approved minimal refactor direction.

### Low-risk helper extraction

The first approved Service 1 helper extraction has been applied:

- `discord/index/sessionSerializer.js`
- `discord/index/viewHelpers.js`
- `discord/commands/registry.js`
- `discord/commands/customIds.js`
- `discord/commands/panelViews.js`
- `discord/commands/panelInteractions.js`
- `discord/sessions/tokenUtils.js`
- `discord/sessions/voiceLabels.js`

The old public modules remain compatibility layers:

- `discord/commands.js` still exports `slashCommandsData`, `handleMessage`, `handleInteraction`, `updatePanel`, `restorePanels`, `cleanupGuild`, and `getPanelMessages`.
- `discord/index/server.js` still registers the same owner dashboard routes.
- `discord/index/views.js` still registers the same owner dashboard pages.

## Approved Minimal Service 1 Organization

The owner approved a small organization direction for `discord/`, not a broad rewrite.

Target direction:

```txt
discord/
├─ index.js
├─ config.json
├─ commands.js
├─ sessionManager.js
├─ voiceWorker.js
├─ auditLogger.js
├─ systemProvider.js
│
├─ core/
│  ├─ env.js
│  ├─ http.js
│  └─ safeLog.js
│
├─ sessions/
│  ├─ tokenUtils.js
│  ├─ sessionRules.js
│  ├─ sessionErrors.js
│  └─ voiceLabels.js
│
├─ guards/
│  ├─ commandGuards.js
│  └─ dashboardGuards.js
│
├─ index/
│  ├─ server.js
│  ├─ views.js
│  ├─ auth.js
│  ├─ events.js
│  ├─ system.js
│  ├─ memoryMonitor.js
│  ├─ verifyOwner.js
│  ├─ sessionSerializer.js
│  ├─ dashboardState.js
│  └─ viewHelpers.js
│
├─ commands/
│  ├─ information.js
│  ├─ moderation.js
│  ├─ utility.js
│  ├─ verification.js
│  ├─ registry.js
│  ├─ panelViews.js
│  ├─ panelInteractions.js
│  └─ customIds.js
│
└─ features/
   ├─ protection.js
   └─ roleButton.js
```

Implementation rule: create and use only the files that have real code to hold. Do not create unused placeholder modules just to match the tree.

The following approved names are intentionally deferred because no safe, necessary extraction was made for them in the first pass:

```txt
discord/core/env.js
discord/core/http.js
discord/core/safeLog.js
discord/guards/commandGuards.js
discord/guards/dashboardGuards.js
discord/index/dashboardState.js
discord/sessions/sessionRules.js
discord/sessions/sessionErrors.js
```

## Refactor Phases

### Phase 1 - Low-risk helper extraction

Goal: reduce file confusion without behavior changes.

Allowed examples:

- Move safe owner-dashboard session serialization out of `discord/index/server.js`.
- Move slash command definitions out of `discord/commands.js`.
- Move voice panel render helpers out of `discord/commands.js`.
- Move custom ID constants/helpers out of `discord/commands.js`.
- Move pure voice label helpers where the same label behavior is reused.
- Move reusable owner-dashboard view helpers where they are server-side helpers.

Rules:

- Keep old exports and route behavior stable.
- Keep command names, options, and custom IDs stable.
- Keep dashboard JSON response shapes stable.
- Keep token/session/security behavior stable.

### Phase 2 - Tests and contracts

Goal: make later refactors safer.

Candidate work:

- Add focused tests for extracted pure helpers.
- Add route response contract tests where feasible without live Discord or production secrets.
- Add command registry sanity tests if the test harness supports Service 1 without logging into Discord.
- Keep Dashboard Public Jest tests aligned with helper contracts.

### Phase 3 - Route surface separation

Only after helper extraction and validation.

Candidate work:

- Split owner dashboard API groups from `discord/index/server.js`.
- Split owner dashboard generated pages from `discord/index/views.js`.
- Split Dashboard Public guild admin routes by config, panel, logs/members, risk, and reveal request.

Rules:

- Preserve public paths.
- Preserve JSON response shapes.
- Preserve auth/rate-limit behavior.
- Manually smoke-test affected pages.

### Phase 4 - Persistence boundary review

Only with a scoped task.

Candidate work:

- Create model/service indexes for Service 1 model exports currently exposed by `sessionManager`.
- Create Dashboard Public model index.
- Document shared records used by both services.

Rules:

- No collection rename without owner approval.
- No field removal without migration plan.
- No token/IP/encryption field changes without security review.
- Both services must remain compatible with existing MongoDB data.

### Phase 5 - Frontend organization

Only after route/API behavior is stable.

Candidate work:

- Split `dashboard-public/public/js/guild-dashboard.js` into feature modules.
- Split `dashboard-public/public/css/dashboard.css` by layout/component/page concerns.
- Extract very large Service 1 generated page sections into smaller helpers.

Rules:

- Preserve UI behavior and routes.
- Do not change OAuth callback behavior while reorganizing UI files.
- Verify pages manually.

### Phase 6 - Larger architecture work

Requires explicit owner approval:

- `discord.js` major upgrade.
- Dashboard framework rewrite.
- Repository split.
- Shared MongoDB replacement.
- Verification architecture replacement.
- Voice/session subsystem redesign.
- Owner/system hook changes.
- Token/encryption/session lifecycle changes.

Approval format:

```txt
Owner approves [specific architecture/refactor change] for [specific reason and scope].
```

## Near-Term Follow-Up Ideas

- Add tests for Service 1 helper modules after extraction.
- Document exact owner-dashboard API response shapes with sample safe payloads.
- Document Dashboard Public API response shapes with safe, redacted examples.
- Review one responsibility hotspot at a time before moving side-effect code.
- Keep `ARCHITECTURE.md` current after runtime changes.
