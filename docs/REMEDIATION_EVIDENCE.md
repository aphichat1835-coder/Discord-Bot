# Repository-wide Remediation Evidence

> Scope: `ttt.1` compared with `ttt` at baseline
> `dcfdaf58fe3b206e409ea07158e4d05ac3f2143d`.
>
> This file is the traceability register for the remediation plan. A green CI
> run is necessary but is not, by itself, proof of production readiness.

## Status vocabulary

- **Closed — automated:** implementation exists and an automated guard or
  behavioural test proves the contract.
- **Closed — reviewed:** implementation and repository-wide scan support the
  result, but the behaviour is not meaningful without an external service.
- **Environment gate:** requires a deployed test service, Test Guild, Test
  database, or third-party credential. The branch must not be merged while a
  required environment gate remains open.

## Finding traceability

| ID | Contract / root cause | Implementation evidence | Test / guard evidence | Status |
|---|---|---|---|---|
| F-001 | Discord.js v13 permission strings reached v14 runtime callers | `discord/core/discordPermissions.js`, command guards, moderation, verification and protected callers | `scripts/checkDiscordV14Compatibility.js`, `discord/tests/discordV14CompatibilityGuard.test.js`, command tests | Closed — automated |
| F-002 | Verification panel setup used deprecated channel checks and incomplete permissions | Verification command and panel interaction validation use sendable text-channel contracts and canonical flags | Command and panel tests, v14 AST guard | Closed — automated |
| F-003 | User-authored messages must be sent exactly as the owner requests, including mentions | `/say`, `/announce` and private webhook payloads preserve Discord mentions | Utility and webhook tests inspect outbound payloads | Closed — automated |
| F-004 | Voice runtime must support alternate accounts and must not bind a token to the requester identity | Token-owner pre/post login rejection was removed; requester identity remains only session-control metadata | Voice lifecycle tests | Closed — automated |
| F-005 | Concurrent Voice creation could create duplicate clients or leave an old target active | Same token+Guild requests are serialized; stale queued requests are superseded and the latest request replaces the previous session | Voice latest-wins and concurrency tests | Closed — automated |
| F-006 | A login completing after timeout could become a ghost client | Cancelled login generations destroy late clients before registration | Voice late-login tests | Closed — automated |
| F-007 | Active Voice records with missing clients were not recovered | Health recovery claims a lock, logs in, rechecks ownership and reconnects | Voice health-recovery tests | Closed — automated |
| F-008 | Empty memory state could trigger unscoped database deletion | Automatic bulk deletion was removed; the unused unscoped clear-all primitive was removed | Static guard rejects `deleteMany({})`; repository scan | Closed — automated |
| F-009 | Shutdown could persist state before pausing runtime activity | Ordered shutdown stops intake/timers, pauses Voice, saves final state, destroys clients and closes dependencies | Voice lifecycle and health tests; syntax/runtime guards | Closed — automated |
| F-010 | Verification could return success after critical persistence failed | Critical persistence contract, role rollback and durable recovery records | Verification persistence and recovery tests | Closed — automated |
| F-011 | A private bot must store the requested OAuth and encrypted Raw-IP data consistently in every Guild | Storage is forced on globally and Guild settings cannot disable it | OAuth storage and recovery tests | Closed — automated |
| F-012 | OAuth refresh races could overwrite newer credentials | Per-user lock, token version and compare-and-set update | OAuth lifecycle CAS tests | Closed — automated |
| F-013 | Re-verification could write into a soft-deleted identity | Reactivation clears deletion markers before new state is stored | Verification lifecycle tests | Closed — automated |
| F-014 | Privacy deletion did not cover all Guild-scoped references | Durable deletion job and collection manifest scrub/delete Guild-scoped data and verify remaining references | `verification-tests/privacyDeletion.test.js` | Closed — automated |
| F-015 | Snapshot activation/retention could leave corrupt or orphaned data | Reconstruction validation, checksums, chunks, finalisation and scoped cleanup remain enforced | Snapshot chunk, rollback, cleanup and budget tests | Closed — automated |
| F-016 | Long-lived OAuth state could be replayed | Short-lived registered nonce and one-time consumption | Security recovery and state tests | Closed — automated |
| F-017 | Owner Dashboard access to Token/IP had unnecessary reveal, reason and audit gates | Full member/session details return Token/IP directly after normal Dashboard authentication; compatibility reveal routes do not depend on audit | Dashboard detail and owner route tests | Closed — automated |
| F-018 | DM events could be lost during database outage and priority was applied after limiting | Bounded volatile retry queue, persistence migration, dedupe and database `priorityRank` ordering | DM system tests | Closed — automated |
| F-019 | Backup/Restore handling differed between dry-run and execution and failed on unsupported channels | Shared planner, thread/unsupported skip results, accurate counters and overwrite normalisation | Backup/Restore tests | Closed — automated |
| F-020 | Protection rules could punish, create cases and notify more than once | Decision pipeline merges evidence and commits one highest-severity outcome | Protection pipeline tests | Closed — automated |
| F-021 | Internal-event filtering could omit matches and private logs must retain full owner-visible metadata | Filter-before-result-limit plus bounded, non-redacting private metadata storage | Internal-event and webhook tests | Closed — automated |
| F-022 | Webhook timeout could cause duplicate retry after a late success | Operation IDs, pending timeout state, late result reconciliation and bounded pending flush | Webhook late-success and late-failure tests | Closed — automated |
| F-023 | Merely sending an auth-looking header could bypass CSRF | Only successfully authenticated server-secret middleware sets the bypass flag | Dashboard auth/CSRF tests | Closed — automated |
| F-024 | Prefix origin checks and request-derived public URLs were unsafe | Parsed exact-origin comparison and canonical production `PUBLIC_BASE_URL` validation | Dashboard guard and unified runtime tests | Closed — automated |
| F-025 | Liveness, readiness and fatal process state were conflated | `/ping` is liveness; readiness reports dependency state; fatal errors enter bounded shutdown and non-zero exit | Server health and lifecycle tests | Closed — automated |
| F-026 | Protected control authentication had defaults, query credentials and non-revocable sessions | Fail-closed credentials, POST/CSRF actions, versioned sessions, bounded attempts and persist-first PIN changes | Protected auth and route integration tests | Closed — automated |
| F-027 | Protected restore/state mixed schemas and could restore unrelated state | Separate role/overwrite/mute snapshots, Guild-scoped state, TTL/generation and lifecycle cleanup | Protected action/renderer tests | Closed — automated |
| F-028 | Protected trace deletion could proceed without durable intent or a secure approval destination | Audit-before-delete, secure destination, redacted preview and atomic claim | Trace approval tests | Closed — automated |
| F-029 | Join Campaign was enabled by default and an empty allow-list permitted all Guilds | Default-off configuration, mandatory allow-list, typed errors and dry-run/start parity | Join Campaign tests | Closed — automated |
| F-030 | Sensitive/state-changing Dashboard operations were exposed through GET and an unused bulk-delete primitive remained exported | Logout and reveal are POST+CSRF; per-session reveal path is correct; unscoped session wipe removed; panel-sync GET is read-only | Static route guard, state-route tests and repository scan | Closed — automated |
| F-031 | Numeric, Snowflake and sensitive-data validation was duplicated or permissive | Shared finite-number, Snowflake, permission and redaction helpers | Core input and static-analysis tests | Closed — automated |
| F-032 | Source-regex mocks and LCOV-file existence could create false confidence | Real v14 objects/flags, behavioural tests and metric thresholds; Voice LCOV is scoped to Voice/Session runtime without lowering thresholds | Discord, Voice and Verification coverage suites | Closed — automated |
| F-033 | Documentation could claim behaviour not implemented or disclose protected internals | README, SECURITY, architecture, runbook, environment and deployment files align with runtime and use the public wording “Dashboard ควบคุมบอท” | Documentation/source contract tests and final review | Closed — reviewed |
| F-034 | Protected files could self-approve digest changes and external analysis could be silently skipped | Complete six-file manifest, base comparison, exact-head owner approval and explicit Sonar degraded status | Protected guard tests and CI | Closed — automated; Sonar external scan is environment-dependent |
| F-035 | Runtime behaviour on Discord, MongoDB and the deployed web service must be proven outside mocks and against the exact deployed commit | `scripts/runIsolatedEnvironmentGate.js`, `.github/workflows/isolated-environment-gate.yml`, `scripts/smokeUnifiedRuntime.js`, runtime release identity and `docs/ISOLATED_ENVIRONMENT_GATE.md` | Gate validation/redaction tests, exact-SHA readiness/smoke tests; a successful external artifact still requires isolated credentials and preview infrastructure | **Environment gate — executable runner complete; external record pending** |
| F-036 | Tracked production files could contain credential-shaped literals without a permanent repository gate | `scripts/checkSecretLeaks.js`, `npm run check:secrets`, CI Secret leak step with redacted path/line output | `discord/tests/secretLeakGuard.test.js`; full tracked-file scan | Closed — automated |

## Automated gate command

The required repository gate is:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run check:secrets
npm run test:coverage:discord
npm run test:coverage:voice
npm run test:coverage:verification
npm run check:coverage
npm audit --audit-level=high
```

CI additionally verifies pinned Node/npm versions, protected-path owner approval,
Sonar availability/degraded status, tracked-file secret patterns and LCOV report
presence.

## Repository-wide negative scan

A final review must find no production occurrences of:

```text
.has("UPPER_SNAKE_CASE")
legacy permission overwrite object keys
.isText()
req.query.pin
app.all(...)
client.channels.cache.clear()
unscoped deleteMany({})
GET logout or sensitive reveal routes
prefix-only window.location.origin comparison
credential-shaped literals in tracked production files
```

The AST and secret guards deliberately contain fixture strings under
`discord/tests`; those fixtures are expected and prove rejection without printing
secret values.

## Required isolated environment gate

The permanent runner is documented in `docs/ISOLATED_ENVIRONMENT_GATE.md`. It is
available on pull requests when `RUN_ISOLATED_ENVIRONMENT_GATE=true` and through
manual dispatch after the workflow exists on the default branch.

The gate refuses production reuse and requires:

1. Exact 40-character PR head SHA.
2. Dedicated Test MongoDB with a clearly test-only database name.
3. Dedicated Discord bot application, Test Guild, text channel and Voice channel.
4. Dedicated OAuth client credentials.
5. Separate HTTPS preview origin and exact hostname allow-list.
6. A production origin value that must differ from the preview.
7. Runtime `/health` and `/ready` release identity matching the exact SHA and
   identifying a pull-request preview.

It then proves Mongo write/read/delete, OAuth client credentials, Discord bot
message create/delete with mention suppression, bot Voice connect/disconnect,
and the deployed single-port smoke routes. The resulting artifact is redacted and
bound to the exact commit.

The repository currently contains no isolated credentials or preview URL. The
availability probe found no Test Mongo, Test Discord application/Guild/channels,
OAuth test application, or Test deployment configuration. Production values are
not an acceptable substitute. Live automation of a normal Discord user account
is not part of this gate; the self-client compatibility boundary remains covered
by automated lifecycle, concurrency, timeout, cleanup and recovery tests.

## Remaining human interaction scenarios

Discord does not provide a compliant bot-side mechanism to originate a real user
slash-command interaction. After the automated isolated gate succeeds, a human
tester in the Test Guild must execute the documented command/verification flows
and attach the redacted result to the same exact SHA. This must include permission
allow/deny, mention suppression, direct/OAuth verification, privacy policy on/off,
recovery, Backup/Restore partial failure, protection dedupe, Dashboard CSRF and
fatal restart observation. No standard-user token may be placed in CI.

## Merge rule

`ttt.1` remains a Draft workstream. A successful automated CI run plus a passing
isolated-environment artifact, the Test Guild interaction record, and resolved
external review findings are required before any commit is brought into `ttt`.
Any new commit invalidates the external records and requires the gates to run
again against the new exact head SHA.
