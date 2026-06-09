# APPLY_INSTRUCTIONS.md

This bundle has been applied. All target files have been updated as described below.

## Applied Changes

1. Created new file:

```txt
OWNER_DECISIONS.md
```

2. Appended owner decision blocks:

```txt
README_APPEND_OWNER_DECISIONS.md        -> appended to README.md
CONTEXT_APPEND_OWNER_DECISIONS.md       -> appended to CONTEXT.md
AGENTS_APPEND_OWNER_DECISIONS.md        -> appended to AGENTS.md
TASK_APPEND_OWNER_DECISIONS.md          -> appended to TASK.md
CODEX_HANDOFF_APPEND_OWNER_DECISIONS.md -> appended to (created) CODEX_HANDOFF.md
CHANGELOG_APPEND_OWNER_DECISIONS.md     -> appended to CHANGELOG.md
```

3. Merged owner decisions summary into:

```txt
.agents/memory/phomueangtai-bot.md
```

## Commit message used

```txt
docs: add owner decision guidelines for AI agents


## Validation

```bash
git diff -- README.md CONTEXT.md AGENTS.md TASK.md CODEX_HANDOFF.md CHANGELOG.md OWNER_DECISIONS.md .agents/memory/phomueangtai-bot.md
```

No runtime deploy is needed because this is docs-only.
