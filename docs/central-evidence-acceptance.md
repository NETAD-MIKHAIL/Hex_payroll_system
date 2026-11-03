# Step 73K-B resumed: atomic evidence acceptance

Status: **verified on 2026-10-24**. The complete existing API regression, including
all PostgreSQL tests and eight formerly blocked restricted-writer tests, passed:
**201 passed, 0 failed, 0 skipped**. The dedicated test writer was provisioned and
configured locally by the user. The agent ran no administrator provisioning script
or production migration. See [the full verification report](step-73kb-verification.md).

## Internal service and atomicity

`createCentralEvidenceAcceptanceService(writerPool, 'central')` takes strict
`{ nodeToken, sessionToken }` credentials and
`{ authorizationDecisionId, request }`. The request is the exact Step 73K-A request.
No endpoint, default pool fallback, UI, worker or receiver is added.

The service rejects ordinary hexpayroll_app and migration-owner connections. It
requires the dedicated evidence writer, rejects elevated attributes, memberships,
schema/database ownership or DDL privileges, password-verifier access, broad
authority writes, generic transport writes and canonical attendance writes.

Inside one transaction it reuses current central node/session/user/grant locking,
serializes the organization using the existing evidence source lock (namespace 731),
locks the request and target, compares every authorization binding/fingerprint and
actor/node, checks the current target revision, validates dependencies and business
semantics, and writes evidence. It then inserts central_evidence_acceptances with
the before/after audit snapshot and publishes through publishTrustedEvidence using
the same client. A final database wall-clock session expiry check precedes commit.
Any failure rolls back the evidence, history, acceptance and publication together.

An exact retry reauthenticates and returns the original acceptance/event even if
the aggregate has since advanced. Altered content cannot reuse an authorization.
Competing requests for one expected revision serialize and only one can advance it.
The existing immutable authorization is never itself considered an acceptance.

## Supported actions and semantics

All eleven existing actions and permission mappings are implemented:

| Actions                                     | Behavior                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| schedule.create / schedule.update           | Stable master UUID; immutable new version and seven weekday rows; strictly advancing effective date                  |
| schedule.status                             | Revisioned master status change with complete version history in accepted snapshot                                   |
| assignment.create / assignment.update       | Active schedule, applicable version, scoped employee and non-overlapping date range; immutable history on correction |
| leaveType.create / leaveType.update         | Revisioned leave configuration, including paid/approval policy                                                       |
| leave.request                               | Scoped employee/type, active type, request-time type snapshot, pending or policy-driven automatic approval           |
| leave.approve / leave.reject / leave.cancel | Existing permitted transitions, attribution from central session, rejection remarks required                         |

Backdated schedule/assignment changes require reasons; assignment corrections
always require a reason. Assignment employee identity cannot change. Overlap is
rejected without implicitly closing another assignment or incrementing an unbound
employee revision. Close an old assignment through its separately authorized update
before authorizing a new non-overlapping assignment.

Schedule timezone must equal the current locked organization timezone and exist in
pg_timezone_names. Existing immutable versions retain their original timezone.
Weekdays, grace minutes, overnight offsets and break bounds reuse shared validation.
Day UUIDs are deterministic UUIDv8 values: SHA-256 UTF-8 of
`hexpayroll:schedule-day:v1:<lowercase version UUID>:<weekday 0..6>`, first 16 bytes,
with version nibble 8 and RFC variant bits set. The namespace/version rule is stable.
Snapshots contain all version/day identities, metadata and assignment history.

Leave type snapshots are derived from the locked current type at acceptance, matching
existing local behavior. Automatic approval requires current requiresApproval=false;
the current leave.create permission suffices under that configured policy. Explicit
approval always needs leave.approve. Subsequent type edits do not rewrite request
snapshots. Approved leave may be cancelled; approval/rejection are pending-only.
Full/half-day duration constraints and overlap checks remain enforced by schemas
and database integrity triggers. Accepted snapshots exceeding the v2 size limit
cause transaction rollback.

No local mutation services are reused: there is no outbox echo, processing job,
attendance invalidation, canonical attendance write or payroll calculation.

## Restricted writer and complete grant manifest

Production's reserved role name is hexpayroll_evidence_writer. This change creates
no production role or credential and does not configure a production connection.
The test-only role is **hexpayroll_acceptance_test_writer**, accepted by the service
only when current_database() is hexpayroll_test. Neither role is granted to
hexpayroll_app, desktop or generic sync credentials.

Central-only migration 0004 adds lock-only dependency guards. PostgreSQL requires
UPDATE permission on a column to take FOR SHARE/UPDATE locks. The writer therefore
gets narrow identity-column UPDATE grants on read-only dependencies; guards reject
actual changes by either reserved writer role. Immutable central records retain
their existing mutation guards as well. No SECURITY DEFINER function is used.

After shared/central migrations, the schema owner explicitly calls
`provisionCentralEvidenceWriter(ownerPool, 'hexpayroll_test')` for the current random
test schema. The helper never creates roles or runs from acceptance/HTTP/migrations.
It checks the explicit database, safe existing role and central migration 0004 before
granting this fixed capability set:

| Objects                                                                    | Exact privileges                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current isolated schema                                                    | USAGE; never CREATE or ownership                                                                                                                                                                                                                       |
| application_setup                                                          | SELECT(singleton), UPDATE(singleton) for locking only                                                                                                                                                                                                  |
| organizations                                                              | SELECT(id,timezone), UPDATE(id) for locking only                                                                                                                                                                                                       |
| employees                                                                  | SELECT(id,organization_id), UPDATE(id) for locking only                                                                                                                                                                                                |
| sync_nodes                                                                 | SELECT(id,organization_id,token_hash,enabled,revoked_at), UPDATE(id) for locking only                                                                                                                                                                  |
| auth_users                                                                 | SELECT(id,organization_id,active), UPDATE(id) for locking only; no password_hash access                                                                                                                                                                |
| auth_sessions                                                              | SELECT(token_hash,user_id,expires_at), UPDATE(token_hash) for locking only                                                                                                                                                                             |
| roles                                                                      | SELECT(id,organization_id,system), UPDATE(id) for locking only                                                                                                                                                                                         |
| user_roles                                                                 | SELECT(user_id,role_id), UPDATE(user_id) for locking only                                                                                                                                                                                              |
| role_permissions                                                           | SELECT(role_id,permission_code), UPDATE(role_id) for locking only                                                                                                                                                                                      |
| permissions                                                                | SELECT(code), UPDATE(code) for locking only                                                                                                                                                                                                            |
| work_schedules, employee_schedule_assignments, leave_types, leave_requests | SELECT, INSERT, UPDATE                                                                                                                                                                                                                                 |
| work_schedule_versions, work_schedule_days                                 | SELECT, INSERT, UPDATE(id) for locking only                                                                                                                                                                                                            |
| schedule_assignment_history                                                | SELECT, INSERT                                                                                                                                                                                                                                         |
| central_evidence_authorizations                                            | SELECT, UPDATE(decision_id) for locking only; no INSERT                                                                                                                                                                                                |
| central_evidence_acceptances                                               | SELECT, INSERT, UPDATE(acceptance_id) for locking only                                                                                                                                                                                                 |
| central_evidence_events                                                    | SELECT, INSERT                                                                                                                                                                                                                                         |
| central_evidence_events_sequence_seq                                       | USAGE, SELECT                                                                                                                                                                                                                                          |
| Required trigger functions                                                 | Explicit EXECUTE on hex_evidence_writer_lock_only, hex_validate_evidence_acceptance_contract, hex_trusted_evidence_sequence, hex_central_attendance_append_only, hex_payroll_source_lock, hex_validate_schedule_assignment, hex_validate_leave_overlap |

The acceptance row's immutable audit_snapshot is the audit storage; the writer does
not need audit_events or its sequence. UUID defaults use PostgreSQL's built-in uuidv7.
No DML grants on canonical attendance tables, generic sync_changes/outbox/inbox,
credentials/grants, biometric or payroll tables are made. No DELETE, TRUNCATE,
REFERENCES, TRIGGER, ownership, membership or broad PUBLIC grant is added.
The executable exact GRANT statements are in central-evidence-writer.ts.

## Manual test provisioning for review

Exact SQL script: **database/test/provision-acceptance-writer.sql**. Read that file
for the complete SQL. It is idempotent for a safely configured existing role, aborts
outside hexpayroll_test or for unsafe role attributes/memberships, grants CONNECT
only to hexpayroll_test, and sets the role's default search_path to pg_catalog.
It never grants CREATEROLE to the migrator and contains no password.

Administrator execution command, supplied for review only (not executed):

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" `
  -h 127.0.0.1 `
  -p 5432 `
  -U postgres `
  -d hexpayroll_test `
  -v ON_ERROR_STOP=1 `
  -f "D:\hexpayrollsys\database\test\provision-acceptance-writer.sql"
```

After approval/provisioning, set the dedicated password locally using psql's
interactive `\password hexpayroll_acceptance_test_writer`. Do not share an admin
password or put passwords into commands/logs/Git. Set the separate URL in untracked
apps/api/.env.test:

```dotenv
TEST_ACCEPTANCE_WRITER_DATABASE_URL=postgresql://hexpayroll_acceptance_test_writer:YOUR_URL_ENCODED_SECRET@127.0.0.1:5432/hexpayroll_test
```

PostgreSQL roles are cluster-wide and SQL has no DENY overriding PUBLIC CONNECT.
The script makes no grants to other databases, but cannot negate existing PUBLIC
CONNECT elsewhere. For a hard connection restriction, the script includes reviewed
pg_hba.conf examples allowing only loopback hexpayroll_test connections for this role
and rejecting its other connections. No global PUBLIC privilege changes are made.
The acceptance service additionally rejects this test role outside hexpayroll_test.

Fixtures require both existing dedicated test URLs plus the new writer URL, validate
same host/port/database and exact test username, create a random isolated schema as
the existing migrator, apply migrations there, and apply the fixed per-schema grants
as its owner. Writer connections explicitly select that isolated schema. Missing URL
means eight blocked tests; configured but missing/unsafe/underprivileged credentials
fail closed. No test runs the administrator role-creation script.

Cleanup: fixtures close writer connections and drop only their own random schemas,
which also removes schema/object ACL dependencies. They do not drop cluster roles.
To retire the test writer, stop its test connections, review any leftover isolated
schemas, and clean only the individually verified test schema names. Then an admin
connected to hexpayroll_test can revoke CONNECT and DROP ROLE. DROP ROLE failing on
remaining dependencies is a review signal; do not use a blanket DROP OWNED or touch
production databases/roles. Remove the test URL and any dedicated pg_hba rules.

## Verification and files

New implementation files: central-evidence-acceptance.ts, central-evidence-writer.ts,
central migration 0004, the manual SQL script, acceptance unit/database tests and
their fixture. apps/api/.env.example documents the new untracked configuration.
This report records the model and provisioning procedure.

Run from D:\hexpayrollsys after provisioning:

```powershell
pnpm --filter @hexpayroll/shared build
pnpm --filter @hexpayroll/api typecheck
node --env-file=apps/api/.env.test --import ./apps/api/node_modules/tsx/dist/loader.mjs --test apps/api/test/central-evidence-acceptance.test.ts apps/api/test/central-evidence-acceptance-database.test.ts
```

Final complete regression: **201 passed, 0 failed, 0 skipped**, including the
original 115-test baseline and every restricted-writer acceptance test. This run
also covers the older authentication, foundation, timekeeping and existing payroll
regressions omitted from the narrower baseline. Shared build, API TypeScript,
strict acceptance-test TypeScript, ESLint and formatting passed.

All eleven actions now have verified committed acceptance under the dedicated test
writer, with immutable audit snapshots and exactly one v2 event. Revocation, CAS
conflicts, replay, overlap, scoped references, policy and rollback tests passed.
No production role/database, VPS service, hardware, worker, receiver, UI or payroll
implementation was changed. The [next integrated stage](trusted-evidence-local-integration-plan.md)
is prepared: local v2 pull and business application, with central authority intact.
