import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { createTimeRecordService } from '../src/timekeeping/services.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';

async function fixture() {
  const db = await databaseFixture();
  try {
    await migrate(db.migrator, db.migrations);
    const org = randomUUID(),
      user = randomUUID(),
      device = randomUUID(),
      employee = randomUUID();
    await db.runtime.query("INSERT INTO organizations(id,legal_name) VALUES($1,'Raw capture')", [
      org,
    ]);
    await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
    await db.runtime.query(
      "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'collector','Collector',$3)",
      [user, org, DUMMY_PASSWORD_HASH],
    );
    await db.runtime.query(
      "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'CLOCK','Clock')",
      [device, org],
    );
    await db.runtime.query(
      "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'E1','Ana','Santos')",
      [employee, org],
    );
    const actor = { id: user, organizationId: org, permissions: [], roles: [] };
    const punch = {
      deviceEmployeeId: 'unknown',
      recordedAt: '2026-10-01T00:00:00.123456Z',
      recordType: 'in' as const,
      externalRecordId: '1',
    };
    const input = { deviceId: device, records: [punch] };
    const ingest = () =>
      createTimeRecordService(db.runtime, { rawCaptureEnabled: true }).ingest(actor, input);
    const count = async (table: string) =>
      Number((await db.runtime.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
    return { ...db, org, user, device, employee, actor, input, punch, ingest, count };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test(
  'new raw capture remains disabled unless explicitly enabled',
  { skip: !databaseTestsEnabled },
  async () => {
    const f = await fixture();
    try {
      await createTimeRecordService(f.runtime).ingest(f.actor, f.input);
      assert.equal(await f.count('biometric_raw_captures'), 0);
      assert.equal(await f.count('biometric_capture_batches'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'offline unmapped evidence survives and exact replay later maps without raw duplication',
  { skip: !databaseTestsEnabled },
  async () => {
    const f = await fixture();
    try {
      assert.deepEqual((await f.ingest()).unmatched, ['unknown']);
      assert.equal(await f.count('biometric_raw_captures'), 1);
      assert.equal(await f.count('time_records'), 0);
      await f.runtime.query(
        "INSERT INTO biometric_mappings(organization_id,employee_id,device_id,device_employee_id) VALUES($1,$2,$3,'unknown')",
        [f.org, f.employee, f.device],
      );
      assert.equal((await f.ingest()).inserted, 1);
      assert.equal((await f.ingest()).duplicates, 1);
      assert.equal(await f.count('biometric_raw_captures'), 1);
      assert.equal(await f.count('time_records'), 1);
      assert.equal(await f.count('biometric_capture_batches'), 3);
    } finally {
      await f.close();
    }
  },
);

test(
  'raw identity conflict rolls back the whole batch and capture checkpoint',
  { skip: !databaseTestsEnabled },
  async () => {
    const f = await fixture();
    try {
      await f.ingest();
      const before = (await f.runtime.query('SELECT * FROM biometric_ingestion_state')).rows;
      await assert.rejects(
        createTimeRecordService(f.runtime, { rawCaptureEnabled: true }).ingest(f.actor, {
          deviceId: f.device,
          records: [
            { ...f.punch, externalRecordId: '2', recordedAt: '2026-10-02T00:00:00Z' },
            { ...f.punch, recordType: 'out' },
          ],
        }),
        /Raw biometric identity/,
      );
      assert.equal(await f.count('biometric_raw_captures'), 1);
      assert.equal(await f.count('biometric_capture_batches'), 1);
      assert.deepEqual(
        (await f.runtime.query('SELECT * FROM biometric_ingestion_state')).rows,
        before,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'injected checkpoint failure rolls back raw evidence and receipt; restart retry recovers',
  { skip: !databaseTestsEnabled },
  async () => {
    const f = await fixture();
    try {
      await f.migrator.query(
        "CREATE FUNCTION fail_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected capture failure'; END $$; CREATE TRIGGER fail_capture BEFORE INSERT ON biometric_ingestion_state FOR EACH ROW EXECUTE FUNCTION fail_capture()",
      );
      await assert.rejects(f.ingest(), /injected capture failure/);
      assert.equal(await f.count('biometric_raw_captures'), 0);
      assert.equal(await f.count('biometric_capture_batches'), 0);
      await f.migrator.query('DROP TRIGGER fail_capture ON biometric_ingestion_state');
      await f.ingest();
      assert.equal(await f.count('biometric_raw_captures'), 1);
      await assert.rejects(f.runtime.query('DELETE FROM biometric_raw_captures'));
    } finally {
      await f.close();
    }
  },
);

test(
  'concurrent duplicate ingestion and delayed punches retain immutable raw identities',
  { skip: !databaseTestsEnabled },
  async () => {
    const f = await fixture();
    try {
      await Promise.all([f.ingest(), f.ingest()]);
      assert.equal(await f.count('biometric_raw_captures'), 1);
      await createTimeRecordService(f.runtime, { rawCaptureEnabled: true }).ingest(f.actor, {
        deviceId: f.device,
        records: [{ ...f.punch, externalRecordId: 'earlier', recordedAt: '2026-09-30T00:00:00Z' }],
      });
      assert.equal(await f.count('biometric_raw_captures'), 2);
      assert.equal(await f.count('biometric_capture_batches'), 3);
    } finally {
      await f.close();
    }
  },
);
