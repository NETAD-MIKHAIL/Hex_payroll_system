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

// Protocol v2 acknowledges committed business application.
export const centralEventSchema = syncEventSchema
  .extend({
    baseRevision: z.number().int().min(0).max(2147483647),
    originNodeId: z.uuid(),
    actorId: z.uuid().nullable(),
  })
  .strict();
export const centralPushSchema = z
  .object({ protocolVersion: z.literal(2), events: z.array(centralEventSchema).min(1).max(3) })
  .strict();
export const centralPushResponseSchema = z
  .object({
    protocolVersion: z.literal(2),
    results: z
      .array(
        z.union([
          z
            .object({
              eventId: z.uuid(),
              status: z.enum(['accepted', 'already_applied']),
              sequence: syncSequenceSchema.refine((v) => v !== '0'),
              revision: z.number().int().positive(),
            })
            .strict(),
          z
            .object({
              eventId: z.uuid(),
              status: z.enum(['rejected', 'retryable_failure']),
              code: z.string().max(100),
              reason: z.string().max(1000),
            })
            .strict(),
          z
            .object({
              eventId: z.uuid(),
              status: z.literal('conflict'),
              conflictId: z.uuid(),
              conflictType: z.string(),
              currentRevision: z.number().int().positive().nullable(),
              snapshot: syncEventSchema.shape.payload.nullable(),
              reason: z.string().max(1000),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(3),
  })
  .strict();
export const centralChangeSchema = syncChangeSchema
  .extend({ baseRevision: z.number().int().nonnegative(), actorId: z.uuid().nullable() })
  .strict();
export const centralPullResponseSchema = z
  .object({
    protocolVersion: z.literal(2),
    changes: z.array(centralChangeSchema).max(3),
    nextSequence: syncSequenceSchema,
    hasMore: z.boolean(),
  })
  .strict();
export type CentralEvent = z.infer<typeof centralEventSchema>;
export type CentralChange = z.infer<typeof centralChangeSchema>;
export type CentralResult = z.infer<typeof centralPushResponseSchema>['results'][number];
