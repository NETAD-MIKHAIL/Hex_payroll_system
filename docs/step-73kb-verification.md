# Step 73K-B verification — 2026-10-24

Status: **verified**. The final complete existing API suite passed **201/201**,
with **0 failed, 0 skipped, 0 cancelled**. This includes all PostgreSQL integration
files, the original 115-test baseline, all acceptance-writer tests and unit tests.
Counts are for the combined suite, not PostgreSQL-only tests. Runtime: 272.448 seconds.

The dedicated acceptance writer was loaded from the locally configured, Git-ignored
apps/api/.env.test. No credential was printed or committed. All database fixtures
targeted hexpayroll_test and used random isolated schemas. No production database,
role provisioning, VPS service, deployment or hardware operation was performed.

## Regressions investigated and fixed

The broader first run exposed three legacy test fixtures creating users before
establishing the installation organization. Account export correctly rejected those
unscoped users. database.test.ts, timekeeping-database.test.ts and
payroll-database.test.ts now establish their isolated organization first. No account
ownership, permission or synchronization rule was relaxed.

The health unit-test import required a runtime DATABASE_URL. A dedicated regression
runner now loads only the explicit test configuration, validates the test database
targets, and binds DATABASE_URL to TEST_DATABASE_URL for child tests. There is no
fallback to production credentials. The default run requires the separate test
writer URL. The explicit --allow-missing-writer diagnostic option is not a complete
verification run and was not used for the final run. Windows loader imports use a
file URL. Configuration parser failures report fixed text rather than secret URLs.

Prettier found 22 previously unformatted attendance implementation/test files;
formatting-only changes were applied. No business authorization, immutable evidence,
CAS, idempotency, transaction or writer capability semantics changed in this turn.
No new payroll calculation implementation was added; existing payroll tests ran.

## Checks and exact commands

Run from D:\hexpayrollsys with the dedicated test configuration present locally:

```powershell
pnpm --filter @hexpayroll/shared build
pnpm --filter @hexpayroll/api typecheck
pnpm exec eslint apps/api/src apps/api/test packages/shared/src
pnpm exec prettier --check apps/api/src apps/api/test packages/shared/src apps/api/package.json docs/central-evidence-acceptance.md docs/trusted-evidence-protocol.md docs/trusted-evidence-local-integration-plan.md docs/step-73kb-verification.md
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/src/cli/test-regression.ts
```

The last command produced 201 passed, 0 failed, 0 skipped. The package alias is
`pnpm --filter @hexpayroll/api test:regression`. Tests run serially in their own
processes. Shared build, API typecheck, ESLint and formatting passed. Separate strict
TypeScript checking of the acceptance unit/database tests and fixture also passed.
A final runner configuration smoke check passed both selected acceptance unit tests.
The sandbox initially blocked test subprocesses with spawn EPERM; authorized execution
outside the sandbox retained the same isolated test target checks.

## Changed files and next stage

Functional test/setup changes:

- apps/api/src/cli/test-regression.ts: complete test discovery, safe test-only runtime
  configuration, required writer configuration, Windows-compatible runner.
- apps/api/package.json: test:regression command.
- apps/api/test/database.test.ts: scoped account fixture setup.
- apps/api/test/timekeeping-database.test.ts: scoped account fixture setup.
- apps/api/test/payroll-database.test.ts: scoped account fixture setup.

Documentation: central-evidence-acceptance.md now records verified status;
trusted-evidence-local-integration-plan.md prepares the next implementation; this
file records reproducible verification. The other 22 formatting changes are limited
to existing API attendance/migration code and tests.

Next: trusted v2 local-mode pull worker, strict aggregate snapshot handlers and
separate durable application receipts. Preserve atomic receipt inbox/checkpoint
updates, CAS/replay safety, missing-dependency retry, history and no outbox echo.
Account/actor provisioning remains an explicit dependency; no synthetic users or
permission grants may be introduced to bypass it. This stage is prepared, not
implemented or activated. Canonical attendance finalization, UI and deployment
remain separate work; payroll calculations are outside the next stage.
