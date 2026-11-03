# Step 73N-B verification — 2026-10-29

Status: implemented and verified in isolated testing. No production rollout,
source hardware enrollment or feature activation was performed.

The implementation completes the Step 73N backend workflow for assessed signed
inventory sources, with a separately authorized limited-evidence path for
unsupported sources. It does not claim that real Sunmi/generic hardware has the
required capabilities. Unassessed sources, absent devices, gaps and conflicts stay
unresolved; generic synchronization cannot approve attendance.

## Implemented behavior

1. Native epoch/sequence/entry provenance extends the existing atomic raw capture
   and receipt pipeline. Immutable source identities and signed bounded inventory
   manifests distinguish hardware/source completeness from capture-batch ordinals.
   Full-range verification exposes missing trailing entries and guard entries,
   compact missing/received native ranges, extra punches and closure conflicts.
2. Immutable per-device capability assessments, explicit employee source coverage
   and default-deny exception policies are administrative configuration, closed to
   runtime/node/operator mutation. Unsupported sources remain unresolved.
3. Central certifications bind coverage, mappings, time zone and complete padded
   shift window, accepted schedule/assignment/leave snapshots, source proof
   identities, raw evidence and the reused deterministic attendance processor.
   Evidence mutations stale old proposals; exact retries and revisions use CAS.
4. Exception decisions are separate, permission-checked and append-only. Limited
   authorization requires explicit policy, a different reviewer, device-export and
   independent-attestation commitments, and a different final approver. Reasons
   cannot waive known gaps, conflicts, missing coverage or invalid calculations.
   Authorized limitations remain in final audit; the source certification is not
   relabeled complete.
5. A separately verified canonical writer reauthenticates current central
   node/user/permissions and database wall-clock session expiry inside the write
   transaction. It uses the existing canonical requests/decisions/state/history,
   accepts calculation and approval atomically with contiguous revisions, and
   requires an explicit audited reopen before replacing an approved result.
   Generic runtime, migration owners, local mode and node-only callers cannot use
   this service to finalize attendance.
6. Independent trusted `central.attendance` delivery binds every calculation,
   approval and reopening revision to immutable canonical history. Atomic local
   inbox/checkpoints and projection/application receipts support concurrency,
   historical replay, dependency deferral and restart, without outbox echo or
   local account/RBAC provisioning. Two independently enrolled local schemas
   converge on the same approved canonical result through real HTTP transport.

The API, source contract, security boundaries, policy decisions and activation
prerequisites are documented in
[source-period certification and finalization](source-period-certification-and-finalization.md).

## New migrations

| Migration                                                   | Scope        | Purpose                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0039_source_identity_and_attendance_delivery.sql`          | Shared       | Nullable native source identity, immutable local closure queue/receipts, independent trusted attendance inbox/checkpoint/projection/application ledgers and database projection-binding guards            |
| `0007_source_certification_and_attendance_finalization.sql` | Central only | Source identity uniqueness, immutable capability/coverage/policy/closure/certification/exception tables, input serialization, canonical-history-bound event publication and restricted-writer lock guards |

No prior migration was edited. No migration was run against a production database.
`provisionCentralAttendanceWriter` is an explicit administrative command, never
called by startup, HTTP or migrations. Existing test-login grants were scoped to
random isolated schemas; no cluster role creation, membership or production grant
was executed. Step 73M evidence-writer verification remains unchanged and still
rejects canonical attendance capabilities.

## Verification

The 31 new PostgreSQL cases exercise:

- Real offline capture, signed closure receipt, HTTP proposal/finalization and
  trusted delivery into two isolated local databases, with no outbox echo.
- Missing trailing native entries, delayed/out-of-order punches, missing closure,
  invalid signature/epoch/window, absent expected devices, changed capabilities
  and contradictory signed inventories.
- Unsupported-source holds and policy decisions, independent reviewers and
  artifact requirements, unwaivable supported-source gaps and explicit limitations.
- Accepted schedule/leave changes, changed mappings, overnight time zones, grace,
  break and undertime calculations, signed empty inventory for approved leave.
- Exact/concurrent certification and finalization retries, competing CAS proposals,
  reopened revision history, current permission/session denial and session expiry
  during a proven source-lock wait.
- Injected publication, inbox and local application-receipt failures; atomic
  rollback, fresh-pool recovery, malformed-page rejection, missing local actors,
  replay, and generic v1 authority forgery rejection.
- Full multi-device closure coverage, tampered stored proposal snapshots and
  closure identity/fingerprint rejection. Previously deferred identities cannot
  starve unrelated received attendance.
- Invalid queued closures retain immutable failed-attempt audits without preventing
  independent valid closure delivery or fabricating a delivery receipt.

Targeted final feature run: **31 passed, 0 failed, 0 skipped**. Duration 462.072
seconds while an earlier full regression was also running in separate schemas.
An initial test-harness lock observation depended on restricted `pg_stat_activity`
query visibility. The corrected test uses the exact requester/holder backend PIDs
and `pg_blocking_pids`; no monitoring privilege or role was granted to make it pass.

Final complete regression: **280 passed, 0 failed, 0 skipped**. This retains all
249 baseline cases and adds 31 PostgreSQL integration cases. Duration: 653.420
seconds; 0 cancelled and 0 todo. The completed run is retained locally in
`.diagnostics/step-73nb-complete-regression.log`.

Shared build, API typecheck, separate strict TypeScript checking of the new test
and fixture, ESLint with zero warnings, formatting and `git diff --check` passed.
No test configuration, database or restricted test-writer prerequisite was missing.
The guarded runner was approved outside the sandbox for test-process spawning;
its database target and schema isolation checks remained in force.

All test fixtures validate the dedicated `hexpayroll_test` URLs before creating
random isolated schemas. No credentials were printed or committed, and no
production database, VPS service, real biometric device or payroll calculation was
changed. New workers/routes/features remain off by default.

Commands:

```powershell
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/src/cli/test-regression.ts
pnpm --filter @hexpayroll/shared build
pnpm --filter @hexpayroll/api typecheck
pnpm exec tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck apps/api/test/attendance-finalization-fixture.ts apps/api/test/attendance-finalization-database.test.ts
pnpm exec eslint apps/api/src apps/api/test packages/shared/src --max-warnings=0
pnpm exec prettier --check apps/api/src apps/api/test packages/shared/src docs/source-period-certification-and-finalization.md docs/step-73nb-verification.md
git diff --check
```

## Remaining activation blockers

- No actual Sunmi or generic SDK/device/firmware capability has been assessed or
  enrolled. Real devices therefore have no automatic-completeness authorization.
  Device-key trust, immutable native epochs/identities, dense inventories and
  reliable sealed-window semantics require concrete vendor/adapter evidence.
- Mixed-epoch windows and manifests exceeding the bounded V1 inventory cannot be
  automatically certified. They remain unresolved, not silently truncated/merged.
- Production source coverage, exception policy and independent artifact retention /
  verification procedures require review. Artifact commitments preserve human
  review provenance; the application does not automatically verify external files.
- Production migration/grant review, backups, restricted writer provisioning and
  real Office/VPS/WFH validation remain required before activation.
- Step 73M immutable-history and different-UUID reconciliation blockers are
  unchanged; no trigger bypass, destructive rewrite or UUID remapping was added.
- Desktop Attendance Management and payroll consumption of the new authoritative
  projection are separate future work. Existing local derived attendance and
  payroll source selection were not changed by this stage.
