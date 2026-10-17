# discord.py adapter

## Contents

- Inspect
- Response and routing
- Views, tasks, and events
- Concurrency and lifecycle
- Proof

## Inspect

Confirm the actual Discord wrapper/version, Python runtime/environment, extensions/Cogs, app-command sync, interaction dispatch, async database/HTTP clients, task ownership, tests, and deployment entrypoint. Do not apply discord.py behavior unchanged to py-cord, disnake, nextcord, or interactions.py without installed-source verification.

## Response and routing

Trace initial response availability before choosing response send/defer, original-response edit, follow-up, or modal. Defer before slow work. Nested helpers should return results or use an explicit responder contract, not reply opportunistically.

Keep app-command metadata, options, checks, localization, and sync policy aligned. Separate development sync from controlled production/global sync.

## Views, tasks, and events

Treat custom IDs/modal fields as untrusted. Re-check actor, hierarchy, guild/channel/message ownership, and durable state inside callbacks. Temporary Views need timeout/cleanup; persistent Views need explicit IDs, startup registration, and durable routing truth.

Never block the event loop with synchronous HTTP/database/media/filesystem work. Give created tasks an owner, exception observation, cancellation, and shutdown policy. Load extensions/listeners once and account for reload/reconnect.

## Concurrency and lifecycle

Use asyncio locks only for single-process ownership; use constraints, transactions, leases, or distributed locks across workers/shards. Make cancellation cooperative and preserve committed side effects. Bound semaphores, queues, retries, task loops, downloads, and voice resources.

Reject synchronous requests in handlers, untracked critical tasks, broad swallowed exceptions, memory-only persistent Views, decorator-only authorization, non-atomic economy writes, uncontrolled tree sync, and code copied from another wrapper without verification.

## Proof

Select async command/response tests, permission/hierarchy/context cases, View ownership/timeout/restart, forged IDs, cancellation/task exceptions, duplicate/concurrent writes, HTTP 403/404/429/5xx adapter behavior, type/lint/import/startup checks, and safe command-tree validation. Prefer small fakes/protocols around Discord and integration boundaries.
