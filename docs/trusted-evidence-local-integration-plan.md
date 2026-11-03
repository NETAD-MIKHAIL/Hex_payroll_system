# Next integrated stage: trusted evidence worker and local application

Status: **implemented and verified as Step 73L** on 2026-10-24. Complete regression:
218 passed, 0 failed, 0 skipped, retaining all 201 Step 73K-B tests. The receiver
and shared migration are implemented; worker activation remains explicitly opt-in
and disabled by default. No production deployment or UI is included.
See [implementation details](trusted-evidence-local-application.md) and
[verification report](step-73l-verification.md). The original plan follows.

## Outcome

Centrally accepted schedule, assignment and leave aggregates reach enrolled office
and WFH databases through the existing v2 stream, preserve identities/history and
converge safely after outages, retries and restarts. A local proposal or generic v1
payload cannot become central authority or silently replace accepted evidence.

## Integrated implementation

1. Add the trusted pull primitive to an explicitly enabled local-mode worker. Keep
   generic v1 delivery independent, central mode from running local application, and
   safe shutdown/non-overlapping ticks. Reuse configured HTTPS central transport;
   never put an acceptance-writer credential on a desktop.
2. Preserve the existing receipt transaction: verify the entire response, lock and
   recheck enrollment/checkpoint, persist immutable envelopes and advance only the
   trusted receipt cursor atomically. Invalid/unsupported envelopes or a failed
   insertion must leave both inbox and receipt checkpoint unchanged.
3. Add separate local application receipts and retry/conflict state. Do not mutate
   trusted_evidence_inbox to mark application: it is immutable. Each successful
   receipt must bind organization, acceptance/event identity, snapshot fingerprint
   and resulting aggregate revision. Commit aggregate writes and application receipt
   together. Receiving an event is distinct from applying its business evidence.
4. Implement strict accepted-snapshot schemas and handlers for work_schedules,
   employee_schedule_assignments, leave_types and leave_requests. Reverify envelope
   provenance structure and fingerprint from durable storage. Admit only the trusted
   inbox, never generic sync_inbox or caller-supplied approval flags.
5. Apply a schedule master, immutable versions and all seven weekday rows as one
   aggregate. Preserve version/day UUIDs, timezone snapshots, effective dates, rest
   days, grace and overnight/break offsets. Compare every existing immutable child;
   never rewrite history or delete a child because another snapshot omits it.
6. Preserve assignment identity, employee ownership, effective ranges and immutable
   assignment history. Reject unbound implicit closures and incompatible overlaps.
   Preserve leave duration, type snapshot, status and central attribution exactly;
   a desktop must not reapprove leave using its local role/permission claims.
7. Lock targets/dependencies and use explicit expected/resulting revision checks.
   Exact duplicate acceptance returns the original receipt. Earlier accepted events
   replay safely without reverting newer state. Missing parents or revision gaps
   defer; same revision with incompatible contents creates a durable conflict.
   Do not use last-write-wins or overwrite differing pending/local data silently.
8. Retry dependencies in bounded batches, retaining same-aggregate ordering while
   allowing independent aggregates to progress. v1 workforce and v2 evidence have
   separate cursors: no cross-stream order may be assumed.

## Dependency and authority gates

Local creator/updater/approver foreign keys can reference central user UUIDs. Generic
account synchronization remains suspended by Step 73J. Verify which trusted accounts
already exist before applying snapshots; missing actors must defer with a precise
reason. Do not invent users, grant permissions, drop attribution or relax foreign
keys to make application pass. Trusted account provisioning/distribution may require
a separately scoped prerequisite.

Existing locally authored schedule/leave records/outbox entries need an explicit
conflict policy and migration strategy before worker activation. Accepted aggregate
revision numbers do not justify silently discarding unrelated local work. Central
authority is established by the accepted event, not by a local row's revision alone.

Receivers must use dedicated projection code, not local mutation services that
publish outbox entries, invalidate attendance approval or enqueue processing as a
side effect. No canonical attendance, local approved attendance, payroll, device
ingestion checkpoints or biometric hardware changes are included in this stage.

## Required isolated integration tests

- A real central acceptance/publication, v2 pull and local application for all four
  aggregate types and all eleven central actions, comparing stable UUIDs/revisions.
- Two enrolled local schemas converge to the same accepted schedule/leave evidence;
  the central-only acceptance/publication tables remain absent locally.
- Disconnect/lost-response retry, durable restart, duplicate events, concurrent pull
  and concurrent application produce exactly one receipt per acceptance.
- Malformed/hash-mismatched/unsupported or foreign-organization envelopes cannot
  advance a receipt cursor or partially apply business records.
- Publication order, pagination, revision gaps and missing workforce/actor parents
  retain recoverable pending work with no unbound aggregate writes.
- Conflicting local revisions, changed immutable weekday/history rows, and duplicate
  acceptance identities with altered content remain conflicts without silent loss.
- Inject failure after child/history writes and before application receipt: all
  aggregate changes roll back; retry applies once. Transport checkpoint semantics
  remain independent of business application failure.
- No sync_outbox echo, no authorization/grant mutations, no attendance finalization
  or payroll writes, and no interference with biometric collection state.

All tests must use the existing dedicated hexpayroll_test fixture model. Retain the
entire verified regression, shared build, API typecheck, lint and formatting checks.
Completion means durable two-PC convergence after failure/recovery tests, not merely
that the HTTP pull endpoint returns an event. Production deployment is separate.
