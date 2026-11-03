# Step 73O — Attendance Management desktop verification

Implemented and verified on 2026-10-29 using isolated `hexpayroll_test` schemas.
Production databases, roles, services, hardware and activation settings were not changed.

## Operator workflow

The existing Electron renderer now exposes **Attendance Management** through its
existing navigation, authentication, API client and React Query cache. The daily
view filters employees and dates and displays stored schedule, overnight shift,
break, grace, leave, punch and attendance results. React formats backend values;
it does not calculate attendance or select payroll sources.

Local provisional attendance, the latest trusted result received on this PC, and
the currently authenticated central state have separate displays. Receipt,
certification, limited-evidence authorization and final approval remain distinct.
An unavailable central connection cannot turn a queued request into approval.

Operators can inspect immutable evidence, certify the source window, prepare a
central proposal, finalize, reopen, and submit a policy-bound exception decision.
Each command requires confirmation and a reason. Certification/proposal selection
is bound to the selected employee and date. Revision conflicts and stale evidence
are returned without overwriting data. Exception evidence commitments and the
Step 73N-B independent-review and source-completeness restrictions still apply.

The biometric view exposes raw and unmapped punches, device checkpoints, delivery
attempts, central receipts, signed closures, missing native ranges, dependencies
and reconciliation holds. Authorized local capture and signed-closure import use
the existing ingestion endpoints. Existing Time Records supports manual evidence
collection; the new interface does not grant local finalization authority.

The audit view exposes local revisions, trusted applications, central decisions,
exceptions and command outcomes. Received snapshots and local history can be
inspected offline. Central historical snapshots require current authorization.
Recent lists are bounded (including 50 central history entries, 100 local history
entries and 500 raw punches); full available snapshots are retrieved by immutable
identity. This is an operator workspace, not an unlimited audit export.

## API and security boundaries

- `/api/timekeeping/attendance-management`: authenticated local days, detail,
  monitoring, full local evidence and request-ID endpoints.
- Its `central/connection`, `central/login`, `central/disconnect`,
  `central/workspace`, `central/evidence` and `central/command` endpoints form the
  same-origin bridge to the configured central service.
- `/sync/attendance/workspace` and `/sync/attendance/evidence` add authenticated,
  organization-scoped central reads beside the existing finalization commands.
- Central sessions are separate from local sessions. Tokens and enrollment
  credentials stay in the local API, never in the renderer or browser storage.
  The bridge binding expires with either session and is forgotten on API restart.
  Disconnect removes that binding and attempts central session revocation; the
  API reports whether remote revocation was confirmed.
- Every command checks current local and central permissions. The existing
  restricted canonical writer still reauthenticates in its write transaction.
  Generic runtime, local nodes and v1 synchronization gain no writer capability.
- A failed or lost response is journaled as unconfirmed. Exact operator-requested
  retries retain the same identity and payload. Restart preserves the journal,
  requires central sign-in again, and does not automatically replay approvals.
- User/organization/permission changes clear attendance query data. Central session
  expiry is reported separately and does not silently invalidate the local session.

New migration: `database/migrations/0040_attendance_desktop_requests.sql` creates
append-only desktop request and outcome journals. These records convey transport
intent, not approval. Both are protected from generic synchronization. No central
migration or production role change was added by this step. Optional reasons on
existing certification/proposal commands preserve desktop rationale centrally.

## Verification

| Check                                                                   | Result                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| Complete API regression                                                 | **284 passed, 0 failed, 0 skipped** (280 baseline + 4 new) |
| Final desktop API tests after offline history inspection addition       | **4 passed, 0 failed, 0 skipped**                          |
| Complete frontend suite                                                 | **16 passed, 0 failed, 0 skipped**                         |
| Shared build                                                            | Passed                                                     |
| Frontend production build                                               | Passed                                                     |
| Frontend, API and desktop typechecks                                    | Passed                                                     |
| Strict typecheck of new API test fixture and cases                      | Passed                                                     |
| ESLint: API/frontend source and tests, shared source, Playwright config | Passed                                                     |
| Prettier: Step 73O implementation files, frontend tests and this report | Passed                                                     |
| `git diff --check`                                                      | Passed                                                     |

The complete API run preceded the final read-only offline historical-inspection
endpoint; all four desktop integration cases and the complete frontend suite were
rerun after that addition. Logs are under `.diagnostics/step-73o-*.log`.

Frontend coverage comprises six browser/component cases and one real HTTP/database
workflow, alongside the existing frontend suite. The live workflow uses simulated
signed source inputs and three isolated PostgreSQL schemas: offline Office capture,
reconnection, central receipt, closure certification, central proposal and approval,
trusted delivery to Office and WFH, offline WFH snapshot inspection, and reopening.
The integration cases also exercise organization isolation, permission removal,
expired central sessions, response loss after commit, exact retries, altered retry
rejection, mismatched employee selection, restart and historical replay inspection.
Component cases cover unsupported sources, evidence commitments, disabled offline
actions, confirmations, concurrent/stale errors and permission changes.

Visual verification used the actual rendered workflow, not static mock screens:

- [Office workflow screenshot](../.diagnostics/attendance-management-office.png)
- [WFH received approval screenshot](../.diagnostics/attendance-management-wfh.png)

The repository-wide `eslint .` additionally reports 11 existing errors in
`.diagnostics/adms/receiver.cjs`. Repository-wide `prettier --check .` reports 18
existing files outside the verified source scope, including that diagnostic script,
configuration files and older setup documents. The broad source formatting check
also includes the existing `apps/web/src/vite-env.d.ts` formatting warning. Those
unrelated files were not rewritten. The Step 73O implementation files pass both
checks.

## Remaining rollout prerequisites

No missing backend endpoint blocks the supported isolated operator workflow.
Packaged Electron and physical-device acceptance testing remain pilot work; browser
tests exercise the same renderer and real API but do not certify installed Windows
packaging or a biometric SDK.

Before real testing, review backups/restore, migrations, restricted central writer
provisioning, HTTPS, organization/node enrollment, trusted actor references and
source coverage/policy configuration. Assess the actual device/SDK capability and
closure proof; unsupported sources must retain explicit audited limitations.
Review activation of the existing biometric, trusted-evidence and attendance
finalization flags and worker configuration. Their production defaults remain off.

Step 73M immutable-history/different-UUID reconciliation blockers remain durable
and unresolved. No payroll calculation or payroll source-selection change is part
of this implementation. Real `payroll_sys`, VPS `payroll_central` and physical
hardware still require the separately reviewed controlled pilot.
