# Audit Runtime Test Plan

This checklist is the manual gate for Audit v4 runtime verification.

Audit runtime verification is still logging-first. Protection policy/state modules must remain audit-only/future foundation during this test pass.

## 0. Environment defaults

Start with conservative defaults:

```env
FEATURE_AUDIT=true
AUDIT_RECONCILER_ENABLED=false
AUDIT_RECONCILER_LIMIT=10
AUDIT_RECONCILER_INTERVAL_MS=300000
LOG_MESSAGE_CREATE=false
```

Do not enable `AUDIT_RECONCILER_ENABLED=true` until gateway logs and dashboard routes are confirmed stable.

## 1. Server integration gate

Verify before running:

- `discord/index/server.js` still keeps `/api` auth/rate-limit/CSRF middleware.
- `/api/reveal-token` and `/api/reveal-all-tokens` logic is unchanged.
- Audit web routes are mounted through `registerAuditWebBundle`.
- `/audit-logs` is behind the same dashboard auth gate as the owner dashboard.

Expected routes after mount:

- `GET /audit-logs`
- `GET /api/audit/logs`
- `GET /api/audit/export`
- `GET /api/audit/health`
- `GET /api/audit/dead-letters`
- `GET /api/audit/settings`
- `POST /api/audit/settings`

## 2. Scheduler integration gate

Expected default behavior:

- On boot, scheduler reports inactive when `AUDIT_RECONCILER_ENABLED=false`.
- No reconcile loop starts by default.
- Shutdown stops the scheduler when it is wired.

Only after gateway/dashboard tests pass, test with:

```env
AUDIT_RECONCILER_ENABLED=true
```

Then confirm:

- It does not spam duplicate logs.
- It records executor/reason/target when Discord audit log data exists.
- It keeps the last seen/cursor state stable across restarts.

## 3. Dashboard route smoke test

After server mount, confirm from a logged-in dashboard session:

- `/audit-logs` loads.
- Navigation has the `Audit` link.
- `GET /api/audit/health` returns JSON.
- `GET /api/audit/logs?guildId=<testGuildId>` returns JSON.
- `GET /api/audit/export?guildId=<testGuildId>&format=csv` downloads text/csv output.
- `GET /api/audit/dead-letters?guildId=<testGuildId>` returns JSON.
- `POST /api/audit/settings` succeeds with the dashboard CSRF cookie/header.

## 4. Discord gateway log tests

Use a private test server. Confirm each event sends to the expected log channel and stores an audit record when storage is enabled.

### Message

- Message edit.
- Message delete.
- Bulk delete.
- Attachment message delete.
- Pin/unpin where supported.

### Member/moderation

- Member join.
- Member leave.
- `/kick` command.
- `/ban` command.
- Unban.
- Nickname change.
- Role add/remove.
- Timeout.

### Voice

- Join voice.
- Leave voice.
- Move channels.
- Server mute/deafen.
- Self mute/deafen.
- Camera/screen-share state where available.

### Server/security

- Channel create/update/delete.
- Role create/update/delete.
- Invite create/delete.
- Webhook create/update/delete.
- Emoji/sticker/thread actions where available.

## 5. Dead-letter reliability test

Use a disposable test guild/channel config.

1. Configure a log category to point to a missing channel.
2. Trigger any audit log for that category.
3. Confirm `/api/audit/dead-letters?guildId=<testGuildId>` shows `missing_log_channel`.
4. Restore the log channel.
5. Confirm normal delivery works again.

Do not add retry loops until failed-send visibility is proven stable.

## 6. Moderation workflow regression test

Confirm behavior after `moderationWorkflow.js` extraction:

- `/ban` checks user permission and bot permission.
- `/kick` checks user permission and bot permission.
- `/timeout` rejects invalid duration.
- DM result is reflected in the reply.
- Case records are created.
- Moderation channel receives case embeds.

## 7. Merge gate

Do not merge until all of these are true:

- CI is green on the latest head commit.
- CodeFactor/SonarCloud are refreshed and no new high-confidence runtime bug exists.
- Server audit routes are mounted and manually tested.
- Scheduler is mounted with default disabled behavior verified.
- Dead-letter visibility is manually tested.
- Protection modules remain audit-only and are not wired to auto punitive actions.

Recommended merge style after runtime pass: squash merge.
