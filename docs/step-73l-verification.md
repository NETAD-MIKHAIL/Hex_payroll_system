# Step 73L verification — 2026-10-24

Status: **verified in the isolated test environment**. Real restricted-writer
central acceptance, HTTP v2 delivery and durable application converged onto two
independent enrolled local schemas for all four aggregates and all eleven actions.

| Check                                                     | Passed | Failed | Skipped |
| --------------------------------------------------------- | -----: | -----: | ------: |
| Complete API PostgreSQL and unit regression               |    218 |      0 |       0 |
| Existing baseline, included above                         |    201 |      0 |       0 |
| New PostgreSQL receiver integration tests, included above |     14 |      0 |       0 |
| New worker unit tests, included above                     |      3 |      0 |       0 |

Complete run: 392.896 seconds; 0 cancelled, 0 todo. Shared build, API typecheck,
strict TypeScript checks for the new test files, ESLint with zero warnings, and
formatting verification passed. Counts above are combined suite counts, not a
claim that all 218 tests are PostgreSQL-only tests.

The regression command was:

```powershell
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/src/cli/test-regression.ts
```

The runner loads the Git-ignored `apps/api/.env.test`, requires the dedicated test
acceptance writer and validates only `hexpayroll_test` connections. Fixtures use
random schemas and remove only those schemas. No credential was printed or added
to Git. No production migration/role, payroll_sys, payroll_central, VPS service or
hardware was modified. Existing payroll regressions were executed unchanged;
no payroll calculation functionality was implemented or enabled.

## Changes

- `database/migrations/0035_trusted_evidence_application.sql`: immutable bound
  application receipts, separate retry/conflict state, indexes and restricted
  application-table privileges. No new central-only migration is needed.
- `apps/api/src/sync/trusted-snapshots.ts`: exact accepted aggregate schemas,
  policy/actor attribution, immutable relationships, timezone and weekday identity
  validation. `client.ts` validates them before the atomic receipt/checkpoint write.
- `apps/api/src/sync/trusted-application.ts`: enrollment/organization gates,
  per-organization serialization, exact predecessor comparisons, revision CAS,
  direct aggregate/child/history projection, dependency retry and durable conflicts.
- `apps/api/src/sync/trusted-worker.ts`: opt-in local-only pull/application loop,
  bounded transport backoff, no overlapping ticks and awaited shutdown.
- `apps/api/src/config/env.ts`, `server.ts`, `apps/api/.env.example`: activation
  setting `SYNC_TRUSTED_EVIDENCE_ENABLED`, default false; independent v1 worker
  retained. No desktop acceptance-writer configuration was added.
- `apps/api/src/sync/service.ts`: protect new application-state entity names from
  generic synchronization; retain all existing account/evidence restrictions.
- `apps/api/src/timekeeping/schedule-identity.ts` and
  `central-evidence-acceptance.ts`: extract/re-export the existing deterministic
  weekday UUID function without changing its algorithm or acceptance behavior.
- `apps/api/test/trusted-application-database.test.ts`, `trusted-worker.test.ts`:
  17 new tests. `trusted-evidence-database.test.ts` supplies complete audit metadata
  in its older privileged test publication fixture for strict snapshot decoding.
- `docs/trusted-evidence-local-application.md`,
  `trusted-evidence-local-integration-plan.md` and this report: implementation,
  activation, dependency/conflict guidance and verified results.

## Demonstrated guarantees

- All eleven real central actions converge to the same IDs, revisions, audit
  actors, overnight rules, schedule versions/weekdays, assignment history/ranges
  and leave duration/policy snapshots on both local schemas.
- Outage recovery, separate v1/v2 cursors, fresh connection-pool recovery after
  receipt but before application, concurrent pulls/applications and historical
  replay produce one immutable application receipt per acceptance without
  reverting newer evidence. The worker cannot run in central or disabled mode.
- Entire-page validation rejects changed hashes, unsupported protocol/origin,
  foreign organization and structurally invalid snapshots even with recomputed
  hashes, leaving inbox and receipt cursor unchanged.
- Missing actors/employees defer durably and recover after explicit provisioning;
  revision gaps never become an unbound create. Independent aggregates progress.
- Existing local records, changed roots at unchanged revisions, immutable child
  drift, pending outbox work and overlapping local assignments remain durable
  conflicts without replacement or deletion of local work.
- Injected failures after seven schedule children and after assignment history but
  before the receipt roll back root revisions, children/history and receipts;
  subsequent retry commits once. Inbox receipt remains durable independently.
- Local schemas contain no central acceptance/publication tables. Receivers add
  no accounts/roles, outbox events, attendance records or processing jobs.
  Existing biometric ingestion and canonical authorization restrictions passed
  the full regression unchanged.

## Remaining dependencies and next stage

No blocker remains for the independently tested receiver implementation. Worker
activation is still off. A PC lacking a referenced central actor will retain
`MISSING_TRUSTED_ACTOR` until a reviewed trusted provisioning/distribution path
provides that identity; generic account sync remains suspended by Step 73J.
Existing locally authored schedule/leave evidence similarly requires explicit
operator reconciliation rather than automatic adoption. Neither prerequisite is
bypassed by this implementation.

Next integration work should address those rollout dependencies, then biometric
evidence completeness and central attendance validation/finalization, followed by
desktop workflow integration and reviewed real-device deployment. Production
rollout and payroll calculations remain outside this stage.
