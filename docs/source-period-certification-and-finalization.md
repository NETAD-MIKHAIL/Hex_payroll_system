# Step 73N-B: source-period certification and central finalization

The backend now separates durable local capture, central transport receipt,
source certification, policy-authorized exceptions, and canonical finalization.
No stage automatically promotes the preceding stage into approval. Features are
disabled by default; no production migration, grant, service or device was changed.

## Source capability contract

No real Sunmi or generic model is declared automatically certifiable by this
implementation. The repository contains no installed vendor SDK, assessed model /
firmware combination, hardware signing enrollment or evidence that a real device
provides the following contract. Tests use an independently signed simulated
source. Product names, SDK pagination, batch ordinals, maximum timestamps and
node enrollment do not establish source completeness.

An administrator must review and install an immutable per-device
`central_source_capabilities` revision, bound to the existing enrolled collector
in `central_biometric_sources`. Supported profiles require:

- `contract = signed-inventory-v1`, an exact source epoch UUID and an Ed25519
  public key belonging to the assessed source authority.
- `assessment.contractVerified = true`, with a retained assessment reference,
  device model, firmware/SDK version and the vendor or adapter contract evidence.
- A durable source epoch that changes on log reset, identity reuse or replacement.
  Entries have immutable native identities and dense, positive decimal source-log
  sequences within the epoch. A collector must not manufacture these sequences
  by numbering the punches it happened to receive.
- A source authority that can seal a bounded timestamp window and export its
  complete immutable inventory, including all employee identities in that window.
  After closure, no entry can be silently admitted, deleted, changed or backdated
  into that window. The native sequence interval includes every source entry and
  any necessary guard entries. Clock/reset behavior must satisfy the assessed
  contract. The device or independently trusted adapter signs that claim.

Signing a collector-assembled partial list does **not** meet this contract. A
signature authenticates the manifest; its completeness meaning depends on the
independently assessed source semantics. The ordinary node credential is not a
source signing key. Private signing keys are not stored in payroll tables or
distributed to local PCs by these features.

An unassessed device uses `contract = unsupported` and no public key, or has no
capability profile. Both remain unresolved. A missing profile is a configuration
blocker, not permission to infer coverage. No real-device model receives a default
supported profile.

Capabilities, employee source coverage and exception policies are append-only
administrative configuration. The application runtime, canonical writer and
ordinary operators cannot insert or modify them. Their latest revisions enter
the immutable evidence fingerprint. Configuration changes require reviewed
administrative provisioning, never a node-supplied assertion.

## Native evidence and signed closure format

The existing `POST /api/time-records/ingest` optionally accepts each punch's
`sourceIdentity: { epoch, sequence, entryId }`. `sequence` is a decimal string;
`entryId` is the immutable native entry identity. The existing raw capture
transaction retains this metadata before employee mapping, alongside the original
device employee identifier, timestamp, type and external identity. Replays compare
the full immutable evidence; epoch/sequence and epoch/entry identities are unique.
Metadata cannot be retrofitted onto a conflicting historical raw punch. Existing
external identities must remain globally immutable for that device; adapters must
namespace reset-prone external IDs by epoch rather than reuse historical IDs.

`POST /api/biometric-source-closures` durably captures a simulated/adapter-provided
closure locally. It requires the existing authenticated `time_records.ingest`
permission and is default-off. It returns capture status, **not certification**.
The existing trusted worker sends pending raw batches and closures independently
with stable identities. Lost acknowledgments retain pending local work.
Failed closure attempts retain an immutable operational audit; independent
unattempted closures are tried before a failed head. Failure never creates a
delivery receipt or deletes captured evidence.

`POST /api/sync/biometric/closure` receives `{ manifest, signature }` centrally,
authenticated by the current enrolled collector bearer token. The manifest has:

- `version: 1`, `contract: signed-inventory-v1`, `closureId`, organization/device,
  assessed `capabilityRevision`, epoch and the shift's IANA `timezone`.
- UTC `start`, `end` and `issuedAt`. The sealed interval is `[start, end)`; issue
  time must follow closure and cannot be in the central server's future.
- Decimal `firstSequence` and `lastSequence` and a dense ordered `inventory`.
  Each entry contains the punch fields and native `sourceIdentity`, excluding the
  locally allocated raw UUID. Source timestamps use canonical UTC with six
  fractional digits, retaining PostgreSQL microseconds. Empty inventories use an
  empty range such as first 1 / last 0.
- A standard-base64 Ed25519 signature over UTF-8 `canonicalSyncJson(manifest)`:
  recursively sorted object keys, unchanged array order and exact scalar values.

V1 bounds are 500 native entries and 72 hours per manifest. Larger inventories
require a reviewed extension; they must not be truncated to fit. Closure receipt
verifies the current collector/device binding, capability revision, epoch,
signature, identity and payload before its transaction commits. It returns
`received: true, certified: false`. Missing raw records do not make receipt fail:
the closure remains durable and certification exposes the missing native ranges.

## Attendance certification

`POST /api/sync/attendance/certify` takes `requestId`, organization, employee,
`workDate` and `expectedRevision`. It requires a real central session with current
`attendance.manage` and an enrolled node in that organization. Authorization and
input locks remain held through the write. Exact retries return the immutable
certification after reauthentication; competing revisions use CAS.

The server derives the applicable accepted assignment, schedule version, weekday,
time zone, grace, overnight offsets and break from immutable
`central_evidence_acceptances`, including adjacent shifts for ambiguity checks.
It also binds applicable accepted leave and leave-type revisions. Generic v1
projections, caller-provided minute totals and local `attendance_records` are not
central attendance authority. Calculation reuses `interpretAttendance` without
changing its attendance rules or adding payroll calculations.

The required window is the entire shift plus two hours on each side, or the full
local calendar day for a rest day. The window must have closed by central database
wall time. `central_attendance_coverage` supplies an explicit nonempty expected
source set for the employee and effective date; current active employee mappings
must match that set. Missing expected devices, mappings or accepted shifts block
certification. Extra active mappings cannot silently disappear from coverage.

For every expected device, the server verifies a signed manifest covering that
whole window and matching its time zone/epoch/profile. It checks every native
entry in the signed sequence interval, including trailing and guard entries,
against received immutable payloads. It also checks for received window entries
absent from the signed inventory and contradictory covering closures. Compact
received/missing sequence ranges, complete inventory/receipt fingerprints,
immutable closure references, selected punch provenance, source capabilities,
coverage, mappings, accepted inputs and the deterministic result enter the saved
snapshot. The snapshot is bounded to 220 KB; exceeding it fails explicitly.

Certification is `verified` only if all source, coverage and calculation gates
pass. Otherwise an immutable `unresolved` certification retains explicit blockers.
Closure receipt, a contiguous batch prefix, a timestamp checkpoint and a reviewer
reason cannot turn that state into complete evidence. Mixed epochs in one shift
are not automatically merged: V1 requires one assessed epoch/window contract per
expected device; resets crossing the window remain blocked.

## Separate exception authorization

`POST /api/sync/attendance/exceptions` binds an exact certification UUID,
fingerprint, current policy revision, independent review request UUID, decision,
reason and supporting artifact commitments. It requires **both** current
`attendance.adjust` and `attendance.approve` permissions. Decisions are append-only
`hold`, `reject`, or `authorize_limited`; a prior decision cannot be overwritten.
New reviews use new certification/request identities.

The default is to deny limited finalization. An explicitly installed policy may
permit it only when the **only** blockers are assessed unsupported devices and
the attendance calculation itself is valid. Known native gaps, conflicts, missing
coverage/mappings, unverified contracts, missing accepted revisions and ambiguous
or incomplete punch sequences cannot be waived through this command.

Limited authorization requires a reviewer different from the certification author,
a device-export commitment and a distinct independent-attestation commitment.
Each retains its SHA-256, artifact kind and immutable reference; reviewers must
verify and retain the actual artifacts under the configured policy. This is an
explicit human verification boundary, not automated verification of external
artifact bytes or a replacement hardware completeness proof. A reason alone is
insufficient. The final approver must also differ from the exception reviewer.

The source certification stays `unresolved`. If later accepted, the canonical
result is labeled `evidenceStatus: exception_authorized`, retaining all source
limitations, policy revision, review identity, artifacts and reason. It is never
represented as `verified_complete`. Policy/configuration changes or new evidence
make an old exception/proposal stale.

The existing processor's `result.complete` describes shift-window closure. It is
not a biometric completeness certificate. Consumers must use the separate
certification status, `evidenceStatus` and retained source limitations.

## Proposal, finalization and reopening

All central commands use `Authorization: Bearer <node token>` and
`X-Central-Session: <central session token>`. A local PC session or cached role list
does not authenticate a central user.

`POST /api/sync/attendance/proposals` takes a UUIDv7 `proposalId`, certification
UUID, nullable `exceptionResolutionId` and `expectedCanonicalRevision`. With
current `attendance.manage`, the restricted writer recomputes the source snapshot,
checks exact certification/exception fingerprints and stores the server-derived
calculation and immutable inputs in the existing `central_attendance_requests`.
This creates no canonical attendance state. The author is retained independently
of a later reviewer; existing local proposal UUIDs can remain request identities.

`POST /api/sync/attendance/finalize` takes a separate UUIDv7 `requestId`,
`proposalId` and nonempty review reason. The current central approver needs both
`attendance.approve` and `attendance.manage`. Inside the write transaction, the
service serializes the canonical employee/date, rechecks current evidence and
exception eligibility, validates the deterministic result and uses CAS against
the proposal's expected canonical revision. Changes to punches, mappings,
coverage, capability, covering closures, policy or relevant accepted schedule /
assignment / leave snapshots reject the old proposal. Conflict decisions and the
failed finalization request remain immutable and auditable. Altered request-ID
replays fail; exact accepted/conflicted retries return their original decision.

Successful finalization atomically accepts the calculation as unreviewed and then
accepts an explicit approval request. It uses the existing canonical
requests/decisions/state/history model, producing two contiguous revisions (initial
calculation 1, approval 2), two append-only histories and two trusted publications
in one transaction. No intermediate unreviewed state can escape a failed
transaction. Publication/history/state failures roll everything back. Session
expiry is checked against database wall time again immediately before commit,
including expiry during a lock wait.

Approved canonical state cannot be recalculated in place. A separate
`POST /api/sync/attendance/reopen` command requires current `attendance.manage`,
the exact current approved revision and a reason. It appends a new unreviewed
revision and trusted event while preserving historical approval. A new calculation
and approval then advance the same stable canonical UUID. Historical finalization
is an as-of decision; new evidence never rewrites its snapshots or silently
reapproves old inputs.

The HTTP routes never fall back to the runtime pool for writes. The server-only
`createCentralAttendanceFinalizationService` verifies a deliberately provisioned
`hexpayroll_attendance_writer`: no owner/DDL powers, role memberships, account/RBAC
mutation, password-verifier reads, source-policy mutation, accepted-source
mutation or generic transport writes. It receives only necessary read/lock
dependencies, append-only ledgers, canonical state INSERT/UPDATE and its own event
sequence. The Step 73M evidence writer's original verifier still rejects canonical
attendance grants. No role is created automatically and no SECURITY DEFINER or
trigger bypass is supplied.

## Trusted delivery and local application

`GET /api/sync/attendance/pull?after=0` is a separate enrolled-node-authorized stream
with `protocolVersion: 2`, `origin: central.attendance`, immutable event identity,
decimal bigint sequence, organization/canonical UUID, canonical revision, complete
accepted state snapshot and SHA-256 fingerprint. It publishes calculation,
approval and reopening revisions so local consumers see approval withdrawal as
well as final approval. Publication is bound by a database trigger to immutable
canonical acceptance history; commit-order serialization prevents cursor loss.

Central TLS/configured-server trust is reused from existing trusted streams.
Content hashes detect tampering; they are not independent server signatures.
Generic v1 cannot supply any of these authority tables or envelopes.

Local whole-page validation precedes atomic inbox/checkpoint writes. Projection
and its append-only application receipts use a separate transaction. Employee or
actor dependencies defer durably; revision gaps and canonical identity collisions
remain pending/conflicted instead of remapping UUIDs. Receipted history never
regresses a newer revision. Concurrent ticks serialize, a fresh pool can resume
from the inbox, and receipt failure rolls back the projection. No outbox entry,
account grant or local attendance approval is created by application.

New unattempted attendance is tried ahead of repeatedly deferred heads, so missing
identities do not starve independent employees in a bounded application batch.

`trusted_attendance_state` is the received central canonical projection. Existing
`attendance_records` remain local derived/draft results. Future desktop screens
must distinguish the two and display source limitations. Payroll consumption of
the new authoritative projection is intentionally outside this change; no payroll
calculation or source-selection behavior was changed.

## Activation and rollout prerequisites

`ATTENDANCE_FINALIZATION_ENABLED=false` remains the default. Activation requires
biometric evidence enabled; local delivery additionally requires the existing
trusted worker enabled. Central activation requires
`CENTRAL_ATTENDANCE_WRITER_DATABASE_URL` for the separately provisioned writer.
That pool is constructed only on an explicitly enabled central server and is
closed during shutdown. No desktop writer credential is configured or used.

Administrative writer provisioning is explicit and separate from migrations,
startup and HTTP commands. Tests reuse the existing dedicated test login only in
random schemas, alternating evidence and attendance grants within that schema;
production requires distinct restricted logins. No cluster roles or production
grants were changed during testing.

Real-device SDK/firmware assessment, coverage and policy review, key enrollment,
artifact retention/review procedures, backups, migration/grant review and real
Office/VPS/WFH validation remain activation prerequisites. The Step 73M immutable
history and different-UUID reconciliation blockers remain unchanged and must be
resolved under their existing reviewed policy. They do not authorize bypassing
attendance source or canonical identity checks.
