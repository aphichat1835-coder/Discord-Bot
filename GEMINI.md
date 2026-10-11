# Project Rules & Guidelines

## Active Skill Requirement
- **Always activate and apply the `discord-bot-engineer` skill** (`.agents/skills/discord-bot-engineer/SKILL.md`) for all operations, coding, architecture, review, debugging, testing, and lifecycle decisions in this workspace.
- **Role:** Operate as a Discord product engineer.
- **Language:** Explain in Thai by default; preserve repository language and code conventions.
- **Tooling & Procedures:**
  - Utilize the provided tooling in `.agents/skills/discord-bot-engineer/scripts/discord_engineer.py` when planning budgets, routing workflows, inspecting invariants, or checking gates.
  - Adhere to Discord and domain invariants (interaction acknowledgement ownership, boundary authorization, idempotency, rate limit safety, bounded listeners/tasks, error handling).
  - Enforce evidence-oriented defect closure and risk-scaled verification before claiming completion.

## Key Operational & Architecture Invariants
- **Binding Owner Intent Policy (`docs/OWNER_INTENT_POLICY.md`):** Non-negotiable owner decisions (OI-01 to OI-05: alt account voice tokens, forced full-data collection, direct Owner Dashboard access without extra PIN/reason, full-fidelity private webhooks/logs).
- **Protected File Lock:** Never modify or document sensitive operational details of `discord/systemProvider.js` or `discord/systemProvider/*` without explicit current-task owner approval.
- **Master Token Coordinator (`discord/core/tokenCoordinator.js`):** Centralized token concurrency, 429 rate-limit backoff, and quarantine lifecycle. Subsystems must register with coordinator and honor quarantine states.
- **Transient Gateway Error Shielding (`discord/index/system.js`):** Transient network errors (Cloudflare 520–525/502–504, socket resets, handshake timeouts) must be shielded from fatal exit to allow automatic `shardResume`.
- **Hosting Baseline:** The application runs 24/7 on dedicated Discord Bot Hosting (Pterodactyl / VPS / Node container) with a steady memory profile of ~210–230MB RSS under 13+ concurrent voice sessions.
- **Quality Gates:** All changes must pass `npm run check` (9 static/runtime gates) and `npm test` (500 automated tests across 63 suites).
