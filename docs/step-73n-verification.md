# Step 73N: biometric capture, receipt and evidence review foundation

Implementation date: 2026-10-27. **Partial implementation; not an attendance
finalization release.** No production migration, device access or activation was
performed. The Step 73M reconciliation blockers remain unchanged.

## Implemented

- Shared migration `0038_biometric_raw_capture.sql` adds immutable raw punch
  identities, capture-batch membership and per-device batch ordinals. The existing
  ingestion service and device advisory lock are reused. Raw punches are retained
  before employee mapping, including unmapped punches and original timestamp
  precision. Mapping can be retried using the same captured input without creating
  a new raw identity. Changed external identities conflict rather than overwrite.
- Raw capture, mapped `time_records`, existing generic outbox, attendance jobs,
  capture-batch audit and existing timestamp checkpoint commit or roll back in the
  existing ingestion transaction. No physical hardware acknowledgment is added.
- Central-only migration `0006_biometric_evidence_receipts.sql` introduces explicit
  immutable device-to-collector bindings, append-only receipts and raw evidence.
  An enrolled node cannot claim another collector's device. Runtime credentials
  cannot create/change device bindings. Binding setup is a reviewed rollout task;
  no automatic production grants or source enrollment are performed.
- `POST /api/sync/biometric/receive` validates a strict versioned payload, current
  node credential, organization and device binding in the receipt transaction.
  Batch identity, batch ordinal and raw evidence identities cannot be reused with
  different content. Raw evidence and its receipt commit together. Delayed and
  out-of-order batches remain durable; sequence gaps are retained for review.
- The existing trusted worker optionally sends one pending biometric capture batch
  per tick, through the existing configured-central transport. Immutable batch IDs
  survive lost or invalid responses. Separate append-only local delivery receipts
  are written only after an exact validated central acknowledgment. There is no
  biometric cursor that could skip an undelivered batch. Central receipts always
  return `received: true, finalized: false`.
- `POST /api/sync/attendance/evidence-review` uses the enrolled node bearer token
  and `X-Central-Session` central user credential. It reauthenticates current
  `attendance.manage` permission inside the write transaction. The strict command
  contains `requestId`, `organizationId`, `employeeId`, `workDate`,
  `expectedRevision`, and a nonempty `reason`. It records immutable accepted-source
  snapshots/revisions, mappings, device bindings, receipt payloads, compact missing
  batch ranges, SHA-256 fingerprint and operator/node attribution. Exact retries
  return the same review after fresh authorization; competing revisions use CAS.
  A later delayed punch requires a new review revision and changes its fingerprint.
- Generic v1 cannot transport any new ledger or canonical attendance table as
  authority. Existing mapped-punch v1 transport remains evidence transport only.

## Completeness boundary and unfinished work

Three states remain distinct: raw local capture, durable central receipt, and
authoritative central finalization. Neither transport success nor an operator
review constitutes finalization or complete hardware evidence.

Capture-batch ordinals identify missing **delivery batches**, not missing device
log entries. A contiguous prefix also cannot expose an absent trailing batch.
Timestamp maxima, two punches, successful synchronization and a gap-free batch
ledger are insufficient proof that an attendance period is complete.

Every current review therefore retains `SOURCE_PERIOD_CLOSURE_UNVERIFIED` and
`pending_review`, even after delivery gaps recover. A source with no enrolled
coverage also retains `EXPECTED_DEVICE_COVERAGE_UNVERIFIED`. The snapshot includes
all currently bound organization devices and accepted evidence conservatively;
it does not yet resolve an authoritative employee-specific expected-device set or
evaluate the correct shift/assignment/leave combination. Organization-wide receipt
snapshots are a foundation and need bounded period-specific selection before
activation at scale.

Remaining work to satisfy the complete Step 73N request:

1. Implement source log epochs/sequences and verified period-closure manifests
   with a documented device capability contract. A sufficient proof must cover
   every expected source and employee mapping for the entire shift window,
   include a complete immutable source identity inventory, prove all required
   ranges received, bind time-zone/window and source provenance, and resolve
   conflicting/delayed punches. A device checkpoint by itself is insufficient.
   Sources lacking this contract must retain explicit operator-review exceptions.
2. Add durable, revision-bound operator resolution of source completeness
   exceptions; an audit reason must not silently waive missing source evidence.
3. Validate actual attendance proposals against those proofs and the applicable
   accepted schedule/assignment/leave revisions; persist immutable input snapshots
   and deterministic attendance results. Reject stale snapshots after delayed
   evidence, mapping changes or new accepted source revisions.
4. Implement restricted centrally authorized canonical acceptance/finalization,
   compare-and-swap canonical revisions and trusted final-result delivery using
   the existing canonical requests/decisions/state/history schema. This change
   deliberately grants no attendance writer authority and performs no canonical
   attendance writes. There is no new attendance approval endpoint.
5. Extend integration coverage to complete source proofs and actual finalization
   rejection/success cases. Current tests cannot demonstrate a finalization path
   that has not been implemented.

## Activation and isolation

`SYNC_BIOMETRIC_EVIDENCE_ENABLED=false` is the default. It gates HTTP receipt and
review commands and local raw capture. Sending also requires the existing local
trusted worker flag `SYNC_TRUSTED_EVIDENCE_ENABLED=true`; neither flag was enabled.
Internal constructors likewise default to disabled. The timestamp checkpoint used
by existing ingestion does not become a completeness certificate.

Testing uses the existing guarded regression runner and random isolated schemas
in `hexpayroll_test`, including two independent schemas connected over loopback
HTTP. Simulated input only; no real biometric device, VPS, production setting,
`payroll_sys` or `payroll_central` was accessed. No payroll calculation changes.

## Verification

The 13 new PostgreSQL integration cases cover disabled capture, unmapped capture,
mapping replay, duplicate identity conflicts, delayed punches, concurrent capture,
injected checkpoint/receipt failures and restart retries, two-device/two-schema
delivery, invalid acknowledgment handling, source binding, revoked credentials,
generic authority forgery, append-only ledgers, review snapshots, missing ranges,
CAS and reauthenticated retries.

Final full regression: **249 passed, 0 failed, 0 skipped**, including all 236
retained baseline cases and 13 new PostgreSQL integration cases. Duration:
516.999 seconds; 0 cancelled and 0 todo. Output is retained locally in
`.diagnostics/step-73n-regression.log`. A review retry date-decoding error found
during the earlier run was fixed before this final successful run.

Shared build, API typecheck, separate strict TypeScript checking of both new test
files, ESLint with zero warnings, formatting and `git diff --check` passed.
No test configuration or PostgreSQL prerequisite was missing. The sandbox blocked
the initial child-process spawn; approved execution of the same guarded runner
outside the sandbox succeeded. All database access remained limited to isolated
`hexpayroll_test` schemas.

Commands:

```powershell
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/src/cli/test-regression.ts
pnpm --filter @hexpayroll/shared build
pnpm --filter @hexpayroll/api typecheck
pnpm exec eslint apps/api/src apps/api/test packages/shared/src --max-warnings=0
pnpm exec prettier --check apps/api/src apps/api/test packages/shared/src docs/step-73n-verification.md
git diff --check
```
