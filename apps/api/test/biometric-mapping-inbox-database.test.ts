import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { applyBiometricMappingEvent } from '../src/sync/biometric-mapping-inbox.js';
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
      otherDevice = randomUUID(),
      foreignDevice = randomUUID();
    const userId = randomUUID();
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Mapping test'),($2,'Foreign')",
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
       VALUES($1,$2,'CLOCK1','Clock 1'),($3,$2,'CLOCK2','Clock 2'),($4,$5,'CLOCK1','Foreign clock')`,
      [deviceId, org, otherDevice, foreignDevice, foreignOrg],
    );
    await db.runtime.query(
      `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
       VALUES($1,$2,'mapping_auditor','Auditor',$3)`,
      [userId, org, DUMMY_PASSWORD_HASH],
    );
    const payload = {
      id: randomUUID(),
      organizationId: org,
      revision: 1,
      employeeId,
      deviceId,
      deviceEmployeeId: '001025',
      status: 'active',
    };
    async function apply(
      snapshot: Record<string, unknown>,
      operation = 'UPDATE',
      overrides: Partial<Parameters<typeof applyBiometricMappingEvent>[1]> = {},
    ) {
      const client = await db.runtime.connect();
      try {
        await client.query('BEGIN');
        await applyBiometricMappingEvent(client, {
          organization_id: org,
          entity_id: snapshot.id as string,
          operation,
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
    async function mappings() {
      return (await db.runtime.query('SELECT * FROM biometric_mappings ORDER BY id')).rows;
    }
    async function noEcho() {
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox')).rows[0].count,
        0,
      );
    }
    return {
      ...db,
      org,
      foreignOrg,
      employeeId,
      otherEmployee,
      foreignEmployee,
      deviceId,
      otherDevice,
      foreignDevice,
      userId,
      payload,
      apply,
      mappings,
      noEcho,
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test(
  'mapping inbox persists original identities, revisions and exact identifier text with safe replay',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply(db.payload, 'CREATE');
      const created = await db.mappings();
      assert.equal(created.length, 1);
      assert.equal(created[0].id, db.payload.id);
      assert.equal(created[0].organization_id, db.org);
      assert.equal(created[0].employee_id, db.employeeId);
      assert.equal(created[0].device_id, db.deviceId);
      assert.equal(created[0].device_employee_id, '001025');
      assert.equal(created[0].status, 'active');
      assert.equal(created[0].revision, 1);
      await db.apply(db.payload, 'CREATE');
      assert.deepEqual(await db.mappings(), created);
      await db.runtime.query(
        `UPDATE biometric_mappings SET updated_by=$2,created_at='2025-01-01T00:00:00Z',
         updated_at='2025-02-01T00:00:00Z' WHERE id=$1`,
        [db.payload.id, db.userId],
      );
      const original = (await db.mappings())[0];
      const update = { ...db.payload, revision: 2, deviceEmployeeId: ' 001026 ' };
      await db.apply(update);
      const saved = await db.mappings();
      assert.equal(saved[0].device_employee_id, ' 001026 ');
      assert.equal(saved[0].revision, 2);
      for (const key of ['created_at', 'updated_at', 'updated_by']) {
        assert.deepEqual(saved[0][key], original[key]);
      }
      await db.apply(update);
      await assert.rejects(
        db.apply({ ...update, employeeId: db.otherEmployee }),
        /revision conflict/,
      );
      await db.apply(db.payload);
      assert.deepEqual(await db.mappings(), saved);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'mapping inbox defers missing mappings and employee or device dependencies and recovers safely',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await assert.rejects(db.apply(db.payload), /mapping dependency missing/);
      const missingEmployee = randomUUID(),
        missingDevice = randomUUID();
      const waiting = { ...db.payload, employeeId: missingEmployee, deviceId: missingDevice };
      await assert.rejects(db.apply(waiting, 'CREATE'), /employee dependency missing/);
      assert.deepEqual(await db.mappings(), []);
      await db.runtime.query(
        `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
         VALUES($1,$2,'RECOVER','Recovered','Employee')`,
        [missingEmployee, db.org],
      );
      await assert.rejects(db.apply(waiting, 'CREATE'), /device dependency missing/);
      assert.deepEqual(await db.mappings(), []);
      await db.runtime.query(
        "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'RECOVER','Recovered clock')",
        [missingDevice, db.org],
      );
      await db.apply(waiting, 'CREATE');
      const before = await db.mappings();
      assert.equal(before[0].employee_id, missingEmployee);
      assert.equal(before[0].device_id, missingDevice);
      await assert.rejects(
        db.apply({ ...waiting, revision: 2, employeeId: randomUUID() }),
        /employee dependency missing/,
      );
      await assert.rejects(
        db.apply({ ...waiting, revision: 2, deviceId: randomUUID() }),
        /device dependency missing/,
      );
      assert.deepEqual(await db.mappings(), before);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'mapping inbox validates envelopes and rejects cross-organization identities and references',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await assert.rejects(
        db.apply(db.payload, 'CREATE', { organization_id: db.foreignOrg }),
        /identity mismatch/,
      );
      await assert.rejects(
        db.apply(db.payload, 'CREATE', { entity_id: randomUUID() }),
        /identity mismatch/,
      );
      await assert.rejects(db.apply(db.payload, 'CREATE', { revision: 2 }), /identity mismatch/);
      await assert.rejects(
        db.apply(db.payload, 'CREATE', { payload_version: 2 }),
        /snapshot or version/,
      );
      await assert.rejects(
        db.apply({ ...db.payload, organizationId: db.foreignOrg }, 'CREATE', {
          organization_id: db.foreignOrg,
        }),
        /not enrolled/,
      );
      await assert.rejects(
        db.apply({ ...db.payload, employeeId: db.foreignEmployee }, 'CREATE'),
        /employee dependency missing/,
      );
      await assert.rejects(
        db.apply({ ...db.payload, deviceId: db.foreignDevice }, 'CREATE'),
        /device dependency missing/,
      );
      for (const patch of [
        { revision: 0 },
        { revision: 2147483648 },
        { revision: 1.5 },
        { deviceEmployeeId: 1025 },
        { deviceEmployeeId: ' ' },
        { status: 'enabled' },
        { pollingEnabled: true },
      ]) {
        await assert.rejects(
          db.apply({ ...db.payload, ...patch }, 'CREATE'),
          /snapshot or version/,
        );
      }
      for (const key of Object.keys(db.payload)) {
        const incomplete: Record<string, unknown> = { ...db.payload };
        delete incomplete[key];
        await assert.rejects(db.apply(incomplete, 'CREATE'), /snapshot or version/);
      }
      assert.deepEqual(await db.mappings(), []);
      await db.runtime.query(
        `INSERT INTO biometric_mappings(id,organization_id,employee_id,device_id,device_employee_id)
         VALUES($1,$2,$3,$4,'001025')`,
        [db.payload.id, db.foreignOrg, db.foreignEmployee, db.foreignDevice],
      );
      const before = await db.mappings();
      await assert.rejects(db.apply(db.payload, 'CREATE'), /organization mismatch/);
      assert.deepEqual(await db.mappings(), before);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'mapping inbox rejects identifier collisions including inactive mappings without merging UUIDs',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply(db.payload, 'CREATE');
      const other = { ...db.payload, id: randomUUID(), deviceEmployeeId: 'OTHER' };
      await db.apply(other, 'CREATE');
      const before = await db.mappings();
      await assert.rejects(
        db.apply({ ...db.payload, id: randomUUID() }, 'CREATE'),
        /identifier conflict/,
      );
      await assert.rejects(
        db.apply({ ...other, revision: 2, deviceEmployeeId: '001025' }),
        /identifier conflict/,
      );
      assert.deepEqual(await db.mappings(), before);
      await db.apply({ ...db.payload, revision: 2, status: 'inactive' }, 'ARCHIVE');
      const archived = await db.mappings();
      await assert.rejects(
        db.apply({ ...db.payload, id: randomUUID() }, 'CREATE'),
        /identifier conflict/,
      );
      assert.deepEqual(await db.mappings(), archived);
      // Identifier uniqueness is per device and preserves leading zeros.
      await db.apply({ ...db.payload, id: randomUUID(), deviceId: db.otherDevice }, 'CREATE');
      await db.apply({ ...db.payload, id: randomUUID(), deviceEmployeeId: '1025' }, 'CREATE');
      assert.equal((await db.mappings()).length, 4);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'mapping reassignment and archival preserve historical punches and ingestion checkpoints',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply(db.payload, 'CREATE');
      await db.runtime.query(
        `INSERT INTO time_records(id,organization_id,employee_id,recorded_at,record_type,
          source,device_id,device_employee_id,created_by)
         VALUES($1,$2,$3,'2026-01-01T00:00:00Z','in','biometric',$4,'001025',$5)`,
        [randomUUID(), db.org, db.employeeId, db.deviceId, db.userId],
      );
      await db.runtime.query(
        `INSERT INTO biometric_ingestion_state(device_id,last_ingestion_at,last_record_at)
         VALUES($1,'2026-01-02T00:00:00Z','2026-01-01T00:00:00Z')`,
        [db.deviceId],
      );
      async function evidence() {
        return {
          punches: (await db.runtime.query('SELECT * FROM time_records ORDER BY id')).rows,
          checkpoints: (
            await db.runtime.query('SELECT * FROM biometric_ingestion_state ORDER BY device_id')
          ).rows,
        };
      }
      const original = await evidence();
      await db.migrator.query(`
        CREATE FUNCTION reject_mapping_evidence_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Mapping sync must not write historical evidence'; END $$;
        CREATE TRIGGER reject_mapping_checkpoint_write BEFORE INSERT OR UPDATE OR DELETE
        ON biometric_ingestion_state FOR EACH ROW EXECUTE FUNCTION reject_mapping_evidence_write();
        CREATE TRIGGER reject_mapping_punch_write BEFORE INSERT OR UPDATE OR DELETE
        ON time_records FOR EACH ROW EXECUTE FUNCTION reject_mapping_evidence_write();
      `);
      const reassigned = { ...db.payload, revision: 2, employeeId: db.otherEmployee };
      await db.apply(reassigned);
      await db.apply(reassigned);
      assert.equal((await db.mappings())[0].employee_id, db.otherEmployee);
      assert.deepEqual(await evidence(), original);
      assert.equal(original.punches[0].employee_id, db.employeeId);
      const moved = {
        ...reassigned,
        revision: 3,
        deviceId: db.otherDevice,
        deviceEmployeeId: '000007',
      };
      await db.apply(moved);
      assert.equal((await db.mappings())[0].device_id, db.otherDevice);
      assert.equal((await db.mappings())[0].device_employee_id, '000007');
      const before = await db.mappings();
      await assert.rejects(db.apply({ ...moved, revision: 4 }, 'ARCHIVE'), /must be inactive/);
      await assert.rejects(
        db.apply({ ...moved, revision: 4 }, 'DELETE'),
        /Invalid biometric mapping operation/,
      );
      assert.deepEqual(await db.mappings(), before);
      const archived = { ...moved, revision: 4, status: 'inactive' };
      await db.apply(archived, 'ARCHIVE');
      await db.apply(archived, 'ARCHIVE');
      assert.equal((await db.mappings())[0].status, 'inactive');
      await db.apply({ ...moved, revision: 5 });
      assert.equal((await db.mappings())[0].status, 'active');
      assert.equal((await db.mappings())[0].revision, 5);
      assert.deepEqual(await evidence(), original);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);
