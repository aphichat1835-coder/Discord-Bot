# Architecture

Last implementation verification: 2026-07-04.

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
6. Archive and migrate a bounded batch of legacy verification records, then
   start retention and encrypted OAuth refresh maintenance.
7. Login the Discord client.
8. Start normal event, audit, voice/session, and scheduled work.

The HTTP-first design keeps `/ping` available during startup. `/health` remains
503 until MongoDB, Discord, required voice support, and verification are ready.

Shutdown is coordinated by `discord/index/system.js`: it marks shutdown state,
stops verification maintenance, pauses/stops voice work, destroys clients,
closes MongoDB, and closes the HTTP listener.

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
│   ├── logging/                  audit, moderation cases, retention/reconciliation
│   ├── sessions/                 voice session helpers
│   ├── voiceWorker.js
│   ├── voiceWorker/              voice worker implementation
│   ├── verification/
│   │   ├── runtime.js            mounts routes/assets into the main Express app
│   │   ├── lifecycle.js          retention and encrypted token refresh
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
├── docs/                        focused operational/audit notes
├── render.yaml                  one root Web Service
└── package.json                 single dependency and command manifest
```

`discord/systemProvider.js` and the entire `discord/systemProvider/` tree are
owner-locked. Their implementation details are intentionally not documented.

## 4. HTTP boundary

### Public routes

| Method/path | Behavior |
| --- | --- |
| `GET /ping` | liveness, always simple 200 while listener is running |
| `GET /ready` | compatibility readiness endpoint; responds with a 307 redirect to `/health` |
| `GET /health` | combined runtime readiness and diagnostics |
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
| `VerifyLog` | immutable-per-attempt core result, snapshot references, policy/device/network state, join/role result, and quality metadata |
| `IpIdentityLink` | per-guild hashed-IP correlation summary and first/last seen state |
| `IPRevealRequest` | historical collection compatibility and expiry maintenance only; no new external guild-admin requests |
| `VerificationMigrationArchive` | deduplicated original OAuthUser documents retained for migration rollback |
| `VerificationMigrationState` | automatic migration lock, progress, result, and failure diagnostics |

Snapshot maintenance uses permanent-history semantics. Every version referenced
by the current `OAuthUser.snapshotRefs` or by any `VerifyLog` (including a
soft-deleted historical log) is preserved. Only incomplete and unreferenced
versions older than the cleanup grace period are eligible for bounded deletion.

Model names, collection behavior, and current/historical token/IP encryption
read compatibility are preserved.

Automatic migration runs after the shared MongoDB connection is ready and on
hourly verification maintenance. It processes a bounded batch, archives each
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
- a category is complete only when `returnedCount === storedCount`, every chunk
  finalized successfully, and `complete` is true
- each document remains below the 12 MB application budget

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
healthCheckPath: /ping
```

Production cutover order:

1. Back up MongoDB.
2. Add the new unified callback URI in Discord Developer Portal.
3. Set all public URL aliases to the unified origin.
4. Deploy and test `/`, `/verification`, `/auth/callback`, `/ping`, and `/health`.
5. Run a real verification smoke test including join and role assignment.
6. Stop the retired service only after the unified runtime passes.

## 10. Environment groups

Authoritative placeholders are in `.env.example`.

- Runtime: `NODE_ENV`, `PORT`, `MONGO_URI`, `TOKEN_MANAGER`
- OAuth: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
  `VERIFY_STATE_SECRET`, public URL aliases
- Sensitive storage: `ENCRYPTION_KEY`, `STORE_OAUTH_TOKENS`
- Owner auth: `DASHBOARD_PIN`, `API_SECRET`, session age controls
- Proxy/network: `TRUST_PROXY`, `TRUST_PROXY_HOPS`,
  `ENABLE_CF_IP_HEADER`, IP lookup controls
- Verification maintenance: refresh, retention, API-byte, and lookup cache limits
- Voice/audit/memory: feature and bounded-runtime controls documented in
  `.env.example`

Do not commit real values.

## 11. Validation

```text
npm run check:protected
npm run check:all
npm run check:scripts
npm run check:memory-guards
npm run check:memory-trend
npm run test:discord
npm run test:voice
npm run test:verification
npm audit --audit-level=high
```

CI installs only the root lockfile, runs all three suites, checks the protected
paths, and audits the root dependency graph.
