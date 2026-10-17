# Discord domain profiles

## Contents

- Moderation
- Verification
- Tickets
- Economy
- Voice and music
- AI and integrations
- Dashboard and OAuth
- Monetization
- Distributed jobs
- Backup and restore

Load only the selected profile. Convert it to a feature contract and tests rather than adding every listed capability.

## Moderation

Check actor/bot permissions, role hierarchy, context, target eligibility, scope, and audit reason. Track requested, eligible, acted, skipped, failed, and already-changed counts. Serialize shared moderation resources and report partial truth. Test missing permission, bot below target, mixed bulk eligibility, REST failure, simultaneous action, and cancellation after partial effects.

## Verification

Use single-use expiring server-side state bound to intended actor/guild/session. Minimize scopes and personal data. Make role/persistence reconciliation retry-safe. Test replay, wrong actor/guild, expiry, permission/hierarchy, duplicate callback, restart, and partial role/database success.

## Tickets

Use a durable ticket record, unique open-ticket policy, versioned component routing, and serialized claim/close. Persist recoverable transcript truth before destructive channel deletion. Test simultaneous open/claim/close, forged/stale ID, restart, missing channel, transcript failure, and partial close.

## Economy

Use exact integer/exact numeric units, atomic transactions, constraints, idempotency keys, and immutable ledger entries. Prevent negative balance, duplicate reward, replay, overflow, and unsafe self-transfer. Test duplicate interactions, concurrent spend/transfer, rollback, worker restart, time boundary, and reconciliation.

## Voice and music

Model guild connection, player, current item, queue, and policy ownership. Bound source resolution/downloads, handle move/disconnect/node/track/timeout/empty-channel/shutdown, and clean every media resource. Test concurrent play/skip, requester leave, node outage, stuck playback, restart, and leakage.

## AI and integrations

Acknowledge before slow work. Bound input/output/concurrency/cost/retries/timeouts and treat external output as untrusted. Prevent mentions, injection into tools/data, and credential leakage. Define privacy, cancellation, partial streaming, provider 429/5xx, malformed output, duplicate billed request, and fallback.

## Dashboard and OAuth

Derive identity from validated server-side session and re-check current Discord authorization for every sensitive operation. Use exact redirect allowlists, current OAuth state/PKCE rules where applicable, secure session storage, least scopes, CSRF protection, and schema validation. Test forged guild/user ID, revoked token, permission drift, replay, session expiry, open redirect, outage, and partial dashboard/bot state.

## Monetization

Key fulfillment by authoritative entitlement/purchase identity. Distinguish durable/consumable products and define consumption, refund, revocation, and reconciliation. Test duplicate/out-of-order event, ownership, delay, API outage, consumption race, and refund.

## Distributed jobs

Name resource owner and routing. Use database constraints, leases with fencing, queues, or pub/sub instead of process-global truth. Define idempotency, visibility timeout, retry/dead-letter, cancellation, rolling versions, drain, and restart recovery. Test duplicate job, worker death around acknowledgement, stale lease, poison message, unavailable shard, and mixed versions.

## Backup and restore

Define authoritative/restorable data, schema version, integrity, encryption/access, retention, ID remapping, dry-run, resumability, and environment scope. Test corrupted/partial backup, incompatible schema, missing Discord entity, interrupted/duplicate restore, permission failure, verification, and rollback.
