---

## Owner Decisions Reminder

Before proposing migration, rewrite, subsystem removal, or architecture replacement, read:

```txt
OWNER_DECISIONS.md
```

Current owner choices:

```txt
Keep discord.js v13 for now.
Keep voice/session subsystem.
Keep dashboard structure.
Keep verification architecture.
Keep one repository + two services + shared MongoDB.
```

Do not repeat previously rejected suggestions unless there is new concrete evidence from implementation.

If reporting a security or runtime issue, include:

```txt
file
behavior
impact
minimal fix
validation
```
