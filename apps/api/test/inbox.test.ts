import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { applyAccountEvent } from '../src/sync/inbox.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const org = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const payload = {
  id,
  organizationId: org,
  username: 'stef',
  email: null,
  displayName: 'Stef',
  passwordHash: DUMMY_PASSWORD_HASH,
  active: true,
  revision: 1,
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
  roles: ['viewer'],
};
const event = {
  entity_type: 'auth_users',
  organization_id: org,
  sequence: '10',
  entity_id: id,
  operation: 'CREATE',
  revision: 1,
  payload_version: 1,
  payload,
};

test('generic account quarantine rejects invalid identities, plaintext verifiers and active archives before writes', async () => {
  const client = {
    query() {
      throw new Error('Unexpected database access');
    },
  } as unknown as PoolClient;
  for (const invalid of [
    { ...event, entity_id: org },
    { ...event, payload_version: 2 },
    { ...event, operation: 'ARCHIVE' },
    { ...event, payload: { ...payload, passwordHash: 'plaintext' } },
  ])
    await assert.rejects(
      applyAccountEvent(client, invalid),
      /Generic account distribution is suspended/,
    );
});

test('valid generic account snapshots cannot create credentials, users or role assignments', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      return { rows: sql.includes('FROM roles') ? [{ id: org, code: 'viewer' }] : [] };
    },
  } as unknown as PoolClient;
  await assert.rejects(
    applyAccountEvent(client, event),
    /Generic account distribution is suspended/,
  );
  assert.equal(calls.length, 0);
});
