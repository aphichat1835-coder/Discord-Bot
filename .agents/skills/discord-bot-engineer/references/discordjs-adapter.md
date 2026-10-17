# discord.js adapter

## Contents

- Inspect
- Response and routing
- Components and events
- Concurrency and lifecycle
- Proof

## Inspect

Confirm resolved discord.js/Node version, ESM/CommonJS, TypeScript configuration, package manager, command deployment/runtime paths, framework layer, tests, and deployment entrypoint. Prefer installed types/source over remembered APIs.

## Response and routing

Preserve the existing handler contract. Keep one response owner and trace every branch through reply, defer/edit, follow-up, update, or modal behavior appropriate to the installed version. Error handling must observe actual response state and preserve ephemeral/public intent.

Keep registration builders and runtime inputs aligned. Separate controlled command deployment from normal production startup unless the repository deliberately owns that policy.

## Components and events

Use versioned custom-ID namespaces but treat their contents as untrusted. Re-load state and authorize callbacks. Bound collectors with time/idle or use a persistent central router. Disable terminal controls and prevent double-click races.

Register listeners intentionally once. Treat reconnect/event duplication as normal. Request only required intents and distinguish cache uncertainty from absence.

## Concurrency and lifecycle

Identify the resource key—message, channel, guild, member, ticket, account, queue, entitlement, or operation. Use constraints/transactions/idempotency and external ownership where process memory is insufficient.

Bound timers, downloads, retries, voice/media resources, and background work. At shutdown stop new work, drain or cancel owned operations, close integrations, destroy voice/client resources, and surface cleanup failure.

Reject token literals/logging, reply-state guessing, unbounded collectors, custom-ID authorization, non-atomic economy writes, global command registration on every ready event, blind retry loops, and wholesale template copies.

## Proof

Select command input/response-state tests, permission/hierarchy/context cases, forged/stale component IDs, duplicate/concurrent actions, REST 403/404/429/5xx adapter behavior, database/API partial failure, typecheck/lint/build, and safe payload/startup checks. Mock boundaries rather than reconstructing the whole framework.
