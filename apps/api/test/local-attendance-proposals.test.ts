import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localProposalContentSchema,
  localProposalDecisionSchema,
} from '../src/timekeeping/local-attendance-proposals.js';

const summary = {
  firstIn: '2026-01-01T00:00:00Z',
  lastOut: '2026-01-01T09:00:00Z',
  workedMinutes: 480,
  lateMinutes: 0,
  undertimeMinutes: 0,
  attendanceStatus: 'present',
  complete: true,
  flags: [],
};
test('local calculation proposals retain data and reject missing fingerprints and non-attendance fields', () => {
  const input = {
    action: 'calculate',
    expectedCanonicalRevision: 0,
    evidenceFingerprint: 'a'.repeat(64),
    payload: summary,
  };
  assert.deepEqual(localProposalContentSchema.parse(input), input);
  assert.equal(
    localProposalContentSchema.safeParse({ ...input, evidenceFingerprint: null }).success,
    false,
  );
  assert.equal(
    localProposalContentSchema.safeParse({ ...input, payload: { ...summary, salary: 1000 } })
      .success,
    false,
  );
  assert.equal(
    localProposalContentSchema.safeParse({
      ...input,
      payload: { ...summary, workedMinutes: 480.5 },
    }).success,
    false,
  );
  assert.equal(
    localProposalContentSchema.safeParse({
      ...input,
      payload: { ...summary, lastOut: '2025-12-31T00:00:00Z' },
    }).success,
    false,
  );
});

test('adjustment, approval and reopen proposals require an existing canonical revision and action-specific content', () => {
  for (const [action, payload] of [
    ['adjust', { reason: 'Reviewed shift', overrides: { workedMinutes: 450 } }],
    ['approve', { reason: null }],
    ['reopen', { reason: 'New evidence' }],
  ]) {
    const input = { action, expectedCanonicalRevision: 1, evidenceFingerprint: null, payload };
    assert.deepEqual(localProposalContentSchema.parse(input), input);
    assert.equal(
      localProposalContentSchema.safeParse({ ...input, expectedCanonicalRevision: 0 }).success,
      false,
    );
  }
  assert.equal(
    localProposalContentSchema.safeParse({
      action: 'adjust',
      expectedCanonicalRevision: 1,
      evidenceFingerprint: null,
      payload: { reason: 'Review', overrides: {} },
    }).success,
    false,
  );
});

test('central decision persistence requires explicit identities, structured reasons and acceptance metadata', () => {
  const input = {
    requestId: '019a0000-0000-7000-8000-000000000001',
    decisionId: '019a0000-0000-7000-8000-000000000002',
    category: 'accepted',
    reason: { code: 'ACCEPTED', message: 'Canonical revision accepted', details: {} },
    canonicalAttendanceId: '019a0000-0000-7000-8000-000000000003',
    acceptedRevision: 1,
    currentRevision: 1,
    decidedAt: '2026-01-01T00:00:00Z',
  };
  assert.deepEqual(localProposalDecisionSchema.parse(input), input);
  for (const patch of [
    { canonicalAttendanceId: null },
    { acceptedRevision: null },
    { currentRevision: 0 },
    { requestId: '019a0000-0000-4000-8000-000000000001' },
    { category: 'rejected' },
    { reason: { code: 'ACCEPTED', message: ' ', details: {} } },
    { deliverySucceeded: true },
  ]) {
    assert.equal(localProposalDecisionSchema.safeParse({ ...input, ...patch }).success, false);
  }
  assert.equal(
    localProposalDecisionSchema.safeParse({
      ...input,
      category: 'conflicted',
      acceptedRevision: null,
      currentRevision: 2,
    }).success,
    true,
  );
});
