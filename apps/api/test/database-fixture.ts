import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMigrations } from '../src/db/migrate.js';
export const databaseTestsEnabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_MIGRATION_DATABASE_URL,
);
export async function databaseFixture(
  dependencies = {
    createPool: (config: pg.PoolConfig) => new pg.Pool(config),
    readMigrations,
  },
) {
  const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  const runtimeUrl = process.env.TEST_DATABASE_URL;

  if (!migrationUrl || !runtimeUrl) {
    throw new Error('Explicit test database connections are required');
  }

  const migrationDb = new URL(migrationUrl);
  const runtimeDb = new URL(runtimeUrl);
  const migrationName = decodeURIComponent(migrationDb.pathname.slice(1));
  const runtimeName = decodeURIComponent(runtimeDb.pathname.slice(1));

  if (
    !/^(hexpayroll_test|hexpayroll_sync_test_[a-f0-9]{16}_(central|a|b))$/.test(migrationName) ||
    runtimeName !== migrationName ||
    migrationDb.hostname !== runtimeDb.hostname ||
    migrationDb.port !== runtimeDb.port
  ) {
    throw new Error('Integration tests must use the same dedicated hexpayroll_test database');
  }
  const name = 'hexpayroll_phase1_test_' + randomBytes(8).toString('hex');
  const owner = dependencies.createPool({ connectionString: migrationUrl });
  let migrator: pg.Pool | undefined;
  let runtime: pg.Pool | undefined;
  let schemaCreated = false;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      const attempt = async (work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          errors.push(error);
        }
      };
      if (runtime) await attempt(() => runtime!.end());
      if (migrator) await attempt(() => migrator!.end());
      if (schemaCreated) await attempt(() => owner.query(`DROP SCHEMA ${name} CASCADE`));
      await attempt(() => owner.end());
      if (errors.length) throw new AggregateError(errors, 'Test fixture cleanup failed');
    })());
  try {
    await owner.query(`CREATE SCHEMA ${name}`);
    schemaCreated = true;
    const options = `-c search_path=${name}`;
    // pg lets URL options override PoolConfig.options. Merge them explicitly so
    // startup role settings cannot silently discard isolated-schema selection.
    const schemaPool = (connectionString: string) => {
      const url = new URL(connectionString);
      const startupOptions = url.searchParams.get('options');
      if (!startupOptions) return dependencies.createPool({ connectionString, options });
      url.searchParams.delete('options');
      return dependencies.createPool({
        connectionString: url.toString(),
        options: `${startupOptions} ${options}`,
      });
    };
    migrator = schemaPool(migrationUrl);
    runtime = schemaPool(runtimeUrl);
    const role = (await runtime.query<{ current_user: string }>('SELECT current_user')).rows[0]!
      .current_user;
    if (role !== 'hexpayroll_app')
      throw new Error('Tests require the DML-only hexpayroll_app role');
    await owner.query(`GRANT USAGE ON SCHEMA ${name} TO hexpayroll_app`);
    await owner.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE hexpayroll_migrator IN SCHEMA ${name} GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO hexpayroll_app`,
    );
    const migrations = await dependencies.readMigrations(
      fileURLToPath(new URL('../../../database/migrations/', import.meta.url)),
    );
    return {
      migrator,
      runtime,
      migrations,
      close,
    };
  } catch (error) {
    // Cleanup must not replace the error that caused setup to fail.
    await close().catch(() => {});
    throw error;
  }
}
