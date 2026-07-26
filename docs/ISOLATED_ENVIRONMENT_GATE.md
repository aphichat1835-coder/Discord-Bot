# Isolated Environment Release Gate

This gate proves the external boundaries that unit and integration mocks cannot
prove: a disposable MongoDB database, a dedicated Discord test application and
Guild, and a separately deployed HTTPS preview of the exact commit.

The gate is intentionally manual and fail-closed. It must never be pointed at the
production database, production deployment, or a normal Discord user account.
The repository keeps the existing Voice/session compatibility boundary, but live
Discord verification uses a dedicated bot application and `@discordjs/voice`.

## Required GitHub environment

Create a protected GitHub Environment named `isolated-integration`. Require an
explicit reviewer before jobs in that environment may read its secrets.

Environment secrets:

| Name | Purpose |
|---|---|
| `TEST_MONGO_URI` | Disposable database URI. The database name must contain `test`, `testing`, `sandbox`, `staging`, `preview`, `integration`, or `ci`. |
| `TEST_DISCORD_TOKEN` | Token of a dedicated Discord bot application used only in the Test Guild. |
| `TEST_GUILD_ID` | Dedicated Test Guild Snowflake. |
| `TEST_TEXT_CHANNEL_ID` | Channel where the gate may create and immediately delete one marker message. |
| `TEST_VOICE_CHANNEL_ID` | Voice channel where the test bot may connect muted/deafened and disconnect. |
| `TEST_DISCORD_CLIENT_ID` | Application ID of the same dedicated Discord test bot. |
| `TEST_DISCORD_CLIENT_SECRET` | Secret for the dedicated test application, used for OAuth client-credentials verification. |
| `TEST_PUBLIC_BASE_URL` | HTTPS preview URL serving the exact commit under test. |

Environment/repository variables:

| Name | Purpose |
|---|---|
| `TEST_ALLOWED_HOSTS` | Exact comma-separated hostname allow-list for the preview smoke test. |
| `PRODUCTION_PUBLIC_BASE_URL` | Production origin. The gate refuses to run when it equals the preview origin. |

Do not reuse `MONGO_URI`, `TOKEN_MANAGER`, the production OAuth application, or
any production channel. Do not add these values to repository files, workflow
inputs, issue comments, logs, or artifacts.

## Running the gate

1. Deploy the exact `ttt.1` commit to an isolated preview service with a separate
   database and separate Discord test application.
2. Open **Actions → Isolated Environment Gate → Run workflow**.
3. Enter the full exact commit SHA in `expected_sha`.
4. Enter `ISOLATED_TEST_ONLY` in `confirmation`.
5. Approve the protected GitHub Environment review.

The workflow checks out the exact SHA, reruns repository checks, all three LCOV
suites, coverage thresholds, and the high-severity package audit before it makes
external calls.

## External proofs

`scripts/runIsolatedEnvironmentGate.js` then performs:

1. Isolation validation: explicit confirmation, exact HTTPS host allow-list,
   non-production URL, valid Snowflakes, and a database name clearly marked as
   test/sandbox/staging/preview/integration/CI.
2. MongoDB: admin ping followed by a unique marker write, read, delete, and
   cleanup in the isolated database.
3. Discord OAuth: client-credentials exchange for the dedicated test
   application without storing the returned access token.
4. Discord bot: application identity match, Test Guild/channel resolution,
   one mention-suppressed marker message create/delete, and muted/deafened bot
   Voice connect/disconnect.
5. Deployed preview: bounded `/ping`, `/health`, `/ready`, public callback, root,
   and owner-boundary checks through `scripts/smokeUnifiedRuntime.js`.

The runner does not automate a standard Discord user account. Self-client
lifecycle behaviour remains covered by the isolated automated Voice tests.

## Evidence record

The workflow uploads `artifacts/environment-gate-<sha>.json` for 30 days. The
record contains timestamps, exact commit SHA, database name, hashed deployment
origin/Guild/channel/application identifiers, pass/fail evidence, and a redacted
error code when a step fails. Tokens, client secrets, connection credentials,
and raw Discord identifiers are not included.

A result is valid only when:

- the workflow conclusion is `success`;
- the artifact says `status: passed`;
- the artifact commit exactly matches the PR head;
- the preview deployment identifies the same commit;
- no later commit has changed the branch;
- Snyk/CodeRabbit and required repository checks are successful;
- no unresolved review thread remains.

## Failure handling

The runner attempts cleanup in `finally` blocks. A failed Mongo marker is deleted,
a created Discord marker message is deleted, Voice is disconnected, and the test
bot client is destroyed. A failed gate remains a release blocker; do not point the
workflow at production to bypass missing test infrastructure.
