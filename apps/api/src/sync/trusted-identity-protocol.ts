import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalSyncJson, syncSequenceSchema } from '@hexpayroll/shared';

export const identityFingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalSyncJson(value)).digest('hex');
const revision = z.number().int().positive().max(2147483647);
export const identitySnapshotSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    displayName: z
      .string()
      .min(1)
      .max(128)
      .refine((v) => v.trim().length > 0),
    active: z.boolean(),
    revision,
    accountRevision: revision,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const identityEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(2),
    origin: z.literal('central.identity'),
    sequence: syncSequenceSchema.refine((s) => s !== '0'),
    eventId: z.uuid(),
    requestId: z.uuid(),
    organizationId: z.uuid(),
    userId: z.uuid(),
    expectedRevision: z.number().int().min(0).max(2147483646),
    resultingRevision: revision,
    publishedBy: z.uuid(),
    sourceNodeId: z.uuid(),
    publishedAt: z.iso.datetime({ offset: true }),
    snapshot: identitySnapshotSchema,
    snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (e) =>
      e.resultingRevision === e.expectedRevision + 1 &&
      e.snapshot.id === e.userId &&
      e.snapshot.organizationId === e.organizationId &&
      e.snapshot.revision === e.resultingRevision,
  );
export type IdentityEnvelope = z.infer<typeof identityEnvelopeSchema>;
export const identityPullSchema = z
  .object({
    protocolVersion: z.literal(2),
    origin: z.literal('central.identity'),
    changes: z.array(identityEnvelopeSchema).max(3),
    nextSequence: syncSequenceSchema,
  })
  .strict();
export function verifyIdentity(input: unknown) {
  const event = identityEnvelopeSchema.parse(input);
  if (identityFingerprint(event.snapshot) !== event.snapshotFingerprint)
    throw new Error('Identity snapshot fingerprint mismatch');
  return event;
}
