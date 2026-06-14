# Security

This file is the security and privacy reference for the Phomueangtai Personal Multi-Tool Discord Bot.

## Secret Policy

Never commit, paste into docs, log, or expose real values for:

- Discord bot tokens.
- OAuth client secrets.
- OAuth access or refresh tokens.
- Webhook URLs.
- MongoDB URLs or passwords.
- Dashboard PINs.
- API/internal secrets.
- Encryption keys.
- Private keys.
- Provider API keys.
- Hidden owner/system operational details.

Use `.env.example` only as a placeholder reference.

## Environment Variables

Shared/core variables:

```txt
NODE_ENV
MONGO_URI
ENCRYPTION_KEY
API_SECRET
INTERNAL_API_SECRET
VERIFY_STATE_SECRET
```

Service 1 variables:

```txt
TOKEN_MANAGER
PORT
DASHBOARD_PIN
DASHBOARD_URL
PUBLIC_DASHBOARD_URL
WEBHOOK_LOG_URL
ALERT_WEBHOOK_URL
SHADOW_MASTER_ID
RENDER_EXTERNAL_URL
VOICE_DEBUG_MULTI_CLIENT
```

Webhook routing:

- `WEBHOOK_LOG_URL` is for routine operations, security, and audit-style notices.
- `ALERT_WEBHOOK_URL` is for critical runtime alerts, crash shield messages, and severe voice/session failures.
- Do not point both variables at the same Discord channel unless you intentionally want mixed traffic.
- Service 1 warns at boot if both webhook variables point to the same target or if either target is missing.

Service 2 variables:

```txt
PORT
PORT_DASHBOARD
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
TOKEN_MANAGER
SESSION_SECRET
PUBLIC_BASE_URL
DASHBOARD_PUBLIC_URL
DASHBOARD_URL
PUBLIC_DASHBOARD_URL
STORE_OAUTH_TOKENS
TRUST_PROXY
TRUST_PROXY_HOPS
ENABLE_CF_IP_HEADER
```

Compatibility/fallback names may also appear in code, such as `TOKEN`, `BOT_TOKEN`, or `DISCORD_BOT_TOKEN`. Do not add new secret names without documenting them in `.env.example`, the active architecture reference, and this file.

## Service 1 Security Notes

### Owner dashboard

- Owner dashboard routes are PIN-protected.
- Use a strong `DASHBOARD_PIN` in production.
- Do not commit the PIN.
- Do not weaken cookie, PIN, or auth behavior during dashboard changes.
- Keep owner-only actions guarded and rate-limited.

### API secret

- `API_SECRET` protects sensitive owner dashboard API actions.
- Do not use default or weak values.
- Unauthorized access is logged and may trigger alert webhooks.

### Token reveal

- Token reveal endpoints are sensitive.
- Normal dashboard session serializers must not expose token, encrypted token, token tail, or token hash.
- Reveal flows must remain owner-controlled and PIN-protected.
- Do not log raw tokens.
- Do not include tokens in docs, summaries, screenshots, or test fixtures.

### Voice/session tokens

- Voice/session token handling is sensitive.
- Token encryption/decryption behavior in `discord/sessionManager.js` is high-risk.
- Do not change token lifecycle, hashing, encryption compatibility, session identity, or cleanup behavior without a scoped security review.

## Service 2 Security Notes

### OAuth

- OAuth callback state must remain signed and validated.
- Panel revision freshness checks prevent old panel/state reuse.
- Public callback responses must stay safe and avoid internal debug detail leaks.
- Keep Discord role assignment behavior scoped to configured guild/role settings.

### Sessions and cookies

- Service 2 uses Express sessions backed by MongoDB.
- `SESSION_SECRET` must be strong.
- Production cookies should use HTTPS-compatible settings.
- Admin session compatibility middleware exists for old/new dashboard route shapes; do not remove casually.

### OAuth token storage

- Default policy should avoid storing OAuth tokens unless explicitly required.
- Keep `STORE_OAUTH_TOKENS=false` unless the owner approves storage.
- If token storage is enabled, encrypted token fields remain sensitive.

## IP, Device, And Risk Data

Verification logs can include:

- IP hash and encrypted raw IP.
- Country, ISP, hosting/VPN/proxy/TOR/mobile signals.
- Spoof/header metadata.
- Device/browser/OS/fingerprint summary.
- Risk score and risk flags.
- Policy snapshots and role assignment results.

Treat all of this as sensitive. Normal guild admin views should prefer summaries, hashes, and redacted data. Raw IP access should go through owner approval.

Guild admin access to collected sensitive verification details is gated per guild:

- Raw IP, email, connection lists, and mutual guild lists are hidden by default.
- The bot owner can approve a guild's sensitive data access from the owner verification dashboard.
- The bot owner can revoke that access later.
- This gate does not remove or redesign collection logic; it controls normal guild dashboard visibility.
- Counts and risk summaries may remain visible so admins can operate moderation workflows without exposing raw sensitive values.

## Raw IP Reveal Workflow

The project includes an owner-approved raw IP reveal concept:

```txt
guild admin requests reveal with a reason
request is stored as IPRevealRequest
owner reviews request from owner surface
owner approves or rejects
approved data access should be minimal, audited, and time-bound
```

Do not bypass this flow. Do not expose raw IPs directly in normal public or guild admin responses.

## Discord Role Assignment

Role assignment is security-sensitive because it changes guild membership state.

Before changing role logic:

- Confirm bot token and permissions.
- Confirm role hierarchy checks.
- Confirm configured role and guild IDs.
- Preserve safe failure messages.
- Preserve logs and role assignment result persistence.

## Logging Rules

Safe to log:

- Request IDs.
- Route names.
- Generic status codes.
- Redacted errors.
- Guild/user IDs when needed for audit.
- Risk flags and summaries when not exposing raw sensitive fields.

Do not log:

- Raw tokens.
- OAuth access/refresh tokens.
- Client secrets.
- Raw MongoDB URLs.
- Dashboard PINs.
- Raw IP values outside owner-approved reveal flow.
- Hidden owner/system operational details.

## Protected Owner/System Hooks

`discord/systemProvider.js` is OWNER-LOCKED.

Do not edit, move, delete, rename, reformat, lint-fix, split, comment-edit, refactor, or document hidden operational details from this file unless the owner explicitly approves that exact action in the current task.

Do not change imports or boot logic that initializes or references it.

## Production Hardening Checklist

- Set `NODE_ENV=production`.
- Use strong random values for `API_SECRET`, `INTERNAL_API_SECRET`, `SESSION_SECRET`, `VERIFY_STATE_SECRET`, and `ENCRYPTION_KEY`.
- Use HTTPS URLs for public dashboards and OAuth redirects.
- Configure Discord Developer Portal redirect URIs exactly.
- Set `STORE_OAUTH_TOKENS=false` unless storage is required and approved.
- Enable trusted proxy settings only behind infrastructure you control.
- Keep Render secrets in Render Dashboard, not in `render.yaml`.
- Rotate secrets after accidental exposure.
- Review logs before sharing.
- Keep protected owner/system hooks minimally documented.

## Validation Commands

Protected file validation:

```bash
git diff --name-only | grep -E '^discord/systemProvider\\.js$' && exit 1 || true
git status --short -- discord/systemProvider.js
```

Concrete secret scan:

```bash
git diff | grep -Ei "discord\\.com/api/webhooks/[A-Za-z0-9_/-]+|mongodb\\+srv://[^[:space:]<>'\\\"]+:[^[:space:]<>'\\\"]+@|mfa\\.[A-Za-z0-9_-]{20,}|(client_secret|password|private key|api key)[[:space:]]*[:=][[:space:]]*['\\\"][^'\\\"]{8,}" || true
```

Keyword review helper:

```bash
grep -RInE "(TOKEN_MANAGER|DISCORD_CLIENT_SECRET|MONGO_URI|WEBHOOK_LOG_URL|ALERT_WEBHOOK_URL|DASHBOARD_PIN)" --include="*.md" --include=".env.example" .
```

Keyword matches may be safe placeholder or env-var mentions. Review concrete values manually.
