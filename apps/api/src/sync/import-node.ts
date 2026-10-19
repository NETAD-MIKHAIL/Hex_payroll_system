import type { Pool } from 'pg';
import { z } from 'zod';
import { nodeCredentialSchema } from './administration.js';
import { transaction } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import { selectLocalOrigin } from './outbox.js';

export const centralEndpointSchema = z
  .string()
  .refine((value) => !/\s/.test(value), 'URL whitespace is not allowed')
  .pipe(z.url())
  .refine((value) => {
    const u = new URL(value);
    return (
      !/\s/.test(value) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    );
  }, 'Use HTTPS or development loopback HTTP without URL credentials');

export async function importLocalNode(database: Pool, input: unknown) {
  const credential = nodeCredentialSchema.parse(input);
  await transaction(database, async (client) => {
    const setup = await client.query(
      'SELECT organization_id,administrator_id FROM application_setup WHERE singleton FOR UPDATE',
    );
    let initializing = false;
    if (setup.rows[0] && !setup.rows[0].organization_id) {
      if (!setup.rows[0].administrator_id)
        throw new Error('Bootstrap a local administrator before importing a device');
      if ((await client.query('SELECT 1 FROM organizations LIMIT 1')).rowCount)
        throw new Error('Import requires an empty organization or a matching canonical identity');
      await client.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Pending central organization')",
        [credential.organizationId],
      );
      await client.query('UPDATE application_setup SET organization_id=$1 WHERE singleton', [
        credential.organizationId,
      ]);
      await client.query('UPDATE auth_users SET organization_id=$1 WHERE organization_id IS NULL', [
        credential.organizationId,
      ]);
      setup.rows[0].organization_id = credential.organizationId;
      initializing = true;
    }
    if (setup.rows[0]?.organization_id !== credential.organizationId)
      throw new Error('Credential organization does not match local setup');
    const existing = await client.query(
      'SELECT id,token_hash,enabled,revoked_at FROM sync_nodes WHERE organization_id=$1',
      [credential.organizationId],
    );
    const same = existing.rows.find((row) => row.id === credential.nodeId);
    if (same && (!same.enabled || same.revoked_at))
      throw new Error('Existing node identity differs or was revoked');
    if (
      existing.rows.some(
        (row) => row.id !== credential.nodeId && row.token_hash && row.enabled && !row.revoked_at,
      )
    )
      throw new Error('Local installation already has an active node');
    if (!same)
      await client.query(
        'INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,$3,$4)',
        [
          credential.nodeId,
          credential.organizationId,
          credential.deviceName,
          tokenHash(credential.token),
        ],
      );
    if (same && same.token_hash !== tokenHash(credential.token))
      await client.query(
        'UPDATE sync_nodes SET token_hash=$2,credential_rotated_at=now() WHERE id=$1',
        [credential.nodeId, tokenHash(credential.token)],
      );
    // Future events use the enrolled identity; already queued origins are immutable.
    await selectLocalOrigin(client, credential.organizationId, credential.nodeId);
    if (initializing)
      await client.query(
        'UPDATE sync_local_identity SET reference_bootstrap_pending=true WHERE organization_id=$1',
        [credential.organizationId],
      );
  });
  return credential;
}

export function importedNodeEnvironment(original: string, input: unknown, endpoint: string) {
  const credential = nodeCredentialSchema.parse(input);
  const url = centralEndpointSchema.parse(endpoint);
  const keys =
    /^\s*(?:export\s+)?(SYNC_MODE|SYNC_CENTRAL_URL|SYNC_NODE_ID|SYNC_NODE_TOKEN|SYNC_ADMIN_TOKEN|SYNC_DEVICE_NAME)\s*=/;
  const lines = original.split(/\r?\n/).filter((line) => !keys.test(line));
  return [
    ...lines,
    'SYNC_MODE=disabled',
    `SYNC_CENTRAL_URL=${url}`,
    `SYNC_NODE_ID=${credential.nodeId}`,
    '',
  ].join('\n');
}
