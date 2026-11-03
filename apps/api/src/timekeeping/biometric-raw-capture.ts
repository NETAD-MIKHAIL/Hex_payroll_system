import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { biometricBatchSchema } from '@hexpayroll/shared';
import { DomainError } from '../foundation/repository.js';

/** Called under the existing device lock and ingestion transaction, before mapping.
 * Raw capture is evidence of receipt only, never proof of period completeness.
 */
export async function captureRawBatch(
  client: PoolClient,
  organizationId: string,
  userId: string,
  input: z.infer<typeof biometricBatchSchema>,
) {
  const ids: string[] = [];
  for (const punch of input.records) {
    const values = [
      organizationId,
      input.deviceId,
      punch.deviceEmployeeId,
      punch.recordedAt,
      punch.recordType,
      punch.externalRecordId,
      userId,
      JSON.stringify(punch.sourceIdentity ?? null),
    ];
    const existing = await client.query<{ id: string; matches: boolean }>(
      `SELECT id,organization_id=$1 AND device_employee_id=$3 AND recorded_at=$4::timestamptz
        AND record_type=$5 AND external_record_id IS NOT DISTINCT FROM $6::text
        AND source_identity IS NOT DISTINCT FROM NULLIF($7::jsonb,'null'::jsonb) AS matches
       FROM biometric_raw_captures WHERE device_id=$2 AND
        ((external_record_id=$6 AND $6::text IS NOT NULL) OR
         (device_employee_id=$3 AND recorded_at=$4::timestamptz AND record_type=$5))`,
      [...values.slice(0, 6), values[7]],
    );
    if (existing.rows.length) {
      if (existing.rows.length !== 1 || !existing.rows[0]!.matches)
        throw new DomainError(
          409,
          'CONFLICT',
          'Raw biometric identity reused with different evidence',
        );
      ids.push(existing.rows[0]!.id);
    } else {
      const row = await client.query<{ id: string }>(
        `INSERT INTO biometric_raw_captures
         (organization_id,device_id,device_employee_id,recorded_at,record_type,external_record_id,captured_by,source_identity)
         VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8::jsonb,'null'::jsonb)) RETURNING id`,
        values,
      );
      ids.push(row.rows[0]!.id);
    }
  }
  await client.query(
    `INSERT INTO biometric_capture_batches(organization_id,device_id,captured_by,raw_ids,sequence)
     VALUES($1,$2,$3,$4::jsonb,(SELECT COALESCE(max(sequence),0)+1 FROM biometric_capture_batches WHERE device_id=$2))`,
    [organizationId, input.deviceId, userId, JSON.stringify([...new Set(ids)])],
  );
}
