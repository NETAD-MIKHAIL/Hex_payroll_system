import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { createSyncRouter } from '../src/sync/router.js';
test(
  'central explicitly refuses obsolete protocol; local refuses central endpoints',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      for (const central of [true, false]) {
        const app = express();
        app.use(express.json());
        app.use('/api', createSyncRouter(db.runtime, central));
        const server = app.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        try {
          const r = await fetch(`http://127.0.0.1:${address.port}/api/sync/pull`);
          assert.equal(r.status, central ? 426 : 404);
          assert.equal(
            (await db.runtime.query('SELECT count(*)::int n FROM sync_changes')).rows[0].n,
            0,
          );
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    } finally {
      await db.close();
    }
  },
);
