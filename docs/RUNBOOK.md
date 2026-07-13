# Unified Runtime Runbook

Updated: 2026-07-04.

## Start and health

```bash
npm install
npm start
```

The process must open one listener on `PORT || 3000`.

- `/ping` proves the HTTP listener is alive.
- `/health` reports combined MongoDB, Discord, voice, and verification
  readiness. A 503 during startup is expected; persistent 503 is not.

Expected boot order in logs:

```text
HTTP listener
MongoDB connection and state load
verification maintenance/OAuth refresh
Discord login
ready
```

## Deployment

### inwcloud

```text
Custom command: npm install && npm start
Internal port: PORT, otherwise 3000
```

Generate one domain for that port. Set all public URL aliases to this domain and
register `https://DOMAIN/auth/callback` in Discord Developer Portal.

### Render

Sync the single root service from `render.yaml`. Render uses `/health` as the
combined readiness check for MongoDB, Discord, voice, and verification. Use
`/ping` separately when checking only whether the HTTP process is alive during
startup or a degraded dependency state.

## Pre-cutover

1. Back up MongoDB and confirm restore access.
2. Add the unified OAuth callback URI without removing the old URI yet.
3. Copy required secrets into the unified service.
4. Keep `PUBLIC_BASE_URL`, `DASHBOARD_URL`, `PUBLIC_DASHBOARD_URL`, and
   `DASHBOARD_PUBLIC_URL` equal.
5. If historical admin grants must refresh against the retired URI, set
   `LEGACY_ADMIN_OAUTH_REDIRECT_URI`.
6. Deploy.
7. Run the single-port smoke helper:

   ```bash
   SMOKE_ALLOWED_HOSTS=DOMAIN npm run smoke:unified -- https://DOMAIN
   ```

8. Test Owner Dashboard, `/verification`, a target guild page, and a complete
   member verification.
9. Stop the retired service only after all checks pass.

## Verification smoke test

1. Login through Owner PIN at `/`.
2. Open `/verification`; confirm every bot guild is selectable, including a
   guild not present in Approved Guild records.
3. Open `/verification/:guildId`.
4. Validate/send or update a verification panel.
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

```bash
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID --apply
# Only after confirming that newer live OAuth data may be overwritten:
npm run restore:verification -- --source-id=OAUTH_USER_DOCUMENT_ID --apply --force
```

The first restore command changes nothing. This archive is in the same MongoDB
database and is intended for migration rollback, not whole-database disaster
recovery.

## Common failures

### `/health` remains degraded

- Check `dbConnected`, `botOnline`, `voiceReady`, and `verificationReady`.
- If database is false, inspect `MONGO_URI`, network allow-list, and MongoDB
  availability.
- If verification is false, inspect the safe maintenance summary and OAuth
  client/crypto configuration.
- If bot/voice is false, inspect bot token, intents, Discord availability, and
  voice diagnostics.

### OAuth redirect mismatch

- Confirm Developer Portal URI exactly matches
  `https://DOMAIN/auth/callback`.
- Confirm all public base URL aliases use the same scheme/host and no extra path.
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
   artifact and restore matching environment aliases.
4. Additive schema fields can remain; old readers should ignore them.
5. Do not roll back encryption keys separately from encrypted records.
6. Record the failure and safe diagnostics without secrets.
