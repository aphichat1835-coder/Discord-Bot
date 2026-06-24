# Audit Runtime Checklist

Use this checklist before merging or enabling Audit v4 runtime features in production.

## Required environment

- `FEATURE_AUDIT=true`
- `AUDIT_RECONCILER_ENABLED=false` by default
- `AUDIT_RECONCILER_ENABLED=true` only after runtime testing
- `AUDIT_RECONCILER_INTERVAL_MS=300000` or higher for normal use
- `AUDIT_RECONCILER_LIMIT=10` to avoid excessive audit-log reads
- `AUDIT_RETENTION_DAYS=90` or a guild-specific retention setting

## Discord permissions

The bot should have:

- View Audit Log
- View Channels
- Send Messages in configured log channels
- Embed Links
- Attach Files when attachment previews are expected
- Manage Messages only if moderation commands require it

If `VIEW_AUDIT_LOG` is missing, gateway logs should still work, but executor fields may show Unknown and the reconciler should stay disabled for that guild.

## Runtime test order

1. Start bot with `AUDIT_RECONCILER_ENABLED=false`.
2. Verify `/audit-logs` and the `/api/audit/*` routes remain behind owner dashboard auth.
3. Verify existing gateway logs still work.
4. Verify message edit/delete logs still include before/after and IDs.
5. Verify member join/leave/kick/ban/unban logs still work.
6. Verify voice join/leave/move/mute/deaf/camera/screen logs still work.
7. Verify channel/role/invite/emoji/sticker/thread/webhook logs still work.
8. Enable `AUDIT_RECONCILER_ENABLED=true` in a private test server only.
9. Confirm reconciler does not spam duplicate logs.
10. Confirm `/api/audit/logs`, `/api/audit/export`, `/api/audit/health`, `/api/audit/settings`, and `/api/audit/dead-letters`.
11. Confirm audit records save to Mongo and fallback settings do not grow unexpectedly.
12. Temporarily remove one configured log channel in a test server and confirm the failed send is visible in dead letters.

## Manual event checklist

- Guild update
- Channel create/update/delete
- Channel overwrite create/update/delete
- Role create/update/delete
- Invite create/update/delete
- Webhook create/update/delete
- Member kick/prune/ban/unban/move/disconnect
- Message delete/bulk delete/pin/unpin
- Integration create/update/delete
- Stage instance create/update/delete
- Sticker create/update/delete
- Scheduled event create/update/delete
- Soundboard sound create/update/delete
- Auto moderation rule create/update/delete
- Auto moderation actions
- Onboarding/home settings
- Voice channel status create/delete

## Reliability checklist

- Missing log channel creates a dead-letter record.
- Send failure creates a dead-letter record.
- Queue-full condition creates a dead-letter record.
- Dead-letter page/API loads without exposing unrelated session data.
- Export still works after filters are applied.

## Merge gate

Do not merge until:

- CI is green.
- Runtime test server passes gateway log checks.
- Audit reconciler is tested with opt-in mode.
- Dashboard/API routes are registered safely and remain owner-auth protected.
- CodeFactor exclusion is removed only after real moderation refactor.
