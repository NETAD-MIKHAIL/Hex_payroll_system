import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import express from 'express';
import { canonicalSyncJson } from '@hexpayroll/shared';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate, migrateCentral, readMigrations } from '../src/db/migrate.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { tokenHash } from '../src/auth/service.js';
import { createCentralEvidenceDecisionService } from '../src/timekeeping/central-evidence-decisions.js';
import { publishTrustedEvidence, pullTrustedEvidence } from '../src/sync/trusted-evidence.js';
import { registerNode, pushEvents, pullChanges } from '../src/sync/service.js';
import { createSyncRouter } from '../src/sync/router.js';
import { pullNextTrustedEvidenceBatch } from '../src/sync/client.js';

const options = { skip: !databaseTestsEnabled };
async function fixture() {
  const central = await databaseFixture(),
    local = await databaseFixture();
  try {
    await migrate(central.migrator, central.migrations);
    await migrate(local.migrator, local.migrations);
    assert.equal(
      (await local.runtime.query("SELECT to_regclass('central_evidence_events') present")).rows[0]
        .present,
      null,
    );
    await migrateCentral(
      central.migrator,
      await readMigrations(
        fileURLToPath(new URL('../../../database/central-migrations/', import.meta.url)),
      ),
      central.migrations,
      { mode: 'central', expectedDatabase: 'hexpayroll_test' },
    );
    const org = randomUUID(),
      otherOrg = randomUUID(),
      user = randomUUID(),
      role = randomUUID();
    await central.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Trusted'),($2,'Other')",
      [org, otherOrg],
    );
    await local.runtime.query("INSERT INTO organizations(id,legal_name) VALUES($1,'Trusted')", [
      org,
    ]);
    const node = await registerNode(central.runtime, org, 'PC'),
      other = await registerNode(central.runtime, otherOrg, 'Foreign');
    await local.runtime.query(
      "INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,'PC',$3)",
      [node.nodeId, org, tokenHash(node.token)],
    );
    await central.runtime.query(
      "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'publisher','Publisher',$3)",
      [user, org, DUMMY_PASSWORD_HASH],
    );
    await central.runtime.query(
      "INSERT INTO roles(id,organization_id,code,name) VALUES($1,$2,'publisher','Publisher')",
      [role, org],
    );
    await central.runtime.query('INSERT INTO user_roles VALUES($1,$2)', [user, role]);
    await central.runtime.query("INSERT INTO role_permissions VALUES($1,'leave.configure')", [
      role,
    ]);
    const session = randomBytes(32).toString('base64url');
    await central.runtime.query(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [tokenHash(session), user],
    );
    // Privileged TEST-ONLY simulation of a future acceptance writer. No evidence is accepted by application code.
    async function acceptedFixture() {
      const input = {
        version: 1,
        requestId: randomUUID(),
        organizationId: org,
        entityId: randomUUID(),
        action: 'leaveType.create',
        expectedRevision: 0,
        payload: {
          code: 'VL',
          name: 'Vacation',
          description: null,
          status: 'active',
          paid: true,
          requiresApproval: true,
        },
      };
      const authorization = await createCentralEvidenceDecisionService(central.runtime, 'central')(
        { nodeToken: node.token, sessionToken: session },
        input,
      );
      const snapshot = {
        id: input.entityId,
        organizationId: org,
        revision: 1,
        ...input.payload,
        updatedBy: user,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const canonical = canonicalSyncJson(snapshot),
        acceptanceId = randomUUID();
      const hash = createHash('sha256').update(canonical).digest('hex');
      await central.migrator.query(
        `INSERT INTO central_evidence_acceptances(acceptance_id,authorization_decision_id,
        organization_id,entity_id,entity_type,action,expected_revision,resulting_revision,canonical_snapshot,snapshot_fingerprint,audit_snapshot)
        VALUES($1,$2,$3,$4,'leave_types','leaveType.create',0,1,$5,$6,'{"fixture":true}')`,
        [acceptanceId, authorization.decision_id, org, input.entityId, canonical, hash],
      );
      return { acceptanceId, authorization, snapshot };
    }
    let override: unknown;
    const app = express();
    app.use(express.json());
    app.get('/api/sync/evidence/pull', (_req, res, next) => {
      if (override !== undefined) res.json(override);
      else next();
    });
    app.use('/api', createSyncRouter(central.runtime, true));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config = {
      url: `http://127.0.0.1:${address.port}`,
      nodeId: node.nodeId,
      token: node.token,
    };
    async function publish(id: string) {
      const client = await central.migrator.connect();
      try {
        await client.query('BEGIN');
        const result = await publishTrustedEvidence(client, id);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    return {
      central,
      local,
      org,
      otherOrg,
      node,
      other,
      config,
      acceptedFixture,
      publish,
      override(value: unknown) {
        override = value;
      },
      async state() {
        return {
          inbox: (
            await local.runtime.query('SELECT * FROM trusted_evidence_inbox ORDER BY sequence')
          ).rows,
          cursor: (
            await local.runtime.query(
              'SELECT last_sequence::text FROM trusted_evidence_checkpoints',
            )
          ).rows,
        };
      },
      async close() {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await local.close();
        await central.close();
      },
    };
  } catch (error) {
    await local.close();
    await central.close();
    throw error;
  }
}

test(
  'trusted storage is central-only, requires a bound acceptance, and denies runtime publication',
  options,
  async () => {
    const f = await fixture();
    try {
      const accepted = await f.acceptedFixture();
      await assert.rejects(
        f.central.runtime.query('INSERT INTO central_evidence_events(acceptance_id) VALUES($1)', [
          accepted.acceptanceId,
        ]),
        { code: '42501' },
      );
      await assert.rejects(
        f.central.runtime.query('INSERT INTO central_evidence_acceptances DEFAULT VALUES'),
        { code: '42501' },
      );
      await assert.rejects(f.publish(randomUUID()), { code: 'ACCEPTANCE_REQUIRED' });
      await assert.rejects(
        f.central.migrator.query(
          `INSERT INTO central_evidence_acceptances(authorization_decision_id,organization_id,entity_id,
      entity_type,action,expected_revision,resulting_revision,canonical_snapshot,snapshot_fingerprint,audit_snapshot)
      SELECT authorization_decision_id,$1,entity_id,entity_type,action,expected_revision,resulting_revision,canonical_snapshot,snapshot_fingerprint,audit_snapshot
      FROM central_evidence_acceptances`,
          [f.otherOrg],
        ),
        { code: '23514' },
      );
      const first = await f.publish(accepted.acceptanceId);
      assert.deepEqual(await f.publish(accepted.acceptanceId), first);
      await assert.rejects(
        f.central.migrator.query('UPDATE central_evidence_events SET protocol_version=2'),
        { code: '23514' },
      );
      await assert.rejects(f.central.migrator.query('DELETE FROM central_evidence_acceptances'), {
        code: '23514',
      });
    } finally {
      await f.close();
    }
  },
);

test(
  'trusted pull persists verified provenance, resumes independently and isolates organizations',
  options,
  async () => {
    const f = await fixture();
    try {
      const accepted = await f.acceptedFixture();
      const published = await f.publish(accepted.acceptanceId);
      const pulled = await pullTrustedEvidence(f.central.runtime, f.node.token, '0');
      assert.equal(pulled.changes[0]!.acceptanceId, accepted.acceptanceId);
      assert.equal(pulled.changes[0]!.authorizationDecisionId, accepted.authorization.decision_id);
      assert.deepEqual(pulled.changes[0]!.snapshot, accepted.snapshot);
      assert.equal(
        (await pullTrustedEvidence(f.central.runtime, f.other.token, '0')).changes.length,
        0,
      );
      assert.equal((await pullChanges(f.central.runtime, f.node.token, '0')).changes.length, 0);
      assert.equal(await pullNextTrustedEvidenceBatch(f.local.runtime, f.config), true);
      assert.equal(await pullNextTrustedEvidenceBatch(f.local.runtime, { ...f.config }), false);
      const state = await f.state();
      assert.equal(state.inbox.length, 1);
      assert.deepEqual(state.inbox[0].envelope, pulled.changes[0]);
      assert.equal(state.cursor[0].last_sequence, published.sequence);
      assert.equal(
        (await f.local.runtime.query('SELECT last_pull_sequence::text s FROM sync_nodes')).rows[0]
          .s,
        '0',
      );
      for (const table of [
        'leave_types',
        'leave_requests',
        'attendance_records',
        'sync_outbox',
        'sync_inbox',
      ])
        assert.equal(
          (await f.local.runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
          0,
        );
    } finally {
      await f.close();
    }
  },
);

test(
  'malformed, tampered, foreign and unsupported envelopes leave inbox and checkpoint unchanged',
  options,
  async () => {
    const f = await fixture();
    try {
      const accepted = await f.acceptedFixture();
      await f.publish(accepted.acceptanceId);
      const good = await pullTrustedEvidence(f.central.runtime, f.node.token, '0');
      const event = good.changes[0]!;
      for (const patch of [
        { protocolVersion: 3 },
        { origin: 'node' },
        { acceptanceId: event.authorizationDecisionId },
        { snapshot: { ...event.snapshot, paid: false } },
        { snapshotFingerprint: 'f'.repeat(64) },
        { organizationId: f.otherOrg },
        { resultingRevision: 2 },
      ]) {
        f.override({ ...good, changes: [{ ...event, ...patch }] });
        await assert.rejects(pullNextTrustedEvidenceBatch(f.local.runtime, f.config));
        assert.deepEqual(await f.state(), { inbox: [], cursor: [] });
      }
      f.override({ ...good, nextSequence: '999999' });
      await assert.rejects(pullNextTrustedEvidenceBatch(f.local.runtime, f.config));
      f.override(undefined);
      await f.local.migrator.query(
        'ALTER TABLE trusted_evidence_inbox ADD CONSTRAINT test_fail CHECK(false)',
      );
      await assert.rejects(pullNextTrustedEvidenceBatch(f.local.runtime, f.config));
      assert.deepEqual(await f.state(), { inbox: [], cursor: [] });
      await f.local.migrator.query('ALTER TABLE trusted_evidence_inbox DROP CONSTRAINT test_fail');
      assert.equal(await pullNextTrustedEvidenceBatch(f.local.runtime, f.config), true);
    } finally {
      await f.close();
    }
  },
);

test(
  'generic push cannot forge provenance and historical protected events stay quarantined',
  options,
  async () => {
    const f = await fixture();
    try {
      const event = {
        eventId: randomUUID(),
        entityId: randomUUID(),
        entityType: 'departments',
        operation: 'CREATE',
        revision: 1,
        payloadVersion: 1,
        payload: { origin: 'central.accepted', acceptanceId: randomUUID() },
      };
      await assert.rejects(
        pushEvents(f.central.runtime, f.node.token, {
          events: [{ ...event, origin: 'central.accepted' }],
        }),
      );
      for (const entityType of [
        'central_evidence_acceptances',
        'central_evidence_events',
        'trusted_evidence_inbox',
        'trusted_evidence_checkpoints',
        'leave_requests',
        'work_schedules',
      ])
        await assert.rejects(
          pushEvents(f.central.runtime, f.node.token, { events: [{ ...event, entityType }] }),
          { code: 'SYNC_CENTRAL_AUTHORITY_REQUIRED' },
        );
      await pushEvents(f.central.runtime, f.node.token, { events: [event] });
      assert.equal(
        (await pullTrustedEvidence(f.central.runtime, f.node.token, '0')).changes.length,
        0,
      );
      await f.central.runtime.query(
        `INSERT INTO sync_changes(organization_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload)
      VALUES($1,$2,$3,'leave_requests',$4,'CREATE',1,'{"status":"approved"}')`,
        [f.org, f.node.nodeId, randomUUID(), randomUUID()],
      );
      assert.equal((await pullChanges(f.central.runtime, f.node.token, '0')).changes.length, 1);
      await f.central.runtime.query(
        'UPDATE sync_nodes SET enabled=false,revoked_at=now() WHERE id=$1',
        [f.node.nodeId],
      );
      await assert.rejects(pullTrustedEvidence(f.central.runtime, f.node.token, '0'), {
        code: 'NODE_INVALID',
      });
    } finally {
      await f.close();
    }
  },
);

test(
  'trusted publication rollback, pagination and concurrent retries preserve ordered delivery',
  options,
  async () => {
    const f = await fixture();
    try {
      const accepted = await f.acceptedFixture();
      const client = await f.central.migrator.connect();
      try {
        await client.query('BEGIN');
        await publishTrustedEvidence(client, accepted.acceptanceId);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      assert.equal(
        (await pullTrustedEvidence(f.central.runtime, f.node.token, '0')).changes.length,
        0,
      );
      const [a, b] = await Promise.all([
        f.publish(accepted.acceptanceId),
        f.publish(accepted.acceptanceId),
      ]);
      assert.deepEqual(a, b);
      for (let i = 0; i < 3; i++) await f.publish((await f.acceptedFixture()).acceptanceId);
      const first = await pullTrustedEvidence(f.central.runtime, f.node.token, '0');
      const second = await pullTrustedEvidence(f.central.runtime, f.node.token, first.nextSequence);
      assert.equal(first.changes.length, 3);
      assert.equal(second.changes.length, 1);
      assert.ok(BigInt(second.nextSequence) > BigInt(first.nextSequence));
      await Promise.all([
        pullNextTrustedEvidenceBatch(f.local.runtime, f.config),
        pullNextTrustedEvidenceBatch(f.local.runtime, f.config),
      ]);
      // A second worker may fetch after the first commits and consume the next page.
      assert.ok([3, 4].includes((await f.state()).inbox.length));
      await pullNextTrustedEvidenceBatch(f.local.runtime, f.config);
      assert.equal((await f.state()).inbox.length, 4);
    } finally {
      await f.close();
    }
  },
);

test(
  'trusted duplicate replay preserves stored provenance and rejects altered metadata atomically',
  options,
  async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 2; i++) await f.publish((await f.acceptedFixture()).acceptanceId);
      const good = await pullTrustedEvidence(f.central.runtime, f.node.token, '0');
      f.override({
        ...good,
        changes: [good.changes[0], { ...good.changes[1], snapshotFingerprint: 'f'.repeat(64) }],
      });
      await assert.rejects(pullNextTrustedEvidenceBatch(f.local.runtime, f.config));
      assert.deepEqual(await f.state(), { inbox: [], cursor: [] });
      f.override(undefined);
      await pullNextTrustedEvidenceBatch(f.local.runtime, f.config);
      const before = await f.state();
      await f.local.runtime.query('UPDATE trusted_evidence_checkpoints SET last_sequence=0');
      await pullNextTrustedEvidenceBatch(f.local.runtime, f.config);
      assert.deepEqual(await f.state(), before);
      await assert.rejects(
        f.local.runtime.query("UPDATE trusted_evidence_inbox SET envelope='{}'"),
        { code: '42501' },
      );
      await f.local.runtime.query('UPDATE trusted_evidence_checkpoints SET last_sequence=0');
      f.override({
        ...good,
        changes: [{ ...good.changes[0], acceptedAt: '2026-01-01T00:00:00Z' }, good.changes[1]],
      });
      await assert.rejects(pullNextTrustedEvidenceBatch(f.local.runtime, f.config));
      const after = await f.state();
      assert.deepEqual(after.inbox, before.inbox);
      assert.equal(after.cursor[0].last_sequence, '0');
    } finally {
      await f.close();
    }
  },
);

test(
  'trusted sequence serialization follows commit order across concurrent writers',
  options,
  async () => {
    const f = await fixture();
    const first = await f.central.migrator.connect(),
      second = await f.central.migrator.connect();
    let pending:
      | Promise<PromiseSettledResult<Awaited<ReturnType<typeof publishTrustedEvidence>>>[]>
      | undefined;
    try {
      const a = await f.acceptedFixture(),
        b = await f.acceptedFixture();
      await first.query('BEGIN');
      await second.query('BEGIN');
      await second.query("SET LOCAL statement_timeout='10s'");
      // A previously reserved identity must not cause a late lower published cursor.
      await second.query("SELECT nextval('central_evidence_events_sequence_seq')");
      const pid = (await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const published = await publishTrustedEvidence(first, a.acceptanceId);
      pending = Promise.allSettled([publishTrustedEvidence(second, b.acceptanceId)]);
      let blocked = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        blocked = (
          await f.central.runtime.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(blocked, 'Second writer must wait until the first commits');
      await first.query('COMMIT');
      const [result] = await pending;
      assert.equal(result!.status, 'fulfilled');
      if (result!.status === 'fulfilled')
        assert.ok(BigInt(result.value.sequence) > BigInt(published.sequence));
      await second.query('COMMIT');
      const pulled = await pullTrustedEvidence(f.central.runtime, f.node.token, '0');
      assert.deepEqual(
        pulled.changes.map((event) => event.acceptanceId),
        [a.acceptanceId, b.acceptanceId],
      );
    } finally {
      await first.query('ROLLBACK');
      if (pending) await pending;
      await second.query('ROLLBACK');
      first.release();
      second.release();
      await f.close();
    }
  },
);
