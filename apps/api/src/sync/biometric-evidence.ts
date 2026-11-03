import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { tokenHash } from '../auth/service.js';
import { transaction } from '../foundation/repository.js';
import { biometricEvidenceBatchSchema } from '../timekeeping/central-biometric-evidence.js';
import { syncRequest, type SyncClientConfig } from './client.js';

/** One immutable batch per tick. Lost responses retry the same batch identity.
 * No delivery cursor is advanced until a validated central receipt is committed.
 */
export async function pushNextBiometricBatch(pool: Pool, config: SyncClientConfig) {
  const identity = async (c: Pool | PoolClient) => {
    const result = await c.query<{ organization_id: string }>(
      `SELECT organization_id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL`,
      [config.nodeId, tokenHash(config.token)],
    );
    if (!result.rows[0]) throw new Error('Local installation not enrolled');
    return result.rows[0].organization_id;
  };
  const org = await identity(pool);
  const pending = await pool.query(
    `SELECT b.*,b.sequence::text ordinal FROM biometric_capture_batches b
    WHERE b.organization_id=$1 AND NOT EXISTS(SELECT 1 FROM biometric_batch_deliveries d WHERE d.batch_id=b.id)
    ORDER BY b.captured_at,b.id LIMIT 1`,
    [org],
  );
  const batch = pending.rows[0];
  if (!batch) return false;
  const records = await pool.query(
    `SELECT r.id,r.device_employee_id AS "deviceEmployeeId",
    to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt",
    r.record_type AS "recordType",r.external_record_id AS "externalRecordId",r.source_identity
    FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY x(id,n)
    JOIN biometric_raw_captures r ON r.id=x.id::uuid AND r.organization_id=$2 AND r.device_id=$3 ORDER BY x.n`,
    [JSON.stringify(batch.raw_ids), org, batch.device_id],
  );
  const body = biometricEvidenceBatchSchema.parse({
    version: 1,
    batchId: batch.id,
    organizationId: org,
    deviceId: batch.device_id,
    sequence: Number(batch.ordinal),
    records: records.rows.map(({ source_identity, ...r }) => ({
      ...r,
      ...(source_identity ? { sourceIdentity: source_identity } : {}),
    })),
  });
  const receipt = z
    .object({
      batchId: z.literal(body.batchId),
      received: z.literal(true),
      finalized: z.literal(false),
    })
    .strict()
    .parse(await syncRequest(config, 'biometric/receive', body));
  await transaction(pool, async (c) => {
    await identity(c);
    await c.query(
      'INSERT INTO biometric_batch_deliveries(batch_id,node_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [receipt.batchId, config.nodeId],
    );
  });
  return true;
}
