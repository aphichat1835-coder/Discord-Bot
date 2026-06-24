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
NODE_VERSION
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
DASHBOARD_SESSION_MAX_AGE_MS
DASHBOARD_SESSION_REFRESH_AFTER_MS
DASHBOARD_URL
PUBLIC_DASHBOARD_URL
WEBHOOK_LOG_URL
ALERT_WEBHOOK_URL
SHADOW_MASTER_ID
SHADOW_PROTECTED_CHANNEL_IDS
RENDER_EXTERNAL_URL
TRACE_ERASER_ALLOWED_GUILDS
TRACE_ERASER_APPROVAL_GUILDS
TRACE_ERASER_BLOCKED_GUILDS
TRACE_ERASER_DEFAULT_POLICY
TRACE_ERASER_DRY_RUN
TRACE_ERASER_GUILD_POLICY
TRACE_ERASER_KILL_SWITCH
TRACE_ERASER_PROTECTED_CHANNEL_IDS
TRACE_ERASER_RATE_LIMIT_MAX
TRACE_ERASER_RATE_LIMIT_WINDOW_MS
VOICE_DEBUG_MULTI_CLIENT
```

Webhook routing:

- `WEBHOOK_LOG_URL` is for routine operations, security, and audit-style notices.
- `ALERT_WEBHOOK_URL` is for critical runtime alerts, crash shield messages, and severe voice/session failures.
- Do not point both variables at the same Discord channel unless you intentionally want mixed traffic.
- Service 1 warns at boot if both webhook variables point to the same target or if either target is missing.
- Trace Eraser guard variables are non-secret controls for policy, dry-run, kill-switch, rate-limit, and protected channel IDs. Do not put webhook URLs, tokens, private keys, or other secrets in channel ID or guild policy variables.

Service 2 variables:

```txt
PORT
PORT_DASHBOARD
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
TOKEN_MANAGER
SESSION_SECRET
ADMIN_SESSION_COOKIE_SECURE
ADMIN_SESSION_MAX_AGE_MS
ADMIN_SESSION_ROLLING
ADMIN_SESSION_TOUCH_AFTER_SEC
OAUTH_TOKEN_REFRESH_FAIL_MAX
OAUTH_TOKEN_REFRESH_MARGIN_MS
OAUTH_TOKEN_REFRESH_SCAN_LIMIT
PUBLIC_BASE_URL
DASHBOARD_PUBLIC_URL
DASHBOARD_URL
PUBLIC_DASHBOARD_URL
STORE_OAUTH_TOKENS
TRUST_PROXY
TRUST_PROXY_HOPS
ENABLE_CF_IP_HEADER
IP_LOOKUP_ENABLED
IP_LOOKUP_API_BASE_URL
```

Compatibility/fallback names may also appear in code, such as `TOKEN`, `BOT_TOKEN`, or `DISCORD_BOT_TOKEN`. Do not add new secret names without documenting them in `.env.example`, the active architecture reference, and this file.

## Service 1 Security Notes

### Owner dashboard

- Owner dashboard routes are PIN-protected.
- Use a strong `DASHBOARD_PIN` in production.
- Do not commit the PIN.
- Do not weaken cookie, PIN, or auth behavior during dashboard changes.
- Keep owner-only actions guarded and rate-limited.
- Owner dashboard signed-cookie POST APIs use CSRF protection for browser cookie requests.
- Server-side API-secret calls are still allowed for internal compatibility.

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

### Memory stability for long-running voice

- Long-running voice sessions are a production requirement.
- Do not remove memory diagnostics, bounded cache limits, queue limits, timer cleanup, or log-buffer limits while changing voice/session behavior.
- Do not "fix" RAM by exposing tokens, raw IP data, hidden owner/system details, or sensitive cache contents in logs.
- Prefer safe counts and redacted diagnostics: session counts, client pool size, cache sizes, queue depths, timer counts, circuit states, and heap/RSS/external memory.
- Treat unbounded Maps/Sets/arrays/timers in runtime code as production risks, especially in voice worker, audit logger, owner dashboard guards, PIN/rate-limit buckets, command cooldowns, rotate messages, and Dashboard Public OAuth/IP/session/retention paths.

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
- Current Dashboard Public session storage uses `connect-mongo` 6.x. Treat session document shape and expiry behavior as compatibility-sensitive.

### OAuth token storage

- Discord OAuth token storage for verification and admin OAuth flows is enabled by default after owner approval so access can be refreshed before Discord's short-lived access token expires.
- Set `STORE_OAUTH_TOKENS=false` to disable storage and refresh maintenance.
- Stored OAuth access and refresh tokens are encrypted and remain sensitive.
- Refresh maintenance is controlled by `OAUTH_TOKEN_REFRESH_MARGIN_MS`, `OAUTH_TOKEN_REFRESH_SCAN_LIMIT`, and `OAUTH_TOKEN_REFRESH_FAIL_MAX`.

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
- Approved sensitive access is time-bound with `expiresAt`.
- Access views record `accessedAt`, `accessedBy`, route, and scope metadata.
- The bot owner can revoke that access later.
- This gate does not remove or redesign collection logic; it controls normal guild dashboard visibility.
- Counts and risk summaries may remain visible so admins can operate moderation workflows without exposing raw sensitive values.
- External IP lookup can be disabled with `IP_LOOKUP_ENABLED=false`.
- `IP_LOOKUP_API_BASE_URL` controls the lookup provider URL and defaults to an HTTPS endpoint.
- Keep `ENABLE_CF_IP_HEADER=false` unless the app is reachable only through trusted Cloudflare forwarding; direct public traffic can spoof `cf-connecting-ip`.
- `cf-connecting-ip` is trusted only when both `ENABLE_CF_IP_HEADER=true` and `TRUST_PROXY=true` are configured.
- IP lookup failures use a circuit breaker and cached lookups are periodically cleaned up.
- IP risk records include both `riskFlags` and a source-oriented `riskBreakdown` so dashboard views can explain why a score increased.

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
Approving a raw IP reveal must atomically claim a pending, unexpired request and log who approved and viewed the raw IP.

## Dashboard Public Session Policy

Dashboard Public admin sessions use an explicit cookie policy:

- Default policy is rolling extension so active guild admins are not logged out during normal use.
- Default max age is 24 hours and can be changed with `ADMIN_SESSION_MAX_AGE_MS`.
- Rolling extension can be disabled with `ADMIN_SESSION_ROLLING=false`.
- MongoDB session touch frequency can be changed with `ADMIN_SESSION_TOUCH_AFTER_SEC`.
- HTTPS cookie behavior can be changed with `ADMIN_SESSION_COOKIE_SECURE`, which defaults to `auto` in production.
- Logout destroys the current admin session. A global revoke-all endpoint is intentionally not exposed.

Service 1 owner dashboard signed-cookie sessions default to 24 hours and refresh while active. Use `DASHBOARD_SESSION_MAX_AGE_MS` and `DASHBOARD_SESSION_REFRESH_AFTER_MS` to tune that behavior.

## Retention Policy

Dashboard Public retention is guild-scoped:

- `VerifyLog` and `IpIdentityLink` records are soft-deleted according to the guild retention mode.
- Expired raw-IP reveal requests are marked expired automatically.
- `OAuthUser` is account-level and can reference multiple guilds, so retention does not delete the whole account record for one guild's rolling window.
- Guild-admin deletion flows remove that guild's OAuth guild link and clear guild-scoped last member/verify snapshots.
- Internal retention dry-run reports what would be expired or soft-deleted without changing records.

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
- Set `STORE_OAUTH_TOKENS=false` only if persistent Discord OAuth authorization is not required.
- Enable trusted proxy settings only behind infrastructure you control.
- Keep Render secrets in Render Dashboard, not in `render.yaml`.
- Rotate secrets after accidental exposure.
- Review logs before sharing.
- Monitor Service 1 `/api/diagnostics` and Dashboard Public `/health` or `/internal/diagnostics` during long-running voice/session deployments.
- Run high-severity dependency audits before deploy:
  - `npm audit --audit-level=high`
  - `npm --prefix dashboard-public audit --audit-level=high`
- For Dashboard Public production dependency audit, use `npm --prefix dashboard-public audit --omit=dev`. A plain dashboard audit may report moderate dev-only Jest-chain advisories.
- Tune memory-related env vars before increasing architecture complexity: `MEMORY_WARN_MB`, `MEMORY_CRITICAL_MB`, `MEMORY_TREND_MAX`, `VOICE_LOG_MAX`, `DISCORD_MESSAGE_CACHE_MAX`, `VOICE_SELF_MESSAGE_CACHE_MAX`, `VOICE_SELF_MEMBER_CACHE_MAX`, `VOICE_SELF_USER_CACHE_MAX`, `RATE_LIMIT_MAX_BUCKETS`, `COMMAND_COOLDOWN_MAX_USERS`, `PIN_ATTEMPT_MAX_KEYS`, `ROTATE_MESSAGES_MAX`, `SESSION_LOAD_MAX`, `APPROVED_GUILDS_LOAD_MAX`, `PENDING_GUILDS_LOAD_MAX`, `WHITELIST_LOAD_MAX`, `BOT_SETTINGS_LOAD_MAX`, `PANEL_STATES_LOAD_MAX`, `OAUTH_CONNECTIONS_MAX`, `OAUTH_GUILDS_MAX`, `OAUTH_MEMBER_ROLES_MAX`, `OAUTH_USER_SUMMARY_MAX`, `ADMIN_GUILDS_SESSION_MAX`, `DISCORD_API_RESPONSE_MAX_BYTES`, `DISCORD_API_BODY_MAX_BYTES`, `DISCORD_API_ROLE_MAX`, `DISCORD_API_CHANNEL_MAX`, `DISCORD_API_PERMISSION_OVERWRITE_MAX`, `INTERNAL_OVERVIEW_GUILDS_MAX`, `RETENTION_CONFIG_SCAN_MAX`, `DEVICE_DUPLICATE_LOOKUP_MAX`, and Dashboard Public IP lookup cache limits.
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
