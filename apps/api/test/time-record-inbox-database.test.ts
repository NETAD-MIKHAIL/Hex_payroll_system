import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { applyTimeRecordEvent } from '../src/sync/time-record-inbox.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';

async function fixture() {
  const db = await databaseFixture();
  try {
    await migrate(db.migrator, db.migrations);
    const org = randomUUID(),
      foreignOrg = randomUUID();
    const employeeId = randomUUID(),
      otherEmployee = randomUUID(),
      foreignEmployee = randomUUID();
    const deviceId = randomUUID(),
      foreignDevice = randomUUID();
    const userId = randomUUID(),
      foreignUser = randomUUID();
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Punch test'),($2,'Foreign')",
      [org, foreignOrg],
    );
    await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
    await db.runtime.query(
      `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
       VALUES($1,$2,'E1','Ana','Santos'),($3,$2,'E2','Ben','Cruz'),($4,$5,'E1','Foreign','Employee')`,
      [employeeId, org, otherEmployee, foreignEmployee, foreignOrg],
    );
    await db.runtime.query(
      `INSERT INTO biometric_devices(id,organization_id,code,name)
       VALUES($1,$2,'CLOCK','Clock'),($3,$4,'CLOCK','Foreign clock')`,
      [deviceId, org, foreignDevice, foreignOrg],
    );
    await db.runtime.query(
      `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
       VALUES($1,$2,'punch_creator','Creator',$5),($3,$4,'foreign_creator','Foreign creator',$5)`,
      [userId, org, foreignUser, foreignOrg, DUMMY_PASSWORD_HASH],
    );
    const payload = {
      id: randomUUID(),
      organizationId: org,
      revision: 1,
      employeeId,
      recordedAt: '2026-01-01T00:00:00.123456Z',
      recordType: 'in',
      source: 'biometric',
      deviceId,
      deviceEmployeeId: '001025',
      externalRecordId: null as string | null,
      reason: null,
      createdBy: userId,
    };
    async function apply(
      snapshot: Record<string, unknown>,
      overrides: Partial<Parameters<typeof applyTimeRecordEvent>[1]> = {},
    ) {
      const client = await db.runtime.connect();
      try {
        await client.query('BEGIN');
        await applyTimeRecordEvent(client, {
          organization_id: org,
          entity_id: snapshot.id as string,
          operation: 'CREATE',
          revision: snapshot.revision as number,
          payload_version: 1,
          payload: snapshot,
          ...overrides,
        });
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
         FROM time_records ORDER BY id`,
        )
      ).rows;
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
    return {
      ...db,
      org,
      foreignOrg,
      employeeId,
      otherEmployee,
      foreignEmployee,
      deviceId,
      foreignDevice,
      userId,
      foreignUser,
      payload,
      apply,
      rows,
      noSideEffects,
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test(
  'punch inbox persists immutable local evidence with original attribution despite reassigned mappings',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.runtime.query(
        `INSERT INTO biometric_mappings(organization_id,employee_id,device_id,device_employee_id)
         VALUES($1,$2,$3,'001025')`,
        [db.org, db.otherEmployee, db.deviceId],
      );
      await db.apply(db.payload);
      const saved = await db.rows();
      assert.equal(saved.length, 1);
      const row = saved[0];
      assert.equal(row.id, db.payload.id);
      assert.equal(row.organization_id, db.org);
      assert.equal(row.employee_id, db.employeeId);
      assert.equal(row.device_id, db.deviceId);
      assert.equal(row.device_employee_id, '001025');
      assert.equal(row.external_record_id, null);
      assert.equal(row.created_by, db.userId);
      assert.equal(row.reason, null);
      assert.equal(row.source, 'biometric');
      assert.equal(row.record_type, 'in');
      assert.equal(row.revision, 1);
      assert.ok(row.created_at);
      await db.apply(db.payload);
      assert.deepEqual(await db.rows(), saved);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'punch inbox retains PostgreSQL microseconds and compares equivalent timestamp offsets exactly',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply(db.payload);
      const before = await db.rows();
      assert.equal(before[0].precise_at, db.payload.recordedAt);
      await db.apply({ ...db.payload, recordedAt: '2026-01-01T08:00:00.123456+08:00' });
      assert.deepEqual(await db.rows(), before);
      await assert.rejects(
        db.apply({ ...db.payload, recordedAt: '2026-01-01T00:00:00.123457Z' }),
        /Immutable time record conflict/,
      );
      assert.deepEqual(await db.rows(), before);
      // Distinct microseconds under distinct UUIDs must remain distinct evidence.
      await db.apply({
        ...db.payload,
        id: randomUUID(),
        recordedAt: '2026-01-01T00:00:00.123457Z',
      });
      assert.deepEqual((await db.rows()).map((r) => r.precise_at).sort(), [
        '2026-01-01T00:00:00.123456Z',
        '2026-01-01T00:00:00.123457Z',
      ]);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'punch inbox rejects UUID changes and duplicate external, fallback and cross-mode physical evidence',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const external = { ...db.payload, externalRecordId: 'LOG-001' };
      await db.apply(external);
      const before = await db.rows();
      for (const patch of [
        { employeeId: db.otherEmployee },
        { recordType: 'out' },
        { source: 'import' },
        { reason: 'Changed' },
        { deviceEmployeeId: '1025' },
        { externalRecordId: 'LOG-CHANGED' },
        { deviceId: null },
      ]) {
        await assert.rejects(db.apply({ ...external, ...patch }));
        assert.deepEqual(await db.rows(), before);
      }
      for (const snapshot of [
        { ...external, id: randomUUID() },
        { ...external, id: randomUUID(), recordedAt: '2026-01-02T00:00:00Z' },
        { ...external, id: randomUUID(), externalRecordId: 'LOG-002' },
        { ...external, id: randomUUID(), externalRecordId: null },
      ]) {
        await assert.rejects(db.apply(snapshot), /Physical punch evidence conflict/);
        assert.deepEqual(await db.rows(), before);
      }
      const fallback = { ...db.payload, id: randomUUID(), recordedAt: '2026-01-03T00:00:00Z' };
      await db.apply(fallback);
      const withFallback = await db.rows();
      await assert.rejects(
        db.apply({ ...fallback, id: randomUUID() }),
        /Physical punch evidence conflict/,
      );
      await assert.rejects(
        db.apply({ ...fallback, id: randomUUID(), externalRecordId: 'LOG-003' }),
        /Physical punch evidence conflict/,
      );
      assert.deepEqual(await db.rows(), withFallback);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'punch inbox validates organization identities, required dependencies and immutable CREATE envelopes',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      for (const overrides of [
        { organization_id: db.foreignOrg },
        { entity_id: randomUUID() },
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
      for (const snapshot of [
        { ...db.payload, employeeId: randomUUID() },
        { ...db.payload, employeeId: db.foreignEmployee },
        { ...db.payload, createdBy: randomUUID() },
        { ...db.payload, createdBy: db.foreignUser },
        { ...db.payload, deviceId: randomUUID() },
        { ...db.payload, deviceId: db.foreignDevice },
      ])
        await assert.rejects(db.apply(snapshot), /dependency missing/);
      for (const operation of ['UPDATE', 'ARCHIVE', 'DELETE']) {
        await assert.rejects(db.apply(db.payload, { operation }), /require CREATE/);
      }
      await assert.rejects(db.apply(db.payload, { payload_version: 2 }), /snapshot or version/);
      for (const patch of [
        { revision: 2 },
        { deviceId: null },
        { deviceEmployeeId: null },
        { recordedAt: 'invalid' },
        { recordType: 'invalid' },
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
      // Recover an absent employee without requiring a current biometric mapping.
      const recoveredEmployee = randomUUID();
      const waiting = { ...db.payload, employeeId: recoveredEmployee };
      await assert.rejects(db.apply(waiting), /employee dependency missing/);
      await db.runtime.query(
        `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
         VALUES($1,$2,'RECOVER','Recovered','Employee')`,
        [recoveredEmployee, db.org],
      );
      await db.apply(waiting);
      assert.equal((await db.rows())[0].employee_id, recoveredEmployee);
      const foreignId = randomUUID();
      await db.runtime.query(
        `INSERT INTO time_records(id,organization_id,employee_id,recorded_at,record_type,source,
         device_id,device_employee_id,created_by)
         VALUES($1,$2,$3,'2026-01-01T00:00:00Z','in','biometric',$4,'001025',$5)`,
        [foreignId, db.foreignOrg, db.foreignEmployee, db.foreignDevice, db.foreignUser],
      );
      const before = await db.rows();
      await assert.rejects(db.apply({ ...db.payload, id: foreignId }), /organization mismatch/);
      assert.deepEqual(await db.rows(), before);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'concurrent punch inbox events serialize identical UUIDs and conflicting physical evidence',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const sameUuid = await Promise.allSettled([db.apply(db.payload), db.apply(db.payload)]);
      assert.deepEqual(
        sameUuid.map((r) => r.status),
        ['fulfilled', 'fulfilled'],
      );
      assert.equal((await db.rows()).length, 1);
      async function race(externalA: string | null, externalB: string | null, recordedAt: string) {
        const candidates = [
          { ...db.payload, id: randomUUID(), recordedAt, externalRecordId: externalA },
          { ...db.payload, id: randomUUID(), recordedAt, externalRecordId: externalB },
        ];
        const results = await Promise.allSettled(candidates.map((p) => db.apply(p)));
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        const failed = results.find((r) => r.status === 'rejected');
        assert.ok(failed && failed.status === 'rejected');
        assert.match(String(failed.reason), /Physical punch evidence conflict/);
        const winner = results.findIndex((r) => r.status === 'fulfilled');
        const saved = (await db.rows()).filter((r) => candidates.some((p) => p.id === r.id));
        assert.equal(saved.length, 1);
        assert.equal(saved[0].id, candidates[winner]!.id);
      }
      await race(null, null, '2026-01-02T00:00:00Z');
      await race('SAME-EXTERNAL', 'SAME-EXTERNAL', '2026-01-03T00:00:00Z');
      await race(null, 'CROSS-MODE', '2026-01-04T00:00:00Z');
      await race('EXTERNAL-A', 'EXTERNAL-B', '2026-01-05T00:00:00Z');
      assert.equal((await db.rows()).length, 5);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);

test(
  'PostgreSQL denies raw punch mutation and enforces ingestion evidence unique constraints',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      const external = { ...db.payload, externalRecordId: 'IMMUTABLE' };
      await db.apply(external);
      const before = await db.rows();
      for (const command of [
        'UPDATE time_records SET employee_id=$2 WHERE id=$1',
        'DELETE FROM time_records WHERE id=$1 AND employee_id<>$2',
      ]) {
        await assert.rejects(
          db.runtime.query(command, [db.payload.id, db.otherEmployee]),
          (error: unknown) => {
            assert.equal((error as { code?: string }).code, '42501');
            return true;
          },
        );
      }
      assert.deepEqual(await db.rows(), before);
      async function directInsert(externalId: string | null, at: string) {
        return db.runtime.query(
          `INSERT INTO time_records(id,organization_id,employee_id,recorded_at,record_type,source,
            device_id,device_employee_id,external_record_id,created_by)
           VALUES($1,$2,$3,$4,'in','biometric',$5,'001025',$6,$7)`,
          [randomUUID(), db.org, db.employeeId, at, db.deviceId, externalId, db.userId],
        );
      }
      const uniqueViolation = (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23505');
        return true;
      };
      await assert.rejects(directInsert('IMMUTABLE', '2026-01-02T00:00:00Z'), uniqueViolation);
      await directInsert(null, '2026-01-03T00:00:00Z');
      await assert.rejects(directInsert(null, '2026-01-03T00:00:00Z'), uniqueViolation);
      // PostgreSQL permits different external IDs at identical physical coordinates.
      // The inbox's conservative conflict check is intentionally stricter than these indexes.
      await directInsert('DISTINCT-EXTERNAL', db.payload.recordedAt);
      assert.equal((await db.rows()).length, 3);
      await db.noSideEffects();
    } finally {
      await db.close();
    }
  },
);
