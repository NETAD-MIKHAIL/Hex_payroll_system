import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { pushEvents, pullChanges, registerNode } from '../src/sync/service.js';

test(
  'node sync rejects identity administration atomically and quarantines historical claims',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const org = randomUUID();
      await db.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Security test')",
        [org],
      );
      const node = await registerNode(db.runtime, org, 'Untrusted PC');
      const event = {
        eventId: randomUUID(),
        entityType: 'departments',
        entityId: randomUUID(),
        operation: 'CREATE' as const,
        revision: 1,
        payloadVersion: 1 as const,
        payload: { name: 'Evidence' },
      };
      for (const entityType of [
        'auth_users',
        'auth_sessions',
        'roles',
        'permissions',
        'user_roles',
        'role_permissions',
        'sync_nodes',
        'application_setup',
        'central_evidence_authorizations',
        'work_schedules',
        'work_schedule_versions',
        'work_schedule_days',
        'employee_schedule_assignments',
        'schedule_assignment_history',
        'leave_types',
        'leave_requests',
      ]) {
        for (const operation of ['CREATE', 'UPDATE', 'ARCHIVE'] as const) {
          await assert.rejects(
            pushEvents(db.runtime, node.token, {
              events: [
                event,
                {
                  ...event,
                  eventId: randomUUID(),
                  entityType,
                  operation,
                  payload: { roles: ['administrator'], passwordHash: 'replacement', active: true },
                },
              ],
            }),
            { code: 'SYNC_CENTRAL_AUTHORITY_REQUIRED' },
          );
        }
      }
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM sync_changes')).rows[0].n,
        0,
      );
      assert.equal(
        (await db.runtime.query('SELECT last_seen_at FROM sync_nodes WHERE id=$1', [node.nodeId]))
          .rows[0].last_seen_at,
        null,
      );
      // Simulate an account snapshot accepted by the previous transport version.
      await db.runtime.query(
        `INSERT INTO sync_changes(organization_id,source_node_id,source_event_id,
        entity_type,entity_id,operation,revision,payload_version,payload)
        VALUES($1,$2,$3,'auth_users',$4,'UPDATE',999,1,'{"roles":["administrator"]}')`,
        [org, node.nodeId, randomUUID(), randomUUID()],
      );
      assert.equal((await pullChanges(db.runtime, node.token, '0')).changes.length, 0);
      const receipt = await pushEvents(db.runtime, node.token, { events: [event] });
      assert.deepEqual(await pushEvents(db.runtime, node.token, { events: [event] }), receipt);
      const pulled = await pullChanges(db.runtime, node.token, '0');
      assert.equal(pulled.changes.length, 1);
      assert.equal(pulled.changes[0].entityType, 'departments');
      assert.equal(pulled.nextSequence, receipt.receipts[0]!.sequence);
    } finally {
      await db.close();
    }
  },
);
