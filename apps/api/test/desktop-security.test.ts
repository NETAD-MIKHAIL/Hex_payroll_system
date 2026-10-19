import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { get } from 'node:http';
import { desktopGuard } from '../src/desktop/security.js';

test('desktop boundary requires launch credential and rejects browser origins and forged hosts', async () => {
  const app = express();
  const token = 'a'.repeat(43);
  app.use(desktopGuard(token));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/health`;
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal(
      (
        await fetch(url, {
          headers: { 'x-hex-desktop': token, origin: 'https://untrusted.example' },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(url, { headers: { 'x-hex-desktop': 'b'.repeat(43) } })).status, 403);
    const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = get(
        url,
        { headers: { 'x-hex-desktop': token, host: 'attacker.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.once('error', reject);
    });
    assert.equal(forgedHostStatus, 403);
    assert.equal(
      (await fetch(url, { headers: { 'x-hex-desktop': token, origin: 'null' } })).status,
      403,
    );
    assert.equal(
      (await fetch(url, { headers: { 'x-hex-desktop': token, origin: 'hexpayroll://app' } }))
        .status,
      200,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
