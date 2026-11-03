import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalSyncJson, syncPushSchema, trustedEvidencePullSchema } from '@hexpayroll/shared';
import { verifyTrustedEvidence } from '../src/sync/trusted-evidence.js';

export function envelope() {
  const entityId = randomUUID(),
    organizationId = randomUUID();
  const snapshot = { id: entityId, organizationId, revision: 1, name: 'Vacation' };
  return {
    protocolVersion: 2,
    origin: 'central.accepted',
    sequence: '1',
    eventId: randomUUID(),
    acceptanceId: randomUUID(),
    authorizationDecisionId: randomUUID(),
    authorizationRequestId: randomUUID(),
    authorizationFingerprint: 'a'.repeat(64),
    organizationId,
    entityId,
    entityType: 'leave_types',
    action: 'leaveType.create',
    expectedRevision: 0,
    resultingRevision: 1,
    acceptedBy: randomUUID(),
    sourceNodeId: randomUUID(),
    acceptedAt: '2026-10-24T00:00:00Z',
    snapshot,
    snapshotFingerprint: createHash('sha256').update(canonicalSyncJson(snapshot)).digest('hex'),
  };
}
test('trusted v2 envelope binds snapshot and action/revision metadata', () => {
  const value = envelope();
  assert.deepEqual(verifyTrustedEvidence(value), value);
  for (const patch of [
    { protocolVersion: 3 },
    { origin: 'node' },
    { entityId: randomUUID() },
    { resultingRevision: 2 },
    { action: 'leave.approve' },
    { snapshotFingerprint: 'b'.repeat(64) },
    { snapshot: { ...value.snapshot, name: 'Changed' } },
    { acceptanceId: value.authorizationDecisionId },
  ])
    assert.throws(() => verifyTrustedEvidence({ ...value, ...patch }));
  assert.equal(
    trustedEvidencePullSchema.safeParse({
      protocolVersion: 2,
      origin: 'central.accepted',
      changes: [],
      nextSequence: '0',
    }).success,
    true,
  );
});
test('generic node push cannot submit the trusted envelope as an event', () => {
  assert.equal(syncPushSchema.safeParse({ events: [envelope()] }).success, false);
});
