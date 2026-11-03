# Step 73K-B: atomic central evidence acceptance review

Status: stopped at the explicitly required trusted-event provenance gate.
No acceptance service or accepted actions were implemented.

## Exact blocker

The existing stream cannot represent the distinction between a node-submitted
snapshot and centrally accepted evidence without a new trusted envelope:

- `database/migrations/0028_sync_transport.sql`: every `sync_changes` row requires
  `source_node_id` referencing a sync node and `source_event_id`. There is no origin
  discriminator or acceptance reference. The sequence, server-generated change UUID
  and timestamp establish transport ordering/identity, not evidence acceptance.
- `database/migrations/0029_sync_delivery_safety.sql`: organization-scoped node
  references and commit-order sequencing preserve delivery safety, but add no
  acceptance provenance. The local inbox stores the same node-event identities.
- `packages/shared/src/sync.ts`: the strict version-one event/change contract carries
  node source, entity, operation, revision and arbitrary payload, with no trusted
  central acceptance envelope. A new top-level provenance field is not part of the
  current contract and needs an explicit compatible protocol change.
- `apps/api/src/sync/service.ts`: ordinary push derives source_node_id from the
  authenticated PC. Protected schedule/leave types are rejected, and pull filters
  them out, including historical events. There is no separate accepted-event writer
  or trusted delivery branch. Generic payloads may contain arbitrary nested claims;
  a payload-level `trusted`, `origin` or `accepted` flag proves nothing.
- `apps/api/src/sync/client.ts`: pulled changes become inbox rows containing the
  generic fields only. No verified central acceptance provenance is persisted.

An invented server node UUID, reuse of the approving PC's node ID, reserved entity
name alone, or authorization decision UUID in the payload would not supply the
required accepted-event boundary. A Step 73K-A authorization record is explicitly
not acceptance. Existing protected-type rejection prevents current generic pushes
of these types, but does not establish an accepted-evidence protocol or provenance
binding for newly published records.

Therefore an acceptance operation cannot currently satisfy the required atomic
trusted distribution event. Implementing only materialization and audit would leave
the requested transaction incomplete. No evidence was materialized.

## Required prerequisite: versioned trusted evidence envelope

Before Step 73K-B resumes, implement and test these protocol/storage guarantees:

1. Define a server-controlled event origin distinguishing generic node transport
   from central accepted evidence. Bind each accepted event to an immutable accepted
   decision, authorization request/fingerprint, organization, aggregate identity,
   action, resulting revision and exact accepted snapshot/hash. Authorization and
   acceptance identities must remain distinct.
2. Add central-only accepted-event storage and publication, or extend the existing
   stream with explicit database constraints and a protected writer. An accepted
   event must reference its acceptance record with organization-scoped identity.
   Acceptance, audit snapshot and event must commit together. A request must map to
   at most one accepted result/event; exact retries return that prior result.
3. Keep node-authenticated push unable to select central origin, submit accepted
   records, or reference an accepted decision as authority. Cover forged top-level
   envelopes, nested claims, protected entities and historical generic events.
   Runtime database credentials remain trusted server credentials, not node tokens.
4. Version the shared pull contract and define how provenance survives local durable
   inbox storage. Preserve ordering/cursors, pagination, organization isolation,
   atomic inbox/checkpoint writes and retry semantics. Keep historical generic
   schedule/leave events quarantined. No business inbox handlers need enabling yet.
5. Specify the verification boundary: authenticated central transport plus protected
   server publication/storage, or a signed envelope if trust must survive transport
   independently. An unverified payload claim is insufficient. Test that consumers
   can distinguish accepted events from node submissions before enabling receivers.

This is a prerequisite specification, not an implemented schema or protocol choice.
The user's stop condition prevents silently inventing that envelope in this step.

## Evidence model inspection

The existing schema supports revisioned schedule masters, immutable effective-dated
schedule versions and weekday rows, assignment ranges/history, revisioned leave
types, and leave request state/attribution. The Step 73K-A payload binds schedule
version UUID and timezone, with weekday rules bundled under the master revision.
Weekday IDs still require a documented deterministic derivation from bound version
UUID plus weekday, or a newly versioned request carrying explicit IDs.

Local schedule services enforce advancing version effective dates, active schedules
for assignments, applicable versions, reasons for backdating/corrections, and
assignment overlap protection. Assignment creation can close an earlier assignment;
future acceptance must explicitly bind/check all such affected revisions or reject
overlap rather than silently alter another record. Leave requests snapshot the
current type; requiresApproval=false auto-approves. Existing transitions permit
pending approval/rejection/cancellation and approved cancellation, with rejection
remarks required. Central acceptance must revalidate these rules under locks and
must avoid local service outbox/job/attendance-invalidation side effects.

The existing shared authorization helper is reusable for current node/session,
organization, active-user and permission checks inside the eventual acceptance
transaction. The authorization request is immutable and already binds exact
canonical content and expected revision. These foundations do not eliminate the
event provenance prerequisite.

## Changes, verification and remaining work

Changed file: `docs/step-73kb-security-review.md` only. No source, migrations,
permissions, local workers, UI or tests were changed. Step 73J/73K-A protected sync
restrictions and canonical attendance write restrictions remain as inspected.
No production database, VPS service, hardware or payroll operation was accessed.

No TypeScript, lint, unit or PostgreSQL tests were rerun for this documentation-only
stop. The verified 106/106 baseline remains the previous run, not a fresh result.
There are no new acceptance, concurrency, rollback or provenance test results.
Prettier formatting verification of this report passed.

Next: establish the trusted accepted-event envelope/storage contract above, then
resume atomic acceptance for the eleven authorized actions with semantic validation,
immutable audit history, replay and concurrency tests. Trusted delivery and local
evidence receivers follow; final attendance acceptance and payroll remain outside
this step.
