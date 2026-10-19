import { z } from 'zod';
import { syncEventSchema, syncSequenceSchema } from './sync.js';
export const conflictTypeSchema = z.enum([
  'UPDATE_UPDATE',
  'UPDATE_ARCHIVE',
  'DUPLICATE_CREATE',
  'STALE_REVISION',
  'MISSING_DEPENDENCY',
  'INVALID_REFERENCE',
  'LEAVE_CONFLICT',
  'SCHEDULE_CONFLICT',
  'PAYROLL_CONFLICT',
  'AUTHORIZATION_CONFLICT',
  'EVENT_IDENTITY',
]);
export const conflictStatusSchema = z.enum(['open', 'under_review', 'resolved', 'dismissed']);
export const conflictResolutionSchema = z.enum([
  'accept_authoritative',
  'reapply_local',
  'manual_merge',
  'reject_mutation',
  'escalate',
]);
const snapshot = syncEventSchema.shape.payload;
export const transportConflictSchema = z
  .object({
    eventId: z.uuid(),
    outcome: z.literal('conflict'),
    conflictType: conflictTypeSchema,
    currentRevision: z.number().int().positive().max(2147483647).nullable(),
    snapshot: snapshot.nullable(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export const structuredPushResponseSchema = z
  .object({
    outcomes: z
      .array(
        z.discriminatedUnion('outcome', [
          transportConflictSchema,
          z
            .object({
              eventId: z.uuid(),
              outcome: z.literal('accepted'),
              sequence: syncSequenceSchema.refine(
                (value) => value !== '0',
                'Receipt sequence must be positive',
              ),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(3),
  })
  .strict();
export const conflictResolutionRequestSchema = z
  .object({
    requestId: z.uuid(),
    resolution: conflictResolutionSchema,
    reason: z.string().trim().min(1).max(1000),
    expectedVersion: z.number().int().positive(),
    expectedRevision: z.number().int().positive().optional(),
    fields: snapshot.optional(),
  })
  .strict();
export const conflictListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    status: conflictStatusSchema.optional(),
    entityType: z.string().max(100).optional(),
    conflictType: conflictTypeSchema.optional(),
    device: z.uuid().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .strict();
export const syncConflictSchema = z.object({
  id: z.uuid(),
  entityType: z.string(),
  entityId: z.uuid(),
  conflictType: conflictTypeSchema,
  status: conflictStatusSchema,
  originNodeId: z.uuid(),
  deviceName: z.string(),
  localRevision: z.number().int(),
  remoteRevision: z.number().int().nullable(),
  baseRevision: z.number().int().nullable(),
  version: z.number().int().positive(),
  detectedAt: z.string(),
  authority: z.enum(['local', 'remote']),
  reason: z.string(),
  resolutionState: z.enum(['none', 'pending', 'confirmed']),
});
export const conflictListResponseSchema = z.object({
  items: z.array(syncConflictSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export const conflictDetailsSchema = syncConflictSchema.extend({
  latestRevision: z.number().int().positive().nullable().optional(),
  latestSnapshot: snapshot.nullable().optional(),
  localPayload: snapshot,
  remoteSnapshot: snapshot.nullable(),
  allowedActions: z.array(conflictResolutionSchema),
  blockingReason: z.string().nullable(),
  history: z.array(
    z.object({
      id: z.uuid(),
      resolution: conflictResolutionSchema,
      reason: z.string(),
      createdAt: z.string(),
      actorId: z.uuid(),
      state: z.string(),
    }),
  ),
});
export type ConflictType = z.infer<typeof conflictTypeSchema>;
export type ConflictStatus = z.infer<typeof conflictStatusSchema>;
export type ConflictResolution = z.infer<typeof conflictResolutionSchema>;
export type SyncConflict = z.infer<typeof syncConflictSchema>;
export type ConflictDetails = z.infer<typeof conflictDetailsSchema>;
export type ConflictListResponse = z.infer<typeof conflictListResponseSchema>;
