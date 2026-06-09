# CODEX_HANDOFF.md

This file is a direct Codex handoff document for the Phomueangtai Enterprise Discord System project.

This is documentation only. It must not change runtime behavior.

---

## 1. Mission

Codex must understand the full project before editing code.

This repository is not verification-only. It is a combined system with:

```txt
main Discord bot runtime
slash command router
voice/session subsystem
main owner dashboard
Dashboard Public
guild admin dashboard
OAuth2 verification
MongoDB persistence
audit logger
protection module
role button feature
moderation commands
utility/admin commands
information commands
approved guild flows
owner/system provider hooks
owner decision policy
AI full project map
```

---

## 2. Read First

Before starting any work, read these files in this order:

```txt
AGENTS.md
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
CONTEXT.md
README.md
TASK.md
CODEX_HANDOFF.md
package.json
dashboard-public/package.json
```

Then inspect the implementation files related to the task.

Do not edit runtime code before understanding the related subsystem.

---

## 3. Service Map

Service 1:

```txt
entry: discord/index.js
runtime: repository root + discord/
purpose: Discord bot runtime, commands, dashboard main, voice/session, audit, events
```

Service 2:

```txt
entry: dashboard-public/index.js
runtime: dashboard-public/
purpose: OAuth verification, guild admin dashboard, internal APIs, verification logs
```

Shared MongoDB is intentional. It does not mean the services are not separated.

---

## 4. Current Owner Decisions

Before proposing migration, rewrite, subsystem removal, or architecture replacement, read:

```txt
OWNER_DECISIONS.md
OWNER_REVIEW_POLICY.md
AI_FULL_PROJECT_MAP.md
```

Current owner choices:

```txt
Keep discord.js v13 for now.
Keep voice/session subsystem.
Keep dashboard structure.
Keep verification architecture.
Keep owner/admin controls.
Keep one repository + two services + shared MongoDB.
```

Do not repeat previously rejected suggestions unless there is new concrete evidence from implementation.

---

## 5. Main Subsystem Map

```txt
1. Main bot boot/runtime
2. Slash command registry/router
3. Voice/session manager
4. Main owner dashboard
5. Dashboard Public
6. Guild admin dashboard
7. OAuth2 verification
8. MongoDB persistence
9. Audit logger
10. Protection module
11. Role button feature
12. Moderation commands
13. Utility/admin commands
14. Information commands
15. Approved guild / pending guild flows
16. Owner/system provider hooks
17. Owner review policy
18. AI full project map
19. Codex planning workflow
20. Validation workflow
```

---

## 6. Critical Files To Inspect By Area

Main bot / boot:

```txt
discord/index.js
discord/index/system.js
discord/index/server.js
discord/index/views.js
discord/index/events.js
discord/index/auth.js
discord/index/verifyOwner.js
```

Commands:

```txt
discord/commands.js
discord/commands/information.js
discord/commands/moderation.js
discord/commands/utility.js
discord/commands/verification.js
```

Voice/session:

```txt
discord/voiceWorker.js
discord/sessionManager.js
discord/commands.js
discord/index/server.js
discord/index/views.js
```

Dashboard Public / verification:

```txt
dashboard-public/index.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/api.js
dashboard-public/models/GuildConfig.js
dashboard-public/models/OAuthUser.js
dashboard-public/models/VerifyLog.js
dashboard-public/models/IpIdentityLink.js
dashboard-public/models/IPRevealRequest.js
dashboard-public/utils/crypto.js
dashboard-public/utils/discordAPI.js
dashboard-public/utils/ipUtils.js
dashboard-public/views/callback.html
dashboard-public/views/home.html
dashboard-public/views/guilds.html
dashboard-public/views/guild.html
```

Audit / protection / role buttons:

```txt
discord/auditLogger.js
discord/features/protection.js
discord/features/roleButton.js
```

Owner/system hooks:

```txt
discord/systemProvider.js
```

---

## 7. Voice / Session Handoff

Core files:

```txt
discord/voiceWorker.js
discord/sessionManager.js
discord/commands.js
discord/index/server.js
discord/index/views.js
```

Expected conceptual flow:

```txt
/panel
→ modal submit
→ sessionManager validates and persists metadata/state
→ voiceWorker owns live lifecycle
→ dashboard reads status and detail from server APIs
→ stop/restart updates state
→ restart can resume saved sessions
```

Current expected behavior:

```txt
1 identity can be active in multiple guilds.
1 identity should not be active in multiple voice channels inside the same guild.
Multiple identities can be active in the same guild/channel.
voiceWorker owns live lifecycle.
sessionManager owns persistence, locks, metadata, and DB state.
```

Do not remove this subsystem only because it looks unusual. Trace dashboard, command, and worker usage first.

---

## 8. Verification Handoff

Core files:

```txt
discord/commands/verification.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/api.js
dashboard-public/models/GuildConfig.js
dashboard-public/models/OAuthUser.js
dashboard-public/models/VerifyLog.js
dashboard-public/models/IpIdentityLink.js
```

Setup flow:

```txt
Admin runs /setup-verify
→ command validates channel/role/options
→ panel is created
→ config is saved
→ panelRevision is saved
→ user-facing button/link is sent
```

User flow:

```txt
User clicks verification panel
→ Discord OAuth authorize
→ callback service receives result
→ profile/connections/guild/member lookup
→ network/device/risk summary
→ GuildConfig policy checks
→ optional guild join
→ role assignment
→ verification records saved
→ callback page shows success/failure
```

panelRevision:

```txt
latest panel has panelRevision
OAuth state carries panelRevision
callback only accepts latest matching revision
old panel/link should fail with panel_revision_mismatch
```

---

## 9. Dashboard Handoff

Main dashboard:

```txt
discord/index/server.js
discord/index/views.js
discord/index/auth.js
discord/index/verifyOwner.js
```

Dashboard Public:

```txt
dashboard-public/index.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/api.js
dashboard-public/views/home.html
dashboard-public/views/guilds.html
dashboard-public/views/guild.html
dashboard-public/views/callback.html
```

Dashboard work must preserve:

```txt
owner/admin controls
session status/detail pages
verification settings
panel management
guild admin access control
safe public callback display
```

---

## 10. Review Boundaries

Some project areas require concrete review instead of generic repeated warnings:

```txt
voice/session dependency stack
session identity values used by voice/session subsystem
network/device/risk summary used by verification/dashboard policy
owner/system provider hooks
owner-only control routes
owner/admin controls with PIN/approval/audit/route guards
```

Rules:

```txt
Do not warn only because the area exists.
Do not recommend deletion only because a name looks unusual.
Do not expose private configuration values.
Do not document hidden operational details.
Inspect implementation before making recommendations.
```

---

## 11. Required Issue Format

If reporting a runtime, privacy, security, or maintainability issue, include:

```txt
File:
Code path / route / command:
Behavior found:
Why it matters:
Concrete impact:
Suggested minimal fix:
Files affected:
Validation:
```

Bad review examples:

```txt
This subsystem is unusual, remove it.
Rewrite the whole project without inspecting dependencies.
Migrate immediately without checking compatibility.
This architecture is wrong because both services share MongoDB.
```

---

## 12. Planning Dry Run Output

When asked to do a Codex planning dry run, output:

```txt
1. Architecture summary
2. Files inspected
3. Confirmed subsystems
4. Actual issues found, if supported by code
5. Proposed implementation phases
6. Files to edit per phase
7. Files not to touch
8. Validation commands
9. Risks / unknowns
10. Questions for owner, only if blocking
```

Do not edit runtime code during planning dry run.

---

## 13. Validation Commands

Service 1:

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

Service 2:

```bash
cd dashboard-public
node --check index.js
node --check routes/oauth.js
node --check routes/guild.js
node --check routes/api.js
node --check utils/discordAPI.js
node --check utils/ipUtils.js
```

Docs only:

```bash
git diff -- README.md CONTEXT.md AGENTS.md TASK.md CHANGELOG.md CODEX_HANDOFF.md OWNER_DECISIONS.md OWNER_REVIEW_POLICY.md AI_FULL_PROJECT_MAP.md .agents/memory/phomueangtai-bot.md
```

---

## 14. Final Instruction

```txt
Read docs.
Inspect code.
Plan first.
Do not rewrite blindly.
Do not remove owner-approved systems.
Report concrete issues only.
Stop before runtime edits unless owner approves implementation.
```
