# Local attendance proposal persistence (Step 73F)

This is an unconnected local repository/service foundation. No route, worker,
calculation, ingestion service, synchronization dispatcher or central API invokes
it. It does not make attendance canonical or implement payroll rules.

## Storage and identity

Shared migration `0033_local_attendance_proposals.sql` adds
`local_attendance_proposals`. It is local-compatible and creates no central-only
tables. All previous migrations remain unchanged.

`proposal_id` defaults to PostgreSQL 18 `uuidv7()` and is also the permanent future
request identity. A caller that needs create retries must retain the returned ID,
or obtain a UUIDv7 before the first call and pass it on every retry. No new ID is
allocated when retrying an uncertain submission. Attempt tokens identify local
attempts only; they must never replace the proposal ID in a future submission.

Organization, employee, work date, author, proposal ID and creation time never
change. Composite foreign keys scope employee and author to the organization;
the service and trigger also require the enrolled local organization. Canonical
attendance UUIDs in future decisions are metadata, without a foreign key to
`attendance_records`: that accepted record might not have arrived locally yet.

Content consists of action, expected canonical revision, JSONB payload, and an
optional SHA-256 evidence/version fingerprint (required for calculate). Revision
zero means create-only; adjust/approve/reopen require a positive base revision.
The fingerprint is supplied and stored, not computed or verified in this step.

Version-one action payloads are deliberately narrow:

- `calculate`: firstIn/lastOut (nullable ISO instants), worked/late/undertime
  integer minutes, attendanceStatus, complete, and flags. This stores a result
  summary; it does not calculate it or certify completeness.
- `adjust`: reason and a nonempty overrides object for minute totals/status,
  matching the existing attendance adjustment fields.
- `approve`: nullable reason. This is a proposal to approve, not approval itself.
- `reopen`: required reason.

Extra fields are rejected. No salary, allowance, deduction or net-pay fields are
part of these payloads. The JSONB storage limit is 256 KiB; structured errors and
decision reasons are bounded to 16 KiB.

## Service boundary

`createLocalAttendanceProposalService(pool)` exposes:

- `createDraft(identity, {proposalId?, employeeId, workDate, content})`
- `read(identity, proposalId)` and `list(identity, {employeeId?, status?, limit?, offset?})`
- `editDraft(identity, proposalId, expectedLocalRevision, content)`
- `queue(identity, proposalId, expectedLocalRevision)`
- `beginAttempt(identity, proposalId, expectedLocalRevision)`
- `recordAttemptOutcome(identity, proposalId, expectedLocalRevision, attemptId, outcome, error)`
- `recordDecision(identity, proposalId, expectedLocalRevision, attemptId, decision)`

Identity is the existing authenticated actor's user ID and organization ID.
Callers must eventually pass a server-authenticated identity, not a request-body
user ID. Permissions are reloaded from local users/roles; caller permission arrays
are ignored. Creation derives the author from that user. Reads require
`attendance.view`; calculate/reopen require `attendance.manage`, adjust requires
`attendance.adjust`, and approve requires `attendance.approve`. For now only the
original author can mutate a proposal; cross-user submission/recovery is future
work. This is intentionally narrower than a future conflict-review workflow.

All operations use local transactions. Mutations lock the proposal row and check
its local revision. Creation also locks the UUID through a transaction advisory
lock. JSONB equality makes object-key ordering irrelevant to idempotent create.
The same UUID with altered stored content/identity fails. After an explicit
draft edit, retrying an old create body is a content conflict.

## Lifecycle

| From                            | Operation                                            | To                               |
| ------------------------------- | ---------------------------------------------------- | -------------------------------- |
| draft                           | edit with expected local revision                    | draft                            |
| draft                           | queue, freezing content                              | pending                          |
| pending (no attempt yet)        | beginAttempt                                         | pending, new token/count         |
| pending (attempt active)        | record timeout/unknown result                        | uncertain                        |
| pending (attempt active)        | record known temporary failure                       | retryable                        |
| uncertain or retryable          | beginAttempt with unchanged request/content          | pending, new token/count         |
| pending, uncertain or retryable | record explicit central decision for current attempt | accepted, conflicted or rejected |

Queuing does not submit anything. Once queued, content stays frozen even if no
network call has happened. Every mutation increments `local_revision`; it is
distinct from the expected canonical revision. An active pending attempt must be
marked uncertain/retryable before another attempt starts (including after crash
recovery). No automatic recovery worker is added here.

Decisions record request/decision UUIDs, structured reason, server timestamp,
canonical UUID, and accepted/current revision where supplied. Acceptance requires
the next revision after the proposal base. Terminal decisions cannot be changed.
An exact decision replay returns the existing row without incrementing revision.
Old attempt tokens, stale local revisions, changed decisions and late timeout
responses cannot overwrite the terminal result. A resolution must become a new
proposal; originals remain preserved. DELETE/TRUNCATE is revoked for the runtime
role. Database triggers additionally enforce frozen identities/content and legal
lifecycle transitions against direct DML.

`recordDecision` is a future internal central-response persistence adapter. Its
input is structurally validated, but it cannot authenticate a central server by
itself. It is NOT exposed as a user endpoint. Before any UI/transport integration,
authenticate the user/device and central response, enforce central canonical
revision rules, and distinguish transport delivery from canonical acceptance.
Neither queueing, a successful network request nor recording this metadata
updates the existing canonical attendance tables.

## Verification

No migration is executed by this implementation step. The ten new PostgreSQL
tests use the existing guarded `hexpayroll_test` fixture and random schemas.

In the PowerShell session with both isolated test connection variables:

```powershell
cd D:\hexpayrollsys
pnpm --filter @hexpayroll/api exec tsx --test test/local-attendance-proposals-database.test.ts
```

Target: 10 passed, 0 failed, 0 skipped. To include the previously verified 54-test
baseline:

```powershell
pnpm --filter @hexpayroll/api exec tsx --test `
  test/local-attendance-proposals-database.test.ts `
  test/central-migration-isolation-database.test.ts `
  test/inbox-database.test.ts `
  test/organization-inbox-database.test.ts `
  test/department-inbox-database.test.ts `
  test/position-inbox-database.test.ts `
  test/employee-inbox-database.test.ts `
  test/biometric-device-inbox-database.test.ts `
  test/biometric-mapping-inbox-database.test.ts `
  test/time-record-inbox-database.test.ts `
  test/time-record-ingestion-concurrency-database.test.ts `
  test/time-record-correction-inbox-database.test.ts
```

Target: 64 passed, 0 failed, 0 skipped. These are targets, not claimed results.
No production database, VPS or physical biometric hardware is part of testing.
