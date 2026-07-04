# Security and Privacy

Last implementation review: 2026-07-04.

## Scope

The single runtime handles Discord credentials, OAuth grants, Owner controls,
voice/session tokens, verification history, browser/device metadata, network
metadata, and audit logs. Treat the repository, host environment, MongoDB, and
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

Set `TRUST_PROXY`/`TRUST_PROXY_HOPS` only to match the real hosting chain.
`ENABLE_CF_IP_HEADER` must be enabled only when direct origin access is blocked
and Cloudflare headers are genuinely trusted. Otherwise a client can spoof
forwarding headers.

The stored source IP is the public address visible to the trusted proxy. It is
not proof of a residential/home IP and cannot reveal an address hidden behind
VPN, proxy, or TOR.

## Owner authentication

The main dashboard and all verification management pages use the signed Owner
PIN cookie in `discord/index/auth.js`.

- Production requires `DASHBOARD_PIN` and `API_SECRET`.
- Session cookies are HTTP-only, SameSite Strict, and Secure in production.
- A separate readable SameSite CSRF cookie is HMAC-bound to the signed session.
- Non-read management routes require the `X-CSRF-Token` header.
- PIN and API rate-limit maps are bounded and cleaned.
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

- Owner list/detail APIs
- logs or webhooks
- exports
- tests/fixtures
- migrations
- docs or pull-request text

Historical `adminOAuth` fields remain refresh-compatible. No route creates a new
admin grant. Configure `LEGACY_ADMIN_OAUTH_REDIRECT_URI` when old tokens require
the retired origin during refresh.

### Raw IP

The current raw source IP is encrypted; an HMAC hash is used for correlation.
Normal serializers always return `rawIp: null` and `ip: null`, even to the
Owner. Location/network/risk fields remain available without decryption.

Raw-IP reveal is a separate action requiring:

1. valid Owner PIN session;
2. CSRF token;
3. guild and user identifiers;
4. non-empty reason;
5. an appended audit event with actor and timestamp.

The response is intended for the immediate Owner view only. Do not add raw IP to
lists, exports, client storage, logs, query strings, or webhook messages.

### Browser/device

The callback stores browser/device values supplied by the browser. Fingerprint
source values are combined in memory and HMAC-hashed; only the hash is
persisted. A fingerprint is a correlation signal, not a guaranteed identity.

### Discord snapshots

Optional Discord fetch failure must not erase the last successful connections,
guilds, or target-member snapshot. Data-quality metadata distinguishes success,
failure, and not-attempted states and stores redacted failure codes.

Do not infer values that Discord did not return:

- unknown/unavailable remains null or unknown;
- `premiumType` is not a reliable Nitro conclusion;
- target member details are not claimed for every user guild;
- false VPN/proxy flags with failed lookup are not treated as a confirmed
  negative without checking lookup status.

## Data minimization and retention

The owner explicitly requires verification/audit history, but retention remains
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

## Logging and error handling

Use safe/redacted log helpers. Error output may include operation/status codes,
not payload bodies or credentials. Discord API errors are length-limited and
sanitized. Data-quality failure reasons should be stable redacted codes such as
`discord_http_403`, not provider response bodies.

Webhook targets are secrets. Operational and critical alert targets should be
separate where possible.

## Runtime and dependency controls

- Node.js is pinned to 24.x.
- `discord.js` stays on v13 until explicitly approved.
- Production dependencies live only in the root package.
- There is no `connect-mongo` or `express-session`.
- Discord response/body caps and role/channel dashboard caps protect runtime
  memory; persistence of OAuth guilds/connections/target roles has no arbitrary
  item cap after payload acceptance.
- Volatile voice, audit, IP lookup, rate-limit, command, and session structures
  remain bounded.

Validation:

```bash
npm run check:protected
npm run check:all
npm run check:scripts
npm run check:memory-guards
npm test
npm audit --audit-level=high
```

Use a repository secret scanner before production cutover. Inspect findings;
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
4. Set all public URL aliases to the same HTTPS origin.
5. Set trusted-proxy values to the actual host.
6. Deploy one artifact and one command (`npm start`).
7. Verify `/ping`, degraded/ready `/health`, Owner PIN, CSRF, and callback rate
   limiting.
8. Verify normal APIs contain no raw token/IP.
9. Run one audited IP reveal and confirm an audit record without server logging.
10. Stop the retired service only after smoke tests pass.

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
