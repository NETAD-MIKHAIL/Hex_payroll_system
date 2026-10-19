import 'dotenv/config';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate, readMigrations } from '../db/migrate.js';
import { fileURLToPath } from 'node:url';
// Create/drop only disposable test databases. Never target the payroll database.
const prefix = 'hexpayroll_sync_test_' + randomBytes(8).toString('hex');
const created: string[] = [];
let admin: pg.Pool | undefined;
try {
  const adminUrl = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
  if (
    !process.env.TEST_ADMIN_DATABASE_URL &&
    !['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname)
  )
    throw new Error('Explicit test admin connection required');
  adminUrl.pathname = '/postgres';
  admin = new pg.Pool({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000 });
  const migration = new URL(
    process.env.TEST_MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL ?? '',
  );
  const runtime = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LOG_LEVEL: 'silent',
    SYNC_MODE: 'disabled',
  };
  for (const name of ['central', 'a', 'b']) {
    const database = prefix + '_' + name;
    await admin.query(`CREATE DATABASE "${database}" OWNER hexpayroll_migrator`);
    created.push(database);
    migration.pathname = '/' + database;
    runtime.pathname = '/' + database;
    runtime.searchParams.set('options', '-c role=hexpayroll_app');
    childEnv['SYNC_TEST_' + name.toUpperCase() + '_RUNTIME'] = runtime.toString();
    childEnv['SYNC_TEST_' + name.toUpperCase() + '_MIGRATION'] = migration.toString();
  }
  childEnv.TEST_DATABASE_URL = childEnv.SYNC_TEST_CENTRAL_RUNTIME;
  childEnv.TEST_MIGRATION_DATABASE_URL = childEnv.SYNC_TEST_CENTRAL_MIGRATION;
  console.log('Created three disposable PostgreSQL databases: central, local A, local B');
  if (process.argv.includes('--schema')) {
    const schemaDb = new pg.Pool({ connectionString: childEnv.SYNC_TEST_CENTRAL_MIGRATION });
    try {
      await migrate(
        schemaDb,
        await readMigrations(
          fileURLToPath(new URL('../../../../database/migrations/', import.meta.url)),
        ),
      );
    } finally {
      await schemaDb.end();
    }
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['node_modules/tsx/dist/cli.mjs', 'src/cli/schema-pull.ts'],
        {
          stdio: 'inherit',
          env: { ...childEnv, MIGRATION_DATABASE_URL: childEnv.SYNC_TEST_CENTRAL_MIGRATION },
        },
      );
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
  } else {
    const files = process.argv.includes('--all')
      ? (await readdir('test')).filter((f) => f.endsWith('.test.ts')).map((f) => 'test/' + f)
      : ['test/central-sync.test.ts'];
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1', ...files],
        { stdio: 'inherit', env: childEnv },
      );
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
  }
} catch (error) {
  console.error(
    'Three-database integration failed:',
    error instanceof Error ? error.message : 'configuration error',
  );
  process.exitCode = 1;
} finally {
  if (admin) {
    for (const name of created.reverse()) {
      if (!['central', 'a', 'b'].some((suffix) => name === prefix + '_' + suffix)) {
        console.error('Unsafe cleanup target rejected');
        process.exitCode = 1;
        continue;
      }
      try {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } catch {
        console.error(`Disposable test database cleanup failed: ${name}`);
        process.exitCode = 1;
      }
    }
    await admin.end();
  }
}
