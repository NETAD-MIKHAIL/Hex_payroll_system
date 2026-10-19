import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { conflictResolutionRequestSchema, structuredPushResponseSchema } from '@hexpayroll/shared';
import {
  detectConflict,
  dependencyKeys,
  redact,
  safeEvidence,
  type ConflictInput,
} from '../src/sync/conflict-policy.js';

const base: ConflictInput = {
  entityType: 'employees',
  operation: 'UPDATE',
  baseRevision: 8,
  incoming: { firstName: 'Local' },
  authoritative: { revision: 8, firstName: 'Current' },
  authorized: true,
};
test('revision policies accept matching revisions and reject stale/future revisions', () => {
  assert.deepEqual(detectConflict(base), { outcome: 'accepted', currentRevision: 8 });
  for (const [revision, category] of [
    [9, 'STALE_REVISION'],
    [7, 'UPDATE_UPDATE'],
  ] as const) {
    const r = detectConflict({ ...base, authoritative: { revision } });
    assert.equal(r.outcome, 'conflict');
    if (r.outcome === 'conflict') assert.equal(r.conflictType, category);
  }
});
test('domain policies protect salaries, identities, schedules, leave decisions and payroll', () => {
  const scenarios: [Partial<ConflictInput>, string][] = [
    [
      {
        incoming: { employmentVersions: [{ basicRateCentavos: 90000 }] },
        authoritative: { revision: 9 },
      },
      'STALE_REVISION',
    ],
    [{ entityType: 'departments', duplicateIdentity: true }, 'DUPLICATE_CREATE'],
    [{ operation: 'ARCHIVE', authoritative: { revision: 9 } }, 'UPDATE_ARCHIVE'],
    [{ entityType: 'employee_schedule_assignments', overlaps: true }, 'SCHEDULE_CONFLICT'],
    [
      {
        entityType: 'leave_requests',
        incoming: { status: 'rejected' },
        authoritative: { revision: 9, status: 'approved' },
      },
      'LEAVE_CONFLICT',
    ],
    [{ entityType: 'payroll_runs', incoming: { finalized: true } }, 'PAYROLL_CONFLICT'],
    [
      { entityType: 'employee_payroll_results', authoritative: { revision: 8, finalized: true } },
      'PAYROLL_CONFLICT',
    ],
    [{ authorized: false }, 'AUTHORIZATION_CONFLICT'],
    [{ dependency: 'missing' }, 'MISSING_DEPENDENCY'],
    [{ dependency: 'invalid' }, 'INVALID_REFERENCE'],
  ];
  for (const [input, expected] of scenarios) {
    const r = detectConflict({ ...base, ...input });
    assert.equal(r.outcome, 'conflict');
    if (r.outcome === 'conflict') assert.equal(r.conflictType, expected);
  }
  assert.equal(detectConflict({ ...base, dependency: 'pending' }).outcome, 'deferred');
});
test('biometric duplicates are idempotent while differing device evidence is immutable', () => {
  const evidence = {
    employeeId: 'employee',
    deviceId: 'device',
    externalRecordId: 'event',
    recordedAt: '2026-10-16T00:00:00Z',
    recordType: 'in',
    revision: 1,
  };
  const input: ConflictInput = {
    ...base,
    entityType: 'time_records',
    operation: 'CREATE',
    baseRevision: 0,
    incoming: evidence,
    authoritative: evidence,
  };
  assert.deepEqual(detectConflict(input), {
    outcome: 'accepted',
    currentRevision: 1,
    idempotent: true,
  });
  assert.equal(
    detectConflict({ ...input, incoming: { ...evidence, recordType: 'out' } }).outcome,
    'conflict',
  );
});
test('dependency keys connect references and keep unknown aggregates conservative', () => {
  assert.ok(
    dependencyKeys('positions', 'p', { departmentId: 'd', code: 'P' })?.includes('departments:d'),
  );
  assert.equal(dependencyKeys('payroll_runs', 'r', {}), null);
  assert.ok(
    dependencyKeys('employees', 'e', { employmentVersions: [{ departmentId: 'd' }] })?.includes(
      'departments:d',
    ),
  );
});
test('evidence is allowlisted and recursively strips secrets; sensitive views remain separate', () => {
  const input = {
    firstName: 'Name',
    passwordHash: 'secret',
    extra: 'unapproved',
    employmentVersions: [{ basicRateCentavos: 123, tin: 'private', token: 'secret' }],
  };
  const evidence = safeEvidence(input);
  assert.equal(JSON.stringify(evidence).includes('secret'), false);
  assert.equal('extra' in evidence, false);
  const publicView = JSON.stringify(redact(evidence));
  assert.equal(publicView.includes('123'), false);
  assert.equal(publicView.includes('private'), false);
  assert.equal(JSON.stringify(redact(evidence, true)).includes('123'), true);
});
test('resolution requests reject blind status closure, missing reasons and unrecognized actions', () => {
  assert.equal(conflictResolutionRequestSchema.safeParse({ status: 'resolved' }).success, false);
  assert.equal(
    structuredPushResponseSchema.safeParse({ outcomes: [{ outcome: 'conflict', eventId: 'bad' }] })
      .success,
    false,
  );
  assert.equal(
    structuredPushResponseSchema.safeParse({
      outcomes: [{ eventId: randomUUID(), outcome: 'accepted', sequence: '9223372036854775808' }],
    }).success,
    false,
  );
  assert.equal(
    structuredPushResponseSchema.safeParse({
      outcomes: [
        {
          eventId: randomUUID(),
          outcome: 'conflict',
          conflictType: 'STALE_REVISION',
          currentRevision: 2,
          snapshot: { name: '給'.repeat(90000) },
          reason: 'Stale',
        },
      ],
    }).success,
    false,
  );
});
