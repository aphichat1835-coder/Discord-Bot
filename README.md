# Phomueangtai Personal Multi-Tool Discord Bot

Personal Discord bot with slash commands, voice/session automation, moderation
cases, protection features, role buttons, a private bot-control dashboard, and OAuth2 verification.

> **Binding owner policy:** AI agents and contributors must read
> [`docs/OWNER_INTENT_POLICY.md`](docs/OWNER_INTENT_POLICY.md) before changing
> Voice tokens, verification collection, Owner Dashboard access, logs, or
> webhooks. The declared owner behavior must not be silently replaced by generic
> security/privacy recommendations.

Private notifications for Voice, verification, and restore results use a shared
Thai Embed delivery service. Delivery supports owner-intended
mentions, deduplication, and priority. A bounded in-memory recovery queue preserves delivery attempts while MongoDB is temporarily unavailable, then reconciles them into the durable MongoDB outbox.

## Runtime shape

The repository deploys as one Node.js 24.18 LTS process with npm 12:

```text
npm start
  ├─ Express / Dashboard ควบคุมบอท
  ├─ public OAuth callback
  ├─ MongoDB persistence and verification maintenance
  ├─ Discord bot
  └─ voice/session subsystem
```

Only `process.env.PORT || 3000` is opened. Verification reuses the Mongoose
connection owned by `discord/sessionManager.js`; it does not call
`mongoose.connect()` during normal runtime.

Boot order is HTTP → MongoDB/state → initial verification maintenance → Discord
login. Slash-command registration, panel restore, and Voice auto-resume begin
after Discord becomes ready. Shutdown stops verification maintenance,
voice/session work, Discord clients, webhook delivery, the database connection,
and the HTTP server.

## Web routes

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /` | Owner PIN | Dashboard ควบคุมบอท |
| `GET /verification` | Owner PIN | Verification guild chooser inside the bot-control dashboard |
| `GET /verification/:guildId` | Owner PIN | Integrated Overview, System, Panel, Policy/Role, and Verification Data workspace |
| `GET /auth/callback` | Public | OAuth callback page |
| `POST /auth/callback` | Public, rate-limited | Exchange a one-time OAuth code and run verification |
| `/api/guilds` | Owner PIN | Bot guild list |
| `/api/guild/:guildId/*` | Owner PIN; CSRF on writes | Verification management APIs |
| `GET /api/guild/:guildId/member/:userId/detail` | Owner PIN | Complete Owner-visible per-user verification detail |
| `POST /api/guild/:guildId/member/:userId/full-detail` | Owner PIN + automatic CSRF | Complete Owner-visible member data without a manual reason or repeated PIN |
| `GET /api/guild/:guildId/member/:userId/ip-history` | Owner PIN | Paginated canonical users/devices/role history for the member's IP |
| `GET /ping` | Public | Lightweight listener liveness |
| `GET /health` | Public | Combined MongoDB, Discord, slash-command, voice, and verification readiness |
| `GET /ready` | Public | Alias of the combined `/health` readiness response |

There is no guild-admin OAuth login and no standalone `dashboard-public`
service. Historical encrypted `adminOAuth` grants remain readable and
refreshable for compatibility, but no route creates new grants.

## Slash commands

The runtime registers exactly 16 guild-only commands: `/voice-online`,
`/serverinfo`, `/ping`, `/userinfo`, `/clear`, `/say`,
`/announce`, `/copy-emojis`, `/backup`, `/restore`, `/voiceadmin`, `/ban`,
`/kick`, `/timeout`, `/setup-verify`, and `/rerole`. Registration retries are bounded and
independent from panel restore and Voice auto-resume; `/health` and its `/ready`
alias remain degraded until Discord accepts the current registry.

`/rerole` is available only to the guild owner or configured bot Owner. It
accepts up to five role exceptions, verifies a stable complete member fetch,
reports role counts, then waits for the exact text `ยืนยัน` from the same owner
in the same channel for at most 60 seconds. The equivalent text command is
`//รียศ [ROLE_ID ...]`. Before removal it rechecks bot permissions and the role
fingerprint, including the bot's own hierarchy; membership or hierarchy changes
cancel the work. It removes only manageable human members' eligible roles,
always skips the invoking account, reports changed members plus successful and
failed role assignments, and does not create a restore snapshot.

`/voiceadmin` is an ephemeral Administrator-only panel for the normal voice
channel where it is opened. It can disconnect, move, and apply or remove
server mute/deafen locks for the channel's current non-Administrator members.
Bulk Voice Admin work starts up to eight members per guild at once, with a
shared twelve-member runtime cap and no fixed per-member delay; Discord's REST
rate-limit queue determines the actual API pace. Each snapshot target is
checked again before action, so someone who already left the source channel is
not followed into another room.
The Owner also has private `//` and `///` text controls in normal voice-channel
chat; these are intentionally not general member commands and are not accepted
outside the configured Owner account. `///ปิดไมค์หมด` creates an Owner-forced
mute lock for every current member except the Owner, including Administrators;
only the configured Owner can release those locks.

The retired Enterprise Audit subsystem is not mounted: there is no `/setup-log`,
`/audit-logs`, or `/api/audit/*`. Existing Discord log channels and historical
MongoDB Audit collections are intentionally left untouched, but this runtime
does not read or write them. Operational webhooks, moderation cases, Protection
enforcement, and Owner verification records remain separate and active.
The owner-locked provider imports a thin compatibility adapter that delegates
only to the separate internal event store. Enterprise Audit remains retired;
internal events still use the `internal_event_*` settings namespace and never
access retired Audit models, routes, channels, or `audit_event_*` keys.

Guild backups are stored in bounded chunks. Every complete version is retained;
one version per guild is marked active, older versions are marked superseded,
and startup reconciliation selects the newest complete readable version without
deleting history. Restore validates backup/target guild identity, chunk item
counts and byte sizes, restores channel permission overwrites, and continues to
read legacy embedded snapshots.

## Binding owner behavior

The following rules are mandatory and are defined in full in
[`docs/OWNER_INTENT_POLICY.md`](docs/OWNER_INTENT_POLICY.md):

- Voice tokens may belong to any main or alternate account. The system does not
  compare the token account with the command invoker or `ownerId`.
- Different tokens are independent. Latest-request-wins replacement is limited
  to the same token hash and same guild.
- Every guild uses the same forced complete verification-data collection policy.
  There is no per-guild opt-out that reduces the owner-required dataset.
- After Owner PIN login, the Dashboard provides direct access to full member
  details, tokens, and raw IP without asking for a reason, repeated PIN,
  step-up authentication, approval queue, or blocking reveal workflow.
- Private Owner-only logs and webhooks preserve full-fidelity values for fields
  intentionally selected by the Owner. AI-driven redaction or data minimization
  is not allowed without a new direct Owner instruction.

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
  fingerprint.
- Network: trusted-proxy source IP, HMAC hash, encrypted raw IP, multi-provider
  location consensus, provider-supplied accuracy radius, confidence with
  reasons, ISP/org/ASN, VPN/proxy/TOR/hosting/mobile/anycast signals, and
  spoof/header-conflict signals. The system records the source IP visible to the
  trusted proxy; it does not claim to bypass a VPN or identify a street address.
- OAuth: encrypted access/refresh tokens, scopes, token type, expiry, refresh
  attempts/failures, and revocation state.
- Data quality: snapshot version, source, attempt/fetch timestamps, status,
  returned/stored counts, chunk count, completion state, truncation flag, and
  failure detail available to the Owner.

All guilds use this same collection contract automatically. A guild-specific
privacy toggle must not disable tokens, raw IP, profile, guild, connection,
member, role, permission, device, network, OAuth, history, or snapshot fields.
Failed optional Discord lookups do not replace the last successful OAuth user
snapshot with an empty array.

Public unauthenticated responses remain separate from Owner-only data. Once the
Owner PIN session is valid, Owner APIs and Dashboard views may return the full
owner-required values directly. Invisible CSRF/session checks may remain, but
manual reasons, repeated PIN entry, step-up authentication, approval queues, and
blocking audit-intent writes are not part of the Owner workflow.

Guilds and connections are stored as ordered versioned chunks, while the target
member has a versioned core snapshot plus ordered role chunks. The stored full
Discord profile and per-item guild/connection payloads preserve future provider
fields. Chunking and list pagination do not discard data. A snapshot is complete
only when `returnedCount === storedCount` and its `complete` flag is true; Member
Detail loads every finalized chunk and retains legacy embedded-snapshot
compatibility.
Successful snapshots referenced by `OAuthUser` or any historical `VerifyLog`
are retained permanently. Hourly maintenance removes only incomplete or fully
unreferenced snapshot garbage after a configurable grace period, in bounded
batches; this permanent-history mode intentionally allows database usage to
grow with verification history.

Oversized profile/member/item objects are stored as Base64 byte chunks with
per-chunk and aggregate SHA-256/length validation. There is no aggregate
snapshot truncation ceiling; the safety limit applies to each MongoDB document.
Incomplete rollback state is recorded and retried by maintenance.

Per-IP summary state remains in `IpIdentityLink`, while users, devices, and role
events are stored in paginated canonical history collections without an overall
item ceiling. Legacy embedded arrays are migrated additively and retained for
rollback. The raw address may remain encrypted at rest and must be directly
available to the authenticated Owner through the Dashboard/API without a manual
reason or repeated authentication step.

`premiumType` remains for schema compatibility only and must not be presented as
a reliable Nitro conclusion.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Production has exactly 16 owner-maintained environment values: `NODE_ENV`,
`MONGO_URI`, `TOKEN_MANAGER`, `OWNER_ID`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
`ENCRYPTION_KEY`, `API_SECRET`, `VERIFY_STATE_SECRET`, `DASHBOARD_PIN`,
`SHADOW_SESSION_SECRET`, `SHADOW_PORTAL_PIN`, `PUBLIC_BASE_URL`, `WEBHOOK_LOG_URL`, `ALERT_WEBHOOK_URL`, and `TRUST_PROXY`.
All other runtime controls have code defaults. Legacy public-URL aliases remain
read-compatible but do not need to be configured.

`OWNER_ID` is one or more comma-separated Owner Discord User IDs (each 17–22
digits). It is required in production and supplies the standard bot Owner
identity; its first ID is used where the bot must display one Owner.

`ENCRYPTION_KEY` alone derives the AES key for OAuth tokens, raw IP values, and
Voice session tokens. IP/device correlation hashes use a separate HMAC key
derived from `ENCRYPTION_KEY` plus `API_SECRET` (or the legacy-compatible
`INTERNAL_API_SECRET` fallback). Keep both HMAC inputs stable unless correlation
history is deliberately migrated or rebuilt; rotating `API_SECRET` also
invalidates Owner sessions.

IP location compares `ipapi.is` and `ipapi.co` by default. Optional
`MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY` enable MaxMind GeoIP as an
additional precision source; they are not required for startup. Lookup requests
run concurrently with bounded timeout/retry, cache, response-size limits, and a
circuit breaker. The Dashboard treats returned coordinates as approximate and
shows a radius only when a provider supplies one.

`DASHBOARD_PIN` must be non-empty in production. The application does not
enforce a minimum length or character pattern; the Owner chooses the credential
policy and should still use a private value that is difficult to guess.

Discord Developer Portal redirect URI:

```text
https://YOUR-DOMAIN/auth/callback
```

For inwcloud:

```text
Custom command: npm install && npm start
Internal port:   PORT (or 3000)
```

`render.yaml` describes one root Web Service with `npm start` and uses `/ping` for host liveness. `/health` and `/ready` remain the combined dependency-readiness responses used by monitoring and diagnostics.

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

Before either `--apply` command, stop the bot runtime (or otherwise pause every
OAuth and verification write) for the entire restore maintenance window.

```bash
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID --apply --maintenance-confirmed
# Only when intentionally replacing newer live state:
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID --apply --force --maintenance-confirmed
```

The archive is stored in the same MongoDB database. It protects against a bad
migration but does not replace an external backup for whole-database loss.

## Validation

```bash
npm run check
npm test
npm run check:coverage
npm audit --audit-level=high
```

Individual suites:

```bash
npm run test:discord
npm run test:voice
npm run test:verification
```

`discord/systemProvider.js` and every file under `discord/systemProvider/` are
owner-locked. Read `AGENTS.md` and `docs/OWNER_INTENT_POLICY.md` before any
change affecting protected files, Voice, Verification, Dashboard, OAuth data,
logs, or webhooks.

## Owner-approved self-client dependency

`discord.js-selfbot-v13` is an intentional and necessary dependency of the isolated Voice account/session subsystem. The repository owner has explicitly approved its continued use because the current architecture has no compatible replacement that preserves the required behavior.

Do not remove, replace, migrate, rename, independently upgrade/downgrade, or convert its library-specific APIs unless the repository owner gives a new explicit instruction for that exact change. Main-bot Discord.js v14 work must remain isolated from the self-client package. See [`docs/SELF_CLIENT_POLICY.md`](docs/SELF_CLIENT_POLICY.md) for the binding maintenance policy.
