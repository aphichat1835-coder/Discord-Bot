# Security and Privacy

Last implementation review: 2026-07-16 (`tt`).

## Scope

The single runtime handles Discord credentials, OAuth grants, Owner controls,
voice/session tokens, verification history, browser/device metadata, network
metadata, moderation cases, and sensitive-access history. Treat the repository, host environment, MongoDB, and
Owner session as security-sensitive.

Never commit or print real:

- Discord bot/self-bot/OAuth tokens
- OAuth client secrets
- MongoDB URIs
- encryption/signing/API secrets
- Owner PINs
- webhook URLs
- raw IP addresses
- decrypted OAuth metadata
- hidden protected-system procedures

`.env.example` is placeholders only.

## Trust boundaries

```text
Untrusted browser
  → trusted reverse proxy
  → one Express app
      → Owner PIN/CSRF boundary
      → public rate-limited callback boundary
  → shared MongoDB
  → Discord API
  → configured IP lookup provider
```

The managed production deployment sets `TRUST_PROXY=true`; the hop count
defaults to one. Change the advanced hop override only when the real hosting
chain differs.
`ENABLE_CF_IP_HEADER` must be enabled only when direct origin access is blocked
and Cloudflare headers are genuinely trusted. Otherwise a client can spoof
forwarding headers.

The stored source IP is the public address visible to the trusted proxy. It is
not proof of a residential/home IP and cannot reveal an address hidden behind
VPN, proxy, or TOR.

IP geolocation is evidence, not an identity proof. The runtime compares bounded
responses from allowlisted HTTPS providers and stores provider agreement,
confidence reasons, and any provider-supplied accuracy radius. MaxMind is
disabled unless both optional credentials are configured. Credentials are sent
only in the Authorization header to the fixed MaxMind hostname and are never
placed in lookup URLs, persisted lookup evidence, or logs.

## Owner authentication

The main dashboard and all verification management pages use the signed Owner
PIN cookie in `discord/index/auth.js`.

- Production uses exactly 13 owner-maintained environment values:
  `NODE_ENV`, `MONGO_URI`, `TOKEN_MANAGER`, `DISCORD_CLIENT_ID`,
  `DISCORD_CLIENT_SECRET`, `ENCRYPTION_KEY`, `API_SECRET`,
  `VERIFY_STATE_SECRET`, `DASHBOARD_PIN`, `PUBLIC_BASE_URL`,
  `WEBHOOK_LOG_URL`, `ALERT_WEBHOOK_URL`, and `TRUST_PROXY`. Advanced controls
  use code defaults, and `PUBLIC_BASE_URL` must be the canonical public HTTPS
  base URL.
- Session cookies are HTTP-only, SameSite Strict, and Secure in production.
- `DASHBOARD_PIN` is required but intentionally has no application-enforced
  length or composition rule. Use a private, non-reused value; PIN attempt
  throttling remains active regardless of credential format.
- Shadow Portal rejects missing/blank credentials and accepts either its
  configured Shadow PIN or the Owner `DASHBOARD_PIN` as a recovery credential;
  both comparisons are timing-safe and successful login clears failed attempts.
- A separate readable SameSite CSRF cookie is HMAC-bound to the signed session.
- Non-read management routes require the `X-CSRF-Token` header.
- PIN and API rate-limit maps are bounded and cleaned.
- Rejected API requests are logged locally; the webhook emits a deduplicated
  `BLOCKED` notice only for rate-limit enforcement or a locked token-reveal PIN,
  and strips query strings from the reported path.
- Redirect targets are normalized to local paths.

The former guild-admin OAuth/session boundary was removed. There is no public
admin login, admin callback, or external sensitive-data approval request.

## Public OAuth callback

`GET /auth/callback` serves a page. `POST /auth/callback` is rate-limited and
requires MongoDB readiness.

Controls:

- signed/expiring verification state
- panel-revision validation
- one-time Discord authorization code exchange
- explicit handling of expired/replayed `invalid_grant`
- response/request byte limits for Discord calls
- safe error serialization
- removal of OAuth code/state from browser history
- no raw token logging
- join failure stops role assignment
- target role and panel configuration validation

The OAuth scopes are:

```text
identify email connections guilds guilds.members.read guilds.join
```

Only request scopes that are actually used. Any scope change requires consent
and regression tests.

## Sensitive persistence

### OAuth tokens

Access and refresh tokens are encrypted before MongoDB storage using the
existing compatible format. Current and historical decrypt formats remain
readable. Token metadata includes scope, type, expiry, refresh time/failures,
safe last error, and revocation time.

Raw tokens must never appear in:

- Owner list APIs or normal member-detail APIs
- logs or webhooks
- exports
- tests/fixtures
- migrations
- docs or pull-request text

The Owner-only per-user OAuth token reveal action is the only exception. It
requires a valid Owner session, CSRF token, non-empty reason, and
rate-limit/cooldown checks. It attempts to write an audit event and returns an
explicit audit status so a failed audit write is visible to the Owner. The
response is for the immediate Owner view only and must not be stored in browser
persistence or included in lists/exports/logs.

Historical `adminOAuth` fields remain refresh-compatible. No route creates a new
admin grant. Configure `LEGACY_ADMIN_OAUTH_REDIRECT_URI` when old tokens require
the retired origin during refresh.

### Raw IP

The current raw source IP is encrypted; an HMAC hash is used for correlation.
Normal serializers always return `rawIp: null` and `ip: null`, even to the
Owner. Location/network/risk fields remain available without decryption.
Paginated IP-history APIs return canonical user/device/role metadata only and
never return encrypted or decrypted raw IP or OAuth tokens.

Raw-IP access requires:

1. valid Owner PIN session;
2. CSRF token;
3. guild and user identifiers;
4. an audit reason (the rate-limited full Member Detail route supplies a fixed
   internal reason; compatibility reveal routes require Owner input);
5. an audit attempt with actor and timestamp, with failure surfaced in the
   response if the audit write fails.

The response is intended for the immediate Owner Member Detail view only. Do
not add raw IP to lists, exports, client storage, logs, query strings, or
webhook messages.

### Browser/device

The callback stores browser/device values supplied by the browser. Fingerprint
source values are combined in memory and HMAC-hashed; only the hash is
persisted. A fingerprint is a correlation signal, not a guaranteed identity.

### Discord snapshots

Optional Discord fetch failure must not erase the last successful connections,
guilds, or target-member snapshot. Data-quality metadata distinguishes success,
failure, and not-attempted states and stores redacted failure codes.

Large guild and connection arrays are stored in versioned chunk collections.
Target-member roles use a separate versioned role-chunk collection, and full
provider snapshots redact token-shaped keys before persistence.
Chunks remain unreadable as a complete snapshot until every write is finalized;
`complete` requires `returnedCount === storedCount`. VerifyLog stores the core
audit event and snapshot references rather than duplicating oversized arrays.
Aggregate payload size is not a truncation boundary. An oversized individual
object uses Base64 byte chunks whose order, count, byte length, and SHA-256
checksums are verified before reconstruction. Object-chunk identity includes the
guild, user, version, category, item, and chunk indexes.
Referenced snapshot history is permanent. Maintenance fails closed if reference
lookups fail and deletes only incomplete or unreferenced versions older than the
configured grace period; it never prunes a version referenced by OAuthUser or
VerifyLog, including soft-deleted logs.

### Automatic migration archive

Before automatic legacy migration changes an OAuthUser, the runtime stores the
complete encrypted source document in a same-database rollback archive. One
archive exists per source and migration version, so restarts do not create
duplicates. Archive failure aborts migration before the source write. Archive
documents must never be exposed through normal APIs, logs, or exports. External
provider backup is still required to survive loss of the entire database.
Restore skips a live OAuthUser whose update timestamp is newer than its archive.
Overwriting newer live state requires the explicit operator-only `--force` flag.
Any restore using `--apply` also requires `--maintenance-confirmed`; all OAuth
and verification writers must remain stopped for the entire restore window.

Do not infer values that Discord did not return:

- unknown/unavailable remains null or unknown;
- `premiumType` is not a reliable Nitro conclusion;
- target member details are not claimed for every user guild;
- false VPN/proxy flags with failed lookup are not treated as a confirmed
  negative without checking lookup status.

## Data minimization and retention

The owner explicitly requires verification and sensitive-access history, but retention remains
configurable by guild. Verification logs and IP identity summaries use
soft-delete retention behavior. Legacy pending reveal requests can expire
automatically.

Before reducing or extending retention:

- check legal/privacy obligations for the deployment jurisdiction;
- back up and test restore;
- preserve audit requirements;
- update user-facing policy/consent;
- verify that the migration is additive and rollback-safe.

Do not introduce bulk raw-token or raw-IP exports.

## Database and migration

Normal runtime uses exactly one Mongoose connection from
`discord/sessionManager.js`. Verification models attach to that connection.

`scripts/migrateVerificationSnapshots.js`:

- defaults to dry-run;
- requires explicit `--apply` to write;
- selects profile/guild/connection/metadata fields only;
- never selects, decrypts, or prints OAuth tokens or raw IP;
- adds derived fields and metadata;
- deletes no fields or collections.

Back up MongoDB before apply mode.

Privacy deletion uses one MongoDB transaction for the related verification and
identity-history writes. Canonical IP-history backfill also commits each event's
related writes transactionally and idempotently, preventing partial history
when a process or database operation fails mid-event.

## Logging and error handling

Use safe/redacted log helpers. Error output may include operation/status codes,
not payload bodies or credentials. Discord API errors are length-limited and
sanitized. Data-quality failure reasons should be stable redacted codes such as
`discord_http_403`, not provider response bodies.

Webhook targets are secrets. Operational and critical alert targets should be
separate where possible. The shared outbound dispatcher accepts only HTTPS
Discord webhook endpoints, disables mentions, bounds Discord payload sizes and
queue depth, prioritizes critical alerts, retries transient failures, and
exposes redacted delivery counters through Owner diagnostics. Shutdown performs
a bounded queue drain; diagnostics never contain webhook URLs.

The Enterprise Audit server-activity subsystem is retired. Runtime no longer
registers its Discord listeners, reads or writes its storage, sends log-channel
embeds, or exposes its Dashboard/API routes. This does not remove the redacted
operational/critical webhook dispatcher, ModCase persistence, or the internal
audit attempt required by sensitive Verification reveal actions.

## Runtime and dependency controls

- Node.js is pinned to 24.x.
- `discord.js` stays on v13 until explicitly approved.
- Production dependencies live only in the root package.
- There is no `connect-mongo` or `express-session`.
- Discord response/body caps and role/channel dashboard caps protect runtime
  memory; persistence of OAuth guilds/connections/target roles has no arbitrary
  item cap after payload acceptance.
- Volatile voice, IP lookup, rate-limit, command, and session structures
  remain bounded.
- Persistent per-IP users, device aggregates, and role events use paginated
  collections rather than truncating history arrays; request processing and UI
  reads remain batch-limited without imposing a total-history ceiling.

Validation:

```bash
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

Use a repository secret scanner before release/deployment. Inspect findings;
never paste discovered values into issues or chat.

## Protected code

`discord/systemProvider.js` and all files recursively under
`discord/systemProvider/` are owner-locked. Do not edit, move, reformat, change
imports/boot references, or document hidden behavior without the exact current
task approval required by `AGENTS.md`.

`.github/CODEOWNERS`, `npm run check:protected`, and CI provide defense in depth.

## Deployment checklist

1. Back up MongoDB.
2. Rotate any credential suspected of exposure.
3. Register `https://DOMAIN/auth/callback` in Discord Developer Portal.
4. Set `PUBLIC_BASE_URL` to the one canonical HTTPS origin.
5. Set `TRUST_PROXY=true` only on the approved managed reverse-proxy host; the
   hop count defaults to one.
6. Deploy one artifact and one command (`npm start`).
7. Set `SMOKE_ALLOWED_HOSTS` to the exact deployed hostname before running the
   unified smoke helper; do not use wildcards.
8. Verify `/ping`, degraded/ready `/health`, Owner PIN, CSRF, and callback rate
   limiting.
9. Verify normal APIs contain no raw token/IP.
10. Run one audited IP reveal and confirm an audit record without server logging.
11. If a legacy standalone service still exists, stop it only after smoke tests
    pass. Current deployments otherwise use only the root service.

The administrator-only smoke CLI is excluded from Codacy static analysis in
`.codacy.yml` because its validated, exact-allowlist URL remains a deliberate
network sink that Codacy reports as tainted. Runtime HTTP and OAuth files remain
included in analysis, and smoke URL validation is covered by repository tests.

## Incident response

If a token, raw IP, PIN, database URI, or signing secret may have leaked:

1. Stop affected access without deleting evidence.
2. Rotate/revoke the credential at its provider.
3. Invalidate Owner sessions by rotating `API_SECRET` and, when needed,
   `DASHBOARD_PIN`.
4. Restrict MongoDB/network access.
5. Preserve sanitized timestamps, request IDs, and audit records.
6. Search logs/exports/history for exposure without redisplaying the value.
7. Patch and validate the leak path.
8. Redeploy and document impact/remediation without including the secret.
