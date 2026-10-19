import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { syncRegistrationSchema, syncRegistrationResponseSchema } from '@hexpayroll/shared';
import { transaction, audit } from '../foundation/repository.js';
import { registerNode } from './service.js';

export const nodeCredentialSchema = syncRegistrationResponseSchema.extend({
  deviceName: syncRegistrationSchema.shape.deviceName,
});

async function requireCentralOrganization(client: PoolClient, organizationId: string) {
  const role = (await client.query('SELECT current_user AS role')).rows[0].role;
  if (role === 'hexpayroll_app') throw new Error('Use a separate enrollment database role');
  const setup = await client.query(
    'SELECT organization_id,administrator_id FROM application_setup WHERE singleton',
  );
  if (!setup.rows[0]?.administrator_id || setup.rows[0].organization_id !== organizationId)
    throw new Error('Central setup is incomplete or canonical organization does not match');
}

export async function enrollCentralNode(database: Pool, input: unknown) {
  const parsed = syncRegistrationSchema.parse(input);
  return transaction(database, async (client) => {
    await requireCentralOrganization(client, parsed.organizationId);
    const result = await registerNode(client, parsed.organizationId, parsed.deviceName);
    await audit(
      client,
      { id: null, organizationId: parsed.organizationId },
      'DEVICE_REGISTERED',
      'sync_nodes',
      result.nodeId,
    );
    return nodeCredentialSchema.parse({ ...result, deviceName: parsed.deviceName });
  });
}

export async function revokeCentralNode(database: Pool, organizationId: string, nodeId: string) {
  z.uuid().parse(organizationId);
  z.uuid().parse(nodeId);
  return transaction(database, async (client) => {
    await requireCentralOrganization(client, organizationId);
    const result = await client.query(
      'UPDATE sync_nodes SET enabled=false,revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND organization_id=$2 RETURNING id',
      [nodeId, organizationId],
    );
    if (!result.rowCount) throw new Error('Node is not enrolled in the canonical organization');
    await audit(client, { id: null, organizationId }, 'DEVICE_REVOKED', 'sync_nodes', nodeId);
    return { nodeId, revoked: true };
  });
}
