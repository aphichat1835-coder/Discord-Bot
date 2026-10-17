# Discord platform contracts

## Contents

- Evidence policy
- Interactions
- Components and modals
- Authorization and installation
- Events and state
- Voice, monetization, and scale

## Evidence policy

Discord capabilities change. Resolve the installed framework/runtime first, then consult installed types/source and current official Discord/framework documentation for version-sensitive behavior. Treat templates as examples, never specifications.

## Interactions

- An interaction has one initial acknowledgement owner.
- Choose initial response, defer/edit, follow-up, modal, or component update from actual response state and interaction type.
- Defer before slow database, external API, AI, media, or multi-item work.
- Preserve ephemeral/public intent through errors and follow-ups.
- Handle expired/deleted original responses and Discord 403/404 separately from domain failure.
- Model terminal state so late progress cannot overwrite success, partial, failure, cancellation, or timeout.
- For HTTP interactions, validate request authenticity at the raw-body boundary using the current platform contract.

## Components and modals

- Treat custom IDs and modal values as untrusted routing/input.
- Bind durable ownership, guild/channel/message, operation, expiry, and lifecycle server-side when consequences matter.
- Re-load state and re-authorize every use.
- Disable or replace stale controls in terminal states.
- Bound temporary collectors/views and clean them up; restore persistent routing across restart.
- Prevent simultaneous callbacks from committing one side effect twice.
- Validate Components V2 versus legacy content/embed behavior against current Discord documentation before composing payloads.

## Authorization and installation

At the side-effect boundary check what applies:

- actor identity and ownership;
- user permission;
- bot permission;
- channel overwrites;
- role hierarchy and guild owner rules;
- guild/DM/private-channel context;
- guild/user installation context;
- OAuth scopes and entitlements;
- current durable resource state.

UI visibility, command defaults, role names, custom IDs, cached permission lists, and client-submitted guild/user IDs are not sufficient authorization.

Treat privileged intents, partial data, cache policy, OAuth/Developer Portal configuration, install context, and integration type as runtime dependencies. A cache miss is not proof of non-existence. Read [modern-discord-features.md](modern-discord-features.md) for detailed User-Installable Apps, Activities, and AutoMod contracts.

## Events and state

- Gateway delivery can repeat across reconnects; duplicate-sensitive handlers must be idempotent.
- Register each listener/extension once and account for reload/startup behavior.
- Bound timers, collectors, tasks, queues, retries, and downloads.
- Give every long-lived resource an owner, terminal states, exception observation, and shutdown cleanup.
- Use external constraints, transactions, leases, queues, or routing when multiple workers/shards can own the same resource.
- Preserve partial truth when Discord and persistence/integration succeed differently.
- Let framework REST machinery handle normal rate limits; application retries require idempotency and bounded policy.

## Voice, monetization, and scale

Voice requires explicit guild connection/player/queue ownership, bounded media work, failure/reconnect policy, and cleanup of connections, streams, processes, tasks, and temporary files.

Monetization requires authoritative entitlement identity, idempotent fulfillment, durable/consumable semantics, revocation/refund handling, and reconciliation where supported.

Distributed systems require external ownership, fencing against stale workers, idempotent jobs, retry/dead-letter behavior, rolling-version compatibility, restart recovery, and safe correlation telemetry.
