import { Router, json } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createAuthService } from '../auth/service.js';
import { importLocalNode, centralEndpointSchema } from '../sync/import-node.js';
import { nodeCredentialSchema } from '../sync/administration.js';
import { windowsCredentials } from '../sync/credentials.js';

const inputSchema = z
  .object({
    endpoint: centralEndpointSchema,
    credential: nodeCredentialSchema,
    enable: z.boolean(),
  })
  .strict();
export function desktopAdministrationRouter(database: Pool) {
  const router = Router();
  let running = false;
  router.post('/api/desktop/admin/import', json({ limit: '20kb' }), async (req, res, next) => {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const session = token ? await createAuthService(database).session(token) : null;
    if (!session?.user.roles?.includes('administrator')) {
      res.status(403).json({ error: { message: 'Sign in as a local administrator.' } });
      return;
    }
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success || new URL(parsed.data.endpoint).protocol !== 'https:') {
      res
        .status(400)
        .json({ error: { message: 'Use a valid credential file and HTTPS central endpoint.' } });
      return;
    }
    if (running) {
      res.status(409).json({ error: { message: 'A configuration operation is already running.' } });
      return;
    }
    running = true;
    try {
      await windowsCredentials.write(parsed.data.credential.nodeId, parsed.data.credential.token);
      await importLocalNode(database, parsed.data.credential);
      const path = join(process.cwd(), 'sync.json');
      await writeFile(
        path + '.tmp',
        JSON.stringify({
          mode: parsed.data.enable ? 'local' : 'disabled',
          url: parsed.data.endpoint,
          nodeId: parsed.data.credential.nodeId,
        }),
        { mode: 0o600 },
      );
      await rename(path + '.tmp', path);
      res.json({ configured: true });
    } catch (error) {
      next(error);
    } finally {
      running = false;
    }
  });
  return router;
}
