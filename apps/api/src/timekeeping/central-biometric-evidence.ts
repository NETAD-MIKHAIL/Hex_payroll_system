import type { Pool } from 'pg';
import { z } from 'zod';
import { biometricSourceIdentitySchema } from '@hexpayroll/shared';
import { tokenHash } from '../auth/service.js';
import { authenticateNode } from '../sync/service.js';
import { DomainError, transaction } from '../foundation/repository.js';

export const biometricEvidenceBatchSchema = z
  .object({
    version: z.literal(1),
    batchId: z.uuid(),
    organizationId: z.uuid(),
    deviceId: z.uuid(),
    // This is a local capture-batch ordinal, NOT a hardware log sequence.
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    records: z
      .array(
        z
          .object({
            id: z.uuid(),
            deviceEmployeeId: z.string().min(1).max(254),
            recordedAt: z.iso.datetime({ offset: true, precision: null }),
            recordType: z.enum(['in', 'out', 'break_out', 'break_in', 'unknown']),
            externalRecordId: z.string().min(1).max(254).nullable(),
            sourceIdentity: biometricSourceIdentitySchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

/** Separate receipt protocol, disabled until reviewed activation. Node identity
 * proves an enrolled collector, not hardware authenticity or attendance approval.
 */
export function createCentralBiometricEvidenceService(
  pool: Pool,
  mode: 'local' | 'central',
  enabled = false,
) {
  return {
    async receive(nodeToken: string, input: unknown) {
      if (mode !== 'central' || !enabled)
        throw new DomainError(403, 'DISABLED', 'Biometric evidence receipt is disabled');
      const batch = biometricEvidenceBatchSchema.parse(input);
      if (new Set(batch.records.map((r) => r.id)).size !== batch.records.length)
        throw new DomainError(400, 'INVALID_REQUEST', 'Duplicate raw identity within batch');
      return transaction(pool, async (c) => {
        const node = await authenticateNode(c, nodeToken);
        const locked = await c.query(
          'SELECT id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL FOR SHARE',
          [node.id, tokenHash(nodeToken)],
        );
        if (!locked.rowCount)
          throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
        if (node.organization_id !== batch.organizationId)
          throw new DomainError(403, 'ORGANIZATION_MISMATCH', 'Biometric organization mismatch');
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'central-biometric:' + batch.deviceId,
        ]);
        const source = await c.query(
          'SELECT node_id FROM central_biometric_sources WHERE organization_id=$1 AND device_id=$2',
          [batch.organizationId, batch.deviceId],
        );
        if (source.rows[0]?.node_id !== node.id)
          throw new DomainError(403, 'SOURCE_MISMATCH', 'Device is not bound to this collector');
        const replay = await c.query<{ matches: boolean }>(
          'SELECT payload=$2::jsonb AS matches FROM central_biometric_receipts WHERE batch_id=$1',
          [batch.batchId, JSON.stringify(batch)],
        );
        if (replay.rows.length) {
          if (!replay.rows[0]!.matches)
            throw new DomainError(409, 'CONFLICT', 'Batch identity reused with different evidence');
          return { batchId: batch.batchId, received: true as const, finalized: false as const };
        }
        await c.query(
          `INSERT INTO central_biometric_receipts(batch_id,organization_id,device_id,node_id,sequence,payload) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            batch.batchId,
            batch.organizationId,
            batch.deviceId,
            node.id,
            batch.sequence,
            JSON.stringify(batch),
          ],
        );
        for (const r of batch.records) {
          const old = await c.query<{ matches: boolean }>(
            `SELECT id=$1 AND organization_id=$2 AND device_id=$3 AND device_employee_id=$4
            AND recorded_at=$5::timestamptz AND record_type=$6 AND external_record_id IS NOT DISTINCT FROM $7::text
            AND source_identity IS NOT DISTINCT FROM NULLIF($8::jsonb,'null'::jsonb) AS matches
            FROM central_biometric_raw_evidence WHERE id=$1 OR (device_id=$3 AND
            ((external_record_id=$7 AND $7::text IS NOT NULL) OR (device_employee_id=$4 AND recorded_at=$5::timestamptz AND record_type=$6)))`,
            [
              r.id,
              batch.organizationId,
              batch.deviceId,
              r.deviceEmployeeId,
              r.recordedAt,
              r.recordType,
              r.externalRecordId,
              JSON.stringify(r.sourceIdentity ?? null),
            ],
          );
          if (old.rows.length) {
            if (old.rows.length !== 1 || !old.rows[0]!.matches)
              throw new DomainError(409, 'CONFLICT', 'Raw evidence identity mismatch');
          } else
            await c.query(
              `INSERT INTO central_biometric_raw_evidence(id,organization_id,device_id,device_employee_id,recorded_at,record_type,external_record_id,first_batch_id,source_identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9::jsonb,'null'::jsonb))`,
              [
                r.id,
                batch.organizationId,
                batch.deviceId,
                r.deviceEmployeeId,
                r.recordedAt,
                r.recordType,
                r.externalRecordId,
                batch.batchId,
                JSON.stringify(r.sourceIdentity ?? null),
              ],
            );
        }
        return { batchId: batch.batchId, received: true as const, finalized: false as const };
      });
    },
  };
}
