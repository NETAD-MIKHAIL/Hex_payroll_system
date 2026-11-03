import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate, migrateCentral, readMigrations, migrationChecksum } from '../src/db/migrate.js';

const target = { mode: 'central' as const, expectedDatabase: 'hexpayroll_test' };
const migration = (name: string, sql: string) => ({ name, sql, checksum: migrationChecksum(sql) });
async function exists(db: Awaited<ReturnType<typeof databaseFixture>>, name: string) {
  return (await db.migrator.query('SELECT to_regclass($1) IS NOT NULL AS present', [name])).rows[0]
    .present;
}

test(
  'desktop migration discovery excludes central SQL and the existing shared path excludes the central ledger',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    const root = await mkdtemp(join(tmpdir(), 'hexpayroll-migration-isolation-'));
    try {
      const sharedDir = join(root, 'migrations');
      const centralDir = join(root, 'central-migrations');
      await mkdir(sharedDir);
      await mkdir(centralDir);
      await mkdir(join(sharedDir, 'central'));
      await writeFile(
        join(sharedDir, '0001_shared_probe.sql'),
        'CREATE TABLE shared_probe(id integer);',
      );
      await writeFile(
        join(centralDir, '0001_central_probe.sql'),
        'CREATE TABLE central_probe(id integer);',
      );
      await writeFile(
        join(sharedDir, 'central', '0001_nested_probe.sql'),
        'CREATE TABLE nested_probe(id integer);',
      );
      const shared = await readMigrations(sharedDir);
      assert.deepEqual(
        shared.map((m) => m.name),
        ['0001_shared_probe.sql'],
      );
      await migrate(db.migrator, shared);
      assert.equal(await exists(db, 'shared_probe'), true);
      assert.equal(await exists(db, 'central_probe'), false);
      assert.equal(await exists(db, 'nested_probe'), false);
      assert.equal(await exists(db, 'central_schema_migrations'), false);
      // Actual desktop discovery still uses only the committed shared directory.
      const committed = await readMigrations(
        fileURLToPath(new URL('../../../database/migrations/', import.meta.url)),
      );
      assert.deepEqual(committed, db.migrations);
      assert.deepEqual(
        (await readMigrations(centralDir)).map((m) => m.name),
        ['0001_central_probe.sql'],
      );
    } finally {
      await db.close();
      // Delete only the exact temporary directory created by this test.
      const resolvedRoot = resolve(root);
      assert.equal(dirname(resolvedRoot), resolve(tmpdir()));
      assert.ok(basename(resolvedRoot).startsWith('hexpayroll-migration-isolation-'));
      await rm(resolvedRoot, { recursive: true, force: true });
    }
  },
);

test(
  'central migrations keep independent history, replay safely and retain checksum and ordering safeguards',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const sharedHistory = (
        await db.migrator.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows;
      const central = [
        migration('0001_central_probe.sql', 'CREATE TABLE central_probe(id integer PRIMARY KEY);'),
      ];
      assert.deepEqual(await migrateCentral(db.migrator, central, db.migrations, target), [
        central[0]!.name,
      ]);
      assert.equal(await exists(db, 'central_probe'), true);
      const history = (
        await db.migrator.query('SELECT * FROM central_schema_migrations ORDER BY name')
      ).rows;
      assert.equal(history.length, 1);
      assert.equal(history[0].name, central[0]!.name);
      assert.equal(history[0].checksum, central[0]!.checksum);
      assert.deepEqual(await migrateCentral(db.migrator, central, db.migrations, target), []);
      assert.deepEqual(await migrate(db.migrator, db.migrations), []);
      assert.deepEqual(
        (await db.migrator.query('SELECT * FROM schema_migrations ORDER BY name')).rows,
        sharedHistory,
      );
      assert.deepEqual(
        (await db.migrator.query('SELECT * FROM central_schema_migrations ORDER BY name')).rows,
        history,
      );
      await assert.rejects(
        migrateCentral(
          db.migrator,
          [migration(central[0]!.name, 'SELECT 1;')],
          db.migrations,
          target,
        ),
        /changed or missing/,
      );
      await assert.rejects(
        migrateCentral(db.migrator, [], db.migrations, target),
        /changed or missing/,
      );
      await assert.rejects(
        migrateCentral(
          db.migrator,
          [migration('0000_earlier.sql', 'CREATE TABLE must_not_exist(id integer);'), ...central],
          db.migrations,
          target,
        ),
        /Out-of-order/,
      );
      assert.equal(await exists(db, 'must_not_exist'), false);
    } finally {
      await db.close();
    }
  },
);

test(
  'central safety gates reject local modes, wrong targets and incomplete shared history before central DDL',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      const central = [migration('0001_guarded.sql', 'CREATE TABLE guarded_probe(id integer);')];
      for (const invalid of [
        { ...target, mode: 'local' as const },
        { ...target, mode: 'disabled' as const },
        { ...target, expectedDatabase: '' },
        { ...target, expectedDatabase: 'payroll_sys' },
      ]) {
        // The wrong target is a comparison only: the fixture still connects solely to hexpayroll_test.
        await assert.rejects(
          migrateCentral(db.migrator, central, db.migrations, invalid),
          /Central migration/,
        );
        assert.equal(await exists(db, 'central_schema_migrations'), false);
      }
      await assert.rejects(migrateCentral(db.migrator, central, db.migrations, target));
      assert.equal(await exists(db, 'central_schema_migrations'), false);
      await migrate(db.migrator, db.migrations);
      for (const incomplete of [
        [],
        db.migrations.slice(1),
        [{ ...db.migrations[0]!, checksum: '0'.repeat(64) }, ...db.migrations.slice(1)],
      ]) {
        await assert.rejects(
          migrateCentral(db.migrator, central, incomplete, target),
          /current shared migrations/,
        );
        assert.equal(await exists(db, 'central_schema_migrations'), false);
      }
      assert.equal(await exists(db, 'guarded_probe'), false);
      // A rejected gate must release the migration lock for the next valid operation.
      assert.deepEqual(await migrateCentral(db.migrator, central, db.migrations, target), [
        central[0]!.name,
      ]);
    } finally {
      await db.close();
    }
  },
);

test(
  'failed central migrations roll back their SQL and history and can be safely retried',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const first = migration(
        '0001_committed.sql',
        'CREATE TABLE committed_probe(id integer); INSERT INTO committed_probe VALUES(1);',
      );
      const failed = migration(
        '0002_retry.sql',
        `CREATE TABLE rollback_probe(id integer);
        INSERT INTO committed_probe VALUES(2); SELECT 1/0;`,
      );
      await assert.rejects(
        migrateCentral(db.migrator, [first, failed], db.migrations, target),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, '22012');
          return true;
        },
      );
      assert.equal(await exists(db, 'rollback_probe'), false);
      assert.deepEqual((await db.migrator.query('SELECT id FROM committed_probe')).rows, [
        { id: 1 },
      ]);
      assert.deepEqual(
        (await db.migrator.query('SELECT name FROM central_schema_migrations ORDER BY name')).rows,
        [{ name: first.name }],
      );
      const repaired = migration(
        failed.name,
        'CREATE TABLE rollback_probe(id integer); INSERT INTO committed_probe VALUES(2);',
      );
      assert.deepEqual(
        await migrateCentral(db.migrator, [first, repaired], db.migrations, target),
        [repaired.name],
      );
      assert.deepEqual(
        (await db.migrator.query('SELECT id FROM committed_probe ORDER BY id')).rows,
        [{ id: 1 }, { id: 2 }],
      );
      assert.deepEqual(
        await migrateCentral(db.migrator, [first, repaired], db.migrations, target),
        [],
      );
      assert.deepEqual(await migrate(db.migrator, db.migrations), []);
    } finally {
      await db.close();
    }
  },
);
