import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { applyOrganizationEvent } from '../src/sync/organization-inbox.js';

test(
  'organization inbox applies newer revisions and rejects conflicting replays',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();

    try {
      await migrate(db.migrator, db.migrations);

      const id = randomUUID();

      await db.runtime.query(
        `INSERT INTO organizations(id,legal_name,revision)
         VALUES($1,'Original Organization',1)`,
        [id],
      );

      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [id]);

      const original = await db.runtime.query(
        'SELECT created_at,updated_at,updated_by FROM organizations WHERE id=$1',
        [id],
      );

      const payload = {
        id,
        organizationId: id,
        revision: 2,
        legalName: 'Updated Organization',
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

      const event = {
        organization_id: id,
        entity_id: id,
        operation: 'UPDATE',
        revision: 2,
        payload_version: 1,
        payload,
      };

      const client = await db.runtime.connect();

      try {
        await client.query('BEGIN');

        await applyOrganizationEvent(client, event);
        await applyOrganizationEvent(client, event);

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const updated = await db.runtime.query(
        `SELECT legal_name,revision,created_at,updated_at,updated_by
         FROM organizations WHERE id=$1`,
        [id],
      );

      assert.equal(updated.rows[0].legal_name, 'Updated Organization');
      assert.equal(updated.rows[0].revision, 2);

      assert.deepEqual(
        [updated.rows[0].created_at, updated.rows[0].updated_at, updated.rows[0].updated_by],
        [original.rows[0].created_at, original.rows[0].updated_at, original.rows[0].updated_by],
      );

      const conflictClient = await db.runtime.connect();

      try {
        await conflictClient.query('BEGIN');

        await assert.rejects(
          applyOrganizationEvent(conflictClient, {
            ...event,
            payload: {
              ...payload,
              legalName: 'Conflicting Organization',
            },
          }),
          /revision conflict/,
        );

        await conflictClient.query('ROLLBACK');
      } finally {
        conflictClient.release();
      }

      const preserved = await db.runtime.query(
        'SELECT legal_name,revision FROM organizations WHERE id=$1',
        [id],
      );

      assert.equal(preserved.rows[0].legal_name, 'Updated Organization');
      assert.equal(preserved.rows[0].revision, 2);

      const outbox = await db.runtime.query('SELECT count(*)::int AS count FROM sync_outbox');

      assert.equal(outbox.rows[0].count, 0);
    } finally {
      await db.close();
    }
  },
);

test(
  'organization inbox ignores stale revisions and rejects foreign identities',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();

    try {
      await migrate(db.migrator, db.migrations);

      const org = randomUUID();
      const foreignOrg = randomUUID();

      await db.runtime.query(
        `INSERT INTO organizations(id,legal_name,revision)
         VALUES($1,'Current Organization',3)`,
        [org],
      );

      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);

      const payload = {
        id: org,
        organizationId: org,
        revision: 2,
        legalName: 'Outdated Organization',
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

      const event = {
        organization_id: org,
        entity_id: org,
        operation: 'UPDATE',
        revision: 2,
        payload_version: 1,
        payload,
      };

      const client = await db.runtime.connect();

      try {
        await client.query('BEGIN');

        await applyOrganizationEvent(client, event);

        await assert.rejects(
          applyOrganizationEvent(client, {
            ...event,
            organization_id: foreignOrg,
          }),
          /identity mismatch/,
        );

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const result = await db.runtime.query(
        'SELECT legal_name,revision FROM organizations WHERE id=$1',
        [org],
      );

      assert.equal(result.rows[0].legal_name, 'Current Organization');
      assert.equal(result.rows[0].revision, 3);
    } finally {
      await db.close();
    }
  },
);
