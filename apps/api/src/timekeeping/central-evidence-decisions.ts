import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  scheduleInputSchema,
  scheduleStatusInputSchema,
  assignmentInputSchema,
  leaveTypeInputSchema,
  leaveInputSchema,
  transitionInputSchema,
  type Permission,
} from '@hexpayroll/shared';
import { DomainError, transaction } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import {
  authorizeCentralUser,
  centralCredentialsSchema,
} from './central-attendance-authorization.js';

export const evidenceActions = {
  'schedule.create': { table: 'work_schedules', permission: 'schedules.create', create: true },
  'schedule.update': { table: 'work_schedules', permission: 'schedules.update', create: false },
  'schedule.status': { table: 'work_schedules', permission: 'schedules.update', create: false },
  'assignment.create': {
    table: 'employee_schedule_assignments',
    permission: 'schedules.assign',
    create: true,
  },
  'assignment.update': {
    table: 'employee_schedule_assignments',
    permission: 'schedules.assign',
    create: false,
  },
  'leaveType.create': { table: 'leave_types', permission: 'leave.configure', create: true },
  'leaveType.update': { table: 'leave_types', permission: 'leave.configure', create: false },
  'leave.request': { table: 'leave_requests', permission: 'leave.create', create: true },
  'leave.approve': { table: 'leave_requests', permission: 'leave.approve', create: false },
  'leave.reject': { table: 'leave_requests', permission: 'leave.reject', create: false },
  'leave.cancel': { table: 'leave_requests', permission: 'leave.cancel', create: false },
} as const satisfies Record<string, { table: string; permission: Permission; create: boolean }>;
const schedule = scheduleInputSchema.extend({
  versionId: z.uuid(),
  timezone: z.string().min(1).max(100),
});
const assignment = z
  .object({
    employeeId: z.uuid(),
    scheduleId: assignmentInputSchema.shape.scheduleId,
    effectiveFrom: assignmentInputSchema.shape.effectiveFrom,
    effectiveTo: assignmentInputSchema.shape.effectiveTo,
    reason: assignmentInputSchema.shape.reason,
  })
  .strict()
  .refine(({ employeeId, ...data }) => {
    void employeeId;
    return assignmentInputSchema.safeParse({ ...data, expectedRevision: 1 }).success;
  }, 'Invalid assignment dates');
const transition = transitionInputSchema.omit({ expectedRevision: true });
const payloads = {
  'schedule.create': schedule,
  'schedule.update': schedule,
  'schedule.status': scheduleStatusInputSchema.omit({ expectedRevision: true }),
  'assignment.create': assignment,
  'assignment.update': assignment,
  'leaveType.create': leaveTypeInputSchema,
  'leaveType.update': leaveTypeInputSchema,
  'leave.request': leaveInputSchema,
  'leave.approve': transition,
  'leave.reject': transition,
  'leave.cancel': transition,
};
const requestSchema = z
  .object({
    version: z.literal(1),
    requestId: z.uuid(),
    organizationId: z.uuid(),
    entityId: z.uuid(),
    action: z.enum(
      Object.keys(evidenceActions) as [
        keyof typeof evidenceActions,
        ...(keyof typeof evidenceActions)[],
      ],
    ),
    expectedRevision: z.number().int().min(0).max(2147483646),
    payload: z.record(z.string(), z.json()),
  })
  .strict();

// V1: recursively sorted object keys, JSON scalar encoding, array order preserved.
// No date, Unicode, or numeric-string coercion. Only JSON input is accepted.
export function canonicalEvidenceJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalEvidenceJson).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) +
          ':' +
          canonicalEvidenceJson((value as Record<string, unknown>)[key]),
      )
      .join(',') +
    '}'
  );
}
export function parseEvidenceDecision(input: unknown) {
  const result = requestSchema.safeParse(input);
  if (!result.success)
    throw new DomainError(400, 'INVALID_REQUEST', 'Invalid evidence decision request');
  const request = result.data;
  // Require explicit schema output: defaults/trimming must not change the bound content.
  const payload = payloads[request.action].safeParse(request.payload);
  if (
    !payload.success ||
    canonicalEvidenceJson(payload.data) !== canonicalEvidenceJson(request.payload) ||
    Buffer.byteLength(canonicalEvidenceJson(request.payload)) > 262144
  )
    throw new DomainError(400, 'INVALID_REQUEST', 'Invalid or non-explicit evidence payload');
  const action = evidenceActions[request.action];
  if (action.create !== (request.expectedRevision === 0))
    throw new DomainError(409, 'EVIDENCE_REVISION_MISMATCH', 'Invalid expected evidence revision');
  return request;
}

/** Internal service only. A persisted authorization is not accepted evidence. */
export function createCentralEvidenceDecisionService(pool: Pool, mode: 'local' | 'central') {
  return async (credentials: unknown, input: unknown) => {
    if (mode !== 'central')
      throw new DomainError(403, 'CENTRAL_ONLY', 'Central evidence authorization is unavailable');
    const parsed = centralCredentialsSchema.safeParse(credentials);
    if (!parsed.success)
      throw new DomainError(401, 'AUTH_INVALID', 'Valid node and user credentials are required');
    const request = parseEvidenceDecision(input);
    const action = evidenceActions[request.action];
    const binding = canonicalEvidenceJson(request);
    const fingerprint = createHash('sha256').update(binding).digest('hex');
    return transaction(pool, async (client) => {
      const identity = await authorizeCentralUser(
        client,
        parsed.data,
        request.organizationId,
        action.permission,
      );
      const checkExpiry = async () => {
        const valid = await client.query(
          'SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()',
          [tokenHash(parsed.data.sessionToken)],
        );
        if (!valid.rowCount) throw new DomainError(401, 'SESSION_INVALID', 'User session invalid');
      };
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'evidence-request:' + request.requestId,
      ]);
      const existing = (
        await client.query('SELECT * FROM central_evidence_authorizations WHERE request_id=$1', [
          request.requestId,
        ])
      ).rows[0];
      if (existing) {
        if (
          existing.canonical_request !== binding ||
          existing.acting_user_id !== identity.authorUserId ||
          existing.source_node_id !== identity.nodeId
        )
          throw new DomainError(
            409,
            'EVIDENCE_REQUEST_CONFLICT',
            'Evidence request identity already bound',
          );
        await checkExpiry();
        return existing;
      }
      // Parent master revision is the concurrency unit, including new immutable shift versions.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        action.table + ':' + request.entityId,
      ]);
      const current = (
        await client.query(
          `SELECT organization_id,revision FROM ${action.table} WHERE id=$1 FOR SHARE`,
          [request.entityId],
        )
      ).rows[0];
      if (current && current.organization_id !== request.organizationId)
        throw new DomainError(403, 'ORGANIZATION_MISMATCH', 'Evidence organization mismatch');
      if (
        (current ? Number(current.revision) : 0) !== request.expectedRevision ||
        (action.create && current)
      )
        throw new DomainError(
          409,
          'EVIDENCE_REVISION_MISMATCH',
          'Evidence revision does not match',
        );
      // Check wall time after every possible lock wait, immediately before persistence.
      await checkExpiry();
      const decision = (
        await client.query(
          `INSERT INTO central_evidence_authorizations
        (request_id,organization_id,entity_id,entity_type,action,expected_revision,request_version,
         canonical_request,payload_fingerprint,acting_user_id,source_node_id,permission_code)
        VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11) RETURNING *`,
          [
            request.requestId,
            request.organizationId,
            request.entityId,
            action.table,
            request.action,
            request.expectedRevision,
            binding,
            fingerprint,
            identity.authorUserId,
            identity.nodeId,
            action.permission,
          ],
        )
      ).rows[0];
      await checkExpiry();
      return decision;
    });
  };
}
