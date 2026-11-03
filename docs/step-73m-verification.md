# Step 73M verification — 2026-10-24

Status: **implemented and verified in isolated testing**, with the explicit
incompatible-history and different-UUID reconciliation blockers below. This is
working identity delivery and operator reconciliation code, not a review-only stage.
No production deployment or worker activation was performed.

| Verification                                         | Passed | Failed | Skipped |
| ---------------------------------------------------- | -----: | -----: | ------: |
| Complete PostgreSQL and unit regression              |    236 |      0 |       0 |
| Retained baseline cases, included above              |    218 |      0 |       0 |
| New identity integration cases, included above       |      9 |      0 |       0 |
| New reconciliation integration cases, included above |      9 |      0 |       0 |

Full run: 542.356 seconds, 0 cancelled, 0 todo. The complete suite includes both
PostgreSQL integration and unit tests; 236 is not a PostgreSQL-only count.
The 18 new cases are isolated PostgreSQL integration tests. Shared build, API
typecheck, strict TypeScript checking of the new test/fixture files, ESLint with
zero warnings, formatting and `git diff --check` passed.

Command used for the complete run:

```powershell
cd D:\hexpayrollsys
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/src/cli/test-regression.ts
```

The runner loaded only the ignored `apps/api/.env.test` and validated the dedicated
test database/writer configuration. Every fixture used random isolated schemas in
`hexpayroll_test`. Existing test writer grants were scoped to those schemas; no
cluster role creation or production grant was executed. Credentials were neither
printed nor committed. PostgreSQL production databases, VPS services/roles,
hardware and production configuration were untouched.

## Implemented and demonstrated

1. An internal restricted-writer command reauthenticates the current central node
   and session, checks existing `users.update` / `users.disable` permissions and
   publishes only the current central account's minimal identity fields. It cannot
   create/change accounts, credentials or grants. Ordinary runtime/owner pools and
   node-only claims fail closed.
2. Immutable publication binds organization, user UUID, exact request identity,
   current account revision, contiguous identity revision, canonical snapshot/hash,
   publisher, enrolled node and timestamp. CAS, concurrent retries, rollback and
   source edits without revisions were tested.
3. The separate v2 `central.identity` stream preserves existing evidence/v1
   protocols and cursors. Whole-page validation and atomic inbox/checkpoint writes
   reject forged/tampered/foreign snapshots before cursor advancement.
4. On two independently enrolled local schemas, real worker ticks install exact
   central actor references and automatically recover `MISSING_TRUSTED_ACTOR`
   evidence without outbox echo. Durable receipts, concurrent delivery, missing
   revisions, organization collisions, outage recovery and rollback were exercised.
5. New actors are explicitly attribution-only: NULL verifier, inactive local login,
   no roles/sessions and no conversion to a login account. Database guards enforce
   this boundary. Received central deactivation denies future local authentication
   and protected actions while preserving historical actor UUIDs and credentials
   of independently provisioned accounts. Reactivation never supplies missing
   credentials or grants.
6. Authenticated local inspection shows competing local/central UUIDs, revisions,
   content, immutable predecessor and pending outbox work. Reconciliation requires
   a fresh real operator session, current administrator role/action permission,
   nonempty reason and exact inspected fingerprints. Node tokens cannot repair data.
7. `preserveLocal` creates an immutable hold. `useCentral` can repair compatible
   conflicts at a bound UUID using only already accepted central content. Complete
   local snapshots and pending outbox content are retained in the audit. Root CAS,
   trusted application receipt, reconciliation receipt and held-outbox bindings
   commit or roll back together. Exact retries return the same result. Future
   accepted revisions ignore only exact reviewed outbox content; unreviewed edits
   become conflicts again. No outbox entry is marked delivered or deleted.
8. Schedule, assignment, leave-type and leave-request root conflict cases were
   exercised. Immutable child/history conflicts remain blocked, with original data
   intact. Competing different local UUIDs are exposed and audited, never silently
   deleted, closed, renamed or remapped.

## Security correction to the retained regression

Inspection found that the legacy generic account materializer could still apply
pre-Step-73J downloaded account snapshots. Step 73M removes that write path:
`applyAccountEvent` now always quarantines before any database account/credential/
role operation. Quarantined heads do not starve unrelated generic evidence batches;
their inbox records remain unapplied for operator review. Generic account outbox
push/pull restrictions remain in force.

All 218 baseline test cases remain present. Five legacy account-inbox cases were
tightened to assert the now-required quarantine contract rather than obsolete peer
credential/role provisioning. They still cover account preservation, same-entity
ordering, bounded batches and no writes/echo. No tests were removed or skipped and
no authorization, immutable evidence, CAS or rollback guarantee was weakened.
Previously applied account changes cannot be automatically assumed trustworthy;
their review remains a deployment prerequisite.

## Migrations and changed files

| Area                                          | Files                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared migrations                             | `database/migrations/0036_trusted_actor_identities.sql`, `0037_evidence_reconciliation.sql`                                                                               |
| Central-only migration                        | `database/central-migrations/0005_trusted_identity_publication.sql`                                                                                                       |
| New identity services/protocol                | `apps/api/src/sync/central-identities.ts`, `trusted-identity-protocol.ts`, `trusted-identities.ts`                                                                        |
| New reconciliation service                    | `apps/api/src/sync/evidence-reconciliation.ts`                                                                                                                            |
| Worker, projection and transport restrictions | `apps/api/src/sync/trusted-worker.ts`, `trusted-application.ts`, `inbox.ts`, `service.ts`                                                                                 |
| API wiring and operator endpoints             | `apps/api/src/app.ts`, `apps/api/src/sync/router.ts`                                                                                                                      |
| Authentication and schema model               | `apps/api/src/auth/service.ts`, `apps/api/src/foundation/repository.ts`, `apps/api/src/db/generated/schema.ts`                                                            |
| Explicit restricted-writer provisioning       | `apps/api/src/timekeeping/central-evidence-writer.ts`                                                                                                                     |
| New tests and fixture                         | `apps/api/test/trusted-identities-database.test.ts`, `evidence-reconciliation-database.test.ts`, `trusted-identity-fixture.ts`                                            |
| Stricter retained account quarantine tests    | `apps/api/test/inbox-database.test.ts`, `inbox.test.ts`                                                                                                                   |
| Documentation                                 | `docs/trusted-identities-and-reconciliation.md`, `central-account-sync-security.md`, `trusted-evidence-protocol.md`, `trusted-evidence-local-application.md`, this report |

No new production role name, acceptance-writer desktop credential, public identity
publication endpoint or additional activation flag was introduced. Identity delivery
runs under the existing explicitly enabled **local-only** trusted worker;
`SYNC_TRUSTED_EVIDENCE_ENABLED=false` remains the default. The central identity
publisher is an internal command requiring a separately provisioned server pool and
current central credentials; it is not called with the ordinary API runtime role.

## Remaining rollout blockers and next work

- `RECONCILIATION_IMMUTABLE_CHILD_BLOCKER` / `RECONCILIATION_IMMUTABLE_HISTORY_BLOCKER`:
  independently authored versions, weekdays or assignment history differ from
  central accepted evidence. They cannot be overwritten/deleted through normal
  application privileges. A reviewed migration/reconciliation policy must preserve
  their historical references. No owner credential or trigger bypass is provided.
- `RECONCILIATION_UNBOUND_AGGREGATE`: another local UUID collides by code or employee
  date range. This command does not have authorization to mutate that other
  aggregate. Inspection and an audited hold are supported; explicit resolution of
  that identity is required before convergence can complete for that event.
- Existing actor/login UUID mappings and previously applied generic account changes
  require security review. Identity-only references unblock attendance attribution,
  but general login credential/RBAC enrollment is not distributed by this path.
- Production rollout still requires backups, reviewed migrations and restricted
  writer grants, central command/workflow integration and real Office/VPS/WFH
  validation before enabling the trusted worker.

The implementation does not finalize attendance, modify biometric collection, add
desktop UI or implement payroll calculations. Existing payroll regressions were run
unchanged as part of the retained suite. Next attendance work can build on tested
identity delivery and compatible reconciliation, while the listed incompatible data
cases remain explicit rather than bypassed.

See [protocol, authorization, endpoint and reconciliation details](trusted-identities-and-reconciliation.md).
