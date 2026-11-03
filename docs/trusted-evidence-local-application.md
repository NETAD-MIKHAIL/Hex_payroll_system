# Step 73L: trusted evidence delivery and local application

Follow-up: [Step 73M](trusted-identities-and-reconciliation.md) implements the
credential-free trusted actor distribution and authenticated local reconciliation
paths identified below. Incompatible immutable histories and different competing
local UUIDs remain explicit blockers; the worker remains off by default.

The receiver applies centrally accepted schedules, assignments, leave types and
leave requests. It does not approve decisions locally or finalize attendance.
Verification uses random schemas in `hexpayroll_test`; no live migration or
deployment is part of this change.

## Activation and authority

`SYNC_TRUSTED_EVIDENCE_ENABLED=false` is the default. Set it to `true` only in an
explicitly configured `SYNC_MODE=local` installation, after reviewing local data
and provisioning the required trusted actor identities. Central and disabled modes
never start this worker. It reuses `SYNC_CENTRAL_URL`, `SYNC_NODE_ID`,
`SYNC_NODE_TOKEN` and `SYNC_INTERVAL_MS`. HTTPS is required except for loopback
development tests. No acceptance-writer URL is read by the receiver or worker.

The trust model remains authenticated central transport and protected central
publication/storage. A snapshot hash binds content; it is not a signature or a
substitute for HTTPS. Generic node-authenticated v1 messages cannot publish trusted
evidence, accounts or application receipts. Existing protected-entity restrictions
remain in force, including historical generic schedule/leave quarantine.

The worker has independent v1/v2 receipt cursors, non-overlapping ticks, awaited
shutdown and capped transport backoff. Already received events can be applied while
the central API is unavailable. Each pull validates the complete page, envelope
hash, exact business shape, attribution, timezone and weekday identities before
the existing atomic inbox/checkpoint transaction runs.

## Local persistence and projection

Shared migration `0035_trusted_evidence_application.sql` adds:

- `trusted_evidence_applications`: append-only receipts containing acceptance/event
  identity, organization, sequence, aggregate identity/revision and the exact
  canonical snapshot/fingerprint. A foreign key and binding trigger tie each
  receipt to its immutable inbox event. Updates, deletes and truncation are denied.
- `trusted_evidence_application_state`: durable pending/conflict status, fixed
  diagnostic code, attempt count and retry time. No raw exception or credential
  content is persisted. Applied receipts take precedence over old attempt state;
  old state is retained as diagnostic history and is not eligible for reapplication.
- Aggregate-order and retry indexes.

The receiver rejects central-ledger schemas, rechecks active local enrollment and
installation organization, and serializes projection using the existing
organization source lock. A batch considers at most 20 eligible aggregate heads.
Earlier unapplied events block later revisions of that aggregate, while unrelated
aggregates can progress. Dependency/transient failures use capped backoff; conflicts
stay blocked for explicit review. Each event uses a savepoint. Projection and its
application receipt commit together; a failed event leaves neither business writes
nor a receipt. The receipt cursor is independent of application progress.

An existing local row without a trusted application predecessor is a conflict.
Updates require both exact expected revision and equality of the entire persisted
aggregate to the preceding trusted snapshot. This detects local edits even when a
local writer did not increment its revision. Unsynced outbox work also blocks
application. There is no last-write-wins adoption or deletion of local work.

All eleven actions use direct SQL projection, without local mutation services,
outbox publication, attendance jobs, payroll work or biometric checkpoint changes:

| Aggregate                       | Actions                               | Preserved evidence                                                                                                     |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `work_schedules`                | `schedule.create/update/status`       | Master revision, immutable versions, effective dates, timezone, seven weekday UUIDs, overnight/break offsets and grace |
| `employee_schedule_assignments` | `assignment.create/update`            | Stable employee/assignment identity, exclusive end date, revisions and immutable history snapshots                     |
| `leave_types`                   | `leaveType.create/update`             | Status, revision, paid/approval policy and audit attribution                                                           |
| `leave_requests`                | `leave.request/approve/reject/cancel` | Duration, inclusive dates, original policy snapshot, transition state and all requester/decision actors and times      |

Weekday UUIDs reuse the existing central UUIDv8 rule in the neutral
`schedule-identity.ts` helper: first 128 SHA-256 bits of
`hexpayroll:schedule-day:v1:<lowercase-version-UUID>:<weekday>`, with UUIDv8/RFC variant
bits set. The receiver verifies rather than generates replacement identities.
Old versions/history cannot be omitted or rewritten. New assignment history must
contain the exact preceding row. Post-write aggregate comparison verifies that
the projection equals the accepted snapshot before inserting its receipt.

Current local parent status or approval permissions do not reauthorize a historical
accepted decision: a parent may already reflect a later central revision. Parent
identity/organization and applicable schedule-version coverage are still required.
Assignment/leave overlaps with untrusted local records are conflicts; overlaps with
trusted records awaiting another accepted change defer. Database overlap constraints
remain enabled as a final concurrency guard.

## Dependencies and conflict resolution

Missing employees/schedules/types defer with a specific dependency code. Actor
foreign keys must reference an existing account in the same organization.
`MISSING_TRUSTED_ACTOR` is a genuine provisioning dependency: Step 73J suspends
generic account synchronization. This implementation neither creates placeholder
accounts nor grants roles, relaxes foreign keys, or discards attribution. The
integration fixtures explicitly provision accounts outside synchronization without
granting local permissions. Production multi-PC rollout still needs a reviewed
trusted account provisioning/distribution path for actors absent on a PC.

Inspect unresolved work without changing inbox/checkpoints:

```sql
SELECT s.organization_id, s.sequence, s.status, s.code, s.attempts,
       s.next_attempt_at, i.envelope->>'entityType' AS entity_type,
       i.envelope->>'entityId' AS entity_id
FROM trusted_evidence_application_state s
JOIN trusted_evidence_inbox i USING (organization_id, sequence)
LEFT JOIN trusted_evidence_applications a USING (organization_id, sequence)
WHERE a.sequence IS NULL
ORDER BY s.sequence;
```

Local conflicts require a separately reviewed reconciliation that preserves local
work and history, establishes the correct accepted predecessor and records the
operator decision before retry. No automatic replacement, conflict dismissal,
receipt deletion or cursor rewind is provided. A revision gap does not justify
creating a later revision directly; it remains pending for investigation/recovery.

## Verification and remaining work

`trusted-application-database.test.ts` uses real central authorization and restricted
writer acceptance, the HTTP v2 endpoint, and two independently enrolled local
schemas with shared migrations only. It exercises all actions, pagination/outages,
fresh-pool recovery, concurrency, historical replay, local root/child/outbox
conflicts, missing actors/workforce, malformed envelopes and injected failures
after schedule children and assignment history but before the receipt.
`trusted-worker.test.ts` covers activation, local-mode gating, non-overlap, shutdown
and bounded transport retries independent of durable application.

Run the complete suite using the ignored local test configuration:

```powershell
cd D:\hexpayrollsys
pnpm --filter @hexpayroll/api test:regression
pnpm --filter @hexpayroll/shared build
pnpm --filter @hexpayroll/api typecheck
pnpm exec eslint apps/api/src apps/api/test packages/shared/src
pnpm exec prettier --check apps/api/src apps/api/test packages/shared/src docs/trusted-evidence-local-application.md
```

Trusted account distribution and operator conflict reconciliation remain rollout
prerequisites. Central attendance evidence completeness/finalization, desktop UI,
production backups/migrations and real office/VPS/WFH deployment remain separate
work. Payroll calculations remain postponed.
