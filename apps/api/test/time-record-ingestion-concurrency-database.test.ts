import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { createTimeRecordService } from '../src/timekeeping/services.js';
import { applyTimeRecordEvent } from '../src/sync/time-record-inbox.js';
import type { Actor } from '../src/foundation/repository.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const db = await databaseFixture();
  try {
    await migrate(db.migrator, db.migrations);
    const org = randomUUID(),
      employeeId = randomUUID(),
      deviceId = randomUUID(),
      userId = randomUUID();
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Concurrency test')",
      [org],
    );
    await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
    await db.runtime.query(
      `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
       VALUES($1,$2,'E1','Ana','Santos')`,
      [employeeId, org],
    );
    await db.runtime.query(
      "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'CLOCK','Clock')",
      [deviceId, org],
    );
    await db.runtime.query(
      `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
       VALUES($1,$2,'concurrency_user','Collector',$3)`,
      [userId, org, DUMMY_PASSWORD_HASH],
    );
    await db.runtime.query(
      `INSERT INTO biometric_mappings(organization_id,employee_id,device_id,device_employee_id)
       VALUES($1,$2,$3,'001025')`,
      [org, employeeId, deviceId],
    );
    const actor: Actor = { id: userId, organizationId: org, permissions: [], roles: [] };
    const payload = {
      id: randomUUID(),
      organizationId: org,
      revision: 1,
      employeeId,
      deviceId,
      deviceEmployeeId: '001025',
      recordedAt: '2026-01-01T00:00:00.123456Z',
      recordType: 'in' as const,
      source: 'biometric',
      externalRecordId: null as string | null,
      reason: null,
      createdBy: userId,
    };
    type Snapshot = typeof payload;
    async function inbox(client: PoolClient, snapshot: Snapshot) {
      await applyTimeRecordEvent(client, {
        organization_id: org,
        entity_id: snapshot.id,
        operation: 'CREATE',
        revision: 1,
        payload_version: 1,
        payload: snapshot,
      });
    }
    function ingest(client: PoolClient, snapshot: Snapshot) {
      // Pin the real service's transaction to a dedicated connection. Its release is owned here.
      const pinned = new Proxy(client, {
        get(target, property) {
          if (property === 'release') return () => {};
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return createTimeRecordService({ connect: async () => pinned } as unknown as Pool).ingest(
        actor,
        {
          deviceId,
          records: [
            {
              deviceEmployeeId: snapshot.deviceEmployeeId,
              recordedAt: snapshot.recordedAt,
              recordType: snapshot.recordType,
              externalRecordId: snapshot.externalRecordId,
            },
          ],
        },
      );
    }
    async function rows() {
      return (
        await db.runtime.query(
          `SELECT *,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_at
         FROM time_records ORDER BY id`,
        )
      ).rows;
    }
    async function blockedBy(waiter: number, holder: number) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await db.runtime.query(
          'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',
          [waiter, holder],
        );
        if (result.rows[0].blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail('Expected the second transaction to wait on the shared PostgreSQL lock');
    }
    return { ...db, payload, inbox, ingest, rows, blockedBy };
  } catch (error) {
    await db.close();
    throw error;
  }
}

// Hold the winner open so concurrency is proven by pg_blocking_pids, not timing guesses.
async function inboxFirst(
  db: Awaited<ReturnType<typeof fixture>>,
  incoming: typeof db.payload,
  local: typeof db.payload,
  rollback = false,
) {
  const receiver = await db.runtime.connect();
  const collector = await db.runtime.connect();
  let pending: ReturnType<typeof db.ingest> | undefined;
  try {
    const receiverPid = (await receiver.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const collectorPid = (await collector.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.notEqual(receiverPid, collectorPid);
    await receiver.query('BEGIN');
    await receiver.query("SET LOCAL statement_timeout='10s'");
    await db.inbox(receiver, incoming);
    await collector.query("SET statement_timeout='10s'");
    pending = db.ingest(collector, local);
    // Attach a rejection handler before waiting for lock observation.
    const settled = Promise.allSettled([pending]);
    await db.blockedBy(collectorPid, receiverPid);
    await receiver.query(rollback ? 'ROLLBACK' : 'COMMIT');
    return (await settled)[0]!;
  } finally {
    await receiver.query('ROLLBACK');
    if (pending) await pending.catch(() => {});
    await collector.query('RESET statement_timeout');
    receiver.release();
    collector.release();
  }
}

test(
  'local ingestion waits for inbox and rejects cross-mode and conflicting external evidence',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const pairs: [string | null, string | null][] = [
        [null, 'LOCAL-ID'],
        ['INBOX-ID', null],
        ['INBOX-A', 'LOCAL-B'],
      ];
      for (const [i, [incomingId, localId]] of pairs.entries()) {
        const incoming = {
          ...db.payload,
          id: randomUUID(),
          externalRecordId: incomingId,
          recordedAt: `2026-01-0${i + 1}T00:00:00.123456Z`,
        };
        const result = await inboxFirst(db, incoming, { ...incoming, externalRecordId: localId });
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected') assert.match(String(result.reason), /conflict/);
        const saved = (await db.rows()).find((r) => r.id === incoming.id)!;
        assert.equal(saved.external_record_id, incomingId);
        assert.equal(saved.precise_at, incoming.recordedAt);
        assert.equal(saved.employee_id, db.payload.employeeId);
      }
      assert.equal((await db.rows()).length, 3);
      // Exact external-ID and fallback re-ingestion are duplicates, retaining the inbox UUID.
      for (const [i, externalRecordId] of [null, 'EXACT-ID'].entries()) {
        const incoming = {
          ...db.payload,
          id: randomUUID(),
          externalRecordId,
          recordedAt: `2026-01-0${i + 4}T00:00:00.123456Z`,
        };
        const result = await inboxFirst(db, incoming, incoming);
        assert.equal(result.status, 'fulfilled');
        if (result.status === 'fulfilled')
          assert.deepEqual(result.value, { inserted: 0, duplicates: 1, unmatched: [] });
        assert.ok((await db.rows()).some((r) => r.id === incoming.id));
      }
      assert.equal((await db.rows()).length, 5);
    } finally {
      await db.close();
    }
  },
);

test(
  'independent local and inbox punches persist once each despite sharing the device lock',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const local = { ...db.payload, recordedAt: '2026-01-01T00:00:00.123457Z' };
      const result = await inboxFirst(db, db.payload, local);
      assert.equal(result.status, 'fulfilled');
      if (result.status === 'fulfilled') assert.equal(result.value.inserted, 1);
      const saved = await db.rows();
      assert.equal(saved.length, 2);
      assert.ok(saved.some((r) => r.id === db.payload.id));
      assert.deepEqual(saved.map((r) => r.precise_at).sort(), [
        db.payload.recordedAt,
        local.recordedAt,
      ]);
      assert.equal(
        (
          await db.runtime.query(
            "SELECT count(*)::int AS count FROM sync_outbox WHERE entity_type='time_records'",
          )
        ).rows[0].count,
        1,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox rollback releases the evidence lock and local ingestion recovers without partial evidence',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const result = await inboxFirst(db, db.payload, db.payload, true);
      assert.equal(result.status, 'fulfilled');
      if (result.status === 'fulfilled') assert.equal(result.value.inserted, 1);
      const saved = await db.rows();
      assert.equal(saved.length, 1);
      assert.notEqual(saved[0].id, db.payload.id);
      assert.equal(saved[0].precise_at, db.payload.recordedAt);
      const client = await db.runtime.connect();
      try {
        await client.query('BEGIN');
        await assert.rejects(db.inbox(client, db.payload), /Physical punch evidence conflict/);
        await client.query('ROLLBACK');
        const replay = await db.ingest(client, db.payload);
        assert.deepEqual(replay, { inserted: 0, duplicates: 1, unmatched: [] });
      } finally {
        client.release();
      }
      assert.deepEqual(await db.rows(), saved);
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox waits for local ingestion and preserves its original UUID and immutable punch evidence',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    const collector = await db.runtime.connect();
    const receiver = await db.runtime.connect();
    const reachedCommit = gate(),
      allowCommit = gate();
    let localPending: Promise<unknown> | undefined;
    let inboxPending: Promise<void> | undefined;
    try {
      const collectorPid = (await collector.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const receiverPid = (await receiver.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await receiver.query("SET statement_timeout='10s'");
      // Pause the actual ingestion service immediately before its transaction commits.
      const heldCollector = new Proxy(collector, {
        get(target, property) {
          if (property === 'query')
            return async (...args: unknown[]) => {
              if (args[0] === 'COMMIT') {
                reachedCommit.resolve();
                await allowCommit.promise;
              }
              return (target.query as (...values: unknown[]) => unknown).apply(target, args);
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      localPending = db.ingest(heldCollector, db.payload);
      // Surface early service failures instead of waiting indefinitely for COMMIT.
      await Promise.race([
        reachedCommit.promise,
        localPending.then(() => {
          throw new Error('Ingestion finished without reaching its commit gate');
        }),
      ]);
      await receiver.query('BEGIN');
      inboxPending = db.inbox(receiver, { ...db.payload, externalRecordId: 'INCOMING-CROSS-MODE' });
      const outcome = Promise.allSettled([inboxPending]);
      await db.blockedBy(receiverPid, collectorPid);
      allowCommit.resolve();
      await localPending;
      const result = (await outcome)[0]!;
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected')
        assert.match(String(result.reason), /Physical punch evidence conflict/);
      await receiver.query('ROLLBACK');
      const before = await db.rows();
      assert.equal(before.length, 1);
      assert.notEqual(before[0].id, db.payload.id);
      assert.equal(before[0].employee_id, db.payload.employeeId);
      assert.equal(before[0].external_record_id, null);
      assert.equal(before[0].precise_at, db.payload.recordedAt);
      for (const sql of [
        "UPDATE time_records SET record_type='out' WHERE id=$1",
        'DELETE FROM time_records WHERE id=$1',
      ]) {
        await assert.rejects(db.runtime.query(sql, [before[0].id]), (error: unknown) => {
          assert.equal((error as { code?: string }).code, '42501');
          return true;
        });
      }
      assert.deepEqual(await db.rows(), before);
    } finally {
      allowCommit.resolve();
      if (localPending) await localPending.catch(() => {});
      if (inboxPending) await inboxPending.catch(() => {});
      await receiver.query('ROLLBACK');
      await receiver.query('RESET statement_timeout');
      collector.release();
      receiver.release();
      await db.close();
    }
  },
);
