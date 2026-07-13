# Phomueangtai Personal Multi-Tool Discord Bot

Personal Discord bot with slash commands, voice/session automation, moderation
cases, protection features, role buttons, Owner Dashboard, and OAuth2 verification.

## Runtime shape

The repository deploys as one Node.js 24 process:

```text
npm start
  ├─ Express / Owner Dashboard
  ├─ public OAuth callback
  ├─ MongoDB persistence and verification maintenance
  ├─ Discord bot
  └─ voice/session subsystem
```

Only `process.env.PORT || 3000` is opened. Verification reuses the Mongoose
connection owned by `discord/sessionManager.js`; it does not call
`mongoose.connect()` during normal runtime.

Boot order is HTTP → MongoDB → verification maintenance/token refresh → Discord
login. Shutdown stops verification maintenance, voice/session work, Discord, the
database connection, and the HTTP server.

## Web routes

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /` | Owner PIN | Main Owner Dashboard |
| `GET /verification` | Owner PIN | Select any guild currently cached by the bot |
| `GET /verification/:guildId` | Owner PIN | Verification config, panels, members, logs, stats, risk, and sensitive review |
| `GET /auth/callback` | Public | OAuth callback page |
| `POST /auth/callback` | Public, rate-limited | Exchange a one-time OAuth code and run verification |
| `/api/guilds` | Owner PIN | Bot guild list |
| `/api/guild/:guildId/*` | Owner PIN; CSRF on writes | Verification management APIs |
| `GET /api/guild/:guildId/member/:userId/detail` | Owner PIN | Full per-user verification detail grouped by category |
| `GET /api/guild/:guildId/member/:userId/ip-history` | Owner PIN | Paginated canonical users/devices/role history for the member's IP |
| `POST /api/guild/:guildId/member/:userId/reveal-token` | Owner PIN + CSRF + reason | Raw OAuth2 token reveal with audit status |
| `POST /api/verify-owner/guild/:guildId/user/:userId/reveal-ip` | Owner PIN + CSRF + reason | Raw-IP reveal with audit status |
| `GET /ping` | Public | Liveness |
| `GET /health` | Public | MongoDB, Discord, slash-command, voice, and verification readiness |

There is no guild-admin OAuth login and no standalone `dashboard-public`
service. Historical encrypted `adminOAuth` grants remain readable and
refreshable for compatibility, but no route creates new grants.

## Slash commands

The runtime registers exactly 16 guild-only commands: `/voice-online`, `/help`,
`/serverinfo`, `/ping`, `/userinfo`, `/clear`, `/say`,
`/announce`, `/copy-emojis`, `/backup`, `/restore`, `/voicekickall`, `/ban`,
`/kick`, `/timeout`, and `/setup-verify`. Registration retries are bounded and
independent from panel restore and Voice auto-resume; `/health` remains degraded
until Discord accepts the current registry.

The retired Enterprise Audit subsystem is not mounted: there is no `/setup-log`,
`/audit-logs`, or `/api/audit/*`. Existing Discord log channels and historical
MongoDB Audit collections are intentionally left untouched, but this runtime
does not read or write them. Operational webhooks, moderation cases, Protection
enforcement, and Verification sensitive-access audit remain separate and active.
The owner-locked provider's immutable legacy import path is retained only as a
thin compatibility shim to a separate internal settings namespace; it does not
register Enterprise Audit models or access the retired Audit keys.

Guild backups are stored in bounded chunks. Every complete version is retained;
one version per guild is marked active, older versions are marked superseded,
and startup reconciliation selects the newest complete readable version without
deleting history. Restore continues to read legacy embedded snapshots.

## Verification data contract

Verification data lives under `discord/verification/` and keeps the existing
MongoDB model/collection names and encryption format.

- Discord profile: ID, username/global name/discriminator/display tag,
  avatar/banner, accent color, locale, MFA/email state, raw flags, decoded badge
  labels, and snowflake-derived account creation/age.
- Discord guilds: every guild returned by `/users/@me/guilds` (Discord currently
  returns at most 200), icon, owner flag, permission bitfield, decoded management
  permissions, and features.
- Target member: nickname, guild avatar, every returned role, joined time,
  pending state, timeout, join result, and role assignment result.
- Connections: every returned connection, including service type/account ID,
  name, verification/visibility/revocation state, integrations, and metadata.
- Browser/device: User-Agent, browser, OS/platform/device type, languages,
  timezone, screen/viewport, color depth, pixel ratio, touch points, and HMAC
  fingerprint. Fingerprint source material is not persisted.
- Network: trusted-proxy source IP, HMAC hash, encrypted raw IP, location,
  ISP/org/ASN, VPN/proxy/TOR/hosting/mobile signals, provider/status, and
  spoof/header-conflict signals. The system records the source IP visible to the
  trusted proxy; it does not claim to bypass a VPN.
- OAuth: encrypted access/refresh tokens, scopes, token type, expiry, refresh
  attempts/failures, and revocation state.
- Data quality: snapshot version, source, attempt/fetch timestamps, status,
  returned/stored counts, chunk count, completion state, truncation flag, and
  redacted failure reason.

Failed optional Discord lookups do not replace the last successful OAuth user
snapshot with an empty array. Normal list/export APIs never return raw OAuth
tokens or raw IP. Raw OAuth2 tokens and raw IP can only be revealed through
Owner per-user actions that attempt audit writes and report audit status. The
Owner Member Detail page performs that audited reveal in one click and displays
the complete decrypted values; list and export APIs remain redacted.

Guilds and connections are stored as ordered versioned chunks, while the target
member has a versioned core snapshot plus ordered role chunks. The sanitized
full Discord profile and per-item raw guild/connection payloads preserve future
provider fields while token-shaped keys remain excluded. Chunking and
list pagination do not discard data. A snapshot is complete only when
`returnedCount === storedCount` and its `complete` flag is true; Member Detail
loads every finalized chunk and retains legacy embedded-snapshot compatibility.
Successful snapshots referenced by `OAuthUser` or any historical `VerifyLog`
are retained permanently. Hourly maintenance removes only incomplete or fully
unreferenced snapshot garbage after a configurable grace period, in bounded
batches; this permanent-history mode intentionally allows database usage to
grow with verification history.

Per-IP summary state remains in `IpIdentityLink`, while users, devices, and role
events are stored in paginated canonical history collections without an overall
item ceiling. Legacy embedded arrays are migrated additively and retained for
rollback. The raw address remains encrypted at rest and is decrypted only by
the audited Owner per-user action; list and export responses use hashes and
summaries instead.

`premiumType` remains for schema compatibility only and must not be presented as
a reliable Nitro conclusion.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Production has exactly 13 owner-maintained environment values: `NODE_ENV`,
`MONGO_URI`, `TOKEN_MANAGER`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
`ENCRYPTION_KEY`, `API_SECRET`, `VERIFY_STATE_SECRET`, `DASHBOARD_PIN`,
`PUBLIC_BASE_URL`, `WEBHOOK_LOG_URL`, `ALERT_WEBHOOK_URL`, and `TRUST_PROXY`.
All other runtime controls have code defaults. Legacy public-URL aliases remain
read-compatible but do not need to be configured.

Discord Developer Portal redirect URI:

```text
https://YOUR-DOMAIN/auth/callback
```

For inwcloud:

```text
Custom command: npm install && npm start
Internal port:   PORT (or 3000)
```

`render.yaml` describes one root Web Service with `npm start` and `/health`
as the combined readiness check. `/ping` remains the lightweight liveness path.

After deploy, run the single-port smoke helper from a trusted machine:

```bash
SMOKE_ALLOWED_HOSTS=YOUR-DOMAIN npm run smoke:unified -- https://YOUR-DOMAIN
```

`SMOKE_ALLOWED_HOSTS` accepts comma-separated exact hostnames. It is required
so the CLI smoke checker cannot be pointed at an arbitrary network target.

## Automatic migration and rollback archive

After MongoDB connects, the runtime detects legacy OAuth records, archives each
original document once per migration version, and applies the additive
migration in bounded batches. Remaining records resume during hourly
maintenance. Tokens and raw IP remain encrypted. Manual apply uses the same
deduplicated archive rule. Manual commands remain available:

```bash
npm run migrate:verification
npm run migrate:verification -- --apply
```

The first command is dry-run mode.

Rollback inspection is also dry-run by default:

```bash
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID --apply
# Only when intentionally replacing newer live state:
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID --apply --force
```

The archive is stored in the same MongoDB database. It protects against a bad
migration but does not replace an external backup for whole-database loss.

## Validation

```bash
npm run check
npm test
npm audit --audit-level=high
```

Individual suites:

```bash
npm run test:discord
npm run test:voice
npm run test:verification
```

`discord/systemProvider.js` and every file under `discord/systemProvider/` are
owner-locked. See `AGENTS.md` before any change.
