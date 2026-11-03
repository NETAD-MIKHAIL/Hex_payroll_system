import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createCentralEvidenceAcceptanceService,
  scheduleWeekdayId,
} from '../src/timekeeping/central-evidence-acceptance.js';

test('acceptance rejects local mode and forged credentials before connecting', async () => {
  const pool = {
    connect() {
      throw new Error('Must not connect');
    },
  } as unknown as Pool;
  const credentials = { nodeToken: 'a'.repeat(43), sessionToken: 'b'.repeat(43) };
  await assert.rejects(createCentralEvidenceAcceptanceService(pool, 'local')(credentials, {}), {
    code: 'CENTRAL_ONLY',
  });
  await assert.rejects(
    createCentralEvidenceAcceptanceService(pool, 'central')(
      { ...credentials, roles: ['administrator'] },
      {},
    ),
    { code: 'AUTH_INVALID' },
  );
  await assert.rejects(
    createCentralEvidenceAcceptanceService(pool, 'central')(credentials, {
      authorizationDecisionId: randomUUID(),
      request: {},
      actorUserId: randomUUID(),
    }),
    { code: 'INVALID_REQUEST' },
  );
});
test('weekday identity is deterministic per immutable version and weekday with UUIDv8 variant', () => {
  const version = randomUUID();
  const ids = Array.from({ length: 7 }, (_, day) => scheduleWeekdayId(version, day));
  assert.equal(new Set(ids).size, 7);
  assert.equal(ids[0], scheduleWeekdayId(version.toUpperCase(), 0));
  assert.notEqual(ids[0], scheduleWeekdayId(randomUUID(), 0));
  assert.match(ids[0]!, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
