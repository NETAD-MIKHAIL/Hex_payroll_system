# Central-only migrations

Place future VPS-only SQL migrations here, named `0001_example.sql`, independently
numbered from `database/migrations/`. Step 73G introduces the first storage-only
canonical attendance migration. See [its contract](../../docs/central-attendance-storage.md).

The existing `pnpm --filter @hexpayroll/api migrate` command reads only the shared
directory, non-recursively. Its migrations and `schema_migrations` ledger remain
unchanged. Do not move existing shared migrations into this directory.

The separate `pnpm --filter @hexpayroll/api migrate:central` command requires:

- `SYNC_MODE=central`
- `CENTRAL_MIGRATION_DATABASE_URL`: an explicit connection using a DDL-capable role
- `CENTRAL_MIGRATION_DATABASE_NAME`: the exact intended database name

There is no fallback to local connection variables. The command checks the URL
database name, then verifies the connected database identity and requires the
shared migration ledger to match all current shared migrations before central DDL.
Apply shared migrations separately first.

Central migrations use `central_schema_migrations` with the existing checksum,
transaction and ordering protections. Both runners use the same advisory lock
to prevent concurrent shared/central migration runs. History tables follow the
connection's search path, as in the existing runner; tests must use isolated schemas.

These are explicit operator target checks, not proof that a database is physically
on the VPS. Never configure the central command with a desktop database target.
No runtime server or desktop startup invokes this command automatically.

Future deployment packages must include this directory when enabling the central
command. Creating files does not deploy or run migrations. PostgreSQL isolation
and canonical-storage tests run exclusively against `hexpayroll_test`.
