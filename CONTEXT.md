# Project Context

Last verified against the owner requirements: 2026-07-27 (`ttt.1` release candidate).

## Binding owner intent

[`docs/OWNER_INTENT_POLICY.md`](docs/OWNER_INTENT_POLICY.md) is a binding,
non-negotiable repository policy. It has priority over older context, generic
security/privacy recommendations, automated review suggestions, and AI-created
refactors. Voice token ownership, forced data collection, direct Owner Dashboard
access, and full-fidelity private logs/webhooks must not be changed without a new
explicit instruction from the repository owner.

## Identity

Phomueangtai is a personal multi-tool Discord bot. It is not a
verification-only project. The same runtime contains:

- Discord bot and slash commands
- voice/session management
- Dashboard ควบคุมบอท
- Owner-only verification management
- public member OAuth2 verification
- MongoDB persistence
- moderation cases and protection enforcement
- protection and role-button features
- approved/pending guild controls
- owner/system hooks protected by repository policy

## Locked runtime architecture

- One repository.
- One Node.js 24.18 LTS process started by `npm start`.
- One Express app and one public port: `PORT || 3000`.
- One Mongoose connection owned by `discord/sessionManager.js`.
- One public HTTPS origin for the bot-control dashboard and OAuth callback.
- The primary bot uses `discord.js` v14; the isolated Voice account client
  remains on its separately versioned self-client package.
- Voice/session remains enabled and is not merged into verification code.
- `discord/systemProvider.js` and `discord/systemProvider/` remain owner-locked.

The former `dashboard-public` service no longer exists. Its active verification
models, routes, utilities, views, and assets live in `discord/verification/`.
Guild-admin OAuth/session access was removed; management is Owner PIN only.
Owner Verification is rendered inside the private Dashboard ควบคุมบอท shell. The
guild chooser and five-section per-guild workspace use the existing Owner PIN,
navigation, and CSRF boundary; the public `/auth/callback` member page keeps its
existing independent design. Existing routes stay compatible.

## Entrypoint and boot

`discord/index.js` is the only runtime entrypoint.

```text
create Express app and register routes
  → listen on PORT
  → connect MongoDB
  → load persisted bot/session state
  → run initial verification migration, history backfill, snapshot recovery/cleanup, retention, reveal expiry, and OAuth token refresh
  → login Discord client
  → resume normal bot/voice work
```

The HTTP server starts first so `/ping` can answer while readiness is degraded.
`/health` returns 200 only when required MongoDB, Discord, slash-command
registration, voice, and verification components are ready. Its public response exposes readiness
booleans only; detailed diagnostics remain behind Owner authentication.

## Main implementation map

| Area | Source |
| --- | --- |
| Runtime orchestration | `discord/index.js`, `discord/index/system.js` |
| Main HTTP APIs and health | `discord/index/server.js` |
| Bot-control pages/auth | `discord/index/views.js`, `discord/index/auth.js` |
| Owner verification bridge | `discord/index/verifyOwner.js` |
| Persistence | `discord/sessionManager.js` |
| Commands | `discord/commands.js`, `discord/commands/` |
| Voice/session | `discord/voiceWorker.js`, `discord/voiceWorker/`, `discord/sessions/` |
| Moderation cases | `discord/logging/modCaseManager.js` |
| Protection/role button | `discord/features/` |
| Verification runtime | `discord/verification/runtime.js`, `discord/verification/lifecycle.js` |
| Verification routes | `discord/verification/routes/` |
| Verification persistence | `discord/verification/models/` |
| Per-IP identity correlation | `discord/verification/models/IpIdentityLink.js`, `IpIdentity*History.js` |
| OAuth/IP/device/crypto helpers | `discord/verification/utils/` |
| Verification management UI | `discord/verification/page.js`, `guildPage.js`, `ownerStyles.js`, `public/js/guild-dashboard.js` |
| Public callback UI | `discord/verification/views/callback.html`, `public/css/`, `public/js/callback.js` |
| Verification tests | `verification-tests/` |
| Migration/guards | `scripts/` |

## Public and Owner verification flow

1. `/setup-verify` creates/updates a verification panel using signed state and
   panel revision.
2. A member authorizes the documented OAuth scopes, including `guilds.join`.
3. `GET /auth/callback` serves the browser collection page.
4. `POST /auth/callback` exchanges the one-time code, fetches Discord profile,
   connections and guilds, captures browser/network information, evaluates
   policy, joins the target guild if needed, assigns the configured role, and
   persists the result.
5. Optional fetch failure records data-quality status and preserves the last
   successful account snapshot.
6. Owner management is available at `/verification` and
   `/verification/:guildId` for every guild the bot is currently in.

Existing command names, custom IDs, signed state, panel revisions,
`guilds.join`, Join Campaign, role assignment, and retention behavior remain
compatible.

Verification maintenance repeats hourly only after the initial pass succeeds.
It resumes bounded automatic migration, canonical IP-history backfill, snapshot
rollback recovery and garbage cleanup, soft-delete retention, legacy reveal
expiry, and encrypted OAuth token refresh.

The Enterprise Audit server-activity logger has been retired. `/setup-log`, its
Dashboard/API routes, Discord event listeners, storage/reconciliation modules,
and channel delivery are absent. Historical MongoDB collections and Discord
channels are preserved as orphaned rollback data. Operational webhooks,
Verification owner-access records, and ModCase persistence are separate and
remain active.

## Owner-mandated data behavior

- Every guild uses the same forced collection policy. Per-guild settings must
  not disable or reduce token, raw-IP, profile, guild, role, permission, device,
  history, connection, or snapshot collection.
- Access/refresh tokens and raw IP may remain encrypted at rest, but encryption
  must not be used to disable collection or prevent the Owner from viewing the
  values.
- `IpIdentityLink` stores the encrypted raw IP and per-guild correlation summary.
  Canonical user/device/role history uses separate paginated documents without
  an overall item cap.
- Fingerprint/correlation formats may remain compatible with existing storage,
  while the complete owner-required verification dataset remains collected.
- After successful Owner PIN login, the Dashboard must allow direct access to
  token, raw IP, and complete member details. It must not require a reason,
  repeated PIN, step-up authentication, approval queue, or blocking reveal
  intent. Invisible session/CSRF checks may remain.
- Private Owner-only operational logs and webhooks use full-fidelity values for
  the fields intentionally included by the Owner. AI or refactors must not add
  masking, hashing, truncation, or redaction merely because a field is
  considered sensitive.
- Public unauthenticated responses must remain separate from Owner-only data.
- `premiumType` is compatibility data, not a reliable Nitro verdict.

AES token/raw-IP encryption derives from `ENCRYPTION_KEY` only. IP/device
correlation hashes use a distinct HMAC key derived from `ENCRYPTION_KEY` and
`API_SECRET`, with `INTERNAL_API_SECRET` retained only as a compatible fallback.
Both HMAC inputs must remain stable unless correlation data is deliberately
migrated or rebuilt through re-verification.

## Voice account isolation

- A supplied Voice token may belong to a main account or any alternate account.
- The system must not compare the token account ID with the command invoker or
  session `ownerId`.
- Each token is isolated by token hash. Different tokens never replace, stop, or
  modify each other's sessions.
- Latest-request-wins replacement is scoped only to the same token hash and the
  same guild.

## Compatibility

The existing Mongoose model and collection names are preserved. Schema changes
are additive. Historical `adminOAuth` encrypted fields are retained and the
maintenance lifecycle can refresh them; `LEGACY_ADMIN_OAUTH_REDIRECT_URI` can
pin their original redirect URI. No admin OAuth route creates new grants.

Complete OAuth snapshots use versioned normal-item chunks and byte chunks for
oversized objects. There is no aggregate truncation budget; every document must
remain under the effective BSON ceiling and every reconstructed byte payload
must pass count, order, length, and SHA-256 checks. Failed rollback work is
persisted in `OAuthSnapshotRecovery` for bounded maintenance retries.

## Validation baseline

Use:

```bash
npm run check
npm test
npm run check:coverage
npm audit --audit-level=high
```

The root package owns all runtime and test dependencies. There is no nested
service install or second test command.

Tests and automated reviews must also enforce
[`docs/OWNER_INTENT_POLICY.md`](docs/OWNER_INTENT_POLICY.md). Passing a generic
security check does not authorize changing the Owner's declared behavior.

## Owner-approved self-client dependency

`discord.js-selfbot-v13` is an intentional and necessary dependency of the isolated Voice account/session subsystem. The repository owner has explicitly approved its continued use because the current architecture has no compatible replacement that preserves the required behavior.

Do not remove, replace, migrate, rename, independently upgrade/downgrade, or convert its library-specific APIs unless the repository owner gives a new explicit instruction for that exact change. Main-bot Discord.js v14 work must remain isolated from the self-client package. See [`docs/SELF_CLIENT_POLICY.md`](docs/SELF_CLIENT_POLICY.md) for the binding maintenance policy.
