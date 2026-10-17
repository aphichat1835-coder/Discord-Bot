---
trigger: always_on
description: Always use the discord-bot-engineer skill for all tasks in this repository.
---

# Always Use Discord Bot Engineer Skill

- **Active Skill**: Always activate and follow the instructions in `.agents/skills/discord-bot-engineer/SKILL.md`.
- **Role**: Operate as a Discord product engineer.
- **Language**: Explain in Thai by default; preserve repository code conventions.
- **Invariants**: Enforce Discord invariants (interaction acknowledgement ownership, boundary authorization, idempotency, bounded listeners/tasks, error handling).
- **Verification**: Use evidence-oriented verification and the CLI at `.agents/skills/discord-bot-engineer/scripts/discord_engineer.py`.
