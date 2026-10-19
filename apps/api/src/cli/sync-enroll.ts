import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { syncRegistrationResponseSchema, syncRegistrationSchema } from '@hexpayroll/shared';
import { pool } from '../db/pool.js';
import { transaction } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import { windowsCredentials } from '../sync/credentials.js';
import { selectLocalOrigin } from '../sync/outbox.js';

class EnrollmentError extends Error {}

// Run with SYNC_MODE=disabled. Credentials stay out of command arguments/logs.
try {
  const url = z.url().parse(process.env.SYNC_CENTRAL_URL);
  const u = new URL(url);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
  )
    throw new EnrollmentError('Use HTTPS or loopback HTTP without URL credentials');
  const admin = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .parse(process.env.SYNC_ADMIN_TOKEN);
  const setup = await pool.query('SELECT organization_id FROM application_setup WHERE singleton');
  if (!setup.rows[0]?.organization_id)
    throw new EnrollmentError('Complete local organization setup first');
  const body = syncRegistrationSchema.parse({
    deviceName: process.env.SYNC_DEVICE_NAME,
    organizationId: setup.rows[0].organization_id,
  });
  if (process.env.SYNC_NODE_ID || process.env.SYNC_NODE_TOKEN)
    throw new EnrollmentError('Installation already configured; revoke it before re-enrollment');
  const response = await fetch(url.replace(/\/$/, '') + '/api/sync/nodes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) throw new EnrollmentError(`Registration rejected (${response.status})`);
  const node = syncRegistrationResponseSchema.parse(await response.json());
  if (node.organizationId !== setup.rows[0].organization_id)
    throw new EnrollmentError(
      'Central and local organization IDs differ; registration must be revoked centrally',
    );
  await windowsCredentials.write(node.nodeId, node.token);
  await transaction(pool, async (c) => {
    await c.query(
      'INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,$3,$4)',
      [node.nodeId, node.organizationId, body.deviceName, tokenHash(node.token)],
    );
    await selectLocalOrigin(c, node.organizationId, node.nodeId);
  });
  const original = await readFile('.env', 'utf8');
  const lines = original
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*(SYNC_MODE|SYNC_CENTRAL_URL|SYNC_NODE_ID|SYNC_NODE_TOKEN|SYNC_ADMIN_TOKEN|SYNC_DEVICE_NAME)=/.test(
          line,
        ),
    );
  lines.push('SYNC_MODE=local', `SYNC_CENTRAL_URL=${url}`, `SYNC_NODE_ID=${node.nodeId}`, '');
  await writeFile('.env', lines.join('\n'), { mode: 0o600 });
  console.log('Installation enrolled. Restart the local API to enable transport.');
} catch (error) {
  // Never print fetch/config errors containing URLs or tokens.
  console.error(
    error instanceof z.ZodError
      ? 'Invalid enrollment configuration'
      : error instanceof EnrollmentError
        ? error.message
        : 'Enrollment failed; inspect central installation list before retrying',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
