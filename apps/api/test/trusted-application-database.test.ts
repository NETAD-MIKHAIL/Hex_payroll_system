import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import pg, { type Pool } from 'pg';
import { canonicalSyncJson } from '@hexpayroll/shared';
import { acceptanceFixture, acceptanceOptions } from './central-evidence-acceptance-fixture.js';
import { databaseFixture } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { registerNode } from '../src/sync/service.js';
import { tokenHash } from '../src/auth/service.js';
import { createSyncRouter } from '../src/sync/router.js';
import { pullNextTrustedEvidenceBatch } from '../src/sync/client.js';
import { applyTrustedEvidenceBatch } from '../src/sync/trusted-application.js';
import { pullTrustedEvidence } from '../src/sync/trusted-evidence.js';
import { normalize } from '../src/foundation/repository.js';

async function fixture() {
  const central = await acceptanceFixture();
  const locals: Awaited<ReturnType<typeof databaseFixture>>[] = [];
  let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
  try {
    let override: unknown,
      outage = false;
    const app = express();
    app.use(express.json());
    app.use('/api/sync/evidence/pull', (_req, res, next) => {
      if (outage) res.sendStatus(503);
      else if (override !== undefined) res.json(override);
      else next();
    });
    app.use('/api', createSyncRouter(central.runtime, true));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const pcs: (Awaited<ReturnType<typeof databaseFixture>> & {
      config: { url: string; nodeId: string; token: string };
      pull: () => Promise<boolean>;
      apply: () => ReturnType<typeof applyTrustedEvidenceBatch>;
    })[] = [];
    for (let n = 0; n < 2; n++) {
      const db = await databaseFixture();
      locals.push(db);
      await migrate(db.migrator, db.migrations);
      await db.runtime.query("INSERT INTO organizations(id,legal_name) VALUES($1,'Local')", [
        central.org,
      ]);
      await db.runtime.query('UPDATE application_setup SET organization_id=$1', [central.org]);
      // Explicit fixture provisioning, outside synchronization. No permission or role grants.
      await db.runtime.query(
        "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'acceptor','Acceptor',$3)",
        [central.user, central.org, DUMMY_PASSWORD_HASH],
      );
      await db.runtime.query(
        "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'E1','Ana','Santos')",
        [central.employee, central.org],
      );
      const node = await registerNode(central.runtime, central.org, 'Local ' + n);
      await db.runtime.query(
        "INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,'Local',$3)",
        [node.nodeId, central.org, tokenHash(node.token)],
      );
      const config = {
        url: `http://127.0.0.1:${address.port}`,
        nodeId: node.nodeId,
        token: node.token,
      };
      pcs.push({
        ...db,
        config,
        pull: () => pullNextTrustedEvidenceBatch(db.runtime, config),
        apply: () => applyTrustedEvidenceBatch(db.runtime, config, 'local'),
      });
    }
    const drain = async () => {
      for (const pc of pcs) {
        for (let i = 0; i < 30 && (await pc.pull()); i++);
        for (let i = 0; i < 30; i++) {
          const r = await pc.apply();
          if (!r.applied) break;
        }
      }
    };
    return {
      central,
      pcs,
      drain,
      override: (v: unknown) => {
        override = v;
      },
      outage: (v: boolean) => {
        outage = v;
      },
      retry: async () => {
        for (const pc of pcs)
          await pc.runtime.query(
            "UPDATE trusted_evidence_application_state SET next_attempt_at=now()-interval '1 second' WHERE status='pending'",
          );
      },
      close: async () => {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
          server!.closeAllConnections();
        });
        for (const db of locals) await db.close();
        await central.close();
      },
    };
  } catch (error) {
    server?.close();
    for (const db of locals) await db.close();
    await central.close();
    throw error;
  }
}
async function count(pool: Pick<Pool, 'query'>, table: string) {
  return (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number;
}

test(
  'a fresh database pool resumes after receipt and before application; revoked local enrollment fails closed',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    let restarted: Pool | undefined;
    try {
      const pc = f.pcs[0]!,
        c = f.central;
      await c.commit('leaveType.create', randomUUID(), 0, c.typePayload());
      await pc.pull();
      const schema = (await pc.runtime.query('SELECT current_schema() name')).rows[0].name;
      restarted = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL!,
        options: `-c search_path=${schema}`,
      });
      assert.equal((await applyTrustedEvidenceBatch(restarted, pc.config, 'local')).applied, 1);
      assert.equal(await pullNextTrustedEvidenceBatch(restarted, pc.config), false);
      await pc.runtime.query('UPDATE sync_nodes SET enabled=false,revoked_at=now()');
      await assert.rejects(applyTrustedEvidenceBatch(restarted, pc.config, 'local'));
      await assert.rejects(pullNextTrustedEvidenceBatch(restarted, pc.config));
      assert.equal(await count(pc.runtime, 'trusted_evidence_applications'), 1);
    } finally {
      await restarted?.end();
      await f.close();
    }
  },
);

test(
  'assignment history and revision roll back together when its application receipt fails',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const pc = f.pcs[0]!,
        c = f.central,
        schedule = randomUUID(),
        assignment = randomUUID();
      await c.commit('schedule.create', schedule, 0, c.schedulePayload());
      await c.commit('assignment.create', assignment, 0, c.assignmentPayload(schedule));
      await f.drain();
      await c.commit('assignment.update', assignment, 1, {
        ...c.assignmentPayload(schedule),
        effectiveTo: '2026-05-01',
        reason: 'Explicit correction',
      });
      await pc.pull();
      await pc.migrator.query(
        "CREATE FUNCTION fail_history_application_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected failure after history'; END $$",
      );
      await pc.migrator.query(
        'CREATE TRIGGER fail_application BEFORE INSERT ON trusted_evidence_applications FOR EACH ROW EXECUTE FUNCTION fail_history_application_test()',
      );
      assert.equal((await pc.apply()).pending, 1);
      assert.equal(await count(pc.runtime, 'schedule_assignment_history'), 0);
      assert.equal(
        (await pc.runtime.query('SELECT revision FROM employee_schedule_assignments')).rows[0]
          .revision,
        1,
      );
      await pc.migrator.query('DROP TRIGGER fail_application ON trusted_evidence_applications');
      await f.retry();
      assert.equal((await pc.apply()).applied, 1);
      assert.equal(await count(pc.runtime, 'schedule_assignment_history'), 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'missing workforce dependencies survive restart and recover; generic inbox never supplies authority',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const pc = f.pcs[0]!,
        c = f.central,
        type = randomUUID(),
        leave = randomUUID();
      await pc.runtime.query('DELETE FROM employees WHERE id=$1', [c.employee]);
      await c.commit('leaveType.create', type, 0, c.typePayload(false));
      await c.commit('leave.request', leave, 0, c.leavePayload(type));
      await f.drain();
      assert.equal(await count(pc.runtime, 'leave_requests'), 0);
      assert.equal(
        (await pc.runtime.query('SELECT code FROM trusted_evidence_application_state')).rows[0]
          .code,
        'MISSING_EMPLOYEES',
      );
      await pc.runtime.query(
        "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'E1','Ana','Santos')",
        [c.employee, c.org],
      );
      await f.retry();
      assert.equal((await pc.apply()).applied, 1);
      assert.equal(
        (await pc.runtime.query('SELECT status,approved_by FROM leave_requests')).rows[0].status,
        'approved',
      );
      assert.equal(await count(pc.runtime, 'sync_outbox'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'pending local outbox prevents application and remains intact',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const pc = f.pcs[0]!,
        c = f.central,
        id = randomUUID(),
        p = c.typePayload();
      await c.commit('leaveType.create', id, 0, p);
      await f.drain();
      await pc.runtime.query(
        "INSERT INTO sync_outbox(organization_id,entity_type,entity_id,operation,revision,payload) VALUES($1,'leave_types',$2,'UPDATE',2,'{}')",
        [c.org, id],
      );
      await c.commit('leaveType.update', id, 1, { ...p, name: 'Central revised' });
      await pc.pull();
      assert.equal((await pc.apply()).conflicts, 1);
      assert.equal(
        (await pc.runtime.query('SELECT code FROM trusted_evidence_application_state')).rows[0]
          .code,
        'PENDING_LOCAL_WORK',
      );
      assert.equal(
        (await pc.runtime.query('SELECT revision FROM leave_types')).rows[0].revision,
        1,
      );
      assert.equal(await count(pc.runtime, 'sync_outbox'), 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'immutable child drift and assignment overlap become durable conflicts without overwriting local evidence',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const pc = f.pcs[0]!,
        c = f.central,
        schedule = randomUUID(),
        assignment = randomUUID(),
        first = c.schedulePayload();
      await c.commit('schedule.create', schedule, 0, first);
      await f.drain();
      await pc.migrator.query('UPDATE work_schedule_days SET grace_minutes=21');
      await c.commit('schedule.update', schedule, 1, {
        ...c.schedulePayload('2026-02-01'),
        code: first.code,
      });
      await pc.pull();
      assert.equal((await pc.apply()).conflicts, 1);
      assert.equal(await count(pc.runtime, 'work_schedule_versions'), 1);
      await pc.runtime.query(
        "INSERT INTO employee_schedule_assignments(organization_id,employee_id,schedule_id,effective_from) VALUES($1,$2,$3,'2026-01-01')",
        [c.org, c.employee, schedule],
      );
      await c.commit('assignment.create', assignment, 0, c.assignmentPayload(schedule));
      await pc.pull();
      assert.equal((await pc.apply()).conflicts, 1);
      assert.equal(await count(pc.runtime, 'employee_schedule_assignments'), 1);
      assert.equal(
        (
          await pc.runtime.query(
            "SELECT code FROM trusted_evidence_application_state WHERE code='LOCAL_ASSIGNMENT_OVERLAP'",
          )
        ).rowCount,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'historical replay cannot revert newer aggregate revisions or duplicate application receipts',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const pc = f.pcs[0]!,
        c = f.central,
        id = randomUUID(),
        p = c.typePayload();
      await c.commit('leaveType.create', id, 0, p);
      await c.commit('leaveType.update', id, 1, { ...p, name: 'Newest' });
      await f.drain();
      await pc.runtime.query('UPDATE trusted_evidence_checkpoints SET last_sequence=0');
      await pc.pull();
      assert.equal((await pc.apply()).applied, 0);
      assert.equal(await count(pc.runtime, 'trusted_evidence_applications'), 2);
      assert.equal(
        (await pc.runtime.query('SELECT revision,name FROM leave_types')).rows[0].name,
        'Newest',
      );
      await assert.rejects(applyTrustedEvidenceBatch(c.runtime, pc.config, 'central'));
      await assert.rejects(applyTrustedEvidenceBatch(c.runtime, pc.config, 'local'));
    } finally {
      await f.close();
    }
  },
);

test(
  'real central acceptance -> v2 pull -> two independent PCs: all eleven actions, immutable history and no echo',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    const c = f.central;
    try {
      const schedule = randomUUID(),
        assignment = randomUUID(),
        type = randomUUID(),
        approved = randomUUID(),
        rejected = randomUUID(),
        cancelled = randomUUID();
      const first = c.schedulePayload();
      await c.commit('schedule.create', schedule, 0, first);
      await c.commit('schedule.update', schedule, 1, {
        ...c.schedulePayload('2026-02-01'),
        code: first.code,
        name: 'Revised night shift',
      });
      await c.commit('assignment.create', assignment, 0, c.assignmentPayload(schedule));
      await c.commit('assignment.update', assignment, 1, {
        ...c.assignmentPayload(schedule),
        effectiveTo: '2026-05-01',
        reason: 'Explicit range correction',
      });
      await c.commit('schedule.status', schedule, 2, { status: 'inactive' });
      const tp = c.typePayload();
      await c.commit('leaveType.create', type, 0, tp);
      await c.commit('leaveType.update', type, 1, { ...tp, name: 'Annual leave' });
      await c.commit('leave.request', approved, 0, c.leavePayload(type));
      await c.commit('leave.approve', approved, 1, { remarks: 'Approved centrally' });
      await c.commit('leave.request', rejected, 0, c.leavePayload(type, '2026-03-02'));
      await c.commit('leave.reject', rejected, 1, { remarks: 'Rejected centrally' });
      await c.commit('leave.request', cancelled, 0, c.leavePayload(type, '2026-03-03'));
      await c.commit('leave.cancel', cancelled, 1, { remarks: 'Cancelled centrally' });
      f.outage(true);
      for (const pc of f.pcs) await assert.rejects(pc.pull());
      f.outage(false);
      await f.drain();
      for (const pc of f.pcs) {
        assert.equal(await count(pc.runtime, 'trusted_evidence_applications'), 13);
        assert.equal(await count(pc.runtime, 'trusted_evidence_application_state'), 0);
        for (const table of [
          'work_schedules',
          'work_schedule_versions',
          'work_schedule_days',
          'employee_schedule_assignments',
          'schedule_assignment_history',
          'leave_types',
          'leave_requests',
        ]) {
          const expected = (await c.runtime.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
          const actual = (await pc.runtime.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
          // JS timestamps retain millisecond precision, which is the canonical protocol precision.
          assert.equal(
            canonicalSyncJson(actual.map(normalize)),
            canonicalSyncJson(expected.map(normalize)),
            table,
          );
        }
        assert.equal(await count(pc.runtime, 'sync_outbox'), 0);
        assert.equal(await count(pc.runtime, 'attendance_records'), 0);
        assert.equal(await count(pc.runtime, 'attendance_processing_jobs'), 0);
        assert.equal(await count(pc.runtime, 'user_roles'), 0);
        assert.equal(
          (
            await pc.runtime.query(
              "SELECT to_regclass('central_evidence_acceptances') a,to_regclass('central_evidence_events') e",
            )
          ).rows[0].a,
          null,
        );
        assert.deepEqual(await pc.apply(), { applied: 0, pending: 0, conflicts: 0 });
        // Durable restart: fresh calls reread DB checkpoints/receipts, no memory-based deduplication.
        assert.equal(await pc.pull(), false);
        assert.equal(
          (await pc.runtime.query('SELECT last_pull_sequence::text n FROM sync_nodes')).rows[0].n,
          '0',
        );
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'missing trusted actor defers durably without creating accounts; explicit provisioning resumes application',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const pc = f.pcs[0]!;
      await pc.runtime.query('DELETE FROM auth_users WHERE id=$1', [f.central.user]);
      await f.central.commit('leaveType.create', randomUUID(), 0, f.central.typePayload());
      await pc.pull();
      assert.equal((await pc.apply()).pending, 1);
      assert.equal(
        (await pc.runtime.query('SELECT code FROM trusted_evidence_application_state')).rows[0]
          .code,
        'MISSING_TRUSTED_ACTOR',
      );
      assert.equal(await count(pc.runtime, 'leave_types'), 0);
      assert.equal(await count(pc.runtime, 'auth_users'), 0);
      await pc.runtime.query(
        "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'acceptor','Acceptor',$3)",
        [f.central.user, f.central.org, DUMMY_PASSWORD_HASH],
      );
      await f.retry();
      assert.equal((await pc.apply()).applied, 1);
      assert.equal(await count(pc.runtime, 'user_roles'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'existing locally authored evidence is a durable conflict, never replaced',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const id = randomUUID(),
        pc = f.pcs[0]!;
      await f.central.commit('leaveType.create', id, 0, f.central.typePayload());
      await pc.runtime.query(
        "INSERT INTO leave_types(id,organization_id,code,name,paid,requires_approval) VALUES($1,$2,'LOCAL','Unsubmitted work',true,true)",
        [id, f.central.org],
      );
      await pc.pull();
      assert.equal((await pc.apply()).conflicts, 1);
      assert.equal(
        (await pc.runtime.query('SELECT name FROM leave_types WHERE id=$1', [id])).rows[0].name,
        'Unsubmitted work',
      );
      assert.equal(
        (await pc.runtime.query('SELECT code FROM trusted_evidence_application_state')).rows[0]
          .code,
        'EXISTING_LOCAL_EVIDENCE',
      );
      assert.equal((await pc.apply()).conflicts, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'changed local root at unchanged revision blocks a later accepted update',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const id = randomUUID(),
        payload = f.central.typePayload(),
        pc = f.pcs[0]!;
      await f.central.commit('leaveType.create', id, 0, payload);
      await f.drain();
      await pc.runtime.query("UPDATE leave_types SET name='Local change' WHERE id=$1", [id]);
      await f.central.commit('leaveType.update', id, 1, { ...payload, name: 'Central change' });
      await pc.pull();
      assert.equal((await pc.apply()).conflicts, 1);
      assert.equal(await count(pc.runtime, 'trusted_evidence_applications'), 1);
      assert.equal(
        (await pc.runtime.query('SELECT code FROM trusted_evidence_application_state')).rows[0]
          .code,
        'LOCAL_EVIDENCE_CHANGED',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'concurrent receipt and application workers commit exactly once; receipts and inbox are immutable',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const pc = f.pcs[0]!;
      await f.central.commit('leaveType.create', randomUUID(), 0, f.central.typePayload());
      await Promise.all([pc.pull(), pc.pull()]);
      const results = await Promise.all([pc.apply(), pc.apply()]);
      assert.equal(
        results.reduce((n, r) => n + r.applied, 0),
        1,
      );
      assert.equal(await count(pc.runtime, 'trusted_evidence_inbox'), 1);
      assert.equal(await count(pc.runtime, 'trusted_evidence_applications'), 1);
      await assert.rejects(
        pc.runtime.query('UPDATE trusted_evidence_applications SET revision=99'),
      );
      await assert.rejects(pc.runtime.query('DELETE FROM trusted_evidence_inbox'));
    } finally {
      await f.close();
    }
  },
);

test(
  'injected receipt failure rolls back master, all seven children and application receipt, then retry succeeds',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const pc = f.pcs[0]!;
      await f.central.commit('schedule.create', randomUUID(), 0, f.central.schedulePayload());
      await pc.pull();
      await pc.migrator.query(
        "CREATE FUNCTION fail_application_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected receipt failure'; END $$",
      );
      await pc.migrator.query(
        'CREATE TRIGGER fail_application BEFORE INSERT ON trusted_evidence_applications FOR EACH ROW EXECUTE FUNCTION fail_application_test()',
      );
      assert.equal((await pc.apply()).pending, 1);
      for (const t of [
        'work_schedules',
        'work_schedule_versions',
        'work_schedule_days',
        'trusted_evidence_applications',
      ])
        assert.equal(await count(pc.runtime, t), 0, t);
      assert.equal(await count(pc.runtime, 'trusted_evidence_inbox'), 1);
      await pc.migrator.query('DROP TRIGGER fail_application ON trusted_evidence_applications');
      await f.retry();
      assert.equal((await pc.apply()).applied, 1);
      assert.equal(await count(pc.runtime, 'work_schedule_days'), 7);
    } finally {
      await f.close();
    }
  },
);

test(
  'whole-response validation rejects tampering, unsupported origin, foreign org and malformed business snapshot without cursor advance',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const pc = f.pcs[0]!;
      await f.central.commit('leaveType.create', randomUUID(), 0, f.central.typePayload());
      const valid = await pullTrustedEvidence(f.central.runtime, pc.config.token, '0');
      const malformedSnapshot = {
        id: valid.changes[0]!.entityId,
        organizationId: f.central.org,
        revision: 1,
      };
      for (const change of [
        { ...valid.changes[0], snapshotFingerprint: '0'.repeat(64) },
        { ...valid.changes[0], origin: 'node' },
        { ...valid.changes[0], organizationId: f.central.foreignOrg },
        { ...valid.changes[0], protocolVersion: 3 },
        {
          ...valid.changes[0],
          snapshot: malformedSnapshot,
          snapshotFingerprint: createHash('sha256')
            .update(canonicalSyncJson(malformedSnapshot))
            .digest('hex'),
        },
      ]) {
        f.override({ ...valid, changes: [change] });
        await assert.rejects(pc.pull());
        assert.equal(await count(pc.runtime, 'trusted_evidence_inbox'), 0);
        assert.equal(await count(pc.runtime, 'trusted_evidence_checkpoints'), 0);
      }
      f.override(undefined);
      await pc.pull();
      assert.equal((await pc.apply()).applied, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'revision gap defers while an independent aggregate progresses; missing predecessor never becomes a create',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const pc = f.pcs[0]!,
        id = randomUUID(),
        p = f.central.typePayload();
      await f.central.commit('leaveType.create', id, 0, p);
      await f.central.commit('leaveType.update', id, 1, { ...p, name: 'Updated' });
      await f.central.commit('leaveType.create', randomUUID(), 0, f.central.typePayload());
      const stream = await pullTrustedEvidence(f.central.runtime, pc.config.token, '0');
      f.override({ ...stream, changes: stream.changes.slice(1) });
      await pc.pull();
      const applied = await pc.apply();
      assert.equal(applied.pending, 1);
      assert.equal(applied.applied, 1);
      assert.equal(
        (await pc.runtime.query('SELECT code FROM trusted_evidence_application_state')).rows[0]
          .code,
        'REVISION_GAP',
      );
      assert.equal(
        (await pc.runtime.query('SELECT 1 FROM leave_types WHERE id=$1', [id])).rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);
