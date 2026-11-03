import type { PoolClient } from 'pg';
import { z } from 'zod';
import { timeRecordSourceSchema, timeRecordTypeSchema } from '@hexpayroll/shared';

const identifier = z
  .string()
  .min(1)
  .max(254)
  .refine((value) => value.trim().length > 0);
const snapshotSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    revision: z.literal(1),
    employeeId: z.uuid(),
    recordedAt: z.iso.datetime({ offset: true }),
    recordType: timeRecordTypeSchema,
    source: timeRecordSourceSchema,
    deviceId: z.uuid().nullable(),
    deviceEmployeeId: identifier.nullable(),
    externalRecordId: identifier.nullable(),
    reason: z.string().max(2000).nullable(),
    createdBy: z.uuid(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      record.source === 'biometric' &&
      (record.deviceId === null || record.deviceEmployeeId === null)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Biometric punch requires device and device-user identifier',
      });
    }
    if (record.source === 'manual' && !record.reason?.trim()) {
      ctx.addIssue({ code: 'custom', message: 'Manual punch requires a reason' });
    }
  });

interface TimeRecordInboxEvent {
  organization_id: string;
  entity_id: string;
  operation: string;
  revision: number;
  payload_version: number;
  payload: unknown;
}

const fields = [
  ['employeeId', 'employee_id'],
  ['recordType', 'record_type'],
  ['source', 'source'],
  ['deviceId', 'device_id'],
  ['deviceEmployeeId', 'device_employee_id'],
  ['externalRecordId', 'external_record_id'],
  ['reason', 'reason'],
  ['createdBy', 'created_by'],
] as const;

// The caller supplies the local transaction/savepoint. Raw evidence is insert-only.
export async function applyTimeRecordEvent(
  client: PoolClient,
  event: TimeRecordInboxEvent,
): Promise<void> {
  const parsed = snapshotSchema.safeParse(event.payload);
  if (!parsed.success || event.payload_version !== 1) {
    throw new Error('Invalid time record snapshot or version');
  }
  const record = parsed.data;
  if (
    record.id !== event.entity_id ||
    record.organizationId !== event.organization_id ||
    record.revision !== event.revision
  ) {
    throw new Error('Time record snapshot identity mismatch');
  }
  if (event.operation !== 'CREATE') throw new Error('Immutable time records require CREATE');
  const setup = await client.query<{ organization_id: string | null }>(
    'SELECT organization_id FROM application_setup WHERE singleton FOR SHARE',
  );
  if (setup.rows[0]?.organization_id !== record.organizationId) {
    throw new Error('Time record organization is not enrolled');
  }
  // Serialize incoming evidence for a device, including different UUIDs for one physical punch.
  if (record.deviceId !== null) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'time_records:device:' + record.deviceId,
    ]);
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'time_records:' + record.id,
  ]);
  // Raw punches cannot be updated or deleted by the application role. A plain SELECT
  // preserves those permissions; the advisory locks above serialize inbox receivers.
  const current = (
    await client.query<Record<string, unknown>>(
      `SELECT *,recorded_at=$2::timestamptz AS timestamp_matches
     FROM time_records WHERE id=$1`,
      [record.id, record.recordedAt],
    )
  ).rows[0];
  if (current) {
    if (current.organization_id !== record.organizationId) {
      throw new Error('Time record organization mismatch');
    }
    // Compare timestamps in PostgreSQL to retain microsecond precision and offset equivalence.
    if (
      Number(current.revision) !== 1 ||
      current.timestamp_matches !== true ||
      !fields.every(([property, column]) => current[column] === record[property])
    ) {
      throw new Error('Immutable time record conflict; local evidence preserved');
    }
    return;
  }
  const employee = await client.query(
    'SELECT id FROM employees WHERE id=$1 AND organization_id=$2 FOR KEY SHARE',
    [record.employeeId, record.organizationId],
  );
  if (!employee.rows[0]) throw new Error('Time record employee dependency missing locally');
  const creator = await client.query(
    'SELECT id FROM auth_users WHERE id=$1 AND organization_id=$2 FOR KEY SHARE',
    [record.createdBy, record.organizationId],
  );
  if (!creator.rows[0]) throw new Error('Time record creator dependency missing locally');
  if (record.deviceId !== null) {
    const device = await client.query(
      'SELECT id FROM biometric_devices WHERE id=$1 AND organization_id=$2 FOR KEY SHARE',
      [record.deviceId, record.organizationId],
    );
    if (!device.rows[0]) throw new Error('Time record device dependency missing locally');
    const duplicate = await client.query(
      `SELECT id FROM time_records WHERE device_id=$1 AND (
         ($2::text IS NOT NULL AND external_record_id=$2)
         OR (device_employee_id=$3 AND recorded_at=$4::timestamptz AND record_type=$5)
       ) LIMIT 1`,
      [
        record.deviceId,
        record.externalRecordId,
        record.deviceEmployeeId,
        record.recordedAt,
        record.recordType,
      ],
    );
    if (duplicate.rows[0]) {
      throw new Error(
        'Physical punch evidence conflict under another UUID; local evidence preserved',
      );
    }
  }
  // Never re-resolve attribution through current mappings, which may have been reassigned.
  // created_at is local receipt time because the current outbox omits the origin timestamp.
  await client.query(
    `INSERT INTO time_records(
       id,organization_id,employee_id,recorded_at,record_type,source,device_id,
       device_employee_id,external_record_id,reason,created_by,revision
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`,
    [
      record.id,
      record.organizationId,
      record.employeeId,
      record.recordedAt,
      record.recordType,
      record.source,
      record.deviceId,
      record.deviceEmployeeId,
      record.externalRecordId,
      record.reason,
      record.createdBy,
    ],
  );
}
