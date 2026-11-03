import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import { privateApiBoundary } from '../src/middleware/private-api.js';
import { desktopEnrollmentSchema } from '../src/desktop/enrollment.js';
import { manualDeviceConnectionSchema } from '../src/desktop/device-config.js';

test('private launch authentication rejects before body parsing and preserves session authorization', async () => {
  const token = randomBytes(32).toString('base64url');
  const app = express();
  app.use(privateApiBoundary(token, 'http://127.0.0.1:52739'));
  app.use(express.json());
  app.post('/', (req, res) => res.json({ authorization: req.headers.authorization }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    for (const candidate of ['', 'short', randomBytes(32).toString('base64url')]) {
      assert.equal(
        (
          await fetch(url, {
            method: 'POST',
            headers: { 'X-Hex-Private-Token': candidate, 'Content-Type': 'application/json' },
            body: '{invalid',
          })
        ).status,
        401,
      );
    }
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { 'X-Hex-Private-Token': token, Origin: 'null' },
        })
      ).status,
      401,
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Hex-Private-Token': token,
        Origin: 'http://127.0.0.1:52739',
        Authorization: 'Bearer user-session',
      },
    });
    assert.deepEqual(await response.json(), { authorization: 'Bearer user-session' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('per-PC import requires HTTPS and rejects shared administrator secrets', () => {
  const registration = {
    url: 'https://isolated-rehearsal.invalid',
    nodeId: randomUUID(),
    organizationId: randomUUID(),
    token: randomBytes(32).toString('base64url'),
    deviceName: 'Rehearsal PC',
  };
  assert.equal(desktopEnrollmentSchema.safeParse(registration).success, true);
  for (const url of [
    'http://central.invalid',
    'https://user:password@central.invalid',
    'https://central.invalid/?token=x',
    'https://central.invalid/#secret',
  ])
    assert.equal(desktopEnrollmentSchema.safeParse({ ...registration, url }).success, false);
  assert.equal(
    desktopEnrollmentSchema.safeParse({ ...registration, administratorToken: registration.token })
      .success,
    false,
  );
});

test('manual biometric inventory never enables capture or advertises an unverified protocol', () => {
  const connection = {
    deviceId: randomUUID(),
    ipAddress: '192.168.1.201',
    port: 4370,
    protocol: 'manual-unverified',
    captureEnabled: false,
  };
  assert.equal(manualDeviceConnectionSchema.safeParse(connection).success, true);
  for (const patch of [
    { port: 0 },
    { port: 65536 },
    { ipAddress: 'not-an-ip' },
    { captureEnabled: true },
    { protocol: 'certified-zk' },
  ])
    assert.equal(
      manualDeviceConnectionSchema.safeParse({ ...connection, ...patch }).success,
      false,
    );
});
