# Project Context

Last verified against the implementation: 2026-07-04.

## Identity

Phomueangtai is a personal multi-tool Discord bot. It is not a
verification-only project. The same runtime contains:

- Discord bot and slash commands
- voice/session management
- Owner Dashboard
- Owner-only verification management
- public member OAuth2 verification
- MongoDB persistence
- audit logging and moderation cases
- protection and role-button features
- approved/pending guild controls
- owner/system hooks protected by repository policy

## Locked runtime architecture

- One repository.
- One Node.js 24 process started by `npm start`.
- One Express app and one public port: `PORT || 3000`.
- One Mongoose connection owned by `discord/sessionManager.js`.
- One public HTTPS origin for the Owner Dashboard and OAuth callback.
- `discord.js` remains v13.
- Voice/session remains enabled and is not merged into verification code.
- `discord/systemProvider.js` and `discord/systemProvider/` remain owner-locked.

The former `dashboard-public` service no longer exists. Its active verification
models, routes, utilities, views, and assets live in `discord/verification/`.
Guild-admin OAuth/session access was removed; management is Owner PIN only.

## Entrypoint and boot

`discord/index.js` is the only runtime entrypoint.

```text
create Express app and register routes
  → listen on PORT
  → connect MongoDB
  → load persisted bot/session state
  → run verification retention and OAuth token refresh
  → login Discord client
  → resume normal bot/voice work
```

The HTTP server starts first so `/ping` can answer while readiness is degraded.
`/health` returns 200 only when required MongoDB, Discord, voice, and
verification components are ready.

## Main implementation map

| Area | Source |
| --- | --- |
| Runtime orchestration | `discord/index.js`, `discord/index/system.js` |
| Main HTTP APIs and health | `discord/index/server.js` |
| Owner pages/auth | `discord/index/views.js`, `discord/index/auth.js` |
| Owner verification bridge | `discord/index/verifyOwner.js` |
| Persistence | `discord/sessionManager.js` |
| Commands | `discord/commands.js`, `discord/commands/` |
| Voice/session | `discord/voiceWorker.js`, `discord/voiceWorker/`, `discord/sessions/` |
| Audit/mod cases | `discord/auditLogger.js`, `discord/logging/` |
| Protection/role button | `discord/features/` |
| Verification runtime | `discord/verification/runtime.js`, `discord/verification/lifecycle.js` |
| Verification routes | `discord/verification/routes/` |
| Verification persistence | `discord/verification/models/` |
| OAuth/IP/device/crypto helpers | `discord/verification/utils/` |
| Verification UI | `discord/verification/views/`, `discord/verification/public/` |
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

## Sensitive data rules

- Access/refresh tokens are encrypted with the existing compatible format.
- Raw IP is encrypted; an HMAC hash is used for correlation.
- Fingerprint source material is never persisted; only its HMAC is stored.
- Normal list/export APIs never return raw tokens or raw IP.
- Raw-IP and raw OAuth-token reveal require Owner PIN, CSRF, a non-empty
  reason, cooldown/rate-limit checks, and append an audit event.
- Failure messages saved in data-quality metadata are redacted status codes.
- Logs, tests, migrations, docs, and exports must not print secrets, tokens, or
  raw IP.
- `premiumType` is compatibility data, not a reliable Nitro verdict.

## Compatibility

The existing Mongoose model and collection names are preserved. Schema changes
are additive. Historical `adminOAuth` encrypted fields are retained and the
maintenance lifecycle can refresh them; `LEGACY_ADMIN_OAUTH_REDIRECT_URI` can
pin their original redirect URI. No admin OAuth route creates new grants.

## Validation baseline

Use:

```bash
npm run check
npm test
npm audit --audit-level=high
```

The root package owns all runtime and test dependencies. There is no nested
service install or second test command.
