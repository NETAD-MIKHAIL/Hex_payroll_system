# Step 73K-A: trusted central evidence authorization

Internal entry point:
`createCentralEvidenceDecisionService(centralPool, 'central')(credentials, request)`.
The pool and mode are server configuration. There is no new HTTP endpoint.

This records an authorization observation only. It does not accept a schedule,
approve a leave row, allocate a canonical attendance revision, enqueue processing,
or publish sync events. Authorization records must never be read as accepted evidence.

## Actions and existing permissions

| Action                                | Entity / revision unit                                                         | Required permission |
| ------------------------------------- | ------------------------------------------------------------------------------ | ------------------- |
| schedule.create                       | work_schedules; initial immutable version and weekday rules bundled in payload | schedules.create    |
| schedule.update                       | work_schedules; new immutable version and weekday rules bundled in payload     | schedules.update    |
| schedule.status                       | work_schedules                                                                 | schedules.update    |
| assignment.create / assignment.update | employee_schedule_assignments                                                  | schedules.assign    |
| leaveType.create / leaveType.update   | leave_types, including automatic approval configuration                        | leave.configure     |
| leave.request                         | leave_requests                                                                 | leave.create        |
| leave.approve                         | leave_requests                                                                 | leave.approve       |
| leave.reject                          | leave_requests                                                                 | leave.reject        |
| leave.cancel                          | leave_requests                                                                 | leave.cancel        |

All permissions already exist in shared migration 0011; no grants are added.
There is no separate shift table or backdating permission. Shift changes are new
immutable work_schedule_versions/days under a revisioned schedule master.
The later acceptance path must preserve this aggregate boundary and enforce reasons
for backdating and assignment corrections, as existing local services do.

## Request and revision model

The strict request has exactly `version: 1`, `requestId` (UUID), `organizationId`,
`entityId`, `action`, `expectedRevision`, and `payload`. Client actor, role, approval
attribution and permission claims are not accepted. Credentials are exactly
`{ nodeToken, sessionToken }`; the acting user is derived from the central session.

Create actions require expectedRevision zero and no existing target row. Update,
status and leave transition actions require the current positive target revision.
The service checks target organization and revision under a shared row lock, with
advisory serialization for absent identities. The revision range leaves space for
the next PostgreSQL integer revision. Parent/master revisions bind schedule version
additions; version rows themselves remain immutable at revision one.

Payloads reuse existing strict shared input schemas. The outer expectedRevision
replaces the nested UI expectedRevision. Assignment payloads additionally identify
employeeId. Schedule create/update payloads additionally bind versionId and timezone.
All defaults must be explicit and strings already normalized: schema parsing may
validate but may not silently alter the content being authorized. Maximum payload
size is 256 KiB. Full/half-day durations, weekday rules, overnight offsets and breaks
retain existing schema validation.

V1 canonicalization recursively sorts object keys by JavaScript string ordering,
uses JSON scalar encoding and preserves array order. It performs no date/timezone,
Unicode or numeric-string coercion. Therefore changing a weekday array order or
timezone string changes the binding even if an application considers them equivalent.
The stored canonical request and SHA-256 fingerprint include every request field,
including organization, entity, action, expected revision and request UUID.

## Authentication, storage and concurrency

Both this service and the existing attendance resolver reuse the same transaction
helper for central node/session verification. It locks setup, the enabled non-revoked
node and current token hash, active user, unexpired central session, and actual
organization-eligible role/permission grants. Locks remain held until the decision
transaction commits. Session expiry uses database wall time and is checked again
after request/entity lock waits and persistence. Missing or revoked authority fails
before a decision can commit. No credentials or hashes are written to decision rows.

Central migration 0002 adds `central_evidence_authorizations` independently of desktop
migrations. Rows contain a server decision UUID and timestamp, globally unique request
UUID, exact binding/fingerprint, organization, entity/type, action, expected revision,
session-derived actor, authenticated node and checked permission. Organization-scoped
foreign keys bind actor and node. SQL constraints enforce action/permission/entity
mapping, revision shape, request metadata and fingerprint consistency. Update, delete
and truncate are denied, including mutation guards for the migrator. The runtime gets
SELECT/INSERT only; its database credential remains a trusted server credential,
not a client capability. No canonical attendance write grants are changed.

An advisory request lock and unique key serialize concurrent retries. An exact retry
by the same current user and node returns the same immutable record after checking
current credentials and permissions. Different content or another actor/node under
that request UUID conflicts. Replay returns a historical authorization record; it
does not assert that the entity still has that revision. Separate request UUIDs may
authorize competing proposals at one revision; only later acceptance can choose a
winner through revision comparison and atomic materialization.

## Generic sync boundary

Step 73J account/session/role restrictions remain. Generic node push additionally
rejects schedule masters, versions, days, assignments/history, leave types/requests
and authorization records with SYNC_CENTRAL_AUTHORITY_REQUIRED. Mixed batches roll
back. Pull quarantines historical events of those types as well. The existing
protected-entity regression exercises every blocked type and operation.

Existing local outbox entries for these entities remain pending and can block mixed
batches. This step does not delete them, mark them delivered, or introduce trusted
distribution. Already downloaded historical events require review before future
receivers are enabled. Local account inbox projection must remain local; peer grants
cannot provision central user/session authority. Central user provisioning and remote
central login/session UX remain pending.

## Required next acceptance transaction

1. Authenticate node and central user again, lock the current permission grants and
   exact stored request, and verify the binding, actor/node policy and payload hash.
2. Lock target and dependencies, compare current expected revision, validate effective
   dates, timezone, organization-scoped references, leave state transitions, automatic
   approval policy and overlaps. Authorization is not a substitute for those checks.
3. Materialize the exact authorized content and append an immutable accepted decision
   in the same transaction. Preserve original UUIDs/history; define persisted weekday
   UUIDs in the accepted snapshot (current local producers omit those IDs). Competing
   proposals must not both consume one expected revision.
4. Publish a separate trusted central evidence event atomically with acceptance.
   Receivers must verify central provenance, not a generic node-supplied approval flag
   or authorization row. Never reuse generic local services that echo outbox entries
   or invalidate accepted canonical attendance as a side effect.

No acceptance, trusted distribution, inbox handlers, workers, UI or payroll changes
are included here. No missing permission or revision incompatibility blocks this
authorization foundation; semantic acceptance and distribution remain required work.

## Verification commands

Run from `D:\hexpayrollsys`. The env file must provide both dedicated test URLs for
`hexpayroll_test`; the fixture enforces the database name and creates/drops only
random isolated schemas. No production migration was executed.

```powershell
pnpm --filter @hexpayroll/api typecheck
pnpm exec eslint apps/api/src/timekeeping/central-attendance-authorization.ts apps/api/src/timekeeping/central-evidence-decisions.ts apps/api/src/sync/service.ts apps/api/test/central-evidence-decisions.test.ts apps/api/test/central-evidence-decisions-database.test.ts apps/api/test/central-account-sync-database.test.ts
node --env-file=apps/api/.env.test --import ./apps/api/node_modules/tsx/dist/loader.mjs --test apps/api/test/central-evidence-decisions.test.ts apps/api/test/central-evidence-decisions-database.test.ts apps/api/test/central-attendance-authorization.test.ts
```

## Implementation report (2026-10-24)

The combined regression passed **106/106**, with zero failures and zero skips:
100 PostgreSQL tests and six database-free unit tests. This includes all original
84 attendance PostgreSQL tests, seven new evidence-decision PostgreSQL tests, nine
transport tests, and the complete overlapping 32-test targeted transport baseline.
New database tests cover all eleven action permissions, immutable audit bindings,
revoked credentials/grants, cross-organization and forged identity claims, exact
revision checks, altered request identities, concurrent retries/conflicts and a
real PostgreSQL wait for concurrent permission revocation. Existing central identity
tests also reverify expiry and concurrent session/node revocation through the reused
helper. API TypeScript, separate strict checking of new tests, ESLint for all changed
TypeScript files, and formatting checks passed.

The first test attempt was blocked by sandbox `spawn EPERM`; an authorized run
outside the sandbox exposed a refined-schema construction error, which was fixed
before the successful full run. All database activity used isolated test schemas.

Changed files:

- `apps/api/src/timekeeping/central-attendance-authorization.ts`: extracted shared
  in-transaction identity/permission verification; retained the existing resolver API.
- `apps/api/src/timekeeping/central-evidence-decisions.ts`: new internal service,
  action mapping, payload validation, canonicalization, revision and replay checks.
- `database/central-migrations/0002_evidence_authorizations.sql`: append-only
  central authorization storage and constraints.
- `apps/api/src/sync/service.ts`: protected evidence/authorization transport boundary.
- `apps/api/test/central-account-sync-database.test.ts`: expanded protected-entity
  push coverage to schedule/leave/authorization types.
- `apps/api/test/central-evidence-decisions.test.ts`: three new unit tests.
- `apps/api/test/central-evidence-decisions-database.test.ts`: seven new integration tests.
- `docs/central-evidence-authorization.md`: model, constraints, limitations and next step.

No public endpoint, evidence receiver, local worker, UI, canonical attendance writer,
production database/VPS migration, hardware integration or payroll behavior changed.
