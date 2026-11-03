# Central canonical attendance storage (Step 73G)

This is storage only. No submission endpoint, acceptance service, calculation,
worker, UI, sync push/pull path, local proposal dispatcher or payroll rule is
introduced or changed. No migration is run by adding these files.

## Prerequisites and isolation

`database/central-migrations/0001_canonical_attendance_storage.sql` is discovered
only by the explicit central migration path. Shared migrations are unchanged.
`migrateCentral` requires central mode, an explicit matching database target and
the complete current shared migration ledger. Independent central history retains
checksum, ordering, replay and rollback checks.

The actual shared schema has organization-scoped unique employee, user and sync
node keys. This migration references those keys; it does not invent identities
or reference local proposal IDs as foreign keys. A central organization/user/
employee/node MUST actually exist before the corresponding storage write can
commit. Rows merely present in `sync_changes` do not satisfy these references.
Materializing and validating remote identities is future work before submissions
are enabled. Existence is not proof of current user authorization or node activity.

All four new tables revoke runtime INSERT/UPDATE/DELETE/TRUNCATE privileges from
`hexpayroll_app`, notwithstanding shared default grants. Runtime access is SELECT
only; no existing endpoint queries these tables. PUBLIC receives no table access.
The tests seed explicit storage transactions through the schema-owner connection.
There is no privileged repository helper exposed to the running application.

Future runtime write access requires a separately reviewed authenticated boundary.
The schema's foreign keys prevent cross-organization references; they are not a
substitute for scoped read queries, active-session validation or action permissions.

## Tables

### `central_attendance_requests`

One immutable business request per global proposal UUIDv7. It stores organization,
employee, date, action, original author, first submitter/node, expected revision,
the complete bounded proposed JSONB payload, optional evidence fingerprint and
server receipt time. Calculation requests require an evidence fingerprint;
adjust/approve/reopen require a positive expected revision.

An INSERT trigger computes a SHA-256 request fingerprint over the proposal UUID,
organization, employee, date, action, author, expected revision, JSONB payload and
evidence fingerprint. First submitter/node and receipt time are excluded from the
business digest so a future retry from another authorized device can match the
same request. The stored first-submission identities remain immutable. This
PostgreSQL JSONB digest is a storage format, not a published cross-language wire
canonicalization algorithm or evidence-validation mechanism.

Reusing the proposal UUID is a uniqueness violation even with identical content.
A future submission service must read the stored request, compare immutable
content/fingerprint and return its prior decision for a matching replay. It must
reject altered content. No such submission service is added here.

### `central_attendance_decisions`

An append-only observation/decision ledger. Each UUIDv7 decision references the
request's exact organization, employee, date, action and expected revision. It
also records structured reason `{code, message, details}`, acting submitter,
source node, canonical UUID when known, resulting/current revision and server
decision time. The request preserves the original author independently of actors.

| Category           | Meaning                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| accepted           | Explicit canonical acceptance, resulting revision = expected + 1                          |
| duplicate_accepted | Replay observation pointing to the original accepted decision for this request and result |
| conflict           | Terminal competing proposal, retained for review                                          |
| rejected           | Terminal rejection, retained for review                                                   |
| retryable          | Nonterminal observation; no canonical acceptance                                          |

A partial unique index permits only one terminal accepted/conflict/rejected
decision per proposal. Retryable observations do not consume that disposition.
Append-only observations must not be interpreted as "latest row wins": future
read/submission code must consult the terminal disposition. Late transport errors
can be retained as observations without undoing a terminal acceptance. A conflict
or rejection must be resolved with a new proposal UUID, not by rewriting history.

A duplicate acceptance must reference a real accepted decision for the same
organization, proposal, canonical UUID and resulting revision. Its observed
current revision can be newer than the original accepted revision. It does not
advance state or create another acceptance-history entry.

Local status mappings are future protocol work: central `conflict` corresponds to
local `conflicted`; `duplicate_accepted` returns the original acceptance, rather
than creating a new local canonical revision. Transport receipts remain separate.

### `central_attendance_state`

One stable canonical attendance UUIDv7 per `(organization_id, employee_id,
work_date)`. Typed timestamps, minutes, attendance/approval statuses, approver,
accepted evidence fingerprint, processor version and result JSONB preserve the
accepted state. The latest proposal/decision and acting user are retained.
Approver references are organization-scoped and approval requires both approver
and approval time. Non-approved state cannot retain approval metadata.

An initial state must be revision 1 from an explicit create-only calculation
decision. Identity/date/creation time cannot change, revisions advance exactly
once and each write must name a preinserted matching accepted decision for the
correct old/new revision. Normal row locking and unique indexes protect concurrent
storage transactions. Higher revisions are not automatically accepted from clients.

The storage layer does not check calculation correctness, synchronized evidence
completeness or whether an authorized reopen is necessary. Those checks belong in
the future acceptance transaction before inserting an accepted decision. No active
runtime writer exists, so this step cannot silently replace approved attendance
through an application endpoint.

### `central_attendance_acceptance_history`

Generated only by an explicit canonical state INSERT/UPDATE. Each append records
proposal, accepted decision, actor, action, contiguous old/new revision and full
old/new state snapshots. The immutable decision link retains structured decision
metadata; it is not copied into mutable history fields. First creation has a null
old state and revision zero. Unique decision and canonical/revision keys prevent
duplicate acceptance records.

Deferred foreign keys link accepted decisions, state and history. An accepted
decision cannot commit without its matching history, and state cannot commit
without its matching accepted decision. Thus fixtures/future writers use this
transaction order:

1. Persist the immutable request if it is new.
2. Explicitly insert the accepted decision after future authorization/validation.
3. Insert/update canonical state (which automatically appends history).
4. Commit all linked writes together.

The history trigger audits writes; it does not evaluate or accept proposals.
Failed writes roll back their decision/history/state transaction. Historical
decisions remain valid when later state revisions are accepted. UPDATE/DELETE/
TRUNCATE on requests, decisions and history is rejected by triggers as well as
runtime privileges. Canonical identity removal is also guarded.

## PostgreSQL verification

Eight isolated tests use the existing guarded `hexpayroll_test` fixture. They
check central-only installation and replay, read-only runtime privileges, stable
identity, concurrent create uniqueness, revision/approval constraints, request-ID
reuse and fingerprints, decision immutability, preserved conflict/rejected bodies,
retryable/duplicate-accepted distinctions, cross-organization references, automatic
append-only snapshots, and rollback of incomplete acceptance transactions.

In the PowerShell session with both isolated test connection variables configured:

```powershell
cd D:\hexpayrollsys
pnpm --filter @hexpayroll/api exec tsx --test test/central-attendance-storage-database.test.ts
```

Target: 8 passed, 0 failed, 0 skipped. Combined with the verified 64-test baseline:

```powershell
pnpm --filter @hexpayroll/api exec tsx --test `
  test/central-attendance-storage-database.test.ts `
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

Target: 72 passed, 0 failed, 0 skipped, excluding the separate validation unit tests.
These are verification targets, not claimed results. No test connects to
`payroll_sys`, `payroll_central` or the VPS. Do not run the production central
migration CLI for these tests; the fixture installs only into its random test schema.

The smallest next step is to run these storage tests and the baseline regression.
Before any submission endpoint, separately design central identity provisioning,
user/device authorization, evidence validation, idempotent canonical revision
acceptance and structured per-proposal responses. No write grants should be
enabled merely because storage tests pass.
