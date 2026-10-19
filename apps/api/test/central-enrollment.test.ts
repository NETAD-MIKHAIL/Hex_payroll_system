import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { enrollCentralNode, revokeCentralNode } from '../src/sync/administration.js';
import {
  importLocalNode,
  importedNodeEnvironment,
  centralEndpointSchema,
} from '../src/sync/import-node.js';
import { startLocalAttendanceWorker } from '../src/sync/worker-mode.js';
import { bootstrapCentral } from '../src/bootstrap/central.js';
import { tokenHash } from '../src/auth/service.js';
import { pushNextBatch, pullNextBatch } from '../src/sync/client.js';
import { createSyncRouter } from '../src/sync/router.js';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';

test('central mode never starts attendance processing, local and disabled modes do', async () => {
  let starts = 0,
    stops = 0;
  const start = () => {
    starts++;
    return async () => {
      stops++;
    };
  };
  await startLocalAttendanceWorker('central', start)();
  assert.equal(starts, 0);
  for (const mode of ['local', 'disabled'] as const)
    await startLocalAttendanceWorker(mode, start)();
  assert.equal(starts, 2);
  assert.equal(stops, 2);
});

test('credential environment import keeps transport disabled and validates the endpoint', () => {
  const credential = {
    nodeId: randomUUID(),
    organizationId: randomUUID(),
    deviceName: 'PC1',
    token: 'a'.repeat(43),
  };
  const result = importedNodeEnvironment(
    'DATABASE_URL=preserved\nSYNC_MODE=local\nexport SYNC_ADMIN_TOKEN = old\nSYNC_NODE_TOKEN=old\n',
    credential,
    'https://central.example.com',
  );
  assert.ok(result.includes('DATABASE_URL=preserved'));
  assert.equal((result.match(/SYNC_MODE=/g) ?? []).length, 1);
  assert.ok(result.includes('SYNC_MODE=disabled'));
  assert.ok(!result.includes('SYNC_ADMIN_TOKEN'));
  assert.ok(!result.includes('SYNC_NODE_TOKEN'));
  assert.ok(!result.includes(credential.token));
  for (const url of [
    'http://central.example.com',
    'https://user:secret@central.example.com',
    'https://central.example.com?token=x',
    'https://central.example.com#fragment',
    'https://central.example.com\n',
  ])
    assert.equal(centralEndpointSchema.safeParse(url).success, false);
});

test(
  'privileged canonical enrollment supports PC1 push to restricted central and PC2 inbox, then revocation',
  { skip: !databaseTestsEnabled },
  async () => {
    const central = await databaseFixture();
    const pc1 = await databaseFixture();
    const pc2 = await databaseFixture();
    let management: pg.Pool | undefined;
    let server: ReturnType<express.Express['listen']> | undefined;
    try {
      for (const fixture of [central, pc1, pc2])
        await migrate(fixture.migrator, fixture.migrations);
      const organizationId = '01a10b0c-6aae-7913-90b9-479f8e0a3bca';
      await assert.rejects(
        enrollCentralNode(central.migrator, { organizationId, deviceName: 'Before setup' }),
        /incomplete/,
      );
      await bootstrapCentral(central.migrator, {
        organization: { id: organizationId, legalName: 'Enrollment test' },
        administrator: {
          username: 'centraladmin',
          displayName: 'Central admin',
          password: 'disposable-test-password-123',
        },
      });
      if (process.env.TEST_BOOTSTRAP_DATABASE_URL) {
        const url = new URL(process.env.TEST_BOOTSTRAP_DATABASE_URL);
        assert.match(url.pathname.slice(1), /^hexpayroll_auth_test_[a-z0-9_]+$/);
        assert.equal(url.username, 'hexpayroll_bootstrap');
        const schema = (await central.migrator.query('SELECT current_schema() AS name')).rows[0]
          .name;
        assert.match(schema, /^hexpayroll_phase1_test_[a-f0-9]+$/);
        await central.migrator.query(`GRANT USAGE ON SCHEMA ${schema} TO hexpayroll_bootstrap`);
        await central.migrator.query('GRANT SELECT ON application_setup TO hexpayroll_bootstrap');
        await central.migrator.query(
          'GRANT SELECT,INSERT,UPDATE ON sync_nodes TO hexpayroll_bootstrap',
        );
        management = new pg.Pool({
          connectionString: url.toString(),
          options: `-c search_path=${schema}`,
        });
        await assert.rejects(management.query('SELECT * FROM auth_users'), { code: '42501' });
      }
      const adminDatabase = management ?? central.migrator;
      await assert.rejects(
        enrollCentralNode(central.runtime, { organizationId, deviceName: 'Denied' }),
        /separate enrollment/,
      );
      await assert.rejects(
        enrollCentralNode(adminDatabase, {
          organizationId: randomUUID(),
          deviceName: 'Wrong organization',
        }),
        /does not match/,
      );
      const first = await enrollCentralNode(adminDatabase, { organizationId, deviceName: 'PC1' });
      const second = await enrollCentralNode(adminDatabase, { organizationId, deviceName: 'PC2' });
      const stored = (
        await central.migrator.query('SELECT token_hash FROM sync_nodes WHERE id=$1', [
          first.nodeId,
        ])
      ).rows[0].token_hash;
      assert.equal(stored, tokenHash(first.token));
      assert.notEqual(stored, first.token);
      for (const fixture of [pc1, pc2]) {
        await fixture.migrator.query(
          "INSERT INTO organizations(id,legal_name) VALUES($1,'Local transport test')",
          [organizationId],
        );
        await fixture.migrator.query(
          'UPDATE application_setup SET organization_id=$1 WHERE singleton',
          [organizationId],
        );
      }
      await assert.rejects(
        importLocalNode(pc1.runtime, { ...first, organizationId: randomUUID() }),
        /does not match/,
      );
      await importLocalNode(pc1.runtime, first);
      await importLocalNode(pc1.runtime, first); // Retry after environment-file delivery failure.
      await importLocalNode(pc1.runtime, { ...first, token: 'a'.repeat(43) });
      await importLocalNode(pc1.runtime, first); // Secure import supports credential rotation.
      await assert.rejects(importLocalNode(pc1.runtime, second), /active node/);
      await importLocalNode(pc2.runtime, second);
      assert.equal(
        (await pc1.runtime.query('SELECT count(*)::int AS count FROM sync_nodes')).rows[0].count,
        1,
      );
      // Central application requires domain DML while DDL remains forbidden.
      await assert.rejects(central.runtime.query('CREATE TABLE forbidden_sync_ddl(id integer)'), {
        code: '42501',
      });
      const app = express();
      app.use(express.json());
      app.use('/api', createSyncRouter(central.runtime, true));
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const url = `http://127.0.0.1:${address.port}`;
      const eventId = randomUUID(),
        entityId = randomUUID();
      await pc1.runtime.query(
        "INSERT INTO sync_outbox(id,organization_id,entity_type,entity_id,operation,revision,payload) VALUES($1,$2,'departments',$3,'CREATE',1,$4)",
        [
          eventId,
          organizationId,
          entityId,
          JSON.stringify({
            id: entityId,
            organizationId,
            revision: 1,
            code: 'FIN',
            name: 'Finance',
          }),
        ],
      );
      assert.equal(await pushNextBatch(pc1.runtime, { url, ...first }), true);
      assert.equal(await pullNextBatch(pc2.runtime, { url, ...second }), true);
      assert.equal(
        (await pc1.runtime.query('SELECT status FROM sync_outbox WHERE id=$1', [eventId])).rows[0]
          .status,
        'synced',
      );
      const inbox = (
        await pc2.runtime.query('SELECT applied_at FROM sync_inbox WHERE source_event_id=$1', [
          eventId,
        ])
      ).rows[0];
      assert.ok(inbox);
      assert.ok(inbox.applied_at);
      assert.equal(
        (await pc2.runtime.query('SELECT count(*)::int AS count FROM departments')).rows[0].count,
        1,
      );
      await assert.rejects(
        revokeCentralNode(adminDatabase, randomUUID(), first.nodeId),
        /does not match/,
      );
      await assert.rejects(
        revokeCentralNode(adminDatabase, organizationId, randomUUID()),
        /not enrolled/,
      );
      await revokeCentralNode(adminDatabase, organizationId, first.nodeId);
      await revokeCentralNode(adminDatabase, organizationId, first.nodeId); // Idempotent revocation.
      const response = await fetch(url + '/api/sync/pull?after=0', {
        headers: { Authorization: `Bearer ${first.token}`, 'X-Hex-Sync-Protocol': '2' },
      });
      assert.equal(response.status, 403);
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await management?.end();
      for (const fixture of [central, pc1, pc2]) await fixture.close();
    }
  },
);
