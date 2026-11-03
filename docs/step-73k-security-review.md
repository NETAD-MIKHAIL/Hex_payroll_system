# Step 73K: schedule, shift and leave synchronization review

Status: stopped at the user-required security gate. Step 73K is not implemented.

## Exact trust boundary blocker

`src/sync/router.ts` exposes push using the node bearer credential.
`src/sync/service.ts:pushEvents` authenticates that node, derives its organization,
and stores arbitrary non-protected entity payloads. It does not authenticate an
acting central user or check schedule/leave permissions. The Step 73J protected
entity list covers accounts and authorization tables, not schedules or leave.
Pull redistributes these payloads within the node's organization. Storage and a
sync receipt currently establish transport delivery only, not authorized evidence.

The local timekeeping router checks user permissions before schedule creation,
editing and assignment (`schedules.create`, `schedules.update`, `schedules.assign`),
leave configuration (`leave.configure`), requests (`leave.create`), and transitions
(`leave.approve`, `leave.reject`, `leave.cancel`). These local route checks do not
run during sync push. The schedule service additionally requires a reason for
backdated creation/assignment changes and for assignment corrections; it has no
separate backdating permission check.

An enrolled node can submit a `leave_requests` payload claiming approved status,
an existing approver UUID, dates, duration and a type snapshot. UUID existence,
organization checks, revision sequencing and replay checks cannot establish that
the approver authorized that event. Changing leave types to
`requiresApproval: false` also changes automatic approval behavior: the existing
request service creates approved leave immediately for those types. Schedule
version or assignment claims can likewise change expected work, lateness and
undertime without central schedule authorization.

Today the inbox scheduler does not dispatch these types. Adding the requested
handlers would turn unverified transport claims into calculation inputs:
`resolveShift` consumes schedule versions/days/assignments, and
`processAttendance` consumes every matching leave request whose status is approved.
The current central attendance authorization resolver handles calculate, adjust,
approve and reopen attendance actions only. It supplies neither a schedule/leave
authorization path nor a durable authorization binding to synchronized evidence.

## Inspected synchronization coverage and semantics

| Entity | Existing producer/storage | Missing receiver work |
| --- | --- | --- |
| work_schedules | Revisioned master outbox snapshots | Authorized provenance and inbox handler |
| work_schedule_versions | Immutable effective-dated versions; timezone snapshot and nested days in outbox | Authorized provenance, dependency retry and immutable replay |
| work_schedule_days | Immutable UUID rows per version and weekday | Producer currently embeds input day objects without persisted day UUIDs; preserve original IDs before implementing receiver |
| employee_schedule_assignments | Effective-dated revisions; closed preceding assignments published | Authorized provenance, non-overlap handling, dependency/revision retry |
| schedule_assignment_history | Append-only local revision snapshots | Define transport/receiver history preservation |
| leave_types | Revisioned outbox including paid and requiresApproval | Authorized configuration provenance and inbox handler |
| leave_requests | Revisioned outbox including status, duration, type snapshot and decision attribution | Authorized request/transition provenance and inbox handler |

There is no independent shift entity in this model: shifts are the weekday rows
of a schedule version. All seven weekdays are required. Shift and break day
offsets support overnight work; grace is in minutes. PostgreSQL resolves times
using the version's timezone. Assignment end dates are exclusive; leave end dates
are inclusive. Leave supports full day or first/second half; half-day requests
must start and end on the same date. Schedule versions/days and assignment history
have database mutation restrictions. Relevant shared migrations are 0007, 0009,
0012, 0013 and 0014.

Existing raw-punch and correction receivers/tests demonstrate isolated schema
fixtures, organization/dependency validation, immutable replay, conflict handling,
revision ordering, original attribution and no outbox/attendance side effects.
Those checks remain necessary but cannot prove schedule/leave authorization.
Reusing local schedule/leave services as inbox handlers would also publish outbox
events and enqueue attendance invalidation; receivers must avoid that behavior.

## Required prerequisite

Implement a trusted schedule/leave decision path before enabling materialization.
It must authenticate a central user independently of node enrollment, verify the
specific current permission and organization, and bind authorization to the exact
entity, revision, operation and content in the same transaction as the decision.
Approved leave, automatic approval configuration, cancellation, schedule assignment
and backdating all require appropriate checks. Offline changes can remain untrusted
proposals until authorized; central grants must not be imported from node claims.
Receiving PCs need a verifiable way to distinguish authorized central evidence
from arbitrary node snapshots, including historical events. Trusted central account
provisioning/distribution remains a separate pending prerequisite.

## Changes and verification

Changed file: this report only. No handlers, migrations or scheduler changes were
made; no new entity types are enabled. Step 73J restrictions remain unchanged.
No production databases, VPS, biometric hardware, canonical results, UI or payroll
were accessed or modified.

No TypeScript, lint, unit or PostgreSQL tests were run for this stopped review;
there are no executable changes or new integration tests. The 84/84 attendance
and 32/32 transport results are the previously verified baseline, not a new run.
The stop was caused by the trust boundary, not test environment availability.

Remaining work: resolve authorized schedule/leave evidence distribution, then
implement the receivers and isolated integration tests in Step 73K. Central
materialization/coverage, independent calculation validation and canonical acceptance,
proposal/result synchronization, desktop UI integration and office/WFH end-to-end
testing remain subsequent attendance work. Payroll remains postponed.
