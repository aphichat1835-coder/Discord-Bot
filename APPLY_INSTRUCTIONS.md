# APPLY_INSTRUCTIONS.md

GitHub write was blocked by the tool, so apply this bundle manually or ask Codex to apply it.

## Files

1. Create new file:

```txt
OWNER_DECISIONS.md
```

Use the included `OWNER_DECISIONS.md`.

2. Append the included blocks:

```txt
README_APPEND_OWNER_DECISIONS.md        -> append to README.md
CONTEXT_APPEND_OWNER_DECISIONS.md       -> append to CONTEXT.md
AGENTS_APPEND_OWNER_DECISIONS.md        -> append to AGENTS.md
TASK_APPEND_OWNER_DECISIONS.md          -> append to TASK.md
CODEX_HANDOFF_APPEND_OWNER_DECISIONS.md -> append to CODEX_HANDOFF.md
CHANGELOG_APPEND_OWNER_DECISIONS.md     -> append to CHANGELOG.md
```

3. Replace or merge:

```txt
.agents/memory/phomueangtai-bot.md
```

with the included memory file.

## Suggested commit message

```txt
docs: add owner decision guidelines for AI agents
```

## Validation

```bash
git diff -- README.md CONTEXT.md AGENTS.md TASK.md CODEX_HANDOFF.md CHANGELOG.md OWNER_DECISIONS.md .agents/memory/phomueangtai-bot.md
```

No runtime deploy is needed because this is docs-only.
