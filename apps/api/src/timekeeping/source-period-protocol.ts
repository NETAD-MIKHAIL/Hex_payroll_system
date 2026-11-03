import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { biometricSourceIdentitySchema, canonicalSyncJson } from '@hexpayroll/shared';
export const digest = (value: unknown) =>
  createHash('sha256').update(canonicalSyncJson(value)).digest('hex');
export const sourceEntrySchema = z
  .object({
    deviceEmployeeId: z.string().min(1).max(254),
    recordedAt: z
      .string()
      .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/)
      .refine((v) => Number.isFinite(Date.parse(v))),
    recordType: z.enum(['in', 'out', 'break_out', 'break_in', 'unknown']),
    externalRecordId: z.string().min(1).max(254).nullable(),
    sourceIdentity: biometricSourceIdentitySchema,
  })
  .strict();
const sequence = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .refine((v) => BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER));
export const sourceManifestSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal('signed-inventory-v1'),
    closureId: z.uuid(),
    organizationId: z.uuid(),
    deviceId: z.uuid(),
    capabilityRevision: z.number().int().positive(),
    epoch: z.uuid(),
    timezone: z.string().min(1).max(100),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    issuedAt: z.iso.datetime({ offset: true }),
    firstSequence: sequence,
    lastSequence: sequence,
    inventory: z.array(sourceEntrySchema).max(500),
  })
  .strict()
  .superRefine((m, c) => {
    const a = Date.parse(m.start),
      b = Date.parse(m.end);
    if (b <= a || b - a > 72 * 3600000 || Date.parse(m.issuedAt) < b)
      c.addIssue({ code: 'custom', message: 'Invalid closed source window' });
    const first = BigInt(m.firstSequence),
      last = BigInt(m.lastSequence);
    if (first < 1n || last - first + 1n !== BigInt(m.inventory.length))
      c.addIssue({ code: 'custom', message: 'Source inventory range mismatch' });
    if (new Set(m.inventory.map((r) => r.sourceIdentity.entryId)).size !== m.inventory.length)
      c.addIssue({ code: 'custom', message: 'Duplicate source entry' });
    m.inventory.forEach((r, i) => {
      if (
        r.sourceIdentity.epoch !== m.epoch ||
        BigInt(r.sourceIdentity.sequence) !== first + BigInt(i)
      )
        c.addIssue({ code: 'custom', message: 'Noncontiguous source inventory' });
    });
  });
export const signedClosureSchema = z
  .object({ manifest: sourceManifestSchema, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) })
  .strict();
export type SourceEntry = z.infer<typeof sourceEntrySchema>;
export function verifySourceClosure(input: unknown, publicKey: string) {
  const closure = signedClosureSchema.parse(input);
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(
      null,
      Buffer.from(canonicalSyncJson(closure.manifest)),
      key,
      Buffer.from(closure.signature, 'base64'),
    )
  )
    throw new Error('Source closure signature invalid');
  return closure;
}
