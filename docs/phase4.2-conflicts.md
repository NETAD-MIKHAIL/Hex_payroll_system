# Phase 4.2 — conflict detection and resolution

Phase 4.2 extends the Phase 4.1 worker, PostgreSQL revision guards, SQL migration
runner, audit trail, shared Zod contracts, and React Sync module. Local business
operations remain independent of Internet availability. Central business
replication and confirmation remain Phase 4.3 work.

## Database and backend

Migrations `0034_conflict_resolution.sql` and
`0035_conflict_evidence_guards.sql` extend `sync_conflicts` rather than creating a
second conflict store. Existing incoming/current revisions and payloads remain
the evidence columns. New columns identify the category, base revision, local
outbox event, authority, concurrency version, resolution state, and update time.
Legacy `ignored` conflicts become `dismissed`; identity-reuse conflicts retain
the `EVENT_IDENTITY` category. Original IDs and timestamps survive migration.

`sync_conflict_resolutions` is an append-only request/history table with UUIDv7
primary keys, organization-scoped request deduplication and actor/conflict foreign
keys. Remote requests are durable `pending` entries. Conflict evidence has a
database update guard and bounded JSON columns; runtime roles cannot delete
conflicts or update/delete/truncate resolution history. Filter/history indexes
support tenant-scoped pagination. The outbox gains optional actor/dependency
metadata and `conflicted`, `rejected`, and `superseded` statuses.

`detectConflict` is a reusable pure policy function. It distinguishes revision
mismatches, duplicate identity, update/archive races, authorization changes,
invalid/missing references, temporary dependency delays, schedule overlaps,
incompatible leave decisions, immutable biometric evidence, and payroll conflicts.
Callers supply validated authoritative records and domain lookup facts; a policy
acceptance is not a database write or authorization grant.

The local API preserves conflict evidence after a failed domain transaction
rolls back. Only authenticated, recognized domain conflicts are captured;
network/database availability errors are not converted into data conflicts.
Repeated equivalent attempts against the same revision deduplicate by a stable
attempt identity. Missing or foreign targets are not disclosed. Local attempts
that never committed have no fabricated outbox event.

`persistConflict`, `resolveConflict`, list/detail services and the local capture
adapter keep business logic outside Express handlers. Employee profile,
department and position resolutions share the same transactional mutation helper
as ordinary foundation edits. Existing employee aggregate locks and atomic
`WHERE revision = expected` updates remain the concurrency authority.

## Domain policy and resolution matrix

| Domain                      | Protection                                                                                              | Available reconciliation                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Employee profile            | Revision and organization checks; sensitive-field permissions                                           | Explicit profile-field reapply or merge                     |
| Employment and compensation | Existing aggregate revision and effective-date controls                                                 | Use the employee employment workflow; no compensation merge |
| Departments and positions   | Duplicate codes, reference constraints, stale revisions                                                 | Explicit editable-field reapply or merge; status excluded   |
| Schedules                   | Existing overlap constraints, effective-date history and revision checks                                | Review/reject the attempt or use scheduling workflows       |
| Attendance and time records | Original evidence remains immutable; source identity deduplication; append-only corrections and history | Use correction/adjustment workflows                         |
| Leave                       | Existing transition guards plus incompatible-decision classification                                    | Use the leave workflow; no last-arrival decision            |
| Payroll                     | Existing frozen snapshots/SQL guards plus conflict evidence                                             | Escalation only in this phase                               |

Reapply and merge cover editable profile/master fields only. Employee number,
employment status/history, salary, payroll line items, and original biometric
evidence cannot be changed by a generic conflict resolution payload. A merge
validates an explicit subset of the existing domain input schema.

Local-authority resolutions use a locked conflict row, expected conflict version,
fresh permissions, domain validation and expected entity revision. Business
changes, audit, replacement publication, history and conflict closure commit
together. A stale entity update rolls everything back. Competing administrators
cannot both close a conflict, and an identical request ID returns its prior
result without applying twice. Original events are preserved rather than edited
or removed.

Local detail responses also expose the latest editable record/revision separately
from the immutable detection snapshot. Refreshing after a stale resolution lets
an administrator review current data before submitting a new revision check.

Remote-authority resolutions are requests, not confirmed changes. They do not
overwrite the local database from a cached remote snapshot, release dependent
events, or label an event synchronized. No production confirmation receiver or
resolution sender is implemented. Escalation records review while keeping the
conflict unresolved. Payroll conflicts cannot be closed through generic actions;
an approved correction/reversal workflow is still required.

## Worker and transport

The existing receipt-only HTTP protocol remains unchanged. Injectable transports
can additionally return a validated `outcomes` array containing accepted receipts
and typed conflicts. Every claimed event must have exactly one outcome. Duplicate
IDs/sequences, missing outcomes, invalid bounds and acceptance of a consumer of a
conflicted predecessor invalidate the whole response. Lease ownership is checked
before any outcomes commit. A validated data conflict is a verified transport
response, not a network failure.

Conflict insertion and the originating event's `conflicted` status commit in one
transaction. Repeated delivery responses reuse the same conflict. Unresolved
events are excluded from automatic retry and the administrator's failed-event
retry endpoint. Only durable delivery receipts create `synced` events.

Queue selection remains publication ordered within an organization. It may pass
a conflict only for proven-independent events. Dependency keys connect entity
identities, business codes, employee aggregates and referenced master records;
blocked consumer keys propagate to later consumers. Scheduling uses a conservative
shared dependency key. Payroll, account and unclassified/correction event shapes
remain organization barriers where full provenance is unavailable. Ordinary
network failures, deferred attempts and active leases retain FIFO blocking.
Selection scans a bounded prefix of 1,000 unsynchronized events per claim; a
larger blocked prefix may require resolution before later work becomes eligible.

## API, security and frontend

Session-authenticated routes:

- `GET /api/sync/conflicts`: paginated status/entity/category/date/device filters.
- `GET /api/sync/conflicts/:id`: permission-filtered evidence, allowed actions,
  blocking reason and resolution history.
- `POST /api/sync/conflicts/:id/resolve`: request ID, action, required reason,
  expected conflict version, and expected entity revision/merge fields when needed.

Legacy status-only closure requests are rejected. Backend permissions are
`sync.conflicts.view`, `sync.conflicts.resolve`, and `sync.conflicts.escalate`,
granted to administrators by migration. Applying edits also requires domain
permissions. Sensitive profile changes require sensitive view/update permissions.

Evidence uses an allowlisted root projection and recursively removes secrets.
Read responses additionally enforce domain visibility and sensitive-field
redaction, including nested employment versions. Legacy account-conflict password
verifiers are removed during migration. Conflict audit entries reuse the existing
audit table and never publish synchronization events.

`/sync/conflicts` provides filters, a conflict table, field comparisons, selectable
merge fields, confirmation, required reasons and history. Queries use the local
API even when the browser reports no Internet. Remote requests explicitly show
pending synchronization rather than confirmation. Sync Status and System Health
show open/resolved conflicts, pending/failed events and last sync attempt; a data
conflict does not change local database health.

## Verification and phase boundary

Automated coverage includes migration compatibility, revision policies, source
idempotency, sensitive redaction, atomic compare-and-swap, local resolution,
concurrent administrators, duplicate request IDs, pending remote resolutions,
payroll closure protection, mixed transport outcomes, lease loss, independent
queue progress, dependent blocking, organization isolation, permissions and
browser-offline conflict management.

Verification results are recorded in the implementation report after running
typecheck, lint, workspace tests, build, and development smoke checks. Database
tests use isolated schemas in `hexpayroll_test` and effective `hexpayroll_app`
runtime permissions. Test connection overrides are process-local; private `.env`
files are preserved.

### Implementation verification — October 16, 2026

| Check                       | Result                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------- |
| SQL migration runner        | Applied `0034` and `0035` locally; historical checksums preserved                     |
| `schema:pull`               | Regenerated Drizzle schema from the migrated database                                 |
| `pnpm typecheck`            | Passed across the workspace                                                           |
| `pnpm lint`                 | Passed                                                                                |
| `pnpm -r --if-present test` | Passed: 119 API, 42 payroll-engine, 12 browser tests; 173 total, no failures or skips |
| `pnpm build`                | Passed across the workspace, including Electron main/preload                          |
| Browser development mode    | Passed through Playwright against the Vite development server                         |
| Electron runtime automation | Timed out during a hidden-window launch; runtime smoke remains unverified             |
| `git diff --check`          | Passed                                                                                |

Both migrations were applied only through the repository runner, followed by
schema introspection. No production central endpoint was contacted, no transport
was enabled, and no deployment or packaging was performed. Temporary launchers
and verification logs were removed after validation.

| Status             | Work                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete           | Local conflict persistence, guarded resolution, typed policies, worker outcome handling, permissions/audit and management UI                                                            |
| Partial            | Electron runtime smoke remains unverified; dependency scheduling is conservative where full provenance is unavailable                                                                   |
| Foundation only    | Structured conflict transport adapter contract and durable remote resolution requests                                                                                                   |
| Requires Phase 4.3 | Versioned central provenance, actor mapping, domain business receivers, bootstrap/grouped transactions, central resolution delivery/confirmation and authoritative local reconciliation |
| Deferred           | Payroll correction/reversal and generic merges outside the explicitly supported master/profile fields                                                                                   |
