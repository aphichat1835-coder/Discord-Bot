# Test Guild Release Record

Use this record only after the automated **Isolated Environment Gate** succeeds
for the same exact PR head SHA. The tester must use the dedicated Test Guild,
Test database, Test OAuth application, and HTTPS preview described in
`docs/ISOLATED_ENVIRONMENT_GATE.md`.

Do not paste tokens, client secrets, MongoDB credentials, raw IP addresses,
session cookies, sensitive user records, or unredacted Discord identifiers into
this file, issues, pull-request comments, screenshots, or artifacts.

## Record identity

- Exact commit SHA: `<40-character SHA>`
- Pull request: `<number>`
- Isolated Environment Gate run: `<run URL or run ID>`
- Gate artifact digest: `<SHA-256>`
- Preview origin hash: `<from gate artifact>`
- Test Guild hash: `<from gate artifact>`
- Test database name: `<test-only name>`
- Started at UTC: `<ISO-8601>`
- Finished at UTC: `<ISO-8601>`
- Tester: `<GitHub username or internal identifier>`

Any commit after the recorded SHA invalidates the entire record.

## Scenario result vocabulary

- `PASS`: expected behaviour observed and cleanup verified.
- `FAIL`: expected behaviour was not observed; merge remains blocked.
- `BLOCKED`: external permission/service prevented execution; merge remains blocked.
- `NOT_APPLICABLE`: allowed only when the evidence register explicitly says the
  feature is disabled for this release. Include the finding ID and reason.

## Test Guild scenarios

| ID | Scenario | Required evidence | Result | Notes / redacted reference |
|---|---|---|---|---|
| TG-001 | A permitted slash command succeeds in the Test Guild | Command name, UTC time, expected response category |  |  |
| TG-002 | The same command is denied when required bot/member permission is removed | Denial category and restored permission |  |  |
| TG-003 | `/say` or equivalent user-content path does not create `@everyone`, role, or user mentions | Redacted payload/result and cleanup |  |  |
| TG-004 | Verification direct flow persists critical state before granting the role | Redacted verification record state and role state |  |  |
| TG-005 | Verification persistence failure rolls the role back and creates recovery evidence | Injected failure ID and recovery record hash |  |  |
| TG-006 | OAuth flow accepts a valid one-time state and rejects replay | First and replay result categories |  |  |
| TG-007 | Guild privacy policy off omits raw IP/token fields; policy on stores only the enabled fields | Policy settings and redacted field-presence report |  |  |
| TG-008 | Sensitive reveal requires authenticated POST+CSRF and creates an audit event | HTTP result categories and audit event code |  |  |
| TG-009 | Privacy deletion finishes and the collection manifest reports no remaining Guild references | Job ID hash and zero-reference report |  |  |
| TG-010 | DM outbox survives a deliberate Test DB outage and resumes in priority order without duplicates | Outage window and redacted delivery sequence |  |  |
| TG-011 | Backup/Restore handles a thread/unsupported channel and permission overwrites with accurate counters | Planner/result counters |  |  |
| TG-012 | Two simultaneous protection rules produce one punishment, one case, and one notification | Redacted case/notification identifiers |  |  |
| TG-013 | Dashboard cross-origin request and missing/invalid CSRF are rejected | HTTP status/category for each case |  |  |
| TG-014 | Dashboard logout and sensitive reveal are unavailable through GET | HTTP status/category |  |  |
| TG-015 | Protected session is revoked after credential/session version change | Before/after auth result categories |  |  |
| TG-016 | Protected trace approval cannot be double-claimed and uses the secure destination | Two concurrent result categories and audit code |  |  |
| TG-017 | Join Campaign is disabled by default and rejects a Guild outside the allow-list | Typed error codes |  |  |
| TG-018 | Fatal shutdown stops intake, completes bounded cleanup, exits non-zero, and restarts cleanly | Process exit/restart observations and readiness result |  |  |
| TG-019 | `/ping` remains live while `/health` or `/ready` reports dependency degradation | Endpoint status and redacted readiness fields |  |  |
| TG-020 | Preview `/health` and `/ready` report the exact recorded SHA and `preview: true` | Release identity object |  |  |

## Voice compatibility scenarios

The repository retains an explicit compatibility boundary for session lifecycle
code. Automated suites already prove owner mismatch, concurrent creation,
late-login cleanup, health recovery, and shutdown ordering. Do not automate a
normal Discord user account for this release record.

Use the official Test bot Voice transport from the Isolated Environment Gate to
confirm network reachability. Record the following:

| ID | Scenario | Required evidence | Result | Notes / redacted reference |
|---|---|---|---|---|
| TV-001 | Official Test bot connects muted/deafened to the Test Voice channel and disconnects | Gate artifact evidence |  |  |
| TV-002 | Automated Voice/session concurrency and recovery suite passed on the exact SHA | CI run ID and step result |  |  |
| TV-003 | No standard-user token was added to GitHub secrets, logs, artifacts, or the record | Secret inventory confirmation and Secret leak gate result |  |  |

## Cleanup verification

- Marker Discord message deleted: `<PASS/FAIL>`
- Test bot disconnected from Voice: `<PASS/FAIL>`
- Mongo gate marker deleted: `<PASS/FAIL>`
- Temporary verification/member records removed or retained only when the
  scenario explicitly requires recovery inspection: `<PASS/FAIL>`
- Temporary roles/channels/permission changes restored: `<PASS/FAIL>`
- Preview deployment stopped or retained according to the test policy:
  `<PASS/FAIL>`

## Final decision

- All required scenarios are `PASS`: `<yes/no>`
- Isolated Environment Gate artifact matches the exact current PR head:
  `<yes/no>`
- CI, coverage, audit, Secret guard, Snyk and CodeRabbit are successful:
  `<yes/no>`
- Sonar status: `<passed/degraded-and-explicit/failed>`
- Unresolved review threads: `<count>`
- Merge recommendation: `<READY/BLOCKED>`
- Blocking scenario IDs: `<none or IDs>`

The pull request may leave Draft state only when the recommendation is `READY`,
the PR head still equals the recorded SHA, and no required external or review
gate remains open.
