# Unified Runtime Runbook

Updated: 2026-07-16 (`tt`).

## Start and health

```bash
npm install
npm start
```

The process must open one listener on `PORT || 3000`.

- `/ping` proves the HTTP listener is alive.
- `/health` is the Render combined-readiness probe for MongoDB, Discord
  slash-command registration, voice, and verification. A 503 during startup is
  expected; persistent 503 requires investigation.
- `/ready` is an alias of the same combined-readiness response.

Expected boot order in logs:

```text
HTTP listener
MongoDB connection and state load
initial verification migration, history, snapshot, retention, reveal, and OAuth maintenance
Discord login
command registration, panel restore, and Voice auto-resume
ready
```

## Deployment

### inwcloud

```text
Custom command: npm install && npm start
Internal port: PORT, otherwise 3000
```

Generate one domain for that port. Set `PUBLIC_BASE_URL` to its canonical HTTPS
origin and register `https://DOMAIN/auth/callback` in Discord Developer Portal.

### Render

Sync the single root service from `render.yaml`. Render uses `/health` as the
combined MongoDB, Discord, voice, slash-command, and verification readiness
check. `/ready` returns the same readiness response, while `/ping` is the
simple listener-only liveness check.

## Pre-release/deployment

1. Back up MongoDB and confirm restore access.
2. Register the unified OAuth callback URI.
3. Copy required secrets into the unified service.
4. Set the 13 owner-maintained values from `.env.example`. `PUBLIC_BASE_URL` is
   canonical. If legacy URL aliases still exist in the host configuration,
   keep them equal or remove them.
5. If historical admin grants must refresh against the retired URI, set
   `LEGACY_ADMIN_OAUTH_REDIRECT_URI`.
6. Deploy.
7. Run the single-port smoke helper:

   ```bash
   SMOKE_ALLOWED_HOSTS=DOMAIN npm run smoke:unified -- https://DOMAIN
   ```

8. Test Owner Dashboard, `/verification`, a target guild page, and a complete
   member verification.
9. If a legacy standalone service still exists, stop it only after all checks
   pass. New/current installations have only the root service.

## Verification smoke test

1. Login through Owner PIN at `/`.
2. Open the Dashboard navigation item `สมาชิก → ยืนยันตัวตน`; confirm every bot
   guild is selectable, including a guild not present in Approved Guild records.
3. Open `/verification/:guildId`; confirm Overview, System, Panel, Policy/Role,
   and Verification Data stay inside the purple Owner Dashboard shell.
4. Validate/send or update a verification panel and return to the guild chooser.
5. In a test member account, authorize the callback.
6. Confirm:
   - callback POST succeeds;
   - existing member or `guilds.join` path works;
   - target role is assigned;
   - profile, connections, guild list, target-member, browser, network,
     join/role result, and data-quality metadata are persisted;
   - no raw token/IP appears in logs or normal APIs.
7. Open a verified user's “ดูข้อมูลทั้งหมด”, confirm the full Owner view shows
   decrypted raw IP and OAuth tokens and creates an internal audit entry.

## Migration

Migration runs automatically in bounded batches after MongoDB connects and
continues during hourly maintenance. Check
`/api/verification/diagnostics` under `automaticMigration`. Manual dry-run is:

```bash
npm run migrate:verification
```

Manual apply remains available for maintenance:

```bash
npm run migrate:verification -- --apply
```

The script should report counts only. It must not print document bodies, tokens,
or IP values. It is additive and does not delete fields/collections.

Inspect or restore an automatically archived original document:

For `--apply`, first stop the bot runtime so all OAuth and verification writes
remain paused until the restore command finishes.

```bash
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID --apply --maintenance-confirmed
# Only after confirming that newer live OAuth data may be overwritten:
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID --apply --force --maintenance-confirmed
```

The first restore command changes nothing. This archive is in the same MongoDB
database and is intended for migration rollback, not whole-database disaster
recovery.

## Common failures

### `/health` or `/ready` remains degraded

- Check `dbConnected`, `botOnline`, `commandsReady`, `voiceReady`, and
  `verificationReady`.
- If database is false, inspect `MONGO_URI`, network allow-list, and MongoDB
  availability.
- If verification is false, inspect the safe maintenance summary and OAuth
  client/crypto configuration.
- If bot/voice is false, inspect bot token, intents, Discord availability, and
  voice diagnostics.

### OAuth redirect mismatch

- Confirm Developer Portal URI exactly matches
  `https://DOMAIN/auth/callback`.
- Confirm `PUBLIC_BASE_URL` uses the same scheme/host and has no extra path.
- Remove stale legacy URL aliases, or keep them exactly equal to the canonical
  origin while compatibility is still required.
- Restart after changing environment variables because callback constants are
  initialized at process start.

### OAuth code expired or already used

This is expected for replayed/old codes. Press the Discord panel again and use
the new authorization flow. Never retry the same raw code server-side or log it.

### Guild join fails

- Confirm the grant includes `guilds.join`.
- Confirm the bot is in the target guild.
- Confirm client ID/secret and bot token belong to the same application.
- Confirm the target guild ID in signed state/config is correct.
- Role assignment must not run after join failure.

### Role assignment fails

- Confirm the role exists.
- Confirm bot permissions and role hierarchy.
- Confirm target member now exists in the guild.
- Inspect the persisted safe `joinResult` and `roleAssignResult`.

### Optional data fetch fails

Check `snapshotMeta`/`dataQuality` status and redacted failure code. A failed
connections/guild/member fetch must leave the last successful `OAuthUser`
snapshot intact.

For chunked snapshots, confirm `complete: true`, verify
`returnedCount === storedCount`, and check `chunkCount`. Pagination in the Owner
Dashboard changes only the displayed page; Member Detail reads all finalized
chunks and does not treat pagination as truncation.

### Voice Session shows no account or server data

An invalid or undecryptable stored Voice token is terminal. On the next login/
auto-resume attempt the runtime marks that record failed, removes it from active
Dashboard cards, and does not keep retrying it as an online Session. Start a new
Session with a valid token. Dashboard stop is idempotent, so a record already
removed by cleanup is reported as stopped instead of returning a false failure.

### Dashboard memory differs from the host panel

The Dashboard RAM card is process RSS: resident memory of the Node process. The
status detail reports V8 heap used/allocated separately. A hosting panel may add
container/runtime overhead, so its number can be higher without either reading
being false.

### Raw IP is missing

- Normal APIs intentionally return null.
- Use only the audited Owner reveal action.
- If reveal returns 404, the selected user has no verification log with an
  encrypted source IP.
- Never add temporary logging of decrypted IP.

### Historical admin OAuth refresh fails

Set `LEGACY_ADMIN_OAUTH_REDIRECT_URI` to the exact URI used when the old grant
was issued. No new admin OAuth route exists.

## Validation before release

```bash
npm ci --no-audit --no-fund
npm run check
npm test
npm audit --audit-level=high
```

Also run an approved secret scan and inspect `git diff --check`. Confirm the
protected-path guard passes and that `git diff` contains no protected file or
boot/import change.

## Rollback

1. Do not run destructive MongoDB cleanup.
2. Keep the backup and old deployment configuration until unified smoke tests
   pass.
3. If rollback is required, route traffic/callback to the known working
   artifact and restore its matching canonical `PUBLIC_BASE_URL`.
4. Additive schema fields can remain; old readers should ignore them.
5. Do not roll back encryption keys separately from encrypted records.
6. Record the failure and safe diagnostics without secrets.
