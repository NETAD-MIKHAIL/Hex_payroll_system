import type { PoolClient } from 'pg';
import { z } from 'zod';
import { timeRecordTypeSchema } from '@hexpayroll/shared';

const snapshotSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    revision: z.number().int().positive().max(2147483647),
    timeRecordId: z.uuid(),
    operation: z.enum(['replace', 'void']),
    recordedAt: z.iso.datetime({ offset: true }).nullable(),
    recordType: timeRecordTypeSchema.nullable(),
    reason: z
      .string()
      .min(1)
      .max(2000)
      .refine((value) => value.trim().length > 0),
    createdBy: z.uuid(),
  })
  .strict()
  .refine(
    (value) =>
      value.operation === 'void' || (value.recordedAt !== null && value.recordType !== null),
    'Replacement requires timestamp and type',
  );

interface TimeRecordCorrectionInboxEvent {
  organization_id: string;
  entity_id: string;
  operation: string;
  revision: number;
  payload_version: number;
  payload: unknown;
}

// The caller supplies the local transaction/savepoint. Correction evidence is append-only.
export async function applyTimeRecordCorrectionEvent(
  client: PoolClient,
  event: TimeRecordCorrectionInboxEvent,
): Promise<void> {
  const parsed = snapshotSchema.safeParse(event.payload);
  if (!parsed.success || event.payload_version !== 1) {
    throw new Error('Invalid time record correction snapshot or version');
  }
  const correction = parsed.data;
  if (
    correction.id !== event.entity_id ||
    correction.organizationId !== event.organization_id ||
    correction.revision !== event.revision
  ) {
    throw new Error('Time record correction snapshot identity mismatch');
  }
  if (event.operation !== 'CREATE') throw new Error('Immutable corrections require CREATE');
  const setup = await client.query<{ organization_id: string | null }>(
    'SELECT organization_id FROM application_setup WHERE singleton FOR SHARE',
  );
  if (setup.rows[0]?.organization_id !== correction.organizationId) {
    throw new Error('Time record correction organization is not enrolled');
  }
  // Ordinary SELECT preserves INSERT/SELECT-only privileges on immutable punches.
  const parent = (
    await client.query<{ organization_id: string; employee_id: string }>(
      'SELECT organization_id,employee_id FROM time_records WHERE id=$1',
      [correction.timeRecordId],
    )
  ).rows[0];
  if (!parent) throw new Error('Correction original punch dependency missing locally');
  if (parent.organization_id !== correction.organizationId) {
    throw new Error('Correction original punch organization mismatch');
  }
  // Local correct() takes this same employee lock before reading the latest revision.
  // It serializes local and incoming corrections even though each revision has its own UUID.
  const employee = await client.query(
    'SELECT id FROM employees WHERE id=$1 AND organization_id=$2 FOR UPDATE',
    [parent.employee_id, correction.organizationId],
  );
  if (!employee.rows[0]) throw new Error('Correction employee dependency missing locally');
  // Also serialize correction UUID ownership across different parent punches.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'time_record_corrections:' + correction.id,
  ]);
  const current = (
    await client.query<Record<string, unknown>>(
      `SELECT *,recorded_at IS NOT DISTINCT FROM $2::timestamptz AS timestamp_matches
     FROM time_record_corrections WHERE id=$1`,
      [correction.id, correction.recordedAt],
    )
  ).rows[0];
  if (current) {
    if (
      current.organization_id !== correction.organizationId ||
      current.time_record_id !== correction.timeRecordId ||
      Number(current.revision) !== correction.revision ||
      current.operation !== correction.operation ||
      current.timestamp_matches !== true ||
      current.record_type !== correction.recordType ||
      current.reason !== correction.reason ||
      current.created_by !== correction.createdBy
    ) {
      throw new Error('Immutable correction UUID conflict; local evidence preserved');
    }
    return;
  }
  const creator = await client.query(
    'SELECT id FROM auth_users WHERE id=$1 AND organization_id=$2 FOR KEY SHARE',
    [correction.createdBy, correction.organizationId],
  );
  if (!creator.rows[0]) throw new Error('Correction creator dependency missing locally');
  const occupied = await client.query(
    'SELECT id FROM time_record_corrections WHERE time_record_id=$1 AND revision=$2',
    [correction.timeRecordId, correction.revision],
  );
  if (occupied.rows[0]) {
    throw new Error('Correction parent revision conflict; local evidence preserved');
  }
  const latest = (
    await client.query<{ revision: number }>(
      'SELECT revision FROM time_record_corrections WHERE time_record_id=$1 ORDER BY revision DESC LIMIT 1',
      [correction.timeRecordId],
    )
  ).rows[0];
  if (correction.revision !== Number(latest?.revision ?? 0) + 1) {
    throw new Error('Correction revision gap; preceding correction missing locally');
  }
  // Origin created_at is absent from the outbound contract; use local receipt time.
  await client.query(
    `INSERT INTO time_record_corrections(
       id,organization_id,time_record_id,operation,recorded_at,record_type,reason,revision,created_by
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      correction.id,
      correction.organizationId,
      correction.timeRecordId,
      correction.operation,
      correction.recordedAt,
      correction.recordType,
      correction.reason,
      correction.revision,
      correction.createdBy,
    ],
  );
}
