import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { applyInboxBatch } from '../src/sync/inbox.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';

test(
  'inbox scheduler retries correction dependencies and parent revision gaps while isolating conflicts',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const org = randomUUID(),
        employeeId = randomUUID(),
        userId = randomUUID();
      const missingCreator = randomUUID(),
        punchId = randomUUID(),
        independentPunch = randomUUID();
      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Correction scheduler')",
        [org],
      );
      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
      await db.runtime.query(
        `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
         VALUES($1,$2,'E1','Ana','Santos')`,
        [employeeId, org],
      );
      await db.runtime.query(
        `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
         VALUES($1,$2,'correction_scheduler','Creator',$3)`,
        [userId, org, DUMMY_PASSWORD_HASH],
      );
      const first = {
        id: randomUUID(),
        organizationId: org,
        revision: 1,
        timeRecordId: punchId,
        operation: 'replace',
        recordedAt: '2026-01-01T00:01:00.123456Z' as string | null,
        recordType: 'in' as string | null,
        reason: 'First correction',
        createdBy: missingCreator,
      };
      const second = { ...first, id: randomUUID(), revision: 2, reason: 'Second correction' };
      const third = {
        ...first,
        id: randomUUID(),
        revision: 3,
        operation: 'void',
        recordedAt: null,
        recordType: null,
        reason: 'Void evidence',
      };
      const independent = {
        ...first,
        id: randomUUID(),
        timeRecordId: independentPunch,
        createdBy: userId,
      };
      async function queue(sequence: number, snapshot: typeof first) {
        await db.runtime.query(
          `INSERT INTO sync_inbox(
            organization_id,sequence,change_id,source_node_id,source_event_id,
            entity_type,entity_id,operation,revision,payload_version,payload
          ) VALUES($1,$2,$3,$4,$5,'time_record_corrections',$6,'CREATE',$7,1,$8)`,
          [
            org,
            sequence,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            snapshot.id,
            snapshot.revision,
            JSON.stringify(snapshot),
          ],
        );
      }
      async function state(sequence: number) {
        return (
          await db.runtime.query(
            `SELECT applied_at,apply_error,apply_attempt_count FROM sync_inbox
           WHERE organization_id=$1 AND sequence=$2`,
            [org, sequence],
          )
        ).rows[0];
      }
      async function applied(sequence: number, attempts: number) {
        const row = await state(sequence);
        assert.notEqual(row.applied_at, null);
        assert.equal(row.apply_error, null);
        assert.equal(row.apply_attempt_count, attempts);
      }
      async function deferred(sequence: number, attempts: number) {
        const row = await state(sequence);
        assert.equal(row.applied_at, null);
        assert.equal(row.apply_attempt_count, attempts);
        assert.equal(
          row.apply_error,
          'Inbox event application failed; review local constraints and retry',
        );
      }
      async function corrections() {
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
      async function insertPunch(id: string) {
        await db.runtime.query(
          `INSERT INTO time_records(id,organization_id,employee_id,recorded_at,record_type,source,created_by)
           VALUES($1,$2,$3,'2026-01-01T00:00:00.123456Z','in','import',$4)`,
          [id, org, employeeId, userId],
        );
      }
      await insertPunch(independentPunch);
      // Reverse parent revision order across different correction UUIDs.
      await queue(1000, third);
      await queue(1001, second);
      await queue(1002, first);
      await queue(1003, independent);
      const missingParent = await applyInboxBatch(db.runtime, org);
      assert.equal(missingParent.applied, 1);
      assert.equal(missingParent.deferred, 3);
      await applied(1003, 1);
      for (const sequence of [1000, 1001, 1002]) await deferred(sequence, 1);
      const independentSaved = (await corrections()).find((r) => r.id === independent.id)!;
      assert.equal(independentSaved.time_record_id, independentPunch);
      await insertPunch(punchId);
      const originalPunches = await punches();
      const missingUser = await applyInboxBatch(db.runtime, org);
      assert.equal(missingUser.applied, 0);
      assert.equal(missingUser.deferred, 3);
      for (const sequence of [1000, 1001, 1002]) await deferred(sequence, 2);
      assert.equal((await corrections()).length, 1);
      await db.runtime.query(
        `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
         VALUES($1,$2,'recovered_corrector','Recovered',$3)`,
        [missingCreator, org, DUMMY_PASSWORD_HASH],
      );
      const revisionOne = await applyInboxBatch(db.runtime, org);
      assert.equal(revisionOne.applied, 1);
      assert.equal(revisionOne.deferred, 2);
      await applied(1002, 3);
      await deferred(1000, 3);
      await deferred(1001, 3);
      assert.deepEqual(
        (await corrections()).filter((r) => r.time_record_id === punchId).map((r) => r.revision),
        [1],
      );
      const revisionTwo = await applyInboxBatch(db.runtime, org);
      assert.equal(revisionTwo.applied, 1);
      assert.equal(revisionTwo.deferred, 1);
      await applied(1001, 4);
      await deferred(1000, 4);
      const revisionThree = await applyInboxBatch(db.runtime, org);
      assert.equal(revisionThree.applied, 1);
      assert.equal(revisionThree.deferred, 0);
      await applied(1000, 5);
      const saved = await corrections();
      const parentHistory = saved.filter((r) => r.time_record_id === punchId);
      assert.deepEqual(
        parentHistory.map((r) => [r.id, r.revision, r.operation]),
        [
          [first.id, 1, 'replace'],
          [second.id, 2, 'replace'],
          [third.id, 3, 'void'],
        ],
      );
      assert.equal(parentHistory[0].precise_at, first.recordedAt);
      assert.equal(parentHistory[0].created_by, missingCreator);
      assert.equal(parentHistory[2].recorded_at, null);
      assert.equal(parentHistory[2].record_type, null);
      assert.deepEqual(
        saved.find((r) => r.id === independent.id),
        independentSaved,
      );
      await queue(1004, first); // Old identical replay remains valid after revision 3.
      await queue(1005, { ...second, id: randomUUID() }); // Occupied parent revision.
      await queue(1006, { ...third, reason: 'Altered void instruction' }); // UUID conflict.
      await queue(1007, {
        ...independent,
        id: randomUUID(),
        revision: 2,
        reason: 'Independent progress',
      });
      const conflicts = await applyInboxBatch(db.runtime, org);
      assert.equal(conflicts.applied, 2);
      assert.equal(conflicts.deferred, 2);
      await applied(1004, 1);
      await applied(1007, 1);
      await deferred(1005, 1);
      await deferred(1006, 1);
      assert.deepEqual(
        (await corrections()).filter((r) => r.time_record_id === punchId),
        parentHistory,
      );
      const after = await corrections();
      const retry = await applyInboxBatch(db.runtime, org);
      assert.equal(retry.applied, 0);
      assert.equal(retry.deferred, 2);
      await deferred(1005, 2);
      await deferred(1006, 2);
      assert.deepEqual(await corrections(), after);
      assert.deepEqual(await punches(), originalPunches);
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
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox scheduler recovers punch dependencies, preserves immutable evidence and rejects duplicates without echo',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const org = randomUUID(),
        employeeId = randomUUID(),
        deviceId = randomUUID(),
        userId = randomUUID();
      const id = randomUUID(),
        duplicateId = randomUUID();
      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Punch scheduler test')",
        [org],
      );
      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
      const payload = {
        id,
        organizationId: org,
        revision: 1,
        employeeId,
        deviceId,
        createdBy: userId,
        deviceEmployeeId: '001025',
        externalRecordId: null as string | null,
        recordedAt: '2026-01-01T00:00:00.123456Z',
        recordType: 'in',
        source: 'biometric',
        reason: null,
      };
      async function queue(sequence: number, snapshot: typeof payload) {
        await db.runtime.query(
          `INSERT INTO sync_inbox(
            organization_id,sequence,change_id,source_node_id,source_event_id,
            entity_type,entity_id,operation,revision,payload_version,payload
          ) VALUES($1,$2,$3,$4,$5,'time_records',$6,'CREATE',1,1,$7)`,
          [
            org,
            sequence,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            snapshot.id,
            JSON.stringify(snapshot),
          ],
        );
      }
      async function state(sequence: number) {
        return (
          await db.runtime.query(
            `SELECT applied_at,apply_error,apply_attempt_count FROM sync_inbox
           WHERE organization_id=$1 AND sequence=$2`,
            [org, sequence],
          )
        ).rows[0];
      }
      async function evidence() {
        return (
          await db.runtime.query(
            `SELECT *,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_at
           FROM time_records ORDER BY id`,
          )
        ).rows;
      }
      async function blocked(sequence: number) {
        assert.deepEqual(await state(sequence), {
          applied_at: null,
          apply_error: null,
          apply_attempt_count: 0,
        });
      }
      async function applied(sequence: number, attempts: number) {
        const row = await state(sequence);
        assert.notEqual(row.applied_at, null);
        assert.equal(row.apply_error, null);
        assert.equal(row.apply_attempt_count, attempts);
      }
      await queue(900, payload);
      await queue(901, payload); // Same entity must wait for its earlier event.
      async function deferred(attempts: number) {
        const result = await applyInboxBatch(db.runtime, org);
        assert.equal(result.applied, 0);
        assert.equal(result.deferred, 1);
        const row = await state(900);
        assert.equal(row.applied_at, null);
        assert.equal(row.apply_attempt_count, attempts);
        assert.equal(
          row.apply_error,
          'Inbox event application failed; review local constraints and retry',
        );
        await blocked(901);
        assert.deepEqual(await evidence(), []);
      }
      await deferred(1); // Employee missing.
      await db.runtime.query(
        `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
         VALUES($1,$2,'E1','Ana','Santos')`,
        [employeeId, org],
      );
      await deferred(2); // Creator missing.
      await db.runtime.query(
        `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
         VALUES($1,$2,'punch_scheduler','Collector',$3)`,
        [userId, org, DUMMY_PASSWORD_HASH],
      );
      await deferred(3); // Device missing.
      await db.runtime.query(
        "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'CLOCK','Clock')",
        [deviceId, org],
      );
      await db.runtime.query(
        `INSERT INTO biometric_ingestion_state(device_id,last_ingestion_at,last_record_at)
         VALUES($1,'2026-01-02T00:00:00Z','2026-01-01T00:00:00Z')`,
        [deviceId],
      );
      const checkpoints = (await db.runtime.query('SELECT * FROM biometric_ingestion_state')).rows;
      const recovered = await applyInboxBatch(db.runtime, org);
      assert.equal(recovered.applied, 1);
      assert.equal(recovered.deferred, 0);
      await applied(900, 4);
      await blocked(901);
      const original = await evidence();
      assert.equal(original.length, 1);
      assert.equal(original[0].id, id);
      assert.equal(original[0].organization_id, org);
      assert.equal(original[0].employee_id, employeeId);
      assert.equal(original[0].device_id, deviceId);
      assert.equal(original[0].created_by, userId);
      assert.equal(original[0].device_employee_id, '001025');
      assert.equal(original[0].external_record_id, null);
      assert.equal(original[0].source, 'biometric');
      assert.equal(original[0].record_type, 'in');
      assert.equal(original[0].revision, 1);
      assert.equal(original[0].precise_at, payload.recordedAt);

      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 1);
      await applied(901, 1);
      assert.deepEqual(await evidence(), original);
      const savedInboxState = await state(900);
      await queue(902, { ...payload, employeeId, recordedAt: '2026-01-01T00:00:00.123457Z' });
      await queue(903, payload); // Blocked by the conflicting same-UUID event.
      await queue(904, { ...payload, id: duplicateId, externalRecordId: 'CROSS-MODE' });
      const independent = {
        ...payload,
        id: randomUUID(),
        recordedAt: '2026-01-02T00:00:00.123456Z',
      };
      await queue(905, independent);
      const conflicts = await applyInboxBatch(db.runtime, org);
      assert.equal(conflicts.applied, 1);
      assert.equal(conflicts.deferred, 2);
      for (const sequence of [902, 904]) {
        const row = await state(sequence);
        assert.equal(row.applied_at, null);
        assert.equal(row.apply_attempt_count, 1);
        assert.equal(
          row.apply_error,
          'Inbox event application failed; review local constraints and retry',
        );
      }
      await blocked(903);
      await applied(905, 1);
      const afterConflicts = await evidence();
      assert.equal(afterConflicts.length, 2);
      assert.deepEqual(
        afterConflicts.find((r) => r.id === id),
        original[0],
      );
      assert.ok(afterConflicts.some((r) => r.id === independent.id));
      assert.ok(!afterConflicts.some((r) => r.id === duplicateId));
      assert.deepEqual(await state(900), savedInboxState);
      // A subsequent batch retries only failures; accepted evidence remains unchanged.
      const replay = await applyInboxBatch(db.runtime, org);
      assert.equal(replay.applied, 0);
      assert.equal(replay.deferred, 2);
      await blocked(903);
      assert.deepEqual(await evidence(), afterConflicts);
      assert.deepEqual(
        (await db.runtime.query('SELECT * FROM biometric_ingestion_state')).rows,
        checkpoints,
      );
      for (const table of ['sync_outbox', 'attendance_records', 'attendance_processing_jobs']) {
        assert.equal(
          (await db.runtime.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,
          0,
        );
      }
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox scheduler recovers mapping dependencies and orders reassignment without rewriting evidence or echo',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const org = randomUUID();
      const employeeId = randomUUID(),
        nextEmployee = randomUUID(),
        missingEmployee = randomUUID();
      const deviceId = randomUUID(),
        missingDevice = randomUUID(),
        userId = randomUUID();
      const id = randomUUID(),
        waitingId = randomUUID();
      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Mapping scheduler test')",
        [org],
      );
      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
      await db.runtime.query(
        `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
         VALUES($1,$2,'E1','Ana','Santos'),($3,$2,'E2','Ben','Cruz')`,
        [employeeId, org, nextEmployee],
      );
      await db.runtime.query(
        "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'CLOCK','Main clock')",
        [deviceId, org],
      );
      await db.runtime.query(
        `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
         VALUES($1,$2,'mapping_scheduler','Auditor',$3)`,
        [userId, org, DUMMY_PASSWORD_HASH],
      );
      await db.runtime.query(
        `INSERT INTO time_records(id,organization_id,employee_id,recorded_at,record_type,
          source,device_id,device_employee_id,created_by)
         VALUES($1,$2,$3,'2026-01-01T00:00:00Z','in','biometric',$4,'001025',$5)`,
        [randomUUID(), org, employeeId, deviceId, userId],
      );
      await db.runtime.query(
        `INSERT INTO biometric_ingestion_state(device_id,last_ingestion_at,last_record_at)
         VALUES($1,'2026-01-02T00:00:00Z','2026-01-01T00:00:00Z')`,
        [deviceId],
      );
      async function evidence() {
        return {
          punches: (await db.runtime.query('SELECT * FROM time_records ORDER BY id')).rows,
          checkpoints: (
            await db.runtime.query('SELECT * FROM biometric_ingestion_state ORDER BY device_id')
          ).rows,
        };
      }
      const originalEvidence = await evidence();
      await db.migrator.query(`
        CREATE FUNCTION reject_scheduler_mapping_evidence_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Mapping scheduler must not modify evidence'; END $$;
        CREATE TRIGGER reject_scheduler_mapping_checkpoint BEFORE INSERT OR UPDATE OR DELETE
        ON biometric_ingestion_state FOR EACH ROW EXECUTE FUNCTION reject_scheduler_mapping_evidence_write();
        CREATE TRIGGER reject_scheduler_mapping_punch BEFORE INSERT OR UPDATE OR DELETE
        ON time_records FOR EACH ROW EXECUTE FUNCTION reject_scheduler_mapping_evidence_write();
      `);
      const payload = {
        id,
        organizationId: org,
        revision: 1,
        employeeId,
        deviceId,
        deviceEmployeeId: '001025',
        status: 'active',
      };
      const waiting = {
        ...payload,
        id: waitingId,
        employeeId: missingEmployee,
        deviceId: missingDevice,
        deviceEmployeeId: '000007',
      };
      async function queue(sequence: number, operation: string, snapshot: typeof payload) {
        await db.runtime.query(
          `INSERT INTO sync_inbox(
            organization_id,sequence,change_id,source_node_id,source_event_id,
            entity_type,entity_id,operation,revision,payload_version,payload
          ) VALUES($1,$2,$3,$4,$5,'biometric_mappings',$6,$7,$8,1,$9)`,
          [
            org,
            sequence,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            snapshot.id,
            operation,
            snapshot.revision,
            JSON.stringify(snapshot),
          ],
        );
      }
      async function mapping(mappingId: string) {
        return (await db.runtime.query('SELECT * FROM biometric_mappings WHERE id=$1', [mappingId]))
          .rows;
      }
      async function state(sequence: number) {
        return (
          await db.runtime.query(
            `SELECT applied_at,apply_error,apply_attempt_count FROM sync_inbox
           WHERE organization_id=$1 AND sequence=$2`,
            [org, sequence],
          )
        ).rows[0];
      }
      async function applied(sequence: number, attempts: number) {
        const row = await state(sequence);
        assert.notEqual(row.applied_at, null);
        assert.equal(row.apply_error, null);
        assert.equal(row.apply_attempt_count, attempts);
      }
      async function blocked(sequence: number) {
        assert.deepEqual(await state(sequence), {
          applied_at: null,
          apply_error: null,
          apply_attempt_count: 0,
        });
      }
      async function deferred(attempts: number) {
        const row = await state(800);
        assert.equal(row.applied_at, null);
        assert.equal(row.apply_attempt_count, attempts);
        assert.equal(
          row.apply_error,
          'Inbox event application failed; review local constraints and retry',
        );
        assert.deepEqual(await mapping(waitingId), []);
        await blocked(804);
      }
      await queue(800, 'CREATE', waiting);
      await queue(801, 'CREATE', payload);
      const reassigned = { ...payload, revision: 2, employeeId: nextEmployee };
      const inactive = { ...reassigned, revision: 3, status: 'inactive' };
      await queue(802, 'UPDATE', reassigned);
      await queue(803, 'ARCHIVE', inactive);
      await queue(804, 'UPDATE', { ...waiting, revision: 2, status: 'inactive' });

      const first = await applyInboxBatch(db.runtime, org);
      assert.equal(first.applied, 1);
      assert.equal(first.deferred, 1);
      const created = (await mapping(id))[0];
      assert.equal(created.id, id);
      assert.equal(created.organization_id, org);
      assert.equal(created.employee_id, employeeId);
      assert.equal(created.device_id, deviceId);
      assert.equal(created.device_employee_id, '001025');
      assert.equal(created.revision, 1);
      assert.equal(created.status, 'active');
      await applied(801, 1);
      await deferred(1);
      await blocked(802);
      await blocked(803);
      assert.deepEqual(await evidence(), originalEvidence);

      await db.runtime.query(
        `INSERT INTO employees(id,organization_id,employee_number,first_name,last_name)
         VALUES($1,$2,'E3','Recovered','Employee')`,
        [missingEmployee, org],
      );
      const second = await applyInboxBatch(db.runtime, org);
      assert.equal(second.applied, 1);
      assert.equal(second.deferred, 1); // Device dependency remains missing.
      const updated = (await mapping(id))[0];
      assert.equal(updated.employee_id, nextEmployee);
      assert.equal(updated.device_employee_id, '001025');
      assert.equal(updated.revision, 2);
      assert.equal(updated.status, 'active');
      await applied(802, 1);
      await deferred(2);
      await blocked(803);
      assert.deepEqual(await evidence(), originalEvidence);

      await db.runtime.query(
        "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'RECOVER','Recovered clock')",
        [missingDevice, org],
      );
      const third = await applyInboxBatch(db.runtime, org);
      assert.equal(third.applied, 2);
      assert.equal(third.deferred, 0);
      const recovered = (await mapping(waitingId))[0];
      assert.equal(recovered.employee_id, missingEmployee);
      assert.equal(recovered.device_id, missingDevice);
      assert.equal(recovered.device_employee_id, '000007');
      assert.equal(recovered.revision, 1);
      assert.equal(recovered.status, 'active');
      await applied(800, 3);
      await applied(803, 1);
      await blocked(804);
      const archived = (await mapping(id))[0];
      assert.equal(archived.employee_id, nextEmployee);
      assert.equal(archived.device_employee_id, '001025');
      assert.equal(archived.status, 'inactive');
      assert.equal(archived.revision, 3);
      for (const key of ['created_at', 'updated_at', 'updated_by']) {
        assert.deepEqual(archived[key], created[key]);
      }
      assert.deepEqual(await evidence(), originalEvidence);

      const fourth = await applyInboxBatch(db.runtime, org);
      assert.equal(fourth.applied, 1);
      assert.equal(fourth.deferred, 0);
      await applied(804, 1);
      assert.equal((await mapping(waitingId))[0].status, 'inactive');
      assert.equal((await mapping(waitingId))[0].revision, 2);
      await queue(805, 'ARCHIVE', inactive);
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 1);
      await applied(805, 1);
      assert.deepEqual((await mapping(id))[0], archived);
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 0);
      assert.deepEqual(await evidence(), originalEvidence);
      assert.equal(originalEvidence.punches[0].employee_id, employeeId);
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox')).rows[0].count,
        0,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox scheduler persists device revisions in order and isolates errors without checkpoint writes or echo',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const org = randomUUID();
      const id = randomUUID();
      const blockedId = randomUUID();
      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Device scheduler test')",
        [org],
      );
      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
      const payload = {
        id,
        organizationId: org,
        revision: 1,
        code: 'CLOCK',
        name: 'Main clock',
        status: 'active',
      };
      async function queue(sequence: number, operation: string, snapshot: typeof payload) {
        await db.runtime.query(
          `INSERT INTO sync_inbox(
            organization_id,sequence,change_id,source_node_id,source_event_id,
            entity_type,entity_id,operation,revision,payload_version,payload
          ) VALUES($1,$2,$3,$4,$5,'biometric_devices',$6,$7,$8,1,$9)`,
          [
            org,
            sequence,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            snapshot.id,
            operation,
            snapshot.revision,
            JSON.stringify(snapshot),
          ],
        );
      }
      async function state(sequence: number) {
        return (
          await db.runtime.query(
            `SELECT applied_at,apply_error,apply_attempt_count FROM sync_inbox
           WHERE organization_id=$1 AND sequence=$2`,
            [org, sequence],
          )
        ).rows[0];
      }
      async function device() {
        return (await db.runtime.query('SELECT * FROM biometric_devices WHERE id=$1', [id]))
          .rows[0];
      }
      async function checkpoints() {
        return (
          await db.runtime.query('SELECT * FROM biometric_ingestion_state ORDER BY device_id')
        ).rows;
      }
      // A failed earlier event must not stop an independent device CREATE.
      const blocked = { ...payload, id: blockedId, code: 'BLOCKED' };
      await queue(700, 'UPDATE', { ...blocked, revision: 2 });
      await queue(701, 'CREATE', payload);
      await queue(702, 'UPDATE', { ...payload, revision: 2, name: 'Updated clock' });
      await queue(703, 'ARCHIVE', {
        ...payload,
        revision: 3,
        name: 'Updated clock',
        status: 'inactive',
      });
      await queue(704, 'UPDATE', { ...blocked, revision: 3, name: 'Must stay blocked' });
      const first = await applyInboxBatch(db.runtime, org);
      assert.equal(first.applied, 1);
      assert.equal(first.deferred, 1);
      const created = await device();
      assert.equal(created.id, id);
      assert.equal(created.organization_id, org);
      assert.equal(created.code, 'CLOCK');
      assert.equal(created.name, 'Main clock');
      assert.equal(created.status, 'active');
      assert.equal(created.revision, 1);
      assert.deepEqual(await checkpoints(), []);
      const createdState = await state(701);
      assert.notEqual(createdState.applied_at, null);
      assert.equal(createdState.apply_error, null);
      assert.equal(createdState.apply_attempt_count, 1);
      async function assertBlocked(attempts: number) {
        const failed = await state(700);
        assert.equal(failed.applied_at, null);
        assert.equal(failed.apply_attempt_count, attempts);
        assert.equal(
          failed.apply_error,
          'Inbox event application failed; review local constraints and retry',
        );
        assert.deepEqual(await state(704), {
          applied_at: null,
          apply_error: null,
          apply_attempt_count: 0,
        });
        assert.equal(
          (await db.runtime.query('SELECT id FROM biometric_devices WHERE id=$1', [blockedId]))
            .rowCount,
          0,
        );
      }
      await assertBlocked(1);
      for (const sequence of [702, 703]) {
        assert.deepEqual(await state(sequence), {
          applied_at: null,
          apply_error: null,
          apply_attempt_count: 0,
        });
      }

      await db.runtime.query(
        `INSERT INTO biometric_ingestion_state(device_id,last_ingestion_at,last_record_at)
         VALUES($1,'2026-01-02T03:04:05Z','2026-01-02T03:00:00Z')`,
        [id],
      );
      const originalCheckpoints = await checkpoints();
      // Fail on any checkpoint write, even if it would preserve the same values.
      await db.migrator.query(`
        CREATE FUNCTION forbid_scheduler_checkpoint_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Scheduler must not write ingestion checkpoints'; END $$;
        CREATE TRIGGER forbid_scheduler_checkpoint_write
        BEFORE INSERT OR UPDATE OR DELETE ON biometric_ingestion_state
        FOR EACH ROW EXECUTE FUNCTION forbid_scheduler_checkpoint_write();
      `);
      const second = await applyInboxBatch(db.runtime, org);
      assert.equal(second.applied, 1);
      assert.equal(second.deferred, 1);
      assert.equal((await device()).name, 'Updated clock');
      assert.equal((await device()).revision, 2);
      assert.equal((await device()).status, 'active');
      assert.notEqual((await state(702)).applied_at, null);
      assert.equal((await state(702)).apply_error, null);
      assert.equal((await state(702)).apply_attempt_count, 1);
      assert.equal((await state(703)).apply_attempt_count, 0);
      await assertBlocked(2);
      assert.deepEqual(await checkpoints(), originalCheckpoints);

      const third = await applyInboxBatch(db.runtime, org);
      assert.equal(third.applied, 1);
      assert.equal(third.deferred, 1);
      const archived = await device();
      assert.equal(archived.name, 'Updated clock');
      assert.equal(archived.status, 'inactive');
      assert.equal(archived.revision, 3);
      for (const key of ['created_at', 'updated_at', 'updated_by']) {
        assert.deepEqual(archived[key], created[key]);
      }
      assert.notEqual((await state(703)).applied_at, null);
      assert.equal((await state(703)).apply_error, null);
      assert.equal((await state(703)).apply_attempt_count, 1);
      await assertBlocked(3);
      assert.deepEqual(await checkpoints(), originalCheckpoints);
      // A subsequent batch retries the failed entity without replaying applied device writes.
      const replay = await applyInboxBatch(db.runtime, org);
      assert.equal(replay.applied, 0);
      assert.equal(replay.deferred, 1);
      await assertBlocked(4);
      assert.deepEqual(await device(), archived);
      assert.deepEqual(await state(701), createdState);
      assert.deepEqual(await checkpoints(), originalCheckpoints);
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox')).rows[0].count,
        0,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox scheduler applies employee history after dependency recovery in revision order without echo',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const org = randomUUID();
      const id = randomUUID();
      const departmentId = randomUUID();
      const positionId = randomUUID();
      const userId = randomUUID();
      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Employee scheduler test')",
        [org],
      );
      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
      const payload = {
        id,
        organizationId: org,
        revision: 1,
        employeeNumber: 'EMP-SCHEDULER',
        firstName: 'Ana',
        middleName: null,
        lastName: 'Santos',
        suffix: null,
        birthDate: '1990-05-17',
        email: null,
        mobileNumber: null,
        address: null,
        barangay: null,
        city: null,
        province: null,
        postalCode: null,
        sssNumber: null,
        philhealthNumber: null,
        pagibigNumber: null,
        tin: null,
        status: 'active',
      };
      const version = {
        id: randomUUID(),
        organizationId: org,
        employeeId: id,
        departmentId,
        positionId,
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        employmentType: 'regular',
        employmentStatus: 'active',
        hireDate: '2025-01-01',
        regularizationDate: null,
        terminationDate: null,
        payType: 'monthly',
        payFrequency: 'semi_monthly',
        basicRateCentavos: 2500000,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        updatedBy: userId,
      };
      const closed = {
        ...version,
        effectiveTo: '2026-01-01',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const nextVersion = {
        ...version,
        id: randomUUID(),
        effectiveFrom: '2026-01-01',
        basicRateCentavos: 3000000,
        createdAt: closed.updatedAt,
        updatedAt: closed.updatedAt,
      };
      async function queue(sequence: number, operation: string, snapshot: Record<string, unknown>) {
        await db.runtime.query(
          `INSERT INTO sync_inbox(
            organization_id,sequence,change_id,source_node_id,source_event_id,
            entity_type,entity_id,operation,revision,payload_version,payload
          ) VALUES($1,$2,$3,$4,$5,'employees',$6,$7,$8,1,$9)`,
          [
            org,
            sequence,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            id,
            operation,
            snapshot.revision,
            JSON.stringify(snapshot),
          ],
        );
      }
      async function employee() {
        return (await db.runtime.query('SELECT * FROM employees WHERE id=$1', [id])).rows[0];
      }
      async function history() {
        return (
          await db.runtime.query(
            `SELECT id,organization_id,employee_id,department_id,position_id,
             effective_from::text,effective_to::text,basic_rate_centavos::text,updated_by
           FROM employment_versions WHERE employee_id=$1 ORDER BY effective_from`,
            [id],
          )
        ).rows;
      }
      async function state(sequence: number) {
        return (
          await db.runtime.query(
            `SELECT applied_at,apply_error,apply_attempt_count FROM sync_inbox
           WHERE organization_id=$1 AND sequence=$2`,
            [org, sequence],
          )
        ).rows[0];
      }
      await queue(600, 'CREATE', payload);
      await queue(601, 'UPDATE', {
        ...payload,
        revision: 2,
        firstName: 'Anna',
        employmentVersions: [version],
      });
      const latest = {
        ...payload,
        revision: 3,
        firstName: 'Annabelle',
        employmentVersions: [nextVersion, closed],
      };
      await queue(602, 'UPDATE', latest);
      const createdBatch = await applyInboxBatch(db.runtime, org);
      assert.equal(createdBatch.applied, 1);
      assert.equal(createdBatch.deferred, 0);
      const created = await employee();
      assert.equal(created.id, id);
      assert.equal(created.organization_id, org);
      assert.equal(created.employee_number, payload.employeeNumber);
      assert.equal(created.first_name, 'Ana');
      assert.equal(created.last_name, 'Santos');
      assert.equal(created.revision, 1);
      assert.deepEqual(await history(), []);
      const createState = await state(600);
      assert.notEqual(createState.applied_at, null);
      assert.equal(createState.apply_error, null);

      async function assertDeferred(attempt: number) {
        const result = await applyInboxBatch(db.runtime, org);
        assert.equal(result.applied, 0);
        assert.equal(result.deferred, 1);
        assert.deepEqual(await employee(), created);
        assert.deepEqual(await history(), []);
        const deferred = await state(601);
        assert.equal(deferred.applied_at, null);
        assert.equal(deferred.apply_attempt_count, attempt);
        assert.equal(
          deferred.apply_error,
          'Inbox event application failed; review local constraints and retry',
        );
        assert.deepEqual(await state(602), {
          applied_at: null,
          apply_error: null,
          apply_attempt_count: 0,
        });
      }
      await assertDeferred(1); // Department is missing.
      await db.runtime.query(
        "INSERT INTO departments(id,organization_id,code,name) VALUES($1,$2,'ENG','Engineering')",
        [departmentId, org],
      );
      await assertDeferred(2); // Position is still missing.
      await db.runtime.query(
        `INSERT INTO positions(id,organization_id,department_id,code,name)
         VALUES($1,$2,$3,'DEV','Developer')`,
        [positionId, org, departmentId],
      );
      await assertDeferred(3); // Historical audit user is still missing.
      await db.runtime.query(
        `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
         VALUES($1,$2,'scheduler_auditor','Auditor',$3)`,
        [userId, org, DUMMY_PASSWORD_HASH],
      );
      const recovered = await applyInboxBatch(db.runtime, org);
      assert.equal(recovered.applied, 1);
      assert.equal(recovered.deferred, 0);
      assert.equal((await employee()).revision, 2);
      assert.equal((await employee()).first_name, 'Anna');
      assert.deepEqual(await history(), [
        {
          id: version.id,
          organization_id: org,
          employee_id: id,
          department_id: departmentId,
          position_id: positionId,
          effective_from: '2025-01-01',
          effective_to: null,
          basic_rate_centavos: '2500000',
          updated_by: userId,
        },
      ]);
      const recoveredState = await state(601);
      assert.notEqual(recoveredState.applied_at, null);
      assert.equal(recoveredState.apply_error, null);
      assert.equal(recoveredState.apply_attempt_count, 4);
      assert.equal((await state(602)).apply_attempt_count, 0);

      const advanced = await applyInboxBatch(db.runtime, org);
      assert.equal(advanced.applied, 1);
      assert.equal(advanced.deferred, 0);
      assert.equal((await employee()).revision, 3);
      assert.equal((await employee()).first_name, 'Annabelle');
      const savedHistory = await history();
      assert.deepEqual(savedHistory, [
        {
          id: version.id,
          organization_id: org,
          employee_id: id,
          department_id: departmentId,
          position_id: positionId,
          effective_from: '2025-01-01',
          effective_to: '2026-01-01',
          basic_rate_centavos: '2500000',
          updated_by: userId,
        },
        {
          id: nextVersion.id,
          organization_id: org,
          employee_id: id,
          department_id: departmentId,
          position_id: positionId,
          effective_from: '2026-01-01',
          effective_to: null,
          basic_rate_centavos: '3000000',
          updated_by: userId,
        },
      ]);
      assert.notEqual((await state(602)).applied_at, null);
      assert.equal((await state(602)).apply_error, null);
      assert.equal((await state(602)).apply_attempt_count, 1);
      const savedEmployee = await employee();
      await queue(603, 'UPDATE', latest);
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 1);
      assert.deepEqual(await employee(), savedEmployee);
      assert.deepEqual(await history(), savedHistory);
      assert.deepEqual(await state(600), createState);
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 0);
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox')).rows[0].count,
        0,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox scheduler applies positions and retries department dependencies in revision order without echo',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const org = randomUUID();
      const departmentId = randomUUID();
      const missingDepartmentId = randomUUID();
      const id = randomUUID();
      const waitingId = randomUUID();
      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Position scheduler test')",
        [org],
      );
      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
      await db.runtime.query(
        "INSERT INTO departments(id,organization_id,code,name) VALUES($1,$2,'ENG','Engineering')",
        [departmentId, org],
      );
      const payload = {
        id,
        organizationId: org,
        revision: 1,
        code: 'ENGINEER',
        name: 'Engineer',
        description: 'Synchronized position',
        status: 'active',
        departmentId,
      };
      async function queue(sequence: number, operation: string, snapshot: typeof payload) {
        await db.runtime.query(
          `INSERT INTO sync_inbox(
            organization_id,sequence,change_id,source_node_id,source_event_id,
            entity_type,entity_id,operation,revision,payload_version,payload
          ) VALUES($1,$2,$3,$4,$5,'positions',$6,$7,$8,1,$9)`,
          [
            org,
            sequence,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            snapshot.id,
            operation,
            snapshot.revision,
            JSON.stringify(snapshot),
          ],
        );
      }
      async function position(positionId: string) {
        return (await db.runtime.query('SELECT * FROM positions WHERE id=$1', [positionId])).rows;
      }
      async function state(sequence: number) {
        return (
          await db.runtime.query(
            `SELECT applied_at,apply_error,apply_attempt_count FROM sync_inbox
           WHERE organization_id=$1 AND sequence=$2`,
            [org, sequence],
          )
        ).rows[0];
      }
      const waiting = {
        ...payload,
        id: waitingId,
        code: 'MANAGER',
        name: 'Manager',
        departmentId: missingDepartmentId,
      };
      await queue(500, 'CREATE', payload);
      await queue(501, 'CREATE', waiting);
      await queue(502, 'UPDATE', { ...waiting, revision: 2, name: 'Senior Manager' });
      const first = await applyInboxBatch(db.runtime, org);
      assert.equal(first.applied, 1);
      assert.equal(first.deferred, 1);
      const created = await position(id);
      assert.equal(created.length, 1);
      assert.equal(created[0].id, id);
      assert.equal(created[0].organization_id, org);
      assert.equal(created[0].code, payload.code);
      assert.equal(created[0].name, payload.name);
      assert.equal(created[0].description, payload.description);
      assert.equal(created[0].status, payload.status);
      assert.equal(created[0].revision, 1);
      assert.equal(created[0].department_id, departmentId);
      assert.deepEqual(await position(waitingId), []);
      const applied = await state(500);
      assert.notEqual(applied.applied_at, null);
      assert.equal(applied.apply_error, null);
      assert.equal(applied.apply_attempt_count, 1);
      const deferred = await state(501);
      assert.equal(deferred.applied_at, null);
      assert.equal(deferred.apply_attempt_count, 1);
      assert.equal(
        deferred.apply_error,
        'Inbox event application failed; review local constraints and retry',
      );
      assert.deepEqual(await state(502), {
        applied_at: null,
        apply_error: null,
        apply_attempt_count: 0,
      });

      // Replay the same snapshot as another inbox event while the dependency is still absent.
      await queue(503, 'CREATE', payload);
      const replay = await applyInboxBatch(db.runtime, org);
      assert.equal(replay.applied, 1);
      assert.equal(replay.deferred, 1);
      assert.deepEqual(await position(id), created);
      assert.deepEqual(await state(500), applied);
      assert.notEqual((await state(503)).applied_at, null);
      assert.equal((await state(503)).apply_error, null);
      assert.equal((await state(501)).apply_attempt_count, 2);
      assert.equal((await state(502)).apply_attempt_count, 0);
      assert.deepEqual(await position(waitingId), []);

      await db.runtime.query(
        "INSERT INTO departments(id,organization_id,code,name) VALUES($1,$2,'OPS','Operations')",
        [missingDepartmentId, org],
      );
      const retry = await applyInboxBatch(db.runtime, org);
      assert.equal(retry.applied, 1);
      assert.equal(retry.deferred, 0);
      const recovered = (await position(waitingId))[0];
      assert.equal(recovered.name, 'Manager');
      assert.equal(recovered.revision, 1);
      assert.equal(recovered.department_id, missingDepartmentId);
      const recoveredState = await state(501);
      assert.notEqual(recoveredState.applied_at, null);
      assert.equal(recoveredState.apply_error, null);
      assert.equal(recoveredState.apply_attempt_count, 3);
      assert.equal((await state(502)).apply_attempt_count, 0);

      const next = await applyInboxBatch(db.runtime, org);
      assert.equal(next.applied, 1);
      assert.equal(next.deferred, 0);
      const updated = (await position(waitingId))[0];
      assert.equal(updated.name, 'Senior Manager');
      assert.equal(updated.revision, 2);
      assert.equal(updated.department_id, missingDepartmentId);
      assert.notEqual((await state(502)).applied_at, null);
      assert.equal((await state(502)).apply_error, null);
      assert.equal((await state(502)).apply_attempt_count, 1);
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 0);
      assert.deepEqual(await position(id), created);
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox')).rows[0].count,
        0,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox scheduler dispatches departments, retries missing dependencies and preserves ordering without echo',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const org = randomUUID();
      const id = randomUUID();
      const missingId = randomUUID();
      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Department scheduler test')",
        [org],
      );
      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);

      const payload = {
        id,
        organizationId: org,
        revision: 1,
        code: 'HR',
        name: 'Human Resources',
        description: 'Synchronized department',
        status: 'active',
      };
      async function queue(sequence: number, operation: string, snapshot: typeof payload) {
        await db.runtime.query(
          `INSERT INTO sync_inbox(
            organization_id,sequence,change_id,source_node_id,source_event_id,
            entity_type,entity_id,operation,revision,payload_version,payload
          ) VALUES($1,$2,$3,$4,$5,'departments',$6,$7,$8,1,$9)`,
          [
            org,
            sequence,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            snapshot.id,
            operation,
            snapshot.revision,
            JSON.stringify(snapshot),
          ],
        );
      }

      await queue(400, 'CREATE', payload);
      const missing = { ...payload, id: missingId, code: 'OPS', revision: 2, name: 'Operations' };
      await queue(401, 'UPDATE', missing);
      await queue(402, 'UPDATE', { ...missing, revision: 3, name: 'Latest Operations' });

      const first = await applyInboxBatch(db.runtime, org);
      assert.equal(first.applied, 1);
      assert.equal(first.deferred, 1);
      const created = await db.runtime.query(
        'SELECT id,organization_id,code,name,description,status,revision FROM departments WHERE id=$1',
        [id],
      );
      assert.deepEqual(created.rows, [
        {
          id,
          organization_id: org,
          code: 'HR',
          name: 'Human Resources',
          description: payload.description,
          status: 'active',
          revision: 1,
        },
      ]);
      assert.equal(
        (await db.runtime.query('SELECT id FROM departments WHERE id=$1', [missingId])).rowCount,
        0,
      );
      async function inboxState() {
        return (
          await db.runtime.query(
            `SELECT sequence,applied_at,apply_error,apply_attempt_count FROM sync_inbox
           WHERE organization_id=$1 ORDER BY sequence`,
            [org],
          )
        ).rows;
      }
      const initial = await inboxState();
      assert.notEqual(initial[0].applied_at, null);
      assert.equal(initial[0].apply_error, null);
      assert.equal(initial[0].apply_attempt_count, 1);
      assert.equal(initial[1].applied_at, null);
      assert.equal(
        initial[1].apply_error,
        'Inbox event application failed; review local constraints and retry',
      );
      assert.equal(initial[1].apply_attempt_count, 1);
      assert.equal(initial[2].applied_at, null);
      assert.equal(initial[2].apply_error, null);
      assert.equal(initial[2].apply_attempt_count, 0);

      const replay = await applyInboxBatch(db.runtime, org);
      assert.equal(replay.applied, 0);
      assert.equal(replay.deferred, 1);
      const retried = await inboxState();
      assert.deepEqual(retried[0], initial[0]);
      assert.equal(retried[1].apply_attempt_count, 2);
      assert.equal(retried[2].apply_attempt_count, 0);
      assert.deepEqual(
        (
          await db.runtime.query(
            'SELECT id,organization_id,code,name,description,status,revision FROM departments WHERE id=$1',
            [id],
          )
        ).rows,
        created.rows,
      );

      // Supply the missing prerequisite locally, then verify queued updates advance in order.
      await db.runtime.query(
        `INSERT INTO departments(id,organization_id,code,name,revision)
         VALUES($1,$2,'OPS','Original Operations',1)`,
        [missingId, org],
      );
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 1);
      assert.deepEqual(
        (await db.runtime.query('SELECT name,revision FROM departments WHERE id=$1', [missingId]))
          .rows,
        [{ name: 'Operations', revision: 2 }],
      );
      const unblocked = await inboxState();
      assert.notEqual(unblocked[1].applied_at, null);
      assert.equal(unblocked[1].apply_error, null);
      assert.equal(unblocked[2].apply_attempt_count, 0);

      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 1);
      assert.deepEqual(
        (await db.runtime.query('SELECT name,revision FROM departments WHERE id=$1', [missingId]))
          .rows,
        [{ name: 'Latest Operations', revision: 3 }],
      );
      const completed = await inboxState();
      assert.notEqual(completed[2].applied_at, null);
      assert.equal(completed[2].apply_error, null);
      assert.equal(completed[2].apply_attempt_count, 1);
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 0);
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox')).rows[0].count,
        0,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  'generic account inbox quarantines historical creation and credential or role changes without outbox echo',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const org = randomUUID(),
        id = randomUUID();
      await db.runtime.query("INSERT INTO organizations(id,legal_name) VALUES($1,'Inbox test')", [
        org,
      ]);
      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
      const payload = {
        id,
        organizationId: org,
        username: 'stef',
        email: null,
        displayName: 'Stef',
        passwordHash: DUMMY_PASSWORD_HASH,
        active: true,
        revision: 1,
        createdAt: '2026-10-08T00:00:00.000Z',
        updatedAt: '2026-10-08T00:00:00.000Z',
        roles: ['viewer'],
      };
      async function queue(sequence: number, snapshot: typeof payload, entityType = 'auth_users') {
        await db.runtime.query(
          `INSERT INTO sync_inbox(organization_id,sequence,change_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload_version,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,'UPDATE',$8,1,$9)`,
          [
            org,
            sequence,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            entityType,
            snapshot.id,
            snapshot.revision,
            JSON.stringify(snapshot),
          ],
        );
      }
      await queue(10, payload);
      const first = await applyInboxBatch(db.runtime, org);
      assert.equal(first.applied, 0);
      assert.equal(first.deferred, 1);
      assert.equal(
        (await db.runtime.query('SELECT 1 FROM auth_users WHERE id=$1', [id])).rowCount,
        0,
      );
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 0);
      await queue(11, payload);
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 0);
      await queue(12, { ...payload, displayName: 'Conflicting' });
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 0);
      const existing = randomUUID();
      await db.runtime.query(
        "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash,active) VALUES($1,$2,'existing','Existing',$3,false)",
        [existing, org, DUMMY_PASSWORD_HASH],
      );
      await db.runtime.query("INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='viewer'", [
        existing,
      ]);
      await queue(15, {
        ...payload,
        id: existing,
        revision: 9,
        roles: ['administrator'],
        passwordHash: DUMMY_PASSWORD_HASH.replace('00', '11'),
      });
      assert.equal((await applyInboxBatch(db.runtime, org)).applied, 0);
      const current = (
        await db.runtime.query(
          'SELECT active,display_name,password_hash,revision FROM auth_users WHERE id=$1',
          [existing],
        )
      ).rows[0];
      assert.deepEqual(current, {
        active: false,
        display_name: 'Existing',
        password_hash: DUMMY_PASSWORD_HASH,
        revision: 1,
      });
      const assigned = (
        await db.runtime.query(
          'SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1',
          [existing],
        )
      ).rows;
      assert.deepEqual(assigned, [{ code: 'viewer' }]);
      const failed = (
        await db.runtime.query('SELECT applied_at,apply_error FROM sync_inbox WHERE sequence=15')
      ).rows[0];
      assert.equal(failed.applied_at, null);
      assert.equal(
        failed.apply_error,
        'Generic account distribution is suspended; use trusted identity publication',
      );
      await queue(16, payload, 'employees');
      await assert.rejects(applyInboxBatch(db.runtime, randomUUID()), /installation/);
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int count FROM sync_outbox')).rows[0].count,
        0,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox quarantines independent legacy accounts and preserves same-entity ordering',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();

    try {
      await migrate(db.migrator, db.migrations);

      const org = randomUUID();
      const accountA = randomUUID();
      const accountB = randomUUID();

      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Inbox scheduling test')",
        [org],
      );

      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);

      const base = {
        organizationId: org,
        email: null,
        passwordHash: DUMMY_PASSWORD_HASH,
        active: true,
        revision: 1,
        createdAt: '2026-10-08T00:00:00.000Z',
        updatedAt: '2026-10-08T00:00:00.000Z',
      };

      async function queue(sequence: number, id: string, payload: Record<string, unknown>) {
        await db.runtime.query(
          `INSERT INTO sync_inbox(
            organization_id, sequence, change_id,
            source_node_id, source_event_id,
            entity_type, entity_id, operation,
            revision, payload_version, payload
          )
          VALUES($1,$2,$3,$4,$5,'auth_users',$6,'UPDATE',$7,1,$8)`,
          [
            org,
            sequence,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            id,
            payload.revision,
            JSON.stringify(payload),
          ],
        );
      }

      const failingA = {
        ...base,
        id: accountA,
        username: 'account_a',
        displayName: 'Account A',
        roles: ['missing_role'],
      };

      const validB = {
        ...base,
        id: accountB,
        username: 'account_b',
        displayName: 'Account B',
        roles: ['viewer'],
      };

      await queue(100, accountA, failingA);
      await queue(101, accountB, validB);
      await queue(102, accountA, {
        ...failingA,
        revision: 2,
        roles: ['viewer'],
      });

      const result = await applyInboxBatch(db.runtime, org);

      assert.equal(result.applied, 0);
      assert.equal(result.deferred, 2);

      const rows = await db.runtime.query(
        `SELECT sequence, applied_at, apply_attempt_count
         FROM sync_inbox
         WHERE organization_id=$1
         ORDER BY sequence`,
        [org],
      );

      assert.equal(rows.rows[0].applied_at, null);
      assert.equal(rows.rows[0].apply_attempt_count, 1);

      assert.equal(rows.rows[1].applied_at, null);
      assert.equal(rows.rows[1].apply_attempt_count, 1);

      assert.equal(rows.rows[2].applied_at, null);
      assert.equal(rows.rows[2].apply_attempt_count, 0);

      const account = await db.runtime.query('SELECT username FROM auth_users WHERE id=$1', [
        accountB,
      ]);

      assert.equal(account.rowCount, 0);
      assert.equal((await applyInboxBatch(db.runtime, org)).deferred, 0);
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox processes at most 20 eligible events per batch',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();

    try {
      await migrate(db.migrator, db.migrations);

      const org = randomUUID();

      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Inbox batch test')",
        [org],
      );

      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);

      for (let i = 0; i < 25; i++) {
        const id = randomUUID();

        const payload = {
          id,
          organizationId: org,
          username: `batch_user_${i}`,
          email: null,
          displayName: `Batch User ${i}`,
          passwordHash: DUMMY_PASSWORD_HASH,
          active: true,
          revision: 1,
          createdAt: '2026-10-08T00:00:00.000Z',
          updatedAt: '2026-10-08T00:00:00.000Z',
          roles: ['viewer'],
        };

        await db.runtime.query(
          `INSERT INTO sync_inbox(
            organization_id,sequence,change_id,
            source_node_id,source_event_id,
            entity_type,entity_id,operation,
            revision,payload_version,payload
          )
          VALUES($1,$2,$3,$4,$5,'auth_users',$6,'CREATE',1,1,$7)`,
          [org, 200 + i, randomUUID(), randomUUID(), randomUUID(), id, JSON.stringify(payload)],
        );
      }

      const first = await applyInboxBatch(db.runtime, org);

      assert.equal(first.applied, 0);
      assert.equal(first.deferred, 20);
      assert.equal(first.pending, 20);

      const afterFirst = await db.runtime.query(
        `SELECT
           count(*) FILTER (WHERE applied_at IS NOT NULL)::int AS applied,
           count(*) FILTER (WHERE applied_at IS NULL)::int AS pending
         FROM sync_inbox
         WHERE organization_id=$1`,
        [org],
      );

      assert.equal(afterFirst.rows[0].applied, 0);
      assert.equal(afterFirst.rows[0].pending, 25);

      const second = await applyInboxBatch(db.runtime, org);

      assert.equal(second.applied, 0);
      assert.equal(second.deferred, 5);

      const afterSecond = await db.runtime.query(
        `SELECT count(*)::int AS remaining
         FROM sync_inbox
         WHERE organization_id=$1
           AND applied_at IS NULL`,
        [org],
      );

      assert.equal(afterSecond.rows[0].remaining, 25);
    } finally {
      await db.close();
    }
  },
);

test(
  'inbox scheduler dispatches organization events without echo',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();

    try {
      await migrate(db.migrator, db.migrations);

      const org = randomUUID();

      await db.runtime.query(
        `INSERT INTO organizations(id,legal_name,revision)
         VALUES($1,'Original Organization',1)`,
        [org],
      );

      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);

      const payload = {
        id: org,
        organizationId: org,
        revision: 2,
        legalName: 'Synchronized Organization',
        tradeName: null,
        tin: null,
        rdoCode: null,
        sssNumber: null,
        philhealthNumber: null,
        pagibigNumber: null,
        address: null,
        barangay: null,
        city: null,
        province: null,
        postalCode: null,
        country: 'PH',
        phone: null,
        email: null,
        timezone: 'Asia/Manila',
        currency: 'PHP',
        status: 'active',
      };

      await db.runtime.query(
        `INSERT INTO sync_inbox(
          organization_id,sequence,change_id,
          source_node_id,source_event_id,
          entity_type,entity_id,operation,
          revision,payload_version,payload
        )
        VALUES($1,300,$2,$3,$4,'organizations',$1,'UPDATE',2,1,$5)`,
        [org, randomUUID(), randomUUID(), randomUUID(), JSON.stringify(payload)],
      );

      const result = await applyInboxBatch(db.runtime, org);

      assert.equal(result.applied, 1);
      assert.equal(result.deferred, 0);

      const organization = await db.runtime.query(
        'SELECT legal_name,revision FROM organizations WHERE id=$1',
        [org],
      );

      assert.equal(organization.rows[0].legal_name, 'Synchronized Organization');
      assert.equal(organization.rows[0].revision, 2);

      const inbox = await db.runtime.query(
        `SELECT applied_at,apply_error
         FROM sync_inbox
         WHERE organization_id=$1 AND sequence=300`,
        [org],
      );

      assert.notEqual(inbox.rows[0].applied_at, null);
      assert.equal(inbox.rows[0].apply_error, null);

      const outbox = await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox');

      assert.equal(outbox.rows[0].count, 0);

      const replay = await applyInboxBatch(db.runtime, org);

      assert.equal(replay.applied, 0);
    } finally {
      await db.close();
    }
  },
);
