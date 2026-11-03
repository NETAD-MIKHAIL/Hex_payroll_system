import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}
export class MigrationHistoryError extends Error {}
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}
export async function readMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const migrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      return { name, sql, checksum: migrationChecksum(sql) };
    }),
  );
  if (new Set(names.map((name) => name.split('_')[0])).size !== names.length)
    throw new MigrationHistoryError('Duplicate migration number');
  return migrations;
}
export async function migrate(database: Pool, migrations: Migration[]): Promise<string[]> {
  return runMigrations(database, migrations, 'schema_migrations');
}

export interface CentralMigrationTarget {
  mode: 'central' | 'local' | 'disabled';
  expectedDatabase: string;
}

export async function migrateCentral(
  database: Pool,
  migrations: Migration[],
  sharedMigrations: Migration[],
  target: CentralMigrationTarget,
): Promise<string[]> {
  if (target.mode !== 'central' || !target.expectedDatabase.trim()) {
    throw new MigrationHistoryError(
      'Central migrations require central mode and an explicit database name',
    );
  }
  return runMigrations(database, migrations, 'central_schema_migrations', async (client) => {
    const identity = await client.query<{ database: string }>(
      'SELECT current_database() AS database',
    );
    if (identity.rows[0]?.database !== target.expectedDatabase) {
      throw new MigrationHistoryError(
        'Central migration database does not match the explicit target',
      );
    }
    // Fail before central DDL: shared migrations must already be installed and current.
    const existing = await client.query<{ name: string; checksum: string }>(
      'SELECT name,checksum FROM schema_migrations ORDER BY name',
    );
    if (
      !sharedMigrations.length ||
      existing.rows.length !== sharedMigrations.length ||
      sharedMigrations.some(
        (source) =>
          !existing.rows.some(
            (row) => row.name === source.name && row.checksum === source.checksum,
          ),
      )
    ) {
      throw new MigrationHistoryError(
        'Apply the current shared migrations before central migrations',
      );
    }
  });
}

async function runMigrations(
  database: Pool,
  migrations: Migration[],
  ledger: 'schema_migrations' | 'central_schema_migrations',
  verify?: (client: PoolClient) => Promise<void>,
): Promise<string[]> {
  const client = await database.connect();
  const applied: string[] = [];
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(684297103)');
    locked = true;
    if (verify) await verify(client);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${ledger} (name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const existing = await client.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${ledger} ORDER BY name`,
    );
    for (const row of existing.rows) {
      const source = migrations.find((migration) => migration.name === row.name);
      if (!source || source.checksum !== row.checksum)
        throw new MigrationHistoryError(`Applied migration changed or missing: ${row.name}`);
    }
    for (const migration of migrations) {
      if (existing.rows.some((row) => row.name === migration.name)) continue;
      if (existing.rows.some((row) => row.name > migration.name))
        throw new MigrationHistoryError(`Out-of-order migration: ${migration.name}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(`INSERT INTO ${ledger} (name,checksum) VALUES ($1,$2)`, [
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(684297103)').catch(() => undefined);
    client.release();
  }
}
