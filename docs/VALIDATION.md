# Validation

Do not claim tests or checks passed unless the exact command was actually run.

## Docs-only validation checklist

```bash
git diff -- README.md CHANGELOG.md AGENTS.md TASK.md CONTEXT.md CODEX_HANDOFF.md AI_FULL_PROJECT_MAP.md OWNER_DECISIONS.md OWNER_REVIEW_POLICY.md docs/
git diff --name-only | rg '(^discord/.*\.js$|^dashboard-public/.*\.js$|(^|/)package\.json$|(^|/)package-lock\.json$|^render\.yaml$|^discord/systemProvider\.js$)' && exit 1 || true
rg -n "(TOKEN_MANAGER|DISCORD_CLIENT_SECRET|MONGO_URI|WEBHOOK_LOG_URL|ALERT_WEBHOOK_URL|DASHBOARD_PIN)" . -g "*.md" -g ".env.example"
```

## Service 1 syntax checks

```bash
node --check discord/index.js
node --check discord/commands.js
node --check discord/commands/information.js
node --check discord/commands/moderation.js
node --check discord/commands/utility.js
node --check discord/commands/verification.js
node --check discord/sessionManager.js
node --check discord/voiceWorker.js
node --check discord/auditLogger.js
node --check discord/index/server.js
node --check discord/index/views.js
node --check discord/index/events.js
node --check discord/index/system.js
```

## Service 2 syntax checks

```bash
cd dashboard-public
node --check index.js
node --check routes/oauth.js
node --check routes/guild.js
node --check routes/api.js
node --check utils/discordAPI.js
node --check utils/ipUtils.js
```

## Dashboard Public tests

```bash
cd dashboard-public
npm test
```

## Protected file validation

For tasks without explicit owner approval to edit `discord/systemProvider.js`, validate that it is not part of the diff:

```bash
git diff --name-only | rg '^discord/systemProvider\.js$' && exit 1 || true
git status --short -- discord/systemProvider.js
```

Do not run automatic formatting, lint fixes, refactors, or migration work on this file. Do not expose hidden operational details in docs or PR text. If editing becomes necessary, stop and request direct approval first.

## Manual review checklist

- Confirm no runtime JavaScript changed during docs-only tasks.
- Confirm package manifests and lockfiles did not change unless explicitly approved.
- Confirm deployment behavior did not change.
- Confirm owner decisions remain preserved.
- Confirm voice/session subsystem context remains preserved.
- Confirm verification architecture context remains preserved.
- Confirm docs contain no real secrets or private operational values.
- Confirm old root compatibility stubs point to the correct new docs.
