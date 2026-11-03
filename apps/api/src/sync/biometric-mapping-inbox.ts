import type { PoolClient } from 'pg';
import { z } from 'zod';
import { mappingInputSchema } from '@hexpayroll/shared';

const mappingSnapshotSchema = mappingInputSchema
  .extend({
    id: z.uuid(),
    organizationId: z.uuid(),
    revision: z.number().int().positive().max(2147483647),
    // Preserve the identifier exactly; the input schema normally trims text.
    deviceEmployeeId: z
      .string()
      .min(1)
      .max(254)
      .refine((value) => value.trim().length > 0),
    status: mappingInputSchema.shape.status.removeDefault(),
  })
  .strict();

interface BiometricMappingInboxEvent {
  organization_id: string;
  entity_id: string;
  operation: string;
  revision: number;
  payload_version: number;
  payload: unknown;
}

const fields = [
  ['employeeId', 'employee_id'],
  ['deviceId', 'device_id'],
  ['deviceEmployeeId', 'device_employee_id'],
  ['status', 'status'],
] as const;

// The caller supplies the local transaction/savepoint. Only mapping metadata is written.
export async function applyBiometricMappingEvent(
  client: PoolClient,
  event: BiometricMappingInboxEvent,
): Promise<void> {
  const parsed = mappingSnapshotSchema.safeParse(event.payload);
  if (!parsed.success || event.payload_version !== 1) {
    throw new Error('Invalid biometric mapping snapshot or version');
  }
  const mapping = parsed.data;
  if (
    mapping.id !== event.entity_id ||
    mapping.organizationId !== event.organization_id ||
    mapping.revision !== event.revision
  ) {
    throw new Error('Biometric mapping snapshot identity mismatch');
  }
  if (!['CREATE', 'UPDATE', 'ARCHIVE'].includes(event.operation)) {
    throw new Error('Invalid biometric mapping operation');
  }
  if (event.operation === 'ARCHIVE' && mapping.status !== 'inactive') {
    throw new Error('Archived biometric mapping must be inactive');
  }
  const setup = await client.query<{ organization_id: string | null }>(
    'SELECT organization_id FROM application_setup WHERE singleton FOR SHARE',
  );
  if (setup.rows[0]?.organization_id !== mapping.organizationId) {
    throw new Error('Biometric mapping organization is not enrolled');
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'biometric_mappings:' + mapping.id,
  ]);
  const current = (
    await client.query<Record<string, unknown>>(
      'SELECT * FROM biometric_mappings WHERE id=$1 FOR UPDATE',
      [mapping.id],
    )
  ).rows[0];
  if (current && current.organization_id !== mapping.organizationId) {
    throw new Error('Biometric mapping organization mismatch');
  }
  if (current && Number(current.revision) > mapping.revision) return;
  if (!current && event.operation !== 'CREATE') {
    throw new Error('Biometric mapping dependency missing locally');
  }
  const employee = await client.query(
    'SELECT id FROM employees WHERE id=$1 AND organization_id=$2 FOR KEY SHARE',
    [mapping.employeeId, mapping.organizationId],
  );
  if (!employee.rows[0]) throw new Error('Biometric mapping employee dependency missing locally');
  const device = await client.query(
    'SELECT id FROM biometric_devices WHERE id=$1 AND organization_id=$2 FOR KEY SHARE',
    [mapping.deviceId, mapping.organizationId],
  );
  if (!device.rows[0]) throw new Error('Biometric mapping device dependency missing locally');

  if (current && Number(current.revision) === mapping.revision) {
    if (!fields.every(([property, column]) => current[column] === mapping[property])) {
      throw new Error('Biometric mapping revision conflict; local data preserved');
    }
    return;
  }
  const collision = await client.query(
    `SELECT id FROM biometric_mappings
     WHERE device_id=$1 AND device_employee_id=$2 AND id<>$3`,
    [mapping.deviceId, mapping.deviceEmployeeId, mapping.id],
  );
  if (collision.rows[0]) {
    throw new Error('Biometric mapping identifier conflict; local data preserved');
  }
  // The unique constraint also rejects concurrent inserts for the same device identifier.
  if (!current) {
    await client.query(
      `INSERT INTO biometric_mappings(
        id,organization_id,employee_id,device_id,device_employee_id,status,revision
      ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        mapping.id,
        mapping.organizationId,
        mapping.employeeId,
        mapping.deviceId,
        mapping.deviceEmployeeId,
        mapping.status,
        mapping.revision,
      ],
    );
    return;
  }
  await client.query(
    `UPDATE biometric_mappings
     SET employee_id=$3,device_id=$4,device_employee_id=$5,status=$6,revision=$7
     WHERE id=$1 AND organization_id=$2`,
    [
      mapping.id,
      mapping.organizationId,
      mapping.employeeId,
      mapping.deviceId,
      mapping.deviceEmployeeId,
      mapping.status,
      mapping.revision,
    ],
  );
}
