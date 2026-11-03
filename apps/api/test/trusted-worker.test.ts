import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { startTrustedEvidenceWorker } from '../src/sync/trusted-worker.js';

const config = { url: 'https://central.example', nodeId: 'unused', token: 'unused' };
test('pilot workers hold broad streams and a failed policy read advances nothing', async () => {
  for (const unavailable of [false, true]) {
    let calls = 0,
      errors = 0;
    const worker = startTrustedEvidenceWorker(
      {} as Pool,
      config,
      { mode: 'local', enabled: true, interval: 300000 },
      () => {
        errors++;
      },
      {
        pilotActive: async () => {
          if (unavailable) throw new Error('unavailable');
          return true;
        },
        pull: async () => {
          calls++;
          return false;
        },
        apply: async () => {
          calls++;
          return { applied: 0, pending: 0, conflicts: 0 };
        },
        pullIdentities: async () => {
          calls++;
          return false;
        },
        applyIdentities: async () => {
          calls++;
          return { applied: 0, pending: 0, conflicts: 0 };
        },
        now: () => 0,
      },
    );
    await worker.tick();
    await worker.stop();
    assert.equal(calls, 0);
    assert.equal(errors, unavailable ? 1 : 0);
  }
});
test('trusted worker is explicitly enabled and local-only', async () => {
  let calls = 0;
  const dependencies = {
    pull: async () => {
      calls++;
      return false;
    },
    apply: async () => {
      calls++;
      return { applied: 0, pending: 0, conflicts: 0 };
    },
    now: () => 0,
  };
  for (const options of [
    { mode: 'local', enabled: false },
    { mode: 'central', enabled: true },
    { mode: 'disabled', enabled: true },
  ] as const) {
    const worker = startTrustedEvidenceWorker(
      {} as Pool,
      config,
      { ...options, interval: 1000 },
      () => {},
      dependencies,
    );
    await worker.tick();
    await worker.stop();
  }
  assert.equal(calls, 0);
});
test('trusted worker prevents overlapping ticks and waits for in-flight application on shutdown', async () => {
  let release!: () => void,
    started!: () => void,
    calls = 0;
  const applying = new Promise<void>((resolve) => {
    started = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = startTrustedEvidenceWorker(
    {} as Pool,
    config,
    { mode: 'local', enabled: true, interval: 300000 },
    () => {},
    {
      pull: async () => {
        calls++;
        return false;
      },
      apply: async () => {
        started();
        await barrier;
        return { applied: 1, pending: 0, conflicts: 0 };
      },
      now: () => 0,
    },
  );
  await applying;
  const one = worker.tick(),
    two = worker.tick();
  assert.equal(one, two);
  let stopped = false;
  const stop = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stop;
  await worker.tick();
  assert.equal(calls, 1);
  assert.equal(stopped, true);
});
test('trusted worker backs off failed transport with a bound while applying durable inbox independently', async () => {
  let now = 0,
    pulls = 0,
    applications = 0,
    errors = 0;
  const worker = startTrustedEvidenceWorker(
    {} as Pool,
    config,
    { mode: 'local', enabled: true, interval: 1000 },
    () => {
      errors++;
    },
    {
      pull: async () => {
        pulls++;
        throw new Error('offline');
      },
      apply: async () => {
        applications++;
        return { applied: 0, pending: 0, conflicts: 0 };
      },
      now: () => now,
    },
  );
  await worker.tick();
  assert.equal(pulls, 1);
  await worker.tick();
  assert.equal(pulls, 1);
  assert.equal(applications, 2);
  for (let i = 0; i < 10; i++) {
    now += 300000;
    await worker.tick();
  }
  const previous = pulls;
  now += 300000;
  await worker.tick();
  assert.equal(pulls, previous + 1);
  await worker.stop();
  assert.equal(errors, pulls);
});
