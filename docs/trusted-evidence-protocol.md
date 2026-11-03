# Step 73K-B1: trusted central evidence protocol

This records the original protocol stage. Central acceptance was subsequently
implemented in Step 73K-B and local evidence application in Step 73L. Step 73M adds
[trusted identity delivery and audited local reconciliation](trusted-identities-and-reconciliation.md)
using an independent identity v2 stream; the accepted-evidence envelope below is unchanged.

## Protocol and compatibility

Trusted evidence uses a separate opt-in version-two stream:
`GET /api/sync/evidence/pull?after=0`. The response is a strict object containing
`protocolVersion: 2`, `origin: 'central.accepted'`, `changes` (at most three), and
`nextSequence` (PostgreSQL bigint encoded as a decimal string).

The existing generic v1 push/pull protocol, sync_changes, pagination, sequencing,
inbox and checkpoint are unchanged. Old clients neither see nor skip trusted events.
New trusted clients start their independent evidence cursor at zero, including when
upgrading a PC whose generic cursor has already advanced. Each stream preserves its
own commit order; no relative order across the two streams is promised. Future
receivers must retry missing dependencies instead of assuming cross-stream order.

Each trusted envelope binds:

- Protocol version, server-controlled origin, event UUID and sequence.
- Distinct acceptance UUID and immutable authorization decision/request UUIDs,
  including the stored authorization fingerprint.
- Organization, aggregate UUID/type, action, expected revision and resulting revision.
- Authorized user and source device from the immutable authorization record, plus
  the acceptance timestamp.
- Exact accepted aggregate snapshot and its SHA-256 fingerprint.

Supported aggregate types are work_schedules (including future version/day snapshots),
employee_schedule_assignments, leave_types and leave_requests. Action/type mapping
matches Step 73K-A's eleven actions. Creation requires expected revision zero;
resulting revision is always expected plus one. Snapshot root id, organizationId and
revision must match the envelope. Hashing uses recursively sorted object keys, JSON
scalar encoding and preserved array order, matching the existing authorization
canonicalization rules. Metadata comes from protected relational joins, never node
payload claims. A hash detects content inconsistency; it is not an authenticity signature.

## Trust boundary

The selected model is authenticated central transport plus protected server storage
and publication, without signatures. The trusted client requires HTTPS to its configured
central URL, with loopback HTTP permitted for local use/tests. HTTP redirects are
rejected by the existing transport primitive. Central URL/configuration, TLS validation,
server code/database writer credentials and local database access are trusted.
Node tokens authenticate the pulling installation, not the publishing authority.

The server only emits envelopes joined from protected publication, acceptance and
authorization rows. Generic push cannot supply trusted top-level fields or insert
protected schedule/leave, authorization, acceptance, publication or trusted-inbox
entities. Arbitrary nested generic flags remain ordinary untrusted payload. Historical
generic schedule/leave events remain excluded from generic pull. No private key is
needed because this step does not promise standalone verification of exported events
outside the authenticated server/local storage boundary. Signatures would require
a separate key provisioning/rotation design if that trust model changes.

## Central storage and future publication

Central-only migration `0003_trusted_evidence_protocol.sql` defines:

- `central_evidence_acceptances`: an immutable acceptance reference contract, unique
  per authorization decision and aggregate resulting revision, with exact canonical
  snapshot/hash and an audit snapshot. The insertion guard compares organization,
  entity/type, action and expected revision to the referenced authorization. A bare
  authorization cannot substitute for this acceptance record.
- `central_evidence_events`: immutable publication identity and sequence referencing
  an acceptance by foreign key, unique per acceptance. All remaining metadata is
  derived from immutable references; payload duplication cannot diverge from acceptance.

PUBLIC and hexpayroll_app have no acceptance/publication write capability. Runtime
may SELECT for delivery but cannot use identity sequences or create either row type.
Owner mutation/truncation guards also preserve append-only records. There is no
SECURITY DEFINER function, public acceptance endpoint, runtime grant escalation or
node credential path into publication.

`publishTrustedEvidence(client, acceptanceId)` requires a privileged server writer
client and the caller's transaction. It validates canonical snapshot encoding and
publishes only an existing acceptance. Exact retries return the existing event and
sequence. A global transaction advisory lock assigns publication sequences in commit
order, including when another transaction reserved an earlier identity value. Gaps
from retries/rollbacks are safe.

No acceptance operation or production acceptance records are implemented here.
The future acceptance service must authenticate user/node again, validate and
materialize exact authorized evidence, insert the acceptance/audit record, and call
publication inside one transaction on a deliberately provisioned restricted writer
connection. This step does not provide that writer role or assert that a schema
reference alone proves business validation. Privileged test fixtures explicitly
simulate future acceptance rows; application code never manufactures them.

## Durable local delivery

Shared migration `0034_trusted_evidence_inbox.sql` adds only desktop-compatible
persistence: `trusted_evidence_inbox` and `trusted_evidence_checkpoints`. It adds no
central authority tables to desktop migrations. The entire envelope is stored as
JSONB with indexed organization/sequence, event and acceptance identities. The
application cannot update/delete/truncate inbox evidence. The independent checkpoint
is scoped to organization and enrolled node.

`pullNextTrustedEvidenceBatch` is an explicit client primitive; it is not enabled in
the existing worker. It validates the complete response before writing: supported
version/origin, shape, action/revision/snapshot consistency, canonical fingerprint,
organization, strict sequence order and exact response cursor. Unknown or malformed
envelopes abort the batch. It then locks/rechecks enrollment and the evidence
checkpoint, stores the envelopes and advances that checkpoint in one transaction.
A concurrent worker whose cursor changed cannot overwrite it. Restart uses durable
state; exact replay retains the same envelope. Reused sequence/event/acceptance IDs
with changed metadata conflict without advancing the cursor. Database insert failure
rolls back all inbox rows and checkpoint changes.

No trusted data is copied into generic sync_inbox. No schedule/leave receiver is
enabled, no outbox echo or calculation job is generated, and canonical attendance
write privileges remain unchanged. A later receiver must keep this trust distinction
and validate stored envelopes before applying business evidence.

## Files and verification

Changed/new files for this step:

- `packages/shared/src/sync.ts`: v2 contracts and canonical snapshot serialization.
- `database/migrations/0034_trusted_evidence_inbox.sql`: durable local protocol storage.
- `database/central-migrations/0003_trusted_evidence_protocol.sql`: protected central contracts.
- `apps/api/src/sync/trusted-evidence.ts`: verification, protected publisher and scoped pull.
- `apps/api/src/sync/router.ts`: separate central-only trusted pull route.
- `apps/api/src/sync/client.ts`: opt-in validated durable trusted delivery primitive.
- `apps/api/src/sync/service.ts`: additional protected protocol entity names.
- `apps/api/test/trusted-evidence.test.ts`: envelope and generic-forgery unit checks.
- `apps/api/test/trusted-evidence-database.test.ts`: isolated protocol/storage regressions.
- `docs/trusted-evidence-protocol.md`: protocol, trust model and remaining dependency.

Run from `D:\hexpayrollsys`, with both dedicated hexpayroll_test URLs supplied by
the test env file. The existing fixture enforces the test database name and creates
and drops only random isolated schemas. No production migration was run.

```powershell
pnpm --filter @hexpayroll/shared build
pnpm --filter @hexpayroll/api typecheck
pnpm exec eslint packages/shared/src/sync.ts apps/api/src/sync/client.ts apps/api/src/sync/router.ts apps/api/src/sync/service.ts apps/api/src/sync/trusted-evidence.ts apps/api/test/trusted-evidence.test.ts apps/api/test/trusted-evidence-database.test.ts
node --env-file=apps/api/.env.test --import ./apps/api/node_modules/tsx/dist/loader.mjs --test apps/api/test/trusted-evidence.test.ts apps/api/test/trusted-evidence-database.test.ts
```

Smallest next step: resume Step 73K-B with internal atomic acceptance using the
protected acceptance/publication contract. No transport incompatibility remains;
actual acceptance, writer provisioning and local business receivers remain pending.

## Verified result (2026-10-24)

The combined regression passed **115/115**, zero failures and zero skips: the
complete prior 106-test baseline plus seven new isolated PostgreSQL tests and two
new unit tests (107 PostgreSQL tests and eight unit tests total). Coverage includes
central migration isolation, protected writer permissions, acceptance-reference
binding, generic provenance forgery, historical quarantine, replay/tampering,
organization isolation, pagination, publication rollback, real concurrent sequence
lock waits, concurrent pulls, and atomic inbox/checkpoint rollback.

Shared build, API TypeScript, strict TypeScript checking of both new test files,
ESLint for changed TypeScript files and Prettier checks passed. The sandbox initially
blocked the test runner with spawn EPERM; the authorized test run outside it used
only the existing dedicated hexpayroll_test fixtures. An initial concurrency test
incorrectly assumed both pull calls would fetch the same page; it was corrected to
allow the valid case where the second call fetches the next page after the first
commits. The final regression has no unresolved failures.

No production migrations, VPS services, biometric hardware, UI, workers, payroll
calculations or canonical attendance writer permissions were changed. The production
protocol has no accepted evidence until the later acceptance implementation writes it.
