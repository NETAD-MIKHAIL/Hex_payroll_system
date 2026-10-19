import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { applyAccountEvent } from '../src/sync/inbox.js';
test(
  'legacy receiver cannot insert an authentication principal',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const c = await db.runtime.connect();
      try {
        await assert.rejects(
          applyAccountEvent(c, { payload: { passwordHash: 'secret', roles: ['administrator'] } }),
        );
        assert.equal((await c.query('SELECT count(*)::int n FROM auth_users')).rows[0].n, 0);
      } finally {
        c.release();
      }
    } finally {
      await db.close();
    }
  },
);
