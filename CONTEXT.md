# Project Context

This document explains the current architecture, active systems, and development context for future human maintainers and AI coding agents.

The goal is to make future work safer and more accurate without requiring every agent to reconstruct the project from chat history.

---

## Project identity

Repository: `aphichat1835-coder/Discord-Bot`

Project type: **Two-service Discord automation and verification platform**

The project began as an enterprise Discord voice/session management bot and is being extended into a verification platform with a public guild-admin dashboard and owner-level administrative controls.

---

## High-level architecture

### Service 1 — Main Bot / Owner System

Location: repository root and `discord/`

Entry point:

```txt
discord/index.js
```

Start command:

```bash
npm start
```

Core responsibilities:

- Discord bot login and slash command registration.
- Express server for owner/admin dashboard routes.
- Voice/session subsystem.
- Panel restoration.
- Audit logger registration.
- Shadow/system provider hooks.
- Owner-only approval/reveal route foundation.
- `/setup-verify` command registration and panel creation.

Important files:

```txt
discord/index.js
discord/commands.js
discord/commands/verification.js
discord/index/server.js
discord/index/views.js
discord/index/events.js
discord/index/system.js
discord/index/verifyOwner.js
discord/sessionManager.js
discord/voiceWorker.js
discord/systemProvider.js
discord/auditLogger.js
```

Important guardrail:

- `discord/index.js` boot order is intentionally Express → MongoDB → Discord.
- `discord/commands.js` is intended to be a router/registry only. Command logic should live in command modules.
- Do not remove `systemProvider.js`, `voiceWorker.js`, or exports used by `index.js` unless the task explicitly requires that.

---

### Service 2 — Dashboard Public / Verification Dashboard

Location:

```txt
dashboard-public/
```

Entry point:

```txt
dashboard-public/index.js
```

Start command:

```bash
cd dashboard-public
npm start
```

Core responsibilities:

- Public Discord OAuth2 verification flow.
- `/auth/callback` web page and backend callback processing.
- Guild-admin login foundation.
- Internal/public dashboard APIs.
- Verification logs and stored profile summaries.
- IP/device/risk summaries.
- Role assignment through the configured bot token.

Important files:

```txt
dashboard-public/index.js
dashboard-public/routes/oauth.js
dashboard-public/routes/guild.js
dashboard-public/routes/api.js
dashboard-public/views/callback.html
dashboard-public/views/home.html
dashboard-public/views/guilds.html
dashboard-public/views/guild.html
dashboard-public/models/GuildConfig.js
dashboard-public/models/OAuthUser.js
dashboard-public/models/VerifyLog.js
dashboard-public/models/IpIdentityLink.js
dashboard-public/models/IPRevealRequest.js
dashboard-public/utils/crypto.js
dashboard-public/utils/discordAPI.js
dashboard-public/utils/ipUtils.js
```

---

## Current active feature: Discord OAuth2 verification

The current stable feature is the OAuth2 verification flow.

### Setup flow

1. A server administrator runs `/setup-verify`.
2. The bot sends a verification panel to the selected channel.
3. The panel button links directly to Discord OAuth2 authorize.
4. The state includes guild ID, role ID, nonce, timestamp, and an HMAC signature.
5. The command syncs verification config into `GuildConfig`.

### User flow

1. User clicks the panel button.
2. User authorizes the Discord OAuth2 app.
3. Discord redirects to Service 2 `/auth/callback`.
4. `callback.html` posts `code` and `state` to the backend.
5. `routes/oauth.js` exchanges the code and fetches Discord profile/connections/guilds/member info.
6. The backend processes IP/device information.
7. The backend checks guild config and verification policy.
8. If the user passes and does not already have the role, the bot assigns the role.
9. The backend logs the event, updates tracking summaries, and optionally sends DM.
10. The page shows success/failure without public debug output.

---

## Current `/setup-verify` behavior

The command currently supports:

Required:

```txt
channel
role
```

Optional:

```txt
verify_type
content
title
description
button_text
color
image
thumbnail
footer
timestamp
url
```

`button_text` replaces the older `button_label` + `button_emoji` split.

Examples:

```txt
✅ ยืนยันตัวตน ✅
🔐 Verify Identity 🔐
<:verify:123456789012345678> ยืนยันตัวตน ✅
```

The implementation still includes backward compatibility for old cached Discord command options.

---

## Verification data model intent

The verification system is designed to store and summarize:

Discord profile data:

```txt
user ID
username
global name
discriminator
avatar/banner URLs
accent color
email/email verified
locale
premium type
public flags
account creation time/account age
connections
guild list and permissions
member roles/nickname/joinedAt/pending/timeout state
```

Web/request/device data:

```txt
encrypted raw IP
IP hash
country/city/ISP/org/ASN summary
VPN/proxy/TOR/hosting flags
user agent
browser
OS/platform
device type
language/timezone/screen size
fingerprint hash
```

System tracking:

```txt
first seen
last seen
verification count
success/blocked/failed counts
role snapshots
same-IP identity links
risk score/risk flags
```

Security note: keep raw sensitive data restricted. Public guild administrators should not receive owner-only sensitive details.

---

## Current stable checkpoint

Completed and tested:

```txt
OAuth2 verification core
role assignment
DM behavior
repeat verification handling
new-account policy block
/setup-verify button_text renovation
callback public debug suppression
```

Known follow-up work:

```txt
Dashboard Public renovation
Owner Dashboard expansion
Data deletion / retention controls
Owner-only sensitive reveal controls
Security Center / env checker
Full AES-GCM and route guard audit
Duplicate schema index warning cleanup
Audit Log/Koya-style improvements later
```

---

## Known risks and review notes

### Public debug

`callback.html` should keep public debug disabled. The backend may still return internal `debugCode` in JSON responses. Future security work should remove or gate this in production and keep details in `VerifyLog`/Render logs/Owner Dashboard.

### Long-lived state

Verification panel links are intentionally long-lived. This matches the current product decision, but future Panel Manager work should add reset/rotate controls.

### Role assignment

If role assignment fails, check:

```txt
Service 2 TOKEN_MANAGER
bot role hierarchy
target role managed status
guild membership
Discord API status
```

### File size / agent safety

Some files mix many concerns. Future refactors should reduce agent risk by splitting large files and keeping command logic out of router files.

---

## Future roadmap

### Phase 1: Dashboard Public renovation

Target sections:

```txt
Overview
Verification Settings
Verified Users
Logs
Risk & Network
Panel Manager
Data & Privacy
```

### Phase 2: Owner Dashboard

Target sections:

```txt
Global Verification Monitor
Guild Control
User Intelligence
Sensitive Reveal Approval
Data Deletion
Service Health
Security Center
```

### Phase 3: Security/data hardening

Target tasks:

```txt
Remove production debugCode exposure
Review AES-GCM usage
Review auth guards on all routes
Review .env / secret handling
Review schema indexes
Add backup/deploy checklist
Add automated syntax/test scripts when approved
```

### Phase 4: Audit Log improvements

Deferred until verification and dashboard systems are stable.

---

## Environment summary

Never commit real secrets.

Service 1 important variables:

```txt
MONGO_URI
TOKEN_MANAGER
API_SECRET
ENCRYPTION_KEY
NODE_ENV
DASHBOARD_PIN
DASHBOARD_URL
WEBHOOK_LOG_URL
ALERT_WEBHOOK_URL
SHADOW_MASTER_ID
```

Service 2 important variables:

```txt
MONGO_URI
TOKEN_MANAGER
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
SESSION_SECRET
ENCRYPTION_KEY
DASHBOARD_URL
PUBLIC_DASHBOARD_URL
INTERNAL_API_SECRET
API_SECRET
STORE_OAUTH_TOKENS
```

Use `.env.example` for fake placeholders only.

---

## Recommended next working style

1. Create a new feature branch from latest `main`.
2. Work on one phase at a time.
3. Keep Pull Requests small enough for review.
4. Let CodeRabbit/Qodo or similar review tools inspect diffs.
5. Do not deploy until smoke tests are defined.
6. After a stable phase, create a backup tag or branch.
