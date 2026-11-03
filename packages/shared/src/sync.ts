import { z } from 'zod';

function payloadBytes(value: Record<string, unknown>) {
  let bytes = 0;
  for (const character of JSON.stringify(value)) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

// PostgreSQL bigint cursors travel as strings, never imprecise JS numbers.
export const syncSequenceSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]*)$/.test(value) &&
      value.length <= 19 &&
      BigInt(value) <= 9223372036854775807n,
    'Sequence exceeds PostgreSQL bigint',
  );
export const syncEventSchema = z
  .object({
    eventId: z.uuid(),
    entityType: z.string().trim().min(1).max(100),
    entityId: z.uuid(),
    operation: z.enum(['CREATE', 'UPDATE', 'ARCHIVE']),
    revision: z.number().int().positive().max(2147483647),
    payloadVersion: z.literal(1),
    payload: z
      .record(z.string(), z.unknown())
      .refine((value) => payloadBytes(value) <= 262144, 'Payload exceeds transport limit'),
  })
  .strict();
export const syncPushSchema = z.object({ events: z.array(syncEventSchema).min(1).max(3) }).strict();
export const syncReceiptSchema = z
  .object({ eventId: z.uuid(), sequence: syncSequenceSchema })
  .strict();
export const syncPushResponseSchema = z
  .object({ receipts: z.array(syncReceiptSchema).min(1).max(3) })
  .strict();
export const syncChangeSchema = syncEventSchema.extend({
  sequence: syncSequenceSchema,
  changeId: z.uuid(),
  sourceNodeId: z.uuid(),
  organizationId: z.uuid(),
});
export const syncPullResponseSchema = z
  .object({
    changes: z.array(syncChangeSchema).max(3),
    nextSequence: syncSequenceSchema,
  })
  .strict();
export const syncRegistrationSchema = z
  .object({ deviceName: z.string().trim().min(1).max(200), organizationId: z.uuid() })
  .strict();
export const syncRegistrationResponseSchema = z
  .object({
    nodeId: z.uuid(),
    organizationId: z.uuid(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type SyncEvent = z.infer<typeof syncEventSchema>;
export type SyncChange = z.infer<typeof syncChangeSchema>;

// Separate opt-in stream: v1 cursors never traverse or skip trusted evidence.
export const trustedEvidenceActions = {
  'schedule.create': 'work_schedules',
  'schedule.update': 'work_schedules',
  'schedule.status': 'work_schedules',
  'assignment.create': 'employee_schedule_assignments',
  'assignment.update': 'employee_schedule_assignments',
  'leaveType.create': 'leave_types',
  'leaveType.update': 'leave_types',
  'leave.request': 'leave_requests',
  'leave.approve': 'leave_requests',
  'leave.reject': 'leave_requests',
  'leave.cancel': 'leave_requests',
} as const;
export function canonicalSyncJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalSyncJson).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) + ':' + canonicalSyncJson((value as Record<string, unknown>)[key]),
      )
      .join(',') +
    '}'
  );
}
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const trustedEvidenceEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(2),
    origin: z.literal('central.accepted'),
    sequence: syncSequenceSchema.refine((value) => value !== '0'),
    eventId: z.uuid(),
    acceptanceId: z.uuid(),
    authorizationDecisionId: z.uuid(),
    authorizationRequestId: z.uuid(),
    authorizationFingerprint: fingerprint,
    organizationId: z.uuid(),
    entityId: z.uuid(),
    entityType: z.enum([
      'work_schedules',
      'employee_schedule_assignments',
      'leave_types',
      'leave_requests',
    ]),
    action: z.enum(
      Object.keys(trustedEvidenceActions) as [
        keyof typeof trustedEvidenceActions,
        ...(keyof typeof trustedEvidenceActions)[],
      ],
    ),
    expectedRevision: z.number().int().min(0).max(2147483646),
    resultingRevision: z.number().int().positive().max(2147483647),
    acceptedBy: z.uuid(),
    sourceNodeId: z.uuid(),
    acceptedAt: z.iso.datetime({ offset: true }),
    snapshot: z.record(z.string(), z.json()).refine((value) => payloadBytes(value) <= 262144),
    snapshotFingerprint: fingerprint,
  })
  .strict()
  .superRefine((event, ctx) => {
    const create = [
      'schedule.create',
      'assignment.create',
      'leaveType.create',
      'leave.request',
    ].includes(event.action);
    if (
      event.entityType !== trustedEvidenceActions[event.action] ||
      event.resultingRevision !== event.expectedRevision + 1 ||
      create !== (event.expectedRevision === 0) ||
      event.acceptanceId === event.authorizationDecisionId ||
      event.snapshot.id !== event.entityId ||
      event.snapshot.organizationId !== event.organizationId ||
      event.snapshot.revision !== event.resultingRevision
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent trusted evidence binding' });
  });
export const trustedEvidencePullSchema = z
  .object({
    protocolVersion: z.literal(2),
    origin: z.literal('central.accepted'),
    changes: z.array(trustedEvidenceEnvelopeSchema).max(3),
    nextSequence: syncSequenceSchema,
  })
  .strict();
export type TrustedEvidenceEnvelope = z.infer<typeof trustedEvidenceEnvelopeSchema>;
