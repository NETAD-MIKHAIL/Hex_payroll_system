import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DomainError } from '../src/foundation/repository.js';
import { createCentralAttendanceAuthorizationResolver } from '../src/timekeeping/central-attendance-authorization.js';

const pool = {
  connect() {
    throw new Error('Must not connect');
  },
} as unknown as Pool;
const credentials = { nodeToken: 'a'.repeat(43), sessionToken: 'b'.repeat(43) };
const operation = {
  organizationId: randomUUID(),
  authorUserId: randomUUID(),
  action: 'calculate' as const,
};
const denied = (code: string) => (error: unknown) =>
  error instanceof DomainError && error.code === code;

test('attendance authorization rejects local mode before connecting', async () => {
  await assert.rejects(
    createCentralAttendanceAuthorizationResolver(pool, 'local')(credentials, operation),
    denied('CENTRAL_ONLY'),
  );
});
test('attendance authorization rejects missing credentials and identity claims before connecting', async () => {
  const resolve = createCentralAttendanceAuthorizationResolver(pool, 'central');
  await assert.rejects(
    resolve({ ...credentials, sessionToken: '' }, operation),
    denied('AUTH_INVALID'),
  );
  const forged = {
    ...credentials,
    userId: operation.authorUserId,
    permissions: ['attendance.manage'],
  };
  await assert.rejects(resolve(forged, operation), denied('AUTH_INVALID'));
  await assert.rejects(
    resolve(undefined as unknown as typeof credentials, operation),
    denied('AUTH_INVALID'),
  );
});
test('attendance authorization rejects forged submitters and unsupported actions before connecting', async () => {
  const resolve = createCentralAttendanceAuthorizationResolver(pool, 'central');
  const forged = { ...operation, submitterUserId: randomUUID() };
  await assert.rejects(resolve(credentials, forged), denied('INVALID_REQUEST'));
  const invalidAction = { ...operation, action: 'payroll' as 'calculate' };
  await assert.rejects(resolve(credentials, invalidAction), denied('INVALID_REQUEST'));
});
