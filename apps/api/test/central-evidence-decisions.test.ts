import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  canonicalEvidenceJson,
  parseEvidenceDecision,
  createCentralEvidenceDecisionService,
} from '../src/timekeeping/central-evidence-decisions.js';

const request = () => ({
  version: 1,
  requestId: randomUUID(),
  organizationId: randomUUID(),
  entityId: randomUUID(),
  action: 'leaveType.create',
  expectedRevision: 0,
  payload: {
    code: 'VL',
    name: 'Vacation',
    description: null,
    status: 'active',
    paid: true,
    requiresApproval: true,
  },
});
test('evidence canonicalization sorts object keys recursively and retains array order and scalar types', () => {
  assert.equal(
    canonicalEvidenceJson({ b: [2, { z: 0, a: true }], a: null }),
    '{"a":null,"b":[2,{"a":true,"z":0}]}',
  );
  assert.notEqual(canonicalEvidenceJson([1, 2]), canonicalEvidenceJson([2, 1]));
  assert.notEqual(canonicalEvidenceJson('1'), canonicalEvidenceJson(1));
});
test('evidence request rejects identity claims, invalid action and revision semantics', () => {
  for (const value of [
    { ...request(), userId: randomUUID() },
    { ...request(), version: 2 },
    { ...request(), expectedRevision: 1 },
    { ...request(), action: 'leave.approve' },
    { ...request(), payload: { ...request().payload, approvedBy: randomUUID() } },
  ])
    assert.throws(() => parseEvidenceDecision(value));
  assert.equal(parseEvidenceDecision(request()).expectedRevision, 0);
});
test('evidence service rejects local mode and forged credentials without connecting', async () => {
  const pool = {
    connect() {
      throw new Error('Must not connect');
    },
  } as unknown as Pool;
  const credentials = { nodeToken: 'a'.repeat(43), sessionToken: 'b'.repeat(43) };
  await assert.rejects(
    createCentralEvidenceDecisionService(pool, 'local')(credentials, request()),
    { code: 'CENTRAL_ONLY' },
  );
  await assert.rejects(
    createCentralEvidenceDecisionService(pool, 'central')(
      { ...credentials, roles: ['administrator'] },
      request(),
    ),
    { code: 'AUTH_INVALID' },
  );
});
