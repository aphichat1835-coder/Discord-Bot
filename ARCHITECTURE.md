# Architecture

Last implementation verification: 2026-07-16 (`tt`).

## 1. System shape

Phomueangtai runs as one deployable Node.js 24 application:

```text
                         one HTTPS origin
                                │
                    Express on PORT || 3000
                     /                    \
           Owner PIN dashboard       public OAuth callback
                 │                           │
                 └──────────┬────────────────┘
                            │
                    shared Mongoose connection
                            │
                         MongoDB
                            │
              Discord bot + voice/session workers
```

The runtime is started only by:

```text
npm start
→ node -r ./discord/core/loadEnv discord/index.js
```

There is no standalone Dashboard Public process, second listener, second
runtime database connection, `express-session`, or `connect-mongo`.

## 2. Boot and shutdown

Authoritative orchestration is `discord/index.js`.

1. Validate environment and initialize process guards.
2. Create the Express app and register main, Owner, and verification routes.
3. Listen on `process.env.PORT || 3000`.
4. Connect MongoDB through `discord/sessionManager.js`.
5. Load persisted bot/session state.
6. Run the initial bounded verification lifecycle: migration, canonical
   IP-history backfill, snapshot rollback recovery/cleanup, retention, reveal
   expiry, and encrypted OAuth token refresh.
7. Login the Discord client.
8. Register commands, restore panels, auto-resume eligible Voice sessions, and
   start normal event, protection, voice/session, and scheduled work.

The HTTP-first design keeps `/ping` available during startup. `/health` is the
combined readiness probe and remains 503 until MongoDB, Discord, slash-command
registration, required voice support, and verification are ready. `/ready` is
an alias of the same combined readiness response. Bounded command-registration retries run
independently so an API registration outage does not block panel restore or
Voice auto-resume.

Shutdown is coordinated by `discord/index/system.js`: it marks shutdown state,
stops verification maintenance, pauses/stops voice work, destroys clients,
drains the bounded outbound webhook queue, closes MongoDB, and closes the HTTP
listener.

Operational and critical webhooks use one in-process dispatcher with cached
Discord clients, bounded priority/concurrency, transient retry, payload limits,
mention suppression, and redacted delivery diagnostics. Critical alerts take
priority over queued routine logs. The retired Enterprise Audit event capture,
channel routing, queues, reconciliation, and dashboard are not part of runtime.

## 3. Repository map

```text
.
├── discord/
│   ├── index.js                  single runtime entry
│   ├── sessionManager.js         shared MongoDB connection and bot state
│   ├── commands.js
│   ├── commands/                 slash command modules
│   ├── core/                     env, HTTP, feature flags, safe logging, webhooks
│   ├── features/                 protection, role button, Join Campaign
│   ├── guards/                   command/dashboard guards
│   ├── index/                    Owner web/API modules and lifecycle helpers
│   ├── logging/                  moderation cases and reconciliation
│   ├── sessions/                 voice session helpers
│   ├── voiceWorker.js
│   ├── voiceWorker/              voice worker implementation
│   ├── verification/
│   │   ├── runtime.js            mounts routes/assets into the main Express app
│   │   ├── lifecycle.js          migration, history, snapshots, retention, and token refresh
│   │   ├── ownerService.js       in-process Owner queries and audited IP reveal
│   │   ├── page.js               Owner guild chooser
│   │   ├── routes/               OAuth and Owner guild APIs
│   │   ├── models/               existing verification model/collection names
│   │   ├── utils/                Discord API, crypto, state, IP/device, serializers
│   │   ├── views/                callback and guild dashboard HTML
│   │   └── public/               verification CSS/browser JavaScript
│   └── tests/                    Node built-in tests
├── verification-tests/          Jest verification contracts/regressions
├── scripts/                     guards, diagnostics, additive migration
├── docs/                        focused operational notes
├── render.yaml                  one root Web Service
└── package.json                 single dependency and command manifest
```

`discord/systemProvider.js` and the entire `discord/systemProvider/` tree are
owner-locked. Their implementation details are intentionally not documented.
The provider's legacy storage import is a thin adapter to internal event storage;
it does not restore the retired Enterprise Audit subsystem.

## 4. HTTP boundary

### Public routes

| Method/path | Behavior |
| --- | --- |
| `GET /ping` | liveness, always simple 200 while listener is running |
| `GET /health` | combined dependency readiness; 200 when ready and 503 when degraded |
| `GET /ready` | alias of the combined `/health` readiness response |
| `GET /auth/callback` | serves OAuth callback UI |
| `POST /auth/callback` | rate-limited verification execution |

`POST /auth/callback` rejects work while MongoDB is not ready.

### Owner routes

| Method/path | Protection |
| --- | --- |
| `GET /` and other main pages | signed Owner PIN cookie |
| `GET /verification` | Owner PIN |
| `GET /verification/:guildId` | Owner PIN and bot-guild membership |
| `GET /api/guilds` | Owner PIN |
| `GET /api/guild/:guildId/*` | Owner PIN |
| write routes under `/api/guild/:guildId/*` | Owner PIN + CSRF |
| `GET /api/guild/:guildId/member/:userId/detail` | Owner PIN |
| `GET /api/guild/:guildId/member/:userId/ip-history` | Owner PIN; paginated canonical IP history |
| `POST /api/guild/:guildId/member/:userId/full-detail` | Owner PIN + CSRF; audited full Owner view |
| `POST /api/guild/:guildId/member/:userId/reveal-token` | Owner PIN + CSRF + reason + audit attempt/status |
| `GET /api/guild/:guildId/preflight` | Owner PIN |
| `POST /api/verify-owner/.../reveal-ip` | Owner PIN + CSRF + reason + audit attempt/status |
| `GET /api/verification/diagnostics` | Owner PIN |
| `POST /api/verification/retention/dry-run` | Owner PIN + CSRF |

The Owner is allowed to manage every guild in the Discord client cache; this is
not filtered by Approved Guild records. `/verify` and `/verify-owner` redirect
to `/verification` for compatibility.

The management APIs retain their established response shapes where practical.
Cross-service HTTP calls were replaced by direct calls to
`discord/verification/ownerService.js`.

The Verification owner surfaces share one responsive Operations Workspace
design across guild selection, per-guild management, OAuth callback, and Join
Campaign. Per-guild routes remain compatible but include an in-page guild
switcher, so routine navigation does not require returning to the selector.

`/api/status` reports process RSS as Dashboard RAM and exposes V8 heap used/
allocated separately. Its historical success-rate field is compatibility-only
because request and background-error counters are not a matched population; the
UI displays the real error-event counter instead.

## 5. Verification flow

### Panel and signed state

`/setup-verify`, existing custom IDs, signed state, and panel revisions remain
compatible. State decoding rejects invalid/expired state and panel revision
checks reject stale panels.

### OAuth callback

The member flow requests:

```text
identify email connections guilds guilds.members.read guilds.join
```

On callback:

1. Exchange the one-time code using the unified-domain redirect URI.
2. Fetch profile, connections, and user guilds.
3. Capture trusted-proxy network and browser/device data.
4. Load the target guild policy.
5. Fetch the target guild member using the OAuth token.
6. Evaluate account, email, connection, network, anti-alt, and panel policies.
7. Join the target guild with `guilds.join` when needed.
8. Assign the configured role.
9. Re-fetch the target member with the bot token after role assignment.
10. Persist the account core, encrypted token state, versioned guild/connection/
    target-member chunks, verification log references, IP/device correlation
    summary, join result, role result, and data-quality metadata.

The code never claims target-member detail for every user guild. Full member
detail applies only to the verification target guild.

OAuth code replay is rejected by Discord `invalid_grant` handling. Raw codes and
tokens are removed from callback-page history and never logged.

## 6. Persistence

The active verification models are:

| Model | Purpose |
| --- | --- |
| `GuildConfig` | verification config, panel revision, policy, retention settings |
| `OAuthUser` | account/profile core, encrypted token state, latest verification summary, and complete snapshot references |
| `OAuthUserProfileSnapshot` | versioned full sanitized Discord profile payload for forward-compatible fields |
| `OAuthUserGuildSnapshot` | versioned ordered chunks containing every guild returned by Discord |
| `OAuthUserConnectionSnapshot` | versioned ordered chunks containing every connection returned by Discord |
| `OAuthMemberSnapshot` | versioned target-guild member core and role-chunk reference |
| `OAuthMemberRoleSnapshot` | versioned ordered chunks containing every returned target-member role |
| `OAuthObjectChunkSnapshot` | versioned Base64 byte chunks for a profile, member, or single item too large for a normal document |
| `OAuthSnapshotRecovery` | payload-free rollback diagnostics and bounded retry state for incomplete snapshot cleanup |
| `VerifyLog` | immutable-per-attempt core result, snapshot references, policy/device/network state, join/role result, and quality metadata |
| `IpIdentityLink` | per-guild hashed-IP correlation summary and first/last seen state |
| `IpIdentityUserHistory` | canonical per-IP user identity aggregate without an overall item cap |
| `IpIdentityDeviceHistory` | canonical per-IP/per-user device aggregate without an overall item cap |
| `IpIdentityRoleHistory` | immutable per-verification role history events loaded with pagination |
| `IPRevealRequest` | historical collection compatibility and expiry maintenance only; no new external guild-admin requests |
| `VerificationMigrationArchive` | deduplicated original OAuthUser documents retained for migration rollback |
| `VerificationMigrationState` | automatic migration lock, progress, result, and failure diagnostics |

Legacy embedded IP histories are copied additively into the canonical history
collections. Historical `VerifyLog` records are also scanned in bounded,
idempotent maintenance batches so recoverable events that predate the canonical
collections are restored without imposing an overall history ceiling.

Snapshot maintenance uses permanent-history semantics. Every version referenced
by the current `OAuthUser.snapshotRefs` or by any `VerifyLog` (including a
soft-deleted historical log) is preserved. Only incomplete and unreferenced
versions older than the cleanup grace period are eligible for bounded deletion.
Object chunks use guild-scoped identity and participate in the same reference
checks; startup maintenance migrates the legacy non-guild-scoped index safely.

Model names, collection behavior, and current/historical token/IP encryption
read compatibility are preserved.

Join Campaign scans OAuth users in stable `_id` cursor batches until the query
is exhausted or the Owner stops the job. Its batch-size setting bounds memory;
it is not a ceiling on the number of users processed.

Automatic migration runs after the shared MongoDB connection is ready and on
hourly verification maintenance. The same lifecycle also backfills canonical
IP history from historical `VerifyLog` records, retries snapshot rollback,
removes eligible snapshot garbage, applies soft-delete retention, expires legacy
reveal requests, and refreshes encrypted OAuth tokens. Each task is bounded and
does not start on an interval until the initial maintenance pass succeeds.
Migration processes a bounded batch with a persistent
source cursor so repeatedly failing records cannot starve later records, archives each
source exactly once per migration version before writing, and skips records
that already have an archive. Backup failure stops migration while leaving the
original untouched. This same-database archive supports migration rollback; it
does not protect against loss of the entire MongoDB database.

### Discord account snapshot

- user ID, username, global name, discriminator, display tag
- avatar/banner hashes and URLs, guild avatar
- accent color, locale, MFA, email and email verification
- raw `flags`/`public_flags` and decoded badge labels
- snowflake-derived account creation timestamp and age
- discriminator `"0"` preserved for modern usernames
- `premiumType` retained only for compatibility, not as a Nitro conclusion

### Guild and connection snapshots

- all guilds returned by Discord, up to the API maximum of 200
- guild ID/name/icon, owner flag, permission bitfield and decoded permission flags
- owner/admin/manage-guild/manage-roles/ban-members booleans
- all returned connections, integrations, and safe metadata
- no arbitrary connection, guild, or target-member-role truncation
- browser-controlled language lists are defensively bounded to eight entries
- large Discord arrays are split into ordered versioned chunks; pagination and
  chunking are storage boundaries, not truncation
- the verified-member list is unioned and deduplicated in MongoDB before
  pagination, so older users remain reachable without an in-memory scan ceiling
- a category is complete only when `returnedCount === storedCount`, every chunk
  finalized successfully, and `complete` is true
- aggregate payload size is not a truncation boundary; normal values are split
  across as many ordered documents as needed
- every document is measured with BSON overhead and remains below the effective
  `VERIFICATION_SNAPSHOT_MAX_BYTES` ceiling, capped at 12 MiB
- an individually oversized object uses Base64 byte chunks with per-chunk and
  aggregate SHA-256/byte-length validation

### Browser/device/network

- User-Agent, browser, OS, platform, device type
- language list, timezone, screen/viewport, color depth, pixel ratio, touch points
- HMAC fingerprint only; raw fingerprint source is not stored
- trusted source IP, IP HMAC, encrypted raw IP
- country/region/city/timezone, ISP/org/ASN
- VPN/proxy/TOR/hosting/mobile and spoof/header-conflict signals
- provider, lookup status, redacted failure status, and lookup timestamp
- Owner Member Detail also exposes the complete per-IP identity history already
  stored by the system: linked users, device fingerprint hashes, role snapshots,
  first/last seen state, location/network state, and risk history

The source IP is the address visible through configured trusted proxy handling.
The system does not claim to discover a residential IP behind VPN/TOR.

### Tokens

`OAuthUser.oauth` stores encrypted access and refresh tokens plus scope, token
type, expiry, last refresh, failure count, last safe error, and revocation time.
Normal APIs, logs, exports, tests, and migrations do not serialize raw tokens.

Historical `OAuthUser.adminOAuth` fields remain readable/refreshable.
`LEGACY_ADMIN_OAUTH_REDIRECT_URI` preserves the exact redirect used by old
grants. No route issues a new admin grant.

### Failure-preserving writes

If connections, guilds, or member lookup fails:

- the previous complete `OAuthUser.snapshotRefs` entry is not replaced;
- latest attempt status and a redacted failure code are updated;
- a `VerifyLog` records what happened during the current attempt;
- unavailable values are represented as null/unknown rather than invented.

Data-quality metadata contains version, source, attempt/fetch timestamp,
success/failed/not-attempted state, returned/stored counts, chunk count,
completion state, truncation flag, and failure reason. Member Detail resolves
all finalized chunks and falls back to legacy embedded arrays for older data.

## 7. Sensitive data access

Normal list serializers explicitly set raw IP fields to null and never decrypt
them. The Owner Member Detail route returns audited full detail in one action:

```text
POST /api/guild/:guildId/member/:userId/full-detail
```

The stricter compatibility raw-IP route remains:

```text
POST /api/verify-owner/guild/:guildId/user/:userId/reveal-ip
```

It requires Owner PIN, CSRF, and a non-empty reason. The service decrypts the
latest encrypted IP only for the response and attempts to append an audit entry
with actor, reason, and time. If the audit write fails, the Owner response
includes audit failure status. The UI does not cache or place raw IP into list
APIs.

Email, connection, and guild details are Owner-only. The former external
guild-admin reveal-request workflow is removed.

Raw OAuth access/refresh tokens are returned only by audited per-user Owner
actions. Member Detail uses the full-detail route above; the compatibility
token-only action remains:

```text
POST /api/guild/:guildId/member/:userId/reveal-token
```

It requires Owner PIN, CSRF, a non-empty reason, cooldown/rate-limit checks, and
an audit attempt. If the audit write fails, the Owner response includes audit
failure status. Normal list, detail, export, log, and migration paths do not
decrypt or serialize raw tokens.

## 8. Maintenance and migration

`discord/verification/lifecycle.js` runs after MongoDB is ready and periodically:

- applies configured soft-delete retention to verification/IP correlation data;
- expires legacy pending reveal requests;
- refreshes encrypted verification and historical admin OAuth tokens.

`scripts/migrateVerificationSnapshots.js` supports:

```text
npm run migrate:verification
npm run migrate:verification -- --apply
```

Dry-run is the default. It backfills only derived display tags, asset URLs,
badge labels, and additive snapshot metadata. Its query projection excludes
token and raw-IP fields; it neither decrypts nor prints them and deletes no
field or collection.

## 9. Deployment

### inwcloud

```text
Custom command: npm install && npm start
Domain internal port: PORT or 3000
Redirect URI: https://DOMAIN/auth/callback
```

### Render

`render.yaml` contains one root Web Service:

```text
buildCommand: npm install
startCommand: npm start
healthCheckPath: /health
```

Release/deployment verification order:

1. Back up MongoDB.
2. Add the new unified callback URI in Discord Developer Portal.
3. Set canonical `PUBLIC_BASE_URL` to the unified HTTPS origin. Remove legacy
   URL aliases when possible; if retained for compatibility, keep them equal.
4. Deploy and test `/`, `/verification`, `/auth/callback`, `/ping`, and `/health`.
5. Run a real verification smoke test including join and role assignment.
6. If a legacy standalone service still exists, stop it only after the unified
   runtime passes. A current installation deploys only the root service.

## 10. Environment groups

Authoritative placeholders are in `.env.example`.

The Owner maintains exactly 13 values: `NODE_ENV`, `MONGO_URI`,
`TOKEN_MANAGER`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
`ENCRYPTION_KEY`, `API_SECRET`, `VERIFY_STATE_SECRET`, `DASHBOARD_PIN`,
`PUBLIC_BASE_URL`, `WEBHOOK_LOG_URL`, `ALERT_WEBHOOK_URL`, and `TRUST_PROXY`.
The host supplies `PORT` when needed; it falls back to 3000. Advanced cache,
batch, timeout, retention, voice, verification, migration, proxy-hop, feature,
and memory controls use code defaults and are not owner-maintained deployment
requirements.

Do not commit real values.

## 11. Validation

```text
npm run check:protected
npm run check:all
npm run check:scripts
npm run check:memory-guards
npm run check:memory-trend < diagnostics.json
npm run test:discord
npm run test:voice
npm run test:verification
npm audit --audit-level=high
```

CI installs only the root lockfile, runs all three suites, checks the protected
paths, and audits the root dependency graph.
