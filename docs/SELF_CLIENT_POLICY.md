# Owner-Approved Self-Client Dependency Policy

Last confirmed by the repository owner: 2026-07-23.

## Decision

`discord.js-selfbot-v13` is an intentional, owner-approved architecture dependency of this repository. It is required by the isolated Voice account/session subsystem, and the current project has no compatible replacement that preserves the required behavior.

This dependency is not an accidental leftover, an unsupported migration remnant, or a general modernization target. Keeping it is a deliberate decision by the owner of the codebase.

## Mandatory maintenance rule

Unless the repository owner gives a new explicit instruction for that exact change, maintainers and automated agents must not:

- remove or replace `discord.js-selfbot-v13`;
- migrate the Voice self-client to the primary `discord.js` package;
- rename or hide the dependency to bypass this policy;
- upgrade or downgrade the package independently;
- rewrite library-specific APIs merely to make them resemble the main bot's Discord.js v14 APIs;
- classify the package as dead code solely because the primary bot uses another Discord.js major version.

Main-bot Discord.js upgrades must remain isolated from the self-client package and its Voice/session lifecycle.

## Allowed work

Normal reliability, security, observability, memory, cleanup, testing, and compatibility fixes around the Voice subsystem are allowed when they preserve the dependency and its required behavior. Any proposed dependency replacement requires a separate owner-approved design, migration, rollback, and live verification plan.

## Review checklist

Before changing Voice/session code, verify that:

1. `discord.js-selfbot-v13` remains declared in `package.json` and locked in `package-lock.json`.
2. Library-specific option names and APIs are checked against the self-client package, not automatically converted to Discord.js v14 names.
3. Main-bot changes do not alter self-client login, cache, session, reconnect, or cleanup contracts.
4. Tests cover the affected Voice/session behavior.
5. The final report states explicitly whether this policy boundary was preserved.
