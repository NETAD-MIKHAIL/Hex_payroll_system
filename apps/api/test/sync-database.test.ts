import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { registerNode, pushEvents, pullChanges, authenticateNode } from '../src/sync/service.js';
import { createSyncRouter } from '../src/sync/router.js';
import { pushNextBatch, pullNextBatch, type SyncClientConfig } from '../src/sync/client.js';
import { tokenHash } from '../src/auth/service.js';

test(
  'sync delivery: isolation, idempotency, commit order, lost responses, inbox atomicity and revocation',
  { skip: !databaseTestsEnabled },
  async (t) => {
    const central = await databaseFixture(),
      local = await databaseFixture();
    let closeServer: (() => Promise<void>) | undefined;
    try {
      await migrate(central.migrator, central.migrations);
      await migrate(local.migrator, local.migrations);
      const org = randomUUID(),
        otherOrg = randomUUID();
      await central.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Transport test'),($2,'Other tenant')",
        [org, otherOrg],
      );
      await local.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Transport test')",
        [org],
      );
      const node = await registerNode(central.runtime, org, 'PC1'),
        other = await registerNode(central.runtime, otherOrg, 'Other PC');
      await local.runtime.query(
        'INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,$3,$4)',
        [node.nodeId, org, 'PC1', tokenHash(node.token)],
      );
      const event = {
        eventId: randomUUID(),
        entityType: 'departments',
        entityId: randomUUID(),
        operation: 'CREATE' as const,
        revision: 1,
        payloadVersion: 1 as const,
        payload: { name: 'Finance', code: 'FIN' },
      };
      await t.test('PUSH authenticates before validating payload', async () => {
        const before = (
          await central.runtime.query('SELECT count(*)::integer AS count FROM sync_changes')
        ).rows[0].count;

        await assert.rejects(
          pushEvents(central.runtime, '', {}),
          { code: 'NODE_INVALID', status: 401 },
        );

        await assert.rejects(
          pushEvents(central.runtime, 'a'.repeat(43), { events: [event] }),
          { code: 'NODE_INVALID', status: 401 },
        );

        await assert.rejects(
          pushEvents(central.runtime, node.token, {}),
          (error: unknown) => {
            assert.equal((error as { name?: string }).name, 'ZodError');
            return true;
          },
        );

        const after = (
          await central.runtime.query('SELECT count(*)::integer AS count FROM sync_changes')
        ).rows[0].count;

        assert.equal(after, before, 'Rejected PUSH requests must not create sync events');
      });

      await t.test('one-time secret is hashed and invalid credentials fail', async () => {
        const stored = (
          await central.runtime.query('SELECT token_hash FROM sync_nodes WHERE id=$1', [
            node.nodeId,
          ])
        ).rows[0].token_hash;
        assert.equal(stored, tokenHash(node.token));
        assert.notEqual(stored, node.token);
        await assert.rejects(authenticateNode(central.runtime, 'bad'));
      });
      await t.test(
        'retries return the original receipt; altered retry records a conflict',
        async () => {
          const first = await pushEvents(central.runtime, node.token, { events: [event] });
          assert.deepEqual(
            await pushEvents(central.runtime, node.token, { events: [event] }),
            first,
          );
          await assert.rejects(
            pushEvents(central.runtime, node.token, {
              events: [{ ...event, payload: { name: 'Changed' } }],
            }),
            { code: 'SYNC_EVENT_CONFLICT' },
          );
          assert.equal(
            (await central.runtime.query('SELECT count(*)::integer count FROM sync_conflicts'))
              .rows[0].count,
            1,
          );
          assert.equal(
            (await central.runtime.query('SELECT count(*)::integer count FROM sync_changes'))
              .rows[0].count,
            1,
          );
          assert.equal((await pullChanges(central.runtime, other.token, '0')).changes.length, 0);
          await assert.rejects(central.runtime.query('UPDATE sync_changes SET revision=2'), {
            code: '42501',
          });
          await assert.rejects(
            central.runtime.query(
              "INSERT INTO sync_changes(organization_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload) VALUES($1,$2,$3,'departments',$4,'CREATE',1,'{}')",
              [otherOrg, node.nodeId, randomUUID(), randomUUID()],
            ),
            { code: '23503' },
          );
        },
      );
      await t.test(
        'published sequence follows commit order even when identity values were reserved earlier',
        async () => {
          const a = await central.runtime.connect(),
            b = await central.runtime.connect();
          try {
            await a.query('BEGIN');
            await b.query('BEGIN');
            // Reserve B's identity first, then publish A. The trigger replaces the stale default.
            await b.query("SELECT nextval('sync_changes_sequence_seq')");
            const insert =
              "INSERT INTO sync_changes(organization_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload) VALUES($1,$2,$3,'departments',$4,'CREATE',1,'{}') RETURNING sequence::text";
            const first = (await a.query(insert, [org, node.nodeId, randomUUID(), randomUUID()]))
              .rows[0].sequence;
            const pending = b.query(insert, [otherOrg, other.nodeId, randomUUID(), randomUUID()]);
            await a.query('COMMIT');
            const second = (await pending).rows[0].sequence;
            await b.query('COMMIT');
            assert.ok(BigInt(second) > BigInt(first));
          } finally {
            await a.query('ROLLBACK');
            await b.query('ROLLBACK');
            a.release();
            b.release();
          }
        },
      );
      let loseResponse = true,
        invalidReceipt = false,
        invalidPull = false;
      const app = express();
      app.use(express.json({ limit: '1mb' }));
      app.post('/api/sync/push', async (req, res, next) => {
        if (invalidReceipt) {
          res.json({ receipts: [{ eventId: randomUUID(), sequence: '1' }] });
          return;
        }
        if (!loseResponse) {
          next();
          return;
        }
        loseResponse = false;
        await pushEvents(central.runtime, node.token, req.body);
        res.sendStatus(503);
      });
      app.get('/api/sync/pull', (_req, res, next) => {
        if (!invalidPull) {
          next();
          return;
        }
        res.json({ changes: [], nextSequence: '9223372036854775807' });
      });
      app.use('/api', createSyncRouter(central.runtime, true));
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      closeServer = () =>
        new Promise<void>((resolve, reject) => {
          server.close((e) => (e ? reject(e) : resolve()));
          server.closeAllConnections();
        });
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const config: SyncClientConfig = {
        url: `http://127.0.0.1:${address.port}`,
        nodeId: node.nodeId,
        token: node.token,
      };
      await t.test('HTTP PUSH authenticates before payload validation', async () => {
        const securityApp = express();
        securityApp.use(express.json({ limit: '1mb' }));
        securityApp.use('/api', createSyncRouter(central.runtime, true));

        const securityServer = securityApp.listen(0, '127.0.0.1');
        try {
          await once(securityServer, 'listening');
          const securityAddress = securityServer.address();
          assert.ok(securityAddress && typeof securityAddress !== 'string');
          const base = `http://127.0.0.1:${securityAddress.port}`;

          const before = (
            await central.runtime.query('SELECT count(*)::integer AS count FROM sync_changes')
          ).rows[0].count;

          const post = (token: string | undefined, body: unknown) =>
            fetch(base + '/api/sync/push', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify(body),
            });

          const missing = await post(undefined, {});
          assert.equal(missing.status, 401);
          assert.equal((await missing.json()).error.code, 'NODE_INVALID');

          const invalid = await post('a'.repeat(43), { events: [event] });
          assert.equal(invalid.status, 401);
          assert.equal((await invalid.json()).error.code, 'NODE_INVALID');

          const malformed = await post(node.token, {});
          assert.equal(malformed.status, 400);
          assert.equal((await malformed.json()).error.code, 'INVALID_REQUEST');

          const unauthenticatedPull = await fetch(base + '/api/sync/pull?after=0');
          assert.equal(unauthenticatedPull.status, 401);
          assert.equal((await unauthenticatedPull.json()).error.code, 'NODE_INVALID');

          const authenticatedPull = await fetch(base + '/api/sync/pull?after=0', {
            headers: { Authorization: `Bearer ${node.token}` },
          });
          assert.equal(authenticatedPull.status, 200);

          const after = (
            await central.runtime.query('SELECT count(*)::integer AS count FROM sync_changes')
          ).rows[0].count;
          assert.equal(after, before, 'Rejected HTTP requests must not create sync events');
        } finally {
          await new Promise<void>((resolve, reject) => {
            securityServer.close((error) => error ? reject(error) : resolve());
            securityServer.closeAllConnections();
          });
        }
      });
      const queued = randomUUID();
      await local.runtime.query(
        "INSERT INTO sync_outbox(id,organization_id,entity_type,entity_id,operation,revision,payload) VALUES($1,$2,'departments',$3,'CREATE',1,$4)",
        [queued, org, randomUUID(), JSON.stringify({ code: 'HR', name: 'Human Resources' })],
      );
      await t.test('invalid acknowledgments cannot mark the outbox delivered', async () => {
        invalidReceipt = true;
        await assert.rejects(pushNextBatch(local.runtime, config));
        invalidReceipt = false;
        assert.equal(
          (await local.runtime.query('SELECT status FROM sync_outbox WHERE id=$1', [queued]))
            .rows[0].status,
          'pending',
        );
        await local.runtime.query('UPDATE sync_outbox SET next_attempt_at=NULL WHERE id=$1', [
          queued,
        ]);
      });
      await t.test(
        'node management requires an organization administrator and never lists secrets',
        async () => {
          const users = [randomUUID(), randomUUID()],
            tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
          for (let i = 0; i < 2; i++) {
            await central.runtime.query(
              'INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,$3,$3,$4)',
              [users[i], org, 'sync-user-' + i, 'unused-test-hash'],
            );
            await central.runtime.query(
              "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
              [tokenHash(tokens[i]!), users[i]],
            );
          }
          await central.runtime.query(
            "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
            [users[0]],
          );
          const post = (token: string, body: unknown) =>
            fetch(config.url + '/api/sync/nodes', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          assert.equal(
            (await post(tokens[1]!, { deviceName: 'Denied', organizationId: org })).status,
            403,
          );
          assert.equal(
            (await post(tokens[0]!, { deviceName: 'Mismatch', organizationId: otherOrg })).status,
            409,
          );
          const created = await post(tokens[0]!, { deviceName: 'PC2', organizationId: org });
          assert.equal(created.status, 201);
          const registration = (await created.json()) as { nodeId: string; token: string };
          const listed = await fetch(config.url + '/api/sync/nodes', {
            headers: { Authorization: `Bearer ${tokens[0]}` },
          });
          const text = await listed.text();
          assert.ok(!text.includes(registration.token) && !text.includes('token_hash'));
          const revoked = await fetch(
            config.url + `/api/sync/nodes/${registration.nodeId}/revoke`,
            { method: 'POST', headers: { Authorization: `Bearer ${tokens[0]}` } },
          );
          assert.equal(revoked.status, 200);
          await assert.rejects(authenticateNode(central.runtime, registration.token));
          const malformed = await fetch(config.url + '/api/sync/pull?after=1.1', {
            headers: { Authorization: `Bearer ${node.token}` },
          });
          assert.equal(malformed.status, 400);
        },
      );
      await t.test(
        'lost response retries once and only a verified receipt marks delivery',
        async () => {
          await assert.rejects(pushNextBatch(local.runtime, config));
          assert.equal(
            (await local.runtime.query('SELECT status FROM sync_outbox WHERE id=$1', [queued]))
              .rows[0].status,
            'pending',
          );
          await local.runtime.query('UPDATE sync_outbox SET next_attempt_at=NULL WHERE id=$1', [
            queued,
          ]);
          assert.equal(await pushNextBatch(local.runtime, config), true);
          assert.equal(
            (await local.runtime.query('SELECT status FROM sync_outbox WHERE id=$1', [queued]))
              .rows[0].status,
            'synced',
          );
          assert.equal(
            (
              await central.runtime.query(
                'SELECT count(*)::integer count FROM sync_changes WHERE source_event_id=$1',
                [queued],
              )
            ).rows[0].count,
            1,
          );
        },
      );
      await t.test(
        'pull stores durable inbox and cursor atomically, with no business writes',
        async () => {
          await local.migrator.query(
            'ALTER TABLE sync_inbox ADD CONSTRAINT test_reject_receipt CHECK(false)',
          );
          await assert.rejects(pullNextBatch(local.runtime, config));
          assert.equal(
            (
              await local.runtime.query(
                'SELECT last_pull_sequence::text FROM sync_nodes WHERE id=$1',
                [node.nodeId],
              )
            ).rows[0].last_pull_sequence,
            '0',
          );
          await local.migrator.query('ALTER TABLE sync_inbox DROP CONSTRAINT test_reject_receipt');
          assert.equal(await pullNextBatch(local.runtime, config), true);
          assert.equal(await pullNextBatch(local.runtime, config), false);
          assert.equal(
            (await local.runtime.query('SELECT count(*)::integer count FROM sync_inbox')).rows[0]
              .count,
            3,
          );
          assert.equal(
            (await local.runtime.query('SELECT count(*)::integer count FROM departments')).rows[0]
              .count,
            0,
          );
          invalidPull = true;
          await assert.rejects(pullNextBatch(local.runtime, config));
          invalidPull = false;
        },
      );
      await t.test(
        'expired processing leases recover and revocation blocks transport',
        async () => {
          const id = randomUUID();
          await local.runtime.query(
            "INSERT INTO sync_outbox(id,organization_id,entity_type,entity_id,operation,revision,payload,status,lease_token,lease_expires_at) VALUES($1,$2,'departments',$3,'CREATE',1,'{}','processing',$4,now()-interval '1 second')",
            [id, org, randomUUID(), randomUUID()],
          );
          assert.equal(await pushNextBatch(local.runtime, config), true);
          await central.runtime.query(
            'UPDATE sync_nodes SET enabled=false,revoked_at=now() WHERE id=$1',
            [node.nodeId],
          );
          await assert.rejects(pullChanges(central.runtime, node.token, '0'), {
            code: 'NODE_INVALID',
          });
          const disabled = express();
          disabled.use('/api', createSyncRouter(central.runtime, false));
          const d = disabled.listen(0, '127.0.0.1');
          await once(d, 'listening');
          try {
            const a = d.address();
            assert.ok(a && typeof a !== 'string');
            assert.equal((await fetch(`http://127.0.0.1:${a.port}/api/sync/pull`)).status, 404);
          } finally {
            await new Promise<void>((resolve) => {
              d.close(() => resolve());
              d.closeAllConnections();
            });
          }
        },
      );
    } finally {
      await closeServer?.();
      await local.close();
      await central.close();
    }
  },
);
