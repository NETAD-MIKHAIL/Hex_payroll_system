import { createInterface } from 'node:readline/promises';
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import {
  importLocalNode,
  importedNodeEnvironment,
  centralEndpointSchema,
} from '../sync/import-node.js';
import { windowsCredentials } from '../sync/credentials.js';
import { nodeCredentialSchema } from '../sync/administration.js';

let temporary: string | undefined;
try {
  if (
    env.SYNC_MODE !== 'disabled' ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.argv.length !== 2
  )
    throw new Error(
      'Stop the local API and run interactively with SYNC_MODE=disabled, without arguments',
    );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let credentialPath: string, endpoint: string;
  try {
    const target = (await pool.query('SELECT current_database() AS database')).rows[0].database;
    console.log(`Local import target: ${target}`);
    if ((await prompt.question('Confirm local database name: ')) !== target)
      throw new Error('Target mismatch');
    credentialPath = (await prompt.question('Private central credential file path: ')).trim();
    endpoint = centralEndpointSchema.parse(
      (await prompt.question('Central HTTPS API endpoint: ')).trim(),
    );
  } finally {
    prompt.close();
  }
  if ((await stat(credentialPath)).size > 16384) throw new Error('Credential file too large');
  const credential = nodeCredentialSchema.parse(JSON.parse(await readFile(credentialPath, 'utf8')));
  const original = await readFile('.env', 'utf8');
  if (env.SYNC_NODE_ID && env.SYNC_NODE_ID !== credential.nodeId)
    throw new Error('A different installation is already configured');
  temporary = `.env.sync-import-${randomUUID()}`;
  await writeFile(temporary, importedNodeEnvironment(original, credential, endpoint), {
    flag: 'wx',
    mode: 0o600,
  });
  await windowsCredentials.write(credential.nodeId, credential.token);
  await importLocalNode(pool, credential);
  // If rename fails, import of the same credential can be retried safely.
  if ((await readFile('.env', 'utf8')) !== original)
    throw new Error('Environment changed during import; retry after reviewing it');
  await rename(temporary, '.env');
  temporary = undefined;
  console.log(
    'Node credential imported. Sync remains disabled. Remove the transferred credential file securely; enable SYNC_MODE=local only when ready for the transport test.',
  );
} catch {
  console.error(
    'Credential import failed. Check local setup/configuration and the credential file. Sync was not enabled; retry with the same credential after reviewing local node state.',
  );
  process.exitCode = 1;
} finally {
  if (temporary) await unlink(temporary).catch(() => {});
  await pool.end();
}
