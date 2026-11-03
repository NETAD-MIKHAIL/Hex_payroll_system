import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { applyBiometricDeviceEvent } from '../src/sync/biometric-device-inbox.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';

async function fixture() {
  const db = await databaseFixture();
  try {
    await migrate(db.migrator, db.migrations);
    const org = randomUUID();
    const foreignOrg = randomUUID();
    const id = randomUUID();
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Device test'),($2,'Foreign')",
      [org, foreignOrg],
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
    async function apply(
      snapshot: Record<string, unknown>,
      operation = 'UPDATE',
      overrides: Partial<Parameters<typeof applyBiometricDeviceEvent>[1]> = {},
    ) {
      const client = await db.runtime.connect();
      try {
        await client.query('BEGIN');
        await applyBiometricDeviceEvent(client, {
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
    async function state() {
      return {
        devices: (await db.runtime.query('SELECT * FROM biometric_devices ORDER BY id')).rows,
        checkpoints: (
          await db.runtime.query('SELECT * FROM biometric_ingestion_state ORDER BY device_id')
        ).rows,
      };
    }
    async function noEcho() {
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox')).rows[0].count,
        0,
      );
    }
    return { ...db, org, foreignOrg, id, payload, apply, state, noEcho };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test(
  'device inbox persists local UUIDs and revisions, replays safely and preserves audit metadata',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply(db.payload, 'CREATE');
      const created = await db.state();
      assert.equal(created.devices.length, 1);
      const row = created.devices[0];
      assert.equal(row.id, db.id);
      assert.equal(row.organization_id, db.org);
      assert.equal(row.code, 'CLOCK');
      assert.equal(row.name, 'Main clock');
      assert.equal(row.status, 'active');
      assert.equal(row.revision, 1);
      assert.deepEqual(created.checkpoints, []);
      await db.apply(db.payload, 'CREATE');
      assert.deepEqual(await db.state(), created);

      // Use non-null audit metadata to catch accidental replacement during synchronization.
      const user = randomUUID();
      await db.runtime.query(
        `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
         VALUES($1,$2,'device_auditor','Auditor',$3)`,
        [user, db.org, DUMMY_PASSWORD_HASH],
      );
      await db.runtime.query(
        `UPDATE biometric_devices SET created_at='2025-01-01T00:00:00Z',
         updated_at='2025-02-01T00:00:00Z',updated_by=$2 WHERE id=$1`,
        [db.id, user],
      );
      const original = (await db.state()).devices[0];
      const update = { ...db.payload, revision: 2, code: 'CLOCK-NEW', name: 'Updated clock' };
      await db.apply(update);
      const saved = await db.state();
      assert.equal(saved.devices[0].code, 'CLOCK-NEW');
      assert.equal(saved.devices[0].name, 'Updated clock');
      assert.equal(saved.devices[0].revision, 2);
      for (const key of ['created_at', 'updated_at', 'updated_by']) {
        assert.deepEqual(saved.devices[0][key], original[key]);
      }
      await db.apply(update);
      await assert.rejects(db.apply({ ...update, name: 'Conflict' }), /revision conflict/);
      await db.apply(db.payload);
      assert.deepEqual(await db.state(), saved);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'device inbox rejects missing records, foreign identities and invalid snapshots without local writes',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await assert.rejects(db.apply(db.payload), /dependency missing/);
      await assert.rejects(db.apply(db.payload, 'ARCHIVE'), /must be inactive/);
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
        db.apply({ ...db.payload, organizationId: db.foreignOrg }, 'CREATE', {
          organization_id: db.foreignOrg,
        }),
        /not enrolled/,
      );
      await assert.rejects(db.apply(db.payload, 'DELETE'), /Invalid biometric device operation/);
      await assert.rejects(
        db.apply(db.payload, 'CREATE', { payload_version: 2 }),
        /snapshot or version/,
      );
      for (const patch of [
        { revision: 0 },
        { revision: 1.5 },
        { revision: 2147483648 },
        { code: '' },
        { name: ' ' },
        { status: 'enabled' },
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
      assert.deepEqual(await db.state(), { devices: [], checkpoints: [] });

      await db.runtime.query(
        `INSERT INTO biometric_devices(id,organization_id,code,name)
         VALUES($1,$2,'FOREIGN','Foreign device')`,
        [db.id, db.foreignOrg],
      );
      const before = await db.state();
      await assert.rejects(db.apply(db.payload, 'CREATE'), /organization mismatch/);
      assert.deepEqual(await db.state(), before);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'device inbox preserves separate UUIDs and rejects local code collisions atomically',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply(db.payload, 'CREATE');
      const other = { ...db.payload, id: randomUUID(), code: 'OTHER', name: 'Other clock' };
      await db.apply(other, 'CREATE');
      const before = await db.state();
      const uniqueViolation = (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23505');
        return true;
      };
      await assert.rejects(
        db.apply({ ...db.payload, id: randomUUID() }, 'CREATE'),
        uniqueViolation,
      );
      assert.deepEqual(await db.state(), before);
      await assert.rejects(db.apply({ ...other, revision: 2, code: 'CLOCK' }), uniqueViolation);
      assert.deepEqual(await db.state(), before);
      // The same code in a different organization does not collide.
      await db.runtime.query(
        `INSERT INTO biometric_devices(id,organization_id,code,name)
         VALUES($1,$2,'CLOCK','Foreign clock')`,
        [randomUUID(), db.foreignOrg],
      );
      assert.equal((await db.state()).devices.length, 3);
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);

test(
  'device metadata archive and reactivation preserve ingestion checkpoints and reject polling settings',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await fixture();
    try {
      await db.apply(db.payload, 'CREATE');
      await db.runtime.query(
        `INSERT INTO biometric_ingestion_state(device_id,last_ingestion_at,last_record_at)
         VALUES($1,'2026-01-02T03:04:05Z','2026-01-02T03:00:00Z')`,
        [db.id],
      );
      const before = await db.state();
      // Guard the checkpoint table against any writes, even writes of identical values.
      await db.migrator.query(`
        CREATE FUNCTION forbid_test_checkpoint_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Device sync must not write ingestion checkpoints'; END $$;
        CREATE TRIGGER forbid_test_checkpoint_write
        BEFORE INSERT OR UPDATE OR DELETE ON biometric_ingestion_state
        FOR EACH ROW EXECUTE FUNCTION forbid_test_checkpoint_write();
      `);
      await assert.rejects(db.apply({ ...db.payload, revision: 2 }, 'ARCHIVE'), /must be inactive/);
      assert.deepEqual(await db.state(), before);
      const archived = { ...db.payload, revision: 2, status: 'inactive' };
      await db.apply(archived, 'ARCHIVE');
      await db.apply(archived, 'ARCHIVE');
      assert.equal((await db.state()).devices[0].status, 'inactive');
      await db.apply({ ...db.payload, revision: 3 });
      const active = await db.state();
      assert.equal(active.devices[0].status, 'active');
      assert.equal(active.devices[0].revision, 3);
      assert.deepEqual(active.checkpoints, before.checkpoints);
      // Network/polling configuration is not part of the six-field sync contract.
      for (const settings of [
        { pollingEnabled: true },
        { pollIntervalMs: 1000 },
        { host: '192.0.2.1' },
        { port: 4370 },
        { communicationKey: 'test-only' },
        { collectorNodeId: randomUUID() },
      ]) {
        await assert.rejects(
          db.apply({ ...db.payload, revision: 4, ...settings }),
          /snapshot or version/,
        );
        assert.deepEqual(await db.state(), active);
      }
      await db.noEcho();
    } finally {
      await db.close();
    }
  },
);
