# Security and Privacy

> **Binding owner policy:** This document is subordinate to
> [`docs/OWNER_INTENT_POLICY.md`](docs/OWNER_INTENT_POLICY.md). For Voice-token
> ownership, verification collection, Owner Dashboard access, and private
> Owner-only logs/webhooks, OI-01 through OI-04 are mandatory. Generic security,
> privacy, minimization, or UX preferences must not silently override them.


Last implementation review: 2026-07-27 (`ttt.1` owner-intent policy alignment).

## Scope

The single runtime handles Discord credentials, OAuth grants, Owner controls,
voice/session tokens, verification history, browser/device metadata, network
metadata, moderation cases, and sensitive-access history. Treat the repository, host environment, MongoDB, and
Owner session as security-sensitive.

Never commit to source control, CI output, public documentation, public issue/PR
text, or public logs:

- Discord bot/self-client credentials
- OAuth client secrets
- MongoDB URIs
- encryption/signing/API secrets
- Owner PINs
- webhook endpoint URLs
- hidden protected-system procedures

Private Owner-only event logs and webhooks are a separate trusted output boundary.
When the Owner-selected event schema includes raw IP, OAuth/verification values,
email, IDs, device/network detail, or another sensitive field, the formatter must
preserve the real value as required by OI-04. Do not invent or dump unrelated
environment secrets, credentials, PINs, MongoDB URIs, or webhook endpoint URLs.
Discord payload-size limits and destination validation still apply. Event profile
images are accepted only from Discord's HTTPS CDN/media hosts; arbitrary remote
image URLs are discarded.

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

Dashboard ควบคุมบอท and all verification management pages use the signed Owner PIN cookie in `discord/index/auth.js`.

- Production uses the documented root environment contract:
  `NODE_ENV`, `MONGO_URI`, `TOKEN_MANAGER`, `DISCORD_CLIENT_ID`,
  `DISCORD_CLIENT_SECRET`, `ENCRYPTION_KEY`, `API_SECRET`,
  `VERIFY_STATE_SECRET`, `DASHBOARD_PIN`, `SHADOW_SESSION_SECRET`,
  `SHADOW_PORTAL_PIN`, `PUBLIC_BASE_URL`, `WEBHOOK_LOG_URL`,
  `ALERT_WEBHOOK_URL`, and `TRUST_PROXY`. These are the 15 owner-maintained
  production values. Advanced controls
  use code defaults, and `PUBLIC_BASE_URL` must be the canonical public HTTPS
  base URL.
- Session cookies are HTTP-only, SameSite Strict, and Secure in production.
- `DASHBOARD_PIN` is required but intentionally has no application-enforced
  length or composition rule. Use a private, non-reused value; PIN attempt
  throttling remains active regardless of credential format.
- The protected control layer uses a separate session secret of at least 32 characters and a separate PIN. Missing credentials disable it with HTTP 503; it never falls back to `DASHBOARD_PIN` or a source-code default. Break-glass access is disabled by default and must be explicitly time-bounded.
- A separate readable SameSite CSRF cookie is HMAC-bound to the signed session.
- Non-read management routes require the `X-CSRF-Token` header.
- PIN and API rate-limit maps are bounded and cleaned.
- Rejected API requests may be logged locally and to the private Owner webhook.
  Dashboard data viewing must not require a second reveal PIN, manual reason,
  step-up authentication, or approval queue after a valid Owner session exists.
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

### Direct-message outbox

The shared `DmNotification` outbox stores only the final mention-disabled DM payload and delivery metadata for up to 30 days. A bounded in-memory queue preserves pending or already-delivered reconciliation records during a temporary MongoDB outage and migrates them into the durable outbox when connectivity returns. Callers must construct payloads
from the minimum information required for the recipient. OAuth access/refresh
tokens, raw IP addresses, voice account tokens, credentials, and decrypted
sensitive records must never enter the outbox. A unique server-derived event
key prevents duplicate side effects; browser-provided recipient IDs are not an
authority source. Restore results never fall back to a public channel when
private delivery fails.

Discord error `50007` and unknown-user delivery failures become terminal after
bounded handling. Transient failures use the persisted retry schedule. Every
payload disables mentions and dynamic profile/server/role text is normalized
before Discord rendering.

### OAuth tokens

Access and refresh tokens are encrypted before MongoDB storage using the
versioned `v3:gcm` format. Its AES-256 key uses the full 32-byte SHA-256 digest
of `ENCRYPTION_KEY`; historical Service-compatible GCM/CBC formats remain
readable only for migration. Bounded maintenance conditionally replaces a
legacy value only when authenticated decryption succeeds and the stored value
has not changed concurrently. Keep `ENCRYPTION_KEY` stable until diagnostics
report no remaining legacy records. Token metadata includes scope, type,
expiry, refresh time/failures, safe last error, and revocation time.

Token and raw-IP encryption do not include `API_SECRET` in their AES key.
IP/device correlation hashes use a separate HMAC key derived from
`ENCRYPTION_KEY` together with `API_SECRET` (falling back to
`INTERNAL_API_SECRET` only for legacy-compatible deployments). Keep both HMAC
inputs stable during normal operation: changing either input prevents new
correlation hashes from matching historical hashes. Any coordinated rotation
therefore requires an explicit correlation migration or re-verification plan.
Rotating `API_SECRET` also invalidates Owner sessions.

Raw tokens must never appear in source control, CI output, public documentation,
public issue/PR text, unauthenticated responses, or public logs.

After a valid Owner PIN session exists, the Owner Dashboard may return the complete
OAuth token as part of direct Owner data access. It must not require a manual
reason, repeated PIN, step-up authentication, reveal intent, approval queue, or
blocking audit write. Automatic CSRF/session validation and non-blocking background
audit are allowed. Private Owner-only logs/webhooks may include a token only when
the Owner-selected event schema intentionally includes that field, as required by
OI-04; unrelated credentials must not be added to an event automatically.

Historical `adminOAuth` fields remain refresh-compatible. No route creates a new
admin grant. Configure `LEGACY_ADMIN_OAUTH_REDIRECT_URI` when old tokens require
the retired origin during refresh.

### Raw IP

The current raw source IP is encrypted at rest; an HMAC hash remains available
for correlation. Public and unauthenticated serializers must not return raw IP.
A valid Owner Dashboard session may receive the decrypted raw IP directly in the
member detail/full-detail flow or the existing Owner route without a manual
reason, repeated PIN, step-up authentication, reveal intent, approval queue, or
blocking audit write. Automatic CSRF/session validation may remain invisible in
the background.

Private Owner-only logs/webhooks may contain raw IP when that field is intentionally
part of the Owner-selected event schema. Do not expose raw IP through public pages,
public logs, source control, CI output, or unauthenticated endpoints.

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
VerifyLog, including soft-deleted logs. OAuth activation and cleanup share a
per-user mutation lock in the single runtime; cleanup then repeats the age,
completion, and reference predicates at deletion time so an in-flight writer
cannot turn a valid snapshot into a stale deletion target.

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

## Mandatory collection and retention

The repository is a private Owner-operated system. Every guild uses the same
Owner-required verification collection contract. Per-guild privacy toggles,
opt-outs, defaults that omit OAuth tokens/raw IP, and guild-specific reduction of
the core dataset are prohibited by OI-02. Collection includes the supported
profile, OAuth, raw-IP, guild/member/role/permission, connection, device/browser,
network, verification-history, OAuth-history, and snapshot fields.

Retention and deletion behavior must be controlled by one Owner policy, not by
independent guild choices. Existing cleanup of incomplete/unreferenced technical
garbage may remain, but it must not remove a complete Owner-required record or
reduce one guild's dataset compared with another. Owner-initiated deletion or a
new direct Owner instruction may change retained data.

Before changing the global retention contract, back up and test restore, preserve
transactional integrity, and update the binding Owner policy when instructed.

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

Separate public/CI logs from private Owner-only logs. Public logs, CI output,
source-control text, and unauthenticated diagnostics must not expose credentials
or environment secrets. Private Owner-only logs and webhooks must preserve the
full value of every field intentionally included by the Owner-selected event
schema, including raw IP, email, Discord IDs, account/device/network detail,
permissions, verification result, error detail, and selected OAuth/verification
fields. Generic sanitizers must not mask, hash, drop, summarize, or replace those
fields merely because an AI considers them sensitive.

Webhook endpoint URLs remain credentials and must not be included in payloads or
diagnostics. The shared outbound dispatcher may enforce exact HTTPS destinations,
Discord payload-size/queue limits, priority, retry, deduplication, and bounded
shutdown drain. These transport controls must not silently remove Owner-selected
event fields.

The Enterprise Audit server-activity subsystem is retired. Runtime no longer
registers its retired Discord listeners, storage, channel embeds, or Dashboard/API
routes. Operational/critical Owner webhooks, ModCase persistence, and current
Owner event records remain active under OI-04. Data viewing in the Owner Dashboard
must not depend on a successful audit write.

## Runtime and dependency controls

- Node.js is pinned to 24.18 LTS and npm 12 through the manifest, CI, and
  deployment configuration.
- The primary bot uses `discord.js` v14. The separately isolated Voice account
  client remains on the latest published `discord.js-selfbot-v13` release;
  that upstream package is deprecated and has no supported v14 replacement.
- Mongoose uses v9 while retaining the existing collection names and additive
  data readers.
- Voice does not install an Opus codec because this runtime joins channels but
  never creates audio players or encodes/decodes audio.
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
9. Verify public/unauthenticated APIs contain no raw token/IP.
10. Verify the authenticated Owner Dashboard can directly display complete Token,
    raw IP, and full detail without a manual reason, repeated PIN, step-up flow,
    approval queue, or blocking audit dependency.
11. Verify a private Owner webhook preserves the complete values of the selected
    event schema while keeping the webhook endpoint URL and unrelated environment
    credentials out of the payload.
12. If a legacy standalone service still exists, stop it only after smoke tests
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

## Owner-approved self-client dependency

`discord.js-selfbot-v13` is an intentional and necessary dependency of the isolated Voice account/session subsystem. The repository owner has explicitly approved its continued use because the current architecture has no compatible replacement that preserves the required behavior.

Do not remove, replace, migrate, rename, independently upgrade/downgrade, or convert its library-specific APIs unless the repository owner gives a new explicit instruction for that exact change. Main-bot Discord.js v14 work must remain isolated from the self-client package. See [`docs/SELF_CLIENT_POLICY.md`](docs/SELF_CLIENT_POLICY.md) for the binding maintenance policy.
