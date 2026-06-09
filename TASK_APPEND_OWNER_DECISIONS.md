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
