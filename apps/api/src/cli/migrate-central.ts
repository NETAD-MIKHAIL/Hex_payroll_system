import 'dotenv/config';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { migrateCentral, readMigrations, MigrationHistoryError } from '../db/migrate.js';
import { migrationErrorMessage } from './migration-error.js';

async function main() {
  // No fallback to the desktop DATABASE_URL or MIGRATION_DATABASE_URL.
  const connectionString = process.env.CENTRAL_MIGRATION_DATABASE_URL;
  const expectedDatabase = process.env.CENTRAL_MIGRATION_DATABASE_NAME;
  if (process.env.SYNC_MODE !== 'central' || !connectionString || !expectedDatabase?.trim()) {
    throw new MigrationHistoryError(
      'Central migrations require SYNC_MODE=central, CENTRAL_MIGRATION_DATABASE_URL and CENTRAL_MIGRATION_DATABASE_NAME',
    );
  }
  const target = new URL(connectionString);
  if (decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase) {
    throw new MigrationHistoryError('Central migration URL must name the explicit target database');
  }
  const [migrations, shared] = await Promise.all([
    readMigrations(
      fileURLToPath(new URL('../../../../database/central-migrations/', import.meta.url)),
    ),
    readMigrations(fileURLToPath(new URL('../../../../database/migrations/', import.meta.url))),
  ]);
  const database = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    const applied = await migrateCentral(database, migrations, shared, {
      mode: 'central',
      expectedDatabase,
    });
    console.log(
      applied.length
        ? `Applied central migrations: ${applied.join(', ')}`
        : 'Central migrations are current.',
    );
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    migrationErrorMessage(error).replaceAll(
      'MIGRATION_DATABASE_URL',
      'CENTRAL_MIGRATION_DATABASE_URL',
    ),
  );
  process.exitCode = 1;
});
