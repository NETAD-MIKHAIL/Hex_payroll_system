import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { applyDepartmentEvent } from '../src/sync/department-inbox.js';

async function applyInTransaction(
  db: { connect(): Promise<PoolClient> },
  event: Parameters<typeof applyDepartmentEvent>[1],
) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await applyDepartmentEvent(client, event);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test(
  'department inbox creates, updates, replays and detects conflicts',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();

    try {
      await migrate(db.migrator, db.migrations);

      const org = randomUUID();
      const id = randomUUID();

      await db.runtime.query(
        `INSERT INTO organizations(id,legal_name)
         VALUES($1,'Test Organization')`,
        [org],
      );

      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);

      const payload = {
        id,
        organizationId: org,
        revision: 1,
        code: 'HR',
        name: 'Human Resources',
        description: null,
        status: 'active',
      };

      const event = {
        organization_id: org,
        entity_id: id,
        operation: 'CREATE',
        revision: 1,
        payload_version: 1,
        payload,
      };

      await applyInTransaction(db.runtime, event);
      await applyInTransaction(db.runtime, event);

      const created = await db.runtime.query(`SELECT * FROM departments WHERE id=$1`, [id]);

      assert.equal(created.rowCount, 1);
      assert.equal(created.rows[0].organization_id, org);
      assert.equal(created.rows[0].name, 'Human Resources');
      assert.equal(created.rows[0].revision, 1);

      const originalMetadata = [
        created.rows[0].created_at,
        created.rows[0].updated_at,
        created.rows[0].updated_by,
      ];

      const updatedEvent = {
        ...event,
        operation: 'UPDATE',
        revision: 2,
        payload: {
          ...payload,
          revision: 2,
          name: 'People Operations',
        },
      };

      await applyInTransaction(db.runtime, updatedEvent);
      await applyInTransaction(db.runtime, updatedEvent);

      const updated = await db.runtime.query(`SELECT * FROM departments WHERE id=$1`, [id]);

      assert.equal(updated.rows[0].name, 'People Operations');
      assert.equal(updated.rows[0].revision, 2);

      assert.deepEqual(
        [updated.rows[0].created_at, updated.rows[0].updated_at, updated.rows[0].updated_by],
        originalMetadata,
      );

      await assert.rejects(
        applyInTransaction(db.runtime, {
          ...updatedEvent,
          payload: {
            ...updatedEvent.payload,
            name: 'Conflicting Department',
          },
        }),
        /revision conflict/,
      );

      const preserved = await db.runtime.query(
        `SELECT name,revision FROM departments WHERE id=$1`,
        [id],
      );

      assert.equal(preserved.rows[0].name, 'People Operations');
      assert.equal(preserved.rows[0].revision, 2);

      const outbox = await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox');

      assert.equal(outbox.rows[0].count, 0);
    } finally {
      await db.close();
    }
  },
);

test(
  'department inbox rejects missing dependencies and foreign organizations',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();

    try {
      await migrate(db.migrator, db.migrations);

      const org = randomUUID();
      const foreignOrg = randomUUID();
      const id = randomUUID();

      await db.runtime.query(
        `INSERT INTO organizations(id,legal_name)
         VALUES($1,'Test Organization')`,
        [org],
      );

      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);

      const payload = {
        id,
        organizationId: org,
        revision: 2,
        code: 'FIN',
        name: 'Finance',
        description: null,
        status: 'active',
      };

      const updateEvent = {
        organization_id: org,
        entity_id: id,
        operation: 'UPDATE',
        revision: 2,
        payload_version: 1,
        payload,
      };

      await assert.rejects(applyInTransaction(db.runtime, updateEvent), /dependency missing/);

      await assert.rejects(
        applyInTransaction(db.runtime, {
          ...updateEvent,
          organization_id: foreignOrg,
        }),
        /identity mismatch/,
      );

      await assert.rejects(
        applyInTransaction(db.runtime, {
          ...updateEvent,
          operation: 'CREATE',
          payload: {
            ...payload,
            organizationId: foreignOrg,
          },
        }),
        /identity mismatch/,
      );

      const absent = await db.runtime.query('SELECT id FROM departments WHERE id=$1', [id]);

      assert.equal(absent.rowCount, 0);

      const outbox = await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox');

      assert.equal(outbox.rows[0].count, 0);
    } finally {
      await db.close();
    }
  },
);

test(
  'department inbox ignores stale revisions and validates archive status',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();

    try {
      await migrate(db.migrator, db.migrations);

      const org = randomUUID();
      const id = randomUUID();

      await db.runtime.query(
        `INSERT INTO organizations(id,legal_name)
         VALUES($1,'Test Organization')`,
        [org],
      );

      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);

      await db.runtime.query(
        `INSERT INTO departments(
          id,organization_id,code,name,status,revision
        ) VALUES($1,$2,'OPS','Current Operations','active',3)`,
        [id, org],
      );

      const payload = {
        id,
        organizationId: org,
        revision: 2,
        code: 'OPS',
        name: 'Outdated Operations',
        description: null,
        status: 'active',
      };

      await applyInTransaction(db.runtime, {
        organization_id: org,
        entity_id: id,
        operation: 'UPDATE',
        revision: 2,
        payload_version: 1,
        payload,
      });

      const current = await db.runtime.query('SELECT name,revision FROM departments WHERE id=$1', [
        id,
      ]);

      assert.equal(current.rows[0].name, 'Current Operations');
      assert.equal(current.rows[0].revision, 3);

      await assert.rejects(
        applyInTransaction(db.runtime, {
          organization_id: org,
          entity_id: id,
          operation: 'ARCHIVE',
          revision: 4,
          payload_version: 1,
          payload: {
            ...payload,
            revision: 4,
          },
        }),
        /Archived department must be inactive/,
      );

      const unchanged = await db.runtime.query(
        'SELECT name,status,revision FROM departments WHERE id=$1',
        [id],
      );

      assert.equal(unchanged.rows[0].name, 'Current Operations');
      assert.equal(unchanged.rows[0].status, 'active');
      assert.equal(unchanged.rows[0].revision, 3);
    } finally {
      await db.close();
    }
  },
);
