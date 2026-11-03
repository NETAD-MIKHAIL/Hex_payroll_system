import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import type { Pool } from 'pg';
import { syncPushPreparseAuth } from '../src/sync/push-preparse-auth.js';

test('central PUSH pre-parser authentication and malformed JSON', async () => {
  const validToken = 'v'.repeat(43);
  const revokedToken = 'r'.repeat(43);

  const db = {
    query: async (_sql: string, params: unknown[]) => {
      const { tokenHash } = await import('../src/auth/service.js');

      if (params[0] === tokenHash(validToken)) {
        return {
          rows: [{ id: 'test-node', organization_id: 'test-org' }],
        };
      }

      return { rows: [] };
    },
  } as unknown as Pool;

  const app = express();

  app.post('/api/sync/push', syncPushPreparseAuth(db));
  app.use(express.json({ limit: '1mb' }));

  app.post('/api/sync/push', (_req, res) => {
    res.json({ accepted: true });
  });

  app.post('/api/other', (_req, res) => {
    res.json({ accepted: true });
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const type = (error as { type?: string }).type;
    res.status(type === 'entity.parse.failed' ? 400 : 500).json({
      error: { code: type === 'entity.parse.failed' ? 'INVALID_REQUEST' : 'INTERNAL_ERROR' },
    });
  });

  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const base = `http://127.0.0.1:${address.port}`;

    const post = async (path: string, token: string | undefined, body: string) => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
        body,
      });

      return {
        status: response.status,
        body: await response.json(),
      };
    };

    const cases = [
      { name: 'missing token, valid JSON', token: undefined, body: '{}', status: 401 },
      { name: 'missing token, malformed JSON', token: undefined, body: '{"events":', status: 401 },
      { name: 'invalid token, malformed JSON', token: 'x'.repeat(43), body: '{"events":', status: 401 },
      { name: 'revoked token, malformed JSON', token: revokedToken, body: '{"events":', status: 401 },
      { name: 'valid token, malformed JSON', token: validToken, body: '{"events":', status: 400 },
      { name: 'valid token, valid JSON', token: validToken, body: '{"events":[]}', status: 200 },
    ];

    for (const item of cases) {
      const result = await post('/api/sync/push', item.token, item.body);
      assert.equal(result.status, item.status, item.name);
      if (item.status === 401) {
        assert.equal(result.body.error.code, 'NODE_INVALID', item.name);
      }
      if (item.status === 400) {
        assert.equal(result.body.error.code, 'INVALID_REQUEST', item.name);
      }
    }

    const other = await post('/api/other', undefined, '{"invalid":');
    assert.equal(other.status, 400, 'Other routes retain normal JSON parsing');

  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
