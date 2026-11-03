import type { PoolClient } from 'pg';
import { z } from 'zod';
import { deviceInputSchema } from '@hexpayroll/shared';

const deviceSnapshotSchema = deviceInputSchema
  .extend({
    id: z.uuid(),
    organizationId: z.uuid(),
    revision: z.number().int().positive().max(2147483647),
    status: deviceInputSchema.shape.status.removeDefault(),
  })
  .strict();

interface BiometricDeviceInboxEvent {
  organization_id: string;
  entity_id: string;
  operation: string;
  revision: number;
  payload_version: number;
  payload: unknown;
}

const fields = ['code', 'name', 'status'] as const;

// The caller supplies the local database transaction (or inbox scheduler savepoint).
// Device connectivity and ingestion checkpoints are deliberately outside this handler.
export async function applyBiometricDeviceEvent(
  client: PoolClient,
  event: BiometricDeviceInboxEvent,
): Promise<void> {
  const parsed = deviceSnapshotSchema.safeParse(event.payload);
  if (!parsed.success || event.payload_version !== 1) {
    throw new Error('Invalid biometric device snapshot or version');
  }
  const device = parsed.data;
  if (
    device.id !== event.entity_id ||
    device.organizationId !== event.organization_id ||
    device.revision !== event.revision
  ) {
    throw new Error('Biometric device snapshot identity mismatch');
  }
  if (!['CREATE', 'UPDATE', 'ARCHIVE'].includes(event.operation)) {
    throw new Error('Invalid biometric device operation');
  }
  if (event.operation === 'ARCHIVE' && device.status !== 'inactive') {
    throw new Error('Archived biometric device must be inactive');
  }
  const setup = await client.query<{ organization_id: string | null }>(
    'SELECT organization_id FROM application_setup WHERE singleton FOR SHARE',
  );
  if (setup.rows[0]?.organization_id !== device.organizationId) {
    throw new Error('Biometric device organization is not enrolled');
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'biometric_devices:' + device.id,
  ]);
  const existing = await client.query<Record<string, unknown>>(
    'SELECT * FROM biometric_devices WHERE id=$1 FOR UPDATE',
    [device.id],
  );
  const current = existing.rows[0];
  if (!current) {
    if (event.operation !== 'CREATE') {
      throw new Error('Biometric device dependency missing locally');
    }
    await client.query(
      `INSERT INTO biometric_devices(id,organization_id,code,name,status,revision)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [device.id, device.organizationId, device.code, device.name, device.status, device.revision],
    );
    return;
  }
  if (current.organization_id !== device.organizationId) {
    throw new Error('Biometric device organization mismatch');
  }
  if (Number(current.revision) > device.revision) return;
  if (Number(current.revision) === device.revision) {
    if (!fields.every((key) => current[key] === device[key])) {
      throw new Error('Biometric device revision conflict; local data preserved');
    }
    return;
  }
  await client.query(
    `UPDATE biometric_devices SET code=$3,name=$4,status=$5,revision=$6
     WHERE id=$1 AND organization_id=$2`,
    [device.id, device.organizationId, device.code, device.name, device.status, device.revision],
  );
}
