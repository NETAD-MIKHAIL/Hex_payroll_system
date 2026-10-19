import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient, Pool } from 'pg';
import { enqueueAccount, queueAccountByUsername } from '../src/sync/accounts.js';
test('local account changes never query or export login credentials, sessions or roles', async () => {
  const c = {
    query() {
      throw new Error('Account synchronization must not query credentials');
    },
  } as unknown as PoolClient;
  assert.deepEqual(await enqueueAccount(c, 'local-user'), { eventId: null, status: 'local_only' });
  await assert.rejects(
    queueAccountByUsername(c as unknown as Pool, 'local-user'),
    /Provision login accounts separately/,
  );
});
