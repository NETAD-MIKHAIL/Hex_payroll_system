import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { conflictDetailsSchema, conflictListResponseSchema } from '@hexpayroll/shared';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { getActor, transaction } from '../src/foundation/repository.js';
import { tokenHash } from '../src/auth/service.js';
import { enqueueOutbox } from '../src/sync/outbox.js';
import { pushNextBatch } from '../src/sync/delivery.js';
import {
  persistConflict,
  resolveConflict,
  conflictDetails,
  listConflicts,
} from '../src/sync/conflicts.js';
import { createSyncRouter } from '../src/sync/router.js';
import { createFoundationRouter } from '../src/foundation/router.js';
import { updateFoundationRecord } from '../src/foundation/mutations.js';

test(
  '0034 preserves legacy ignored conflicts and removes credential evidence',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(
        db.migrator,
        db.migrations.filter((m) => m.name < '0034'),
      );
      const org = (
        await db.runtime.query(
          "INSERT INTO organizations(legal_name) VALUES('Legacy conflicts') RETURNING id",
        )
      ).rows[0].id;
      const node = (
        await db.runtime.query(
          "INSERT INTO sync_nodes(organization_id,device_name) VALUES($1,'Legacy') RETURNING id",
          [org],
        )
      ).rows[0].id;
      const id = (
        await db.runtime.query(
          "INSERT INTO sync_conflicts(organization_id,node_id,source_event_id,entity_type,entity_id,incoming_revision,incoming_payload,reason,status,resolved_at) VALUES($1,$2,$3,'auth_users',$4,1,$5,'Identity reused','ignored',now()) RETURNING id",
          [
            org,
            node,
            randomUUID(),
            randomUUID(),
            JSON.stringify({ username: 'legacy', passwordHash: 'private-verifier' }),
          ],
        )
      ).rows[0].id;
      await migrate(db.migrator, db.migrations);
      const row = (await db.runtime.query('SELECT * FROM sync_conflicts WHERE id=$1', [id]))
        .rows[0];
      assert.equal(row.status, 'dismissed');
      assert.equal(row.conflict_type, 'EVENT_IDENTITY');
      assert.equal(row.incoming_payload.passwordHash, undefined);
      assert.equal(row.incoming_payload.username, 'legacy');
      await assert.rejects(
        db.runtime.query("UPDATE sync_conflicts SET incoming_payload='{}' WHERE id=$1", [id]),
        /immutable/,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  'Phase 4.2 database: durable conflicts, domain resolution, permissions and worker integration',
  { skip: !databaseTestsEnabled },
  async (t) => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      const org = (
        await db.runtime.query(
          "INSERT INTO organizations(legal_name) VALUES('Conflict test') RETURNING id",
        )
      ).rows[0].id as string;
      const otherOrg = (
        await db.runtime.query("INSERT INTO organizations(legal_name) VALUES('Other') RETURNING id")
      ).rows[0].id as string;
      const user = (
        await db.runtime.query(
          "INSERT INTO auth_users(organization_id,username,display_name,password_hash) VALUES($1,'conflict-admin','Admin','test-only') RETURNING id",
          [org],
        )
      ).rows[0].id as string;
      await db.runtime.query(
        "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
        [user],
      );
      const actor = await getActor(db.runtime, user);
      const token = randomBytes(32).toString('base64url');
      const node = (
        await db.runtime.query(
          "INSERT INTO sync_nodes(organization_id,device_name,token_hash) VALUES($1,'Device A',$2) RETURNING id",
          [org, tokenHash(token)],
        )
      ).rows[0].id as string;
      await db.runtime.query('INSERT INTO sync_local_identity VALUES($1,$2)', [org, node]);
      const config = { nodeId: node, token, url: 'http://unused.invalid' };
      const department = (
        await db.runtime.query(
          "INSERT INTO departments(organization_id,code,name,description,updated_by) VALUES($1,'D1','Current','Preserve unselected description',$2) RETURNING *",
          [org, user],
        )
      ).rows[0];
      const store = async (
        authority: 'local' | 'remote' = 'local',
        category: 'STALE_REVISION' | 'PAYROLL_CONFLICT' = 'STALE_REVISION',
      ) =>
        transaction(db.runtime, (c) =>
          persistConflict(c, {
            organizationId: org,
            nodeId: node,
            eventId: randomUUID(),
            entityType: category === 'PAYROLL_CONFLICT' ? 'payroll_runs' : 'departments',
            entityId: department.id,
            incomingRevision: 2,
            currentRevision: 1,
            baseRevision: 0,
            incoming: { name: 'Local', passwordHash: 'secret', grossPay: 200 },
            current: { name: 'Current', revision: 1, grossPay: 100 },
            conflictType: category,
            reason: 'Revision conflict',
            authority,
          }),
        );
      const request = (resolution: string, extra: Record<string, unknown> = {}) => ({
        requestId: randomUUID(),
        resolution,
        reason: 'Reviewed evidence',
        expectedVersion: 1,
        ...extra,
      });
      await t.test(
        'persistence deduplicates responses, removes secrets and enforces organization isolation',
        async () => {
          const id = await store();
          const d = conflictDetailsSchema.parse(await conflictDetails(db.runtime, actor, id));
          assert.equal(d.version, 1);
          assert.equal(JSON.stringify(d).includes('secret'), false);
          assert.equal(d.id[14], '7');
          const restricted = await conflictDetails(
            db.runtime,
            {
              ...actor,
              permissions: actor.permissions.filter((p) => p !== 'employees.sensitive.view'),
            },
            id,
          );
          assert.equal(JSON.stringify(restricted).includes('grossPay'), false);
          const accountConflict = await transaction(db.runtime, (c) =>
            persistConflict(c, {
              organizationId: org,
              nodeId: node,
              eventId: randomUUID(),
              entityType: 'auth_users',
              entityId: user,
              incomingRevision: 2,
              currentRevision: 1,
              baseRevision: 1,
              incoming: { email: 'private@example.test' },
              current: null,
              conflictType: 'EVENT_IDENTITY',
              reason: 'Identity conflict',
            }),
          );
          const noUsersView = await conflictDetails(
            db.runtime,
            { ...actor, permissions: actor.permissions.filter((p) => p !== 'users.view') },
            accountConflict,
          );
          assert.deepEqual(noUsersView.localPayload, {});
          await assert.rejects(
            conflictDetails(db.runtime, { ...actor, organizationId: otherOrg }, id),
            /not found/,
          );
          const list = conflictListResponseSchema.parse(
            await listConflicts(db.runtime, actor, { status: 'open', device: node }),
          );
          assert.ok(list.items.some((c) => c.id === id));
          await assert.rejects(
            listConflicts(db.runtime, { ...actor, permissions: [] }, {}),
            /Permission required/,
          );
          await assert.rejects(
            db.runtime.query('DELETE FROM sync_conflicts WHERE id=$1', [id]),
            /permission denied/,
          );
        },
      );
      await t.test(
        'local manual merge increments the entity revision, audits and publishes atomically',
        async () => {
          const id = await store();
          const req = request('manual_merge', { expectedRevision: 1, fields: { name: 'Merged' } });
          const result = await resolveConflict(db.runtime, actor, id, req);
          assert.equal(result.state, 'confirmed');
          assert.equal(result.resultingRevision, 2);
          assert.equal(
            (
              await db.runtime.query('SELECT description FROM departments WHERE id=$1', [
                department.id,
              ])
            ).rows[0].description,
            'Preserve unselected description',
          );
          assert.equal(
            (
              await db.runtime.query('SELECT name,revision FROM departments WHERE id=$1', [
                department.id,
              ])
            ).rows[0].name,
            'Merged',
          );
          assert.equal(
            (
              await db.runtime.query('SELECT count(*)::int n FROM sync_outbox WHERE entity_id=$1', [
                department.id,
              ])
            ).rows[0].n,
            1,
          );
          assert.deepEqual(await resolveConflict(db.runtime, actor, id, req), {
            id,
            state: 'confirmed',
          });
          await assert.rejects(
            resolveConflict(db.runtime, actor, id, request('reject_mutation')),
            /changed|unavailable/,
          );
          const history = (await conflictDetails(db.runtime, actor, id)).history;
          assert.equal(history.length, 1);
          await assert.rejects(
            db.runtime.query(
              'UPDATE sync_conflict_resolutions SET reason=$1 WHERE conflict_id=$2',
              ['overwrite', id],
            ),
            /permission denied/,
          );
        },
      );
      await t.test(
        'stale reapply rolls back; valid reapply uses current revision and validated fields',
        async () => {
          const id = await store();
          await assert.rejects(
            resolveConflict(
              db.runtime,
              actor,
              id,
              request('reapply_local', { expectedRevision: 1 }),
            ),
            /changed/,
          );
          assert.equal((await conflictDetails(db.runtime, actor, id)).status, 'open');
          const refreshed = await conflictDetails(db.runtime, actor, id);
          assert.equal(refreshed.latestRevision, 2);
          assert.equal(refreshed.remoteRevision, 1);
          const r = await resolveConflict(
            db.runtime,
            actor,
            id,
            request('reapply_local', { expectedRevision: 2 }),
          );
          assert.equal(r.resultingRevision, 3);
        },
      );
      await t.test(
        'atomic compare-and-swap accepts one concurrent writer and publishes once',
        async () => {
          const id = (
            await db.runtime.query(
              "INSERT INTO departments(organization_id,code,name) VALUES($1,'CAS','Initial') RETURNING id",
              [org],
            )
          ).rows[0].id;
          const result = await Promise.allSettled(
            ['A', 'B'].map((name) =>
              transaction(db.runtime, (c) =>
                updateFoundationRecord(c, actor, 'departments', id, 1, { name }),
              ),
            ),
          );
          assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
          assert.equal(
            (await db.runtime.query('SELECT revision FROM departments WHERE id=$1', [id])).rows[0]
              .revision,
            2,
          );
          assert.equal(
            (
              await db.runtime.query('SELECT count(*)::int n FROM sync_outbox WHERE entity_id=$1', [
                id,
              ])
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'accept authoritative, rejection, escalation and competing administrators preserve history',
        async () => {
          for (const resolution of ['accept_authoritative', 'reject_mutation', 'escalate']) {
            const id = await store();
            await resolveConflict(db.runtime, actor, id, request(resolution));
            assert.equal(
              (await conflictDetails(db.runtime, actor, id)).status,
              resolution === 'escalate'
                ? 'under_review'
                : resolution === 'reject_mutation'
                  ? 'dismissed'
                  : 'resolved',
            );
          }
          const id = await store();
          const results = await Promise.allSettled([
            resolveConflict(db.runtime, actor, id, request('reject_mutation')),
            resolveConflict(db.runtime, actor, id, request('accept_authoritative')),
          ]);
          assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
          assert.equal((await conflictDetails(db.runtime, actor, id)).history.length, 1);
        },
      );
      await t.test(
        'remote requests remain pending and finalized payroll cannot close',
        async () => {
          const id = await store('remote');
          const result = await resolveConflict(
            db.runtime,
            actor,
            id,
            request('accept_authoritative'),
          );
          assert.equal(result.state, 'pending');
          assert.equal((await conflictDetails(db.runtime, actor, id)).status, 'under_review');
          await assert.rejects(
            resolveConflict(
              db.runtime,
              actor,
              id,
              request('reject_mutation', { expectedVersion: 2 }),
            ),
            /unavailable/,
          );
          const payroll = await store('remote', 'PAYROLL_CONFLICT');
          assert.deepEqual((await conflictDetails(db.runtime, actor, payroll)).allowedActions, [
            'escalate',
          ]);
          await assert.rejects(
            resolveConflict(db.runtime, actor, payroll, request('accept_authoritative')),
            /unavailable/,
          );
          await resolveConflict(db.runtime, actor, payroll, request('escalate'));
        },
      );
      await t.test(
        'structured outcomes persist and link once, skip independent events and block dependents across restart',
        async () => {
          await db.runtime.query(
            "UPDATE sync_outbox SET status='synced' WHERE organization_id=$1",
            [org],
          );
          const enqueue = async (
            id: string,
            code: string,
            entityType = 'departments',
            payload: Record<string, unknown> = {},
          ) =>
            transaction(db.runtime, (c) =>
              enqueueOutbox(c, {
                organizationId: org,
                entityType,
                entityId: id,
                operation: 'CREATE',
                revision: 1,
                payload: { id, code, name: code, ...payload },
                actorId: user,
              }),
            );
          const conflicted = randomUUID(),
            independent = randomUUID();
          await enqueue(conflicted, 'C');
          await enqueue(independent, 'I');
          await pushNextBatch(db.runtime, config, {
            transport: {
              push: async (events) => ({
                outcomes: events.map((e, i) =>
                  i === 0
                    ? {
                        eventId: e.eventId,
                        outcome: 'conflict',
                        conflictType: 'DUPLICATE_CREATE',
                        currentRevision: 1,
                        snapshot: { code: 'C', passwordHash: 'secret' },
                        reason: 'Duplicate',
                      }
                    : { eventId: e.eventId, outcome: 'accepted', sequence: String(i + 1) },
                ),
              }),
            },
          });
          const rows = (
            await db.runtime.query(
              'SELECT * FROM sync_outbox WHERE entity_id=ANY($1::uuid[]) ORDER BY publication_sequence',
              [[conflicted, independent]],
            )
          ).rows;
          assert.deepEqual(
            rows.map((r) => r.status),
            ['conflicted', 'synced'],
          );
          const conflict = (
            await db.runtime.query('SELECT * FROM sync_conflicts WHERE local_event_id=$1', [
              rows[0].id,
            ])
          ).rows[0];
          assert.equal(conflict.node_id, node);
          assert.equal(conflict.current_payload.passwordHash, undefined);
          await transaction(db.runtime, (c) =>
            persistConflict(c, {
              organizationId: org,
              nodeId: node,
              eventId: rows[0].id,
              localEventId: rows[0].id,
              entityType: 'departments',
              entityId: conflicted,
              incomingRevision: 1,
              currentRevision: 1,
              baseRevision: 0,
              incoming: { code: 'C' },
              current: { code: 'C' },
              conflictType: 'DUPLICATE_CREATE',
              reason: 'Duplicate',
            }),
          );
          assert.equal(
            (
              await db.runtime.query(
                'SELECT count(*)::int n FROM sync_conflicts WHERE local_event_id=$1',
                [rows[0].id],
              )
            ).rows[0].n,
            1,
          );
          const position = randomUUID(),
            later = randomUUID();
          await enqueue(position, 'P', 'positions', { departmentId: conflicted });
          await enqueue(later, 'L');
          const sent: string[] = [];
          await pushNextBatch(db.runtime, config, {
            transport: {
              push: async (events) => {
                sent.push(...events.map((e) => e.entityId));
                return {
                  receipts: events.map((e, i) => ({
                    eventId: e.eventId,
                    sequence: String(i + 10),
                  })),
                };
              },
            },
          });
          assert.deepEqual(sent, [later]);
          assert.equal(
            await pushNextBatch(db.runtime, config, {
              transport: {
                push: async () => {
                  throw new Error('Blocked events were sent');
                },
              },
            }),
            false,
          );
          assert.equal(
            (
              await db.runtime.query('SELECT attempt_count FROM sync_outbox WHERE entity_id=$1', [
                conflicted,
              ])
            ).rows[0].attempt_count,
            1,
          );
          // Requesting authoritative acceptance must not mark the event delivered.
          await resolveConflict(db.runtime, actor, conflict.id, request('accept_authoritative'));
          assert.equal(
            (await db.runtime.query('SELECT status FROM sync_outbox WHERE id=$1', [rows[0].id]))
              .rows[0].status,
            'conflicted',
          );
        },
      );
      await t.test(
        'malformed structured outcomes and stale leases cannot partially acknowledge a batch',
        async () => {
          const otherToken = randomBytes(32).toString('base64url');
          const otherNode = (
            await db.runtime.query(
              "INSERT INTO sync_nodes(organization_id,device_name,token_hash) VALUES($1,'Other',$2) RETURNING id",
              [otherOrg, tokenHash(otherToken)],
            )
          ).rows[0].id;
          const otherConfig = {
            nodeId: otherNode,
            token: otherToken,
            url: 'http://unused.invalid',
          };
          for (const code of ['A', 'B'])
            await transaction(db.runtime, (c) =>
              enqueueOutbox(c, {
                organizationId: otherOrg,
                entityType: 'departments',
                entityId: randomUUID(),
                operation: 'CREATE',
                revision: 1,
                payload: { code },
              }),
            );
          await assert.rejects(
            pushNextBatch(db.runtime, otherConfig, {
              transport: {
                push: async (events) => ({
                  outcomes: [{ eventId: events[0]!.eventId, outcome: 'accepted', sequence: '1' }],
                }),
              },
            }),
            /outcomes/,
          );
          assert.ok(
            (
              await db.runtime.query('SELECT status FROM sync_outbox WHERE organization_id=$1', [
                otherOrg,
              ])
            ).rows.every((r) => r.status === 'pending'),
          );
          assert.equal(
            (
              await db.runtime.query(
                'SELECT count(*)::int n FROM sync_conflicts WHERE organization_id=$1',
                [otherOrg],
              )
            ).rows[0].n,
            0,
          );
          await db.runtime.query(
            'UPDATE sync_outbox SET next_attempt_at=NULL WHERE organization_id=$1',
            [otherOrg],
          );
          await assert.rejects(
            pushNextBatch(db.runtime, otherConfig, {
              transport: {
                push: async (events) => ({
                  outcomes: events.map((e) => ({
                    eventId: e.eventId,
                    outcome: 'conflict',
                    conflictType: 'STALE_REVISION',
                    currentRevision: 1,
                    snapshot: { organizationId: org },
                    reason: 'Stale',
                  })),
                }),
              },
            }),
            /organization/,
          );
          await db.runtime.query(
            'UPDATE sync_outbox SET next_attempt_at=NULL WHERE organization_id=$1',
            [otherOrg],
          );
          await assert.rejects(
            pushNextBatch(db.runtime, otherConfig, {
              transport: {
                push: async (events) => {
                  await db.runtime.query('UPDATE sync_outbox SET lease_token=$1 WHERE id=$2', [
                    randomUUID(),
                    events[1]!.eventId,
                  ]);
                  return {
                    outcomes: events.map((e, i) => ({
                      eventId: e.eventId,
                      outcome: 'accepted',
                      sequence: String(i + 1),
                    })),
                  };
                },
              },
            }),
            /lease/,
          );
          assert.ok(
            (
              await db.runtime.query(
                'SELECT central_sequence FROM sync_outbox WHERE organization_id=$1',
                [otherOrg],
              )
            ).rows.every((r) => r.central_sequence === null),
          );
        },
      );
      await t.test(
        'API rejects blind closure, enforces permissions and captures deduplicated local stale edits',
        async () => {
          const sessionToken = randomBytes(32).toString('base64url');
          await db.runtime.query(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
            [tokenHash(sessionToken), user],
          );
          const app = express();
          app.use(express.json());
          app.use('/api', createSyncRouter(db.runtime, false));
          app.use('/api', createFoundationRouter(db.runtime));
          const server = app.listen(0, '127.0.0.1');
          await once(server, 'listening');
          try {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            const base = `http://127.0.0.1:${address.port}/api/`;
            const headers = {
              authorization: `Bearer ${sessionToken}`,
              'content-type': 'application/json',
            };
            assert.equal((await fetch(base + 'sync/conflicts')).status, 401);
            const id = await store();
            assert.equal(
              (
                await fetch(base + `sync/conflicts/${id}/resolve`, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({ status: 'resolved' }),
                })
              ).status,
              400,
            );
            const body = {
              expectedRevision: 1,
              code: 'D1',
              name: 'Stale',
              description: null,
              status: 'active',
            };
            for (let i = 0; i < 2; i++)
              assert.equal(
                (
                  await fetch(base + `departments/${department.id}`, {
                    method: 'PUT',
                    headers,
                    body: JSON.stringify(body),
                  })
                ).status,
                409,
              );
            const stored = await db.runtime.query(
              "SELECT * FROM sync_conflicts WHERE entity_id=$1 AND reason='Local mutation rejected by revision or domain validation'",
              [department.id],
            );
            assert.equal(stored.rowCount, 1);
            assert.equal(stored.rows[0].authority, 'local');
            await db.runtime.query('DELETE FROM user_roles WHERE user_id=$1', [user]);
            assert.equal((await fetch(base + 'sync/conflicts', { headers })).status, 403);
            await assert.rejects(
              resolveConflict(db.runtime, actor, id, request('reject_mutation')),
              /Permission required/,
            );
          } finally {
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            });
          }
        },
      );
    } finally {
      await db.close();
    }
  },
);
