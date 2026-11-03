import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { applyTimeRecordCorrectionEvent } from '../src/sync/time-record-correction-inbox.js';
import { createTimeRecordService } from '../src/timekeeping/services.js';
import type { Actor } from '../src/foundation/repository.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';

async function fixture() {
  const db = await databaseFixture();
  try {
    await migrate(db.migrator, db.migrations);
    const org = randomUUID(),
      foreignOrg = randomUUID(),
      employeeId = randomUUID();
    const userId = randomUUID(),
      foreignUser = randomUUID(),
      punchId = randomUUID();
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Corrections'),($2,'Foreign')",
      [org, foreignOrg],
    );
    await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
    await db.runtime.query(
      `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
       VALUES($1,$2,'E1','Ana','Santos')`,
      [employeeId, org],
    );
    await db.runtime.query(
      `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
       VALUES($1,$2,'correction_user','Corrector',$5),($3,$4,'foreign_user','Foreign',$5)`,
      [userId, org, foreignUser, foreignOrg, DUMMY_PASSWORD_HASH],
    );
    await db.runtime.query(
      `INSERT INTO time_records(id,organization_id,employee_id,recorded_at,record_type,source,created_by)
       VALUES($1,$2,$3,'2026-01-01T00:00:00.123456Z','in','import',$4)`,
      [punchId, org, employeeId, userId],
    );
    const payload = {
      id: randomUUID(),
      organizationId: org,
      revision: 1,
      timeRecordId: punchId,
      operation: 'replace',
      recordedAt: '2026-01-01T00:01:00.123456Z' as string | null,
      recordType: 'in' as 'in' | 'out' | null,
      reason: 'Correct clock evidence',
      createdBy: userId,
    };
    function event(snapshot: Record<string, unknown>) {
      return {
        organization_id: org,
        entity_id: snapshot.id as string,
        operation: 'CREATE',
        revision: snapshot.revision as number,
        payload_version: 1,
        payload: snapshot,
      };
    }
    async function apply(
      snapshot: Record<string, unknown>,
      overrides: Partial<Parameters<typeof applyTimeRecordCorrectionEvent>[1]> = {},
    ) {
      const client = await db.runtime.connect();
      try {
        await client.query('BEGIN');
        await applyTimeRecordCorrectionEvent(client, { ...event(snapshot), ...overrides });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    async function rows() {
      return (
        await db.runtime.query(
          `SELECT *,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_at
         FROM time_record_corrections ORDER BY time_record_id,revision`,
        )
      ).rows;
    }
    async function punches() {
      return (await db.runtime.query('SELECT * FROM time_records ORDER BY id')).rows;
    }
    async function noSideEffects() {
      for (const table of [
        'sync_outbox',
        'attendance_records',
        'attendance_processing_jobs',
        'biometric_ingestion_state',
      ]) {
        assert.equal(
          (await db.runtime.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,
          0,
        );
      }
    }
    const actor: Actor = { id: userId, organizationId: org, permissions: [], roles: [] };
    return {
      ...db,
      org,
      foreignOrg,
      employeeId,
      userId,
      foreignUser,
      punchId,
      payload,
      event,
      apply,
      rows,
      punches,
      noSideEffects,
      actor,
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test(
  'correction inbox persists replacement evidence with microseconds and idempotent offset-equivalent replay',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const original = await db.punches();
      await db.apply(db.payload);
      const saved = await db.rows();
      assert.equal(saved.length, 1);
      const row = saved[0];
      assert.equal(row.id, db.payload.id);
      assert.equal(row.organization_id, db.org);
      assert.equal(row.time_record_id, db.punchId);
      assert.equal(row.operation, 'replace');
      assert.equal(row.record_type, 'in');
      assert.equal(row.precise_at, db.payload.recordedAt);
      assert.equal(row.reason, db.payload.reason);
      assert.equal(row.created_by, db.userId);
      assert.equal(row.revision, 1);
      assert.ok(row.created_at);
      await db.apply(db.payload);
      await db.apply({ ...db.payload, recordedAt: '2026-01-01T08:01:00.123456+08:00' });
      assert.deepEqual(await db.rows(), saved);
      assert.deepEqual(await db.punches(), original);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'correction inbox appends void instructions and PostgreSQL denies correction updates and deletes',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const original = await db.punches();
      await db.apply(db.payload);
      const voided = {
        ...db.payload,
        id: randomUUID(),
        revision: 2,
        operation: 'void',
        recordedAt: null,
        recordType: null,
      };
      await db.apply(voided);
      const saved = await db.rows();
      assert.equal(saved.length, 2);
      assert.equal(saved[1].operation, 'void');
      assert.equal(saved[1].recorded_at, null);
      assert.equal(saved[1].record_type, null);
      assert.equal(saved[1].revision, 2);
      await db.apply(voided);
      for (const sql of [
        "UPDATE time_record_corrections SET reason='Changed' WHERE id=$1",
        'DELETE FROM time_record_corrections WHERE id=$1',
      ]) {
        await assert.rejects(db.runtime.query(sql, [voided.id]), (error: unknown) => {
          assert.equal((error as { code?: string }).code, '42501');
          return true;
        });
      }
      assert.deepEqual(await db.rows(), saved);
      assert.deepEqual(await db.punches(), original);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'correction inbox defers revision gaps and retries the same UUID after predecessors arrive',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const second = { ...db.payload, id: randomUUID(), revision: 2, reason: 'Second' };
      const third = { ...db.payload, id: randomUUID(), revision: 3, reason: 'Third' };
      await assert.rejects(db.apply(third), /revision gap/);
      await assert.rejects(db.apply(second), /revision gap/);
      assert.deepEqual(await db.rows(), []);
      await db.apply(db.payload);
      await assert.rejects(db.apply(third), /revision gap/);
      assert.equal((await db.rows()).length, 1);
      await db.apply(second);
      await db.apply(third);
      const saved = await db.rows();
      assert.deepEqual(
        saved.map((r) => [r.id, r.revision]),
        [
          [db.payload.id, 1],
          [second.id, 2],
          [third.id, 3],
        ],
      );
      await db.apply(db.payload); // Historical replay is valid after later corrections.
      assert.deepEqual(await db.rows(), saved);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'correction inbox rejects conflicting parent revisions and altered UUID evidence atomically',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply(db.payload);
      const saved = await db.rows();
      await assert.rejects(
        db.apply({ ...db.payload, id: randomUUID() }),
        /parent revision conflict/,
      );
      for (const patch of [
        { reason: 'Changed' },
        { revision: 2 },
        { recordedAt: '2026-01-01T00:01:00.123457Z' },
        { recordType: 'out' },
        { operation: 'void', recordedAt: null, recordType: null },
      ]) {
        await assert.rejects(db.apply({ ...db.payload, ...patch }), /UUID conflict/);
        assert.deepEqual(await db.rows(), saved);
      }
      const otherPunch = randomUUID();
      await db.runtime.query(
        `INSERT INTO time_records(id,organization_id,employee_id,recorded_at,record_type,source,created_by)
         VALUES($1,$2,$3,'2026-01-02T00:00:00Z','in','import',$4)`,
        [otherPunch, db.org, db.employeeId, db.userId],
      );
      await assert.rejects(db.apply({ ...db.payload, timeRecordId: otherPunch }), /UUID conflict/);
      assert.deepEqual(await db.rows(), saved);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'correction inbox validates dependencies, organization identities and strict immutable envelopes',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const missingPunch = randomUUID(),
        missingUser = randomUUID();
      const waiting = { ...db.payload, timeRecordId: missingPunch, createdBy: missingUser };
      await assert.rejects(db.apply(waiting), /original punch dependency missing/);
      await db.runtime.query(
        `INSERT INTO time_records(id,organization_id,employee_id,recorded_at,record_type,source,created_by)
         VALUES($1,$2,$3,'2026-01-02T00:00:00Z','in','import',$4)`,
        [missingPunch, db.org, db.employeeId, db.userId],
      );
      await assert.rejects(db.apply(waiting), /creator dependency missing/);
      await assert.rejects(
        db.apply({ ...db.payload, createdBy: db.foreignUser }),
        /creator dependency missing/,
      );
      for (const overrides of [
        { entity_id: randomUUID() },
        { organization_id: db.foreignOrg },
        { revision: 2 },
      ]) {
        await assert.rejects(db.apply(db.payload, overrides), /identity mismatch/);
      }
      await assert.rejects(
        db.apply(
          { ...db.payload, organizationId: db.foreignOrg },
          {
            organization_id: db.foreignOrg,
          },
        ),
        /not enrolled/,
      );
      for (const operation of ['UPDATE', 'ARCHIVE']) {
        await assert.rejects(db.apply(db.payload, { operation }), /require CREATE/);
      }
      await assert.rejects(db.apply(db.payload, { payload_version: 2 }), /snapshot or version/);
      for (const patch of [
        { recordedAt: null },
        { recordType: null },
        { reason: ' ' },
        { revision: 0 },
        { revision: 2147483648 },
        { unexpected: true },
      ]) {
        await assert.rejects(db.apply({ ...db.payload, ...patch }), /snapshot or version/);
      }
      for (const key of Object.keys(db.payload)) {
        const incomplete: Record<string, unknown> = { ...db.payload };
        delete incomplete[key];
        await assert.rejects(db.apply(incomplete), /snapshot or version/);
      }
      assert.deepEqual(await db.rows(), []);
      await db.runtime.query(
        `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
         VALUES($1,$2,'recovered_creator','Recovered',$3)`,
        [missingUser, db.org, DUMMY_PASSWORD_HASH],
      );
      await db.apply(waiting);
      assert.equal((await db.rows())[0].created_by, missingUser);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'incoming correction serializes concurrent local creation and preserves the winning revision and original punch',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    const incoming = await db.runtime.connect(),
      local = await db.runtime.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const original = await db.punches();
      const incomingPid = (await incoming.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const localPid = (await local.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      assert.notEqual(incomingPid, localPid);
      await incoming.query('BEGIN');
      await applyTimeRecordCorrectionEvent(incoming, db.event(db.payload));
      await local.query("SET statement_timeout='10s'");
      const pinned = new Proxy(local, {
        get(target, property) {
          if (property === 'release') return () => {};
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const service = createTimeRecordService({ connect: async () => pinned } as unknown as Pool);
      const input = {
        operation: 'replace' as const,
        recordedAt: '2026-01-01T00:02:00Z',
        recordType: 'out' as const,
        reason: 'Concurrent local correction',
        expectedRevision: 0,
      };
      pending = service.correct(db.actor, db.punchId, input);
      const outcome = Promise.allSettled([pending]);
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = (
          await db.runtime.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [
            localPid,
            incomingPid,
          ])
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, 'Local correction must wait on the incoming employee row lock');
      await incoming.query('COMMIT');
      const result = (await outcome)[0]!;
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.match(String(result.reason), /Correction changed/);
      assert.deepEqual(
        (await db.rows()).map((r) => [r.id, r.revision]),
        [[db.payload.id, 1]],
      );
      await db.noSideEffects();
      // Retrying with the observed revision appends revision 2 using the real local service.
      await service.correct(db.actor, db.punchId, { ...input, expectedRevision: 1 });
      const saved = await db.rows();
      assert.deepEqual(
        saved.map((r) => r.revision),
        [1, 2],
      );
      assert.equal(saved[0].id, db.payload.id);
      await assert.rejects(
        db.apply({ ...db.payload, id: randomUUID(), revision: 2 }),
        /parent revision conflict/,
      );
      assert.deepEqual(await db.rows(), saved);
      assert.deepEqual(await db.punches(), original);
      assert.equal(
        (
          await db.runtime.query(
            "SELECT count(*)::int AS count FROM sync_outbox WHERE entity_type='time_record_corrections'",
          )
        ).rows[0].count,
        1,
      ); // Only the intentional local correction publishes.
    } finally {
      await incoming.query('ROLLBACK');
      if (pending) await pending.catch(() => {});
      await local.query('RESET statement_timeout');
      incoming.release();
      local.release();
      await db.close();
    }
  },
);
