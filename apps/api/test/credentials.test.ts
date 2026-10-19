import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { windowsCredentials } from '../src/sync/credentials.js';

test(
  'Windows Credential Manager round trip, rotation and removal without a plaintext file',
  { skip: process.platform !== 'win32' },
  async () => {
    const id = randomUUID(),
      first = randomBytes(32).toString('base64url'),
      second = randomBytes(32).toString('base64url');
    let stored = false;
    try {
      await windowsCredentials.write(id, first);
      stored = true;
      assert.equal(await windowsCredentials.read(id), first);
      await windowsCredentials.write(id, second);
      assert.equal(await windowsCredentials.read(id), second);
    } finally {
      if (stored) await windowsCredentials.remove(id);
    }
    await assert.rejects(windowsCredentials.read(id));
  },
);
