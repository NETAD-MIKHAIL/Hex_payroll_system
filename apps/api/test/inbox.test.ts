import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { applyAccountEvent } from '../src/sync/inbox.js';
test('legacy account snapshots cannot change credentials or grant roles', async () => {
  let queries = 0;
  const c = {
    query() {
      queries++;
      throw new Error('No writes allowed');
    },
  } as unknown as PoolClient;
  await assert.rejects(
    applyAccountEvent(c, { payload: { passwordHash: 'secret', roles: ['administrator'] } }),
    /Account replication is disabled/,
  );
  assert.equal(queries, 0);
});
