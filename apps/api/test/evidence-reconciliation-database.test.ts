import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptanceOptions } from './central-evidence-acceptance-fixture.js';
import { identityFixture } from './trusted-identity-fixture.js';
import { identityFingerprint } from '../src/sync/trusted-identity-protocol.js';
import express from 'express';
import { once } from 'node:events';
import { createSyncRouter } from '../src/sync/router.js';

test(
  'reconciliation inspection exposes different local identities but never deletes or remaps an unbound aggregate',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      await f.publish();
      const pc = f.pcs[0]!;
      await pc.identities();
      const incoming = randomUUID(),
        local = randomUUID(),
        payload = f.central.typePayload();
      await f.central.commit('leaveType.create', incoming, 0, payload);
      await pc.runtime.query(
        'INSERT INTO leave_types(id,organization_id,code,name,paid,requires_approval) VALUES($1,$2,$3,$4,false,true)',
        [local, f.central.org, payload.code, 'Competing local identity'],
      );
      await pc.pull();
      assert.equal((await pc.apply()).conflicts, 1);
      const sequence = String(
        (await pc.runtime.query('SELECT sequence FROM trusted_evidence_inbox')).rows[0].sequence,
      );
      const view = await pc.reconcile.inspect(pc.session, sequence);
      assert.equal(view.local, null);
      assert.equal(view.competingLocal[0]!.id, local);
      await assert.rejects(
        pc.reconcile.reconcile(pc.session, await request(pc, sequence)),
        (e: unknown) =>
          e instanceof Error && 'code' in e && e.code === 'RECONCILIATION_UNBOUND_AGGREGATE',
      );
      await pc.reconcile.reconcile(pc.session, await request(pc, sequence, 'preserveLocal'));
      assert.equal(
        (await pc.runtime.query('SELECT competing_snapshot FROM trusted_evidence_reconciliations'))
          .rows[0].competing_snapshot[0].id,
        local,
      );
      assert.equal((await pc.runtime.query('SELECT id FROM leave_types')).rows[0].id, local);
    } finally {
      await f.close();
    }
  },
);

test(
  'local reconciliation HTTP routes require real operator sessions; enrolled node tokens cannot authorize repair',
  acceptanceOptions,
  async () => {
    const f = await typeConflict();
    let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
    try {
      const pc = f.pcs[0]!,
        app = express();
      app.use(express.json());
      app.use('/api', createSyncRouter(pc.runtime, false, pc.config));
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const url = `http://127.0.0.1:${address.port}/api/sync/local-evidence/`;
      assert.equal(
        (await fetch(url + f.sequence, { headers: { Authorization: 'Bearer ' + pc.config.token } }))
          .status,
        401,
      );
      const read = await fetch(url + f.sequence, {
        headers: { Authorization: 'Bearer ' + pc.session },
      });
      assert.equal(read.status, 200);
      const body = await request(pc, f.sequence, 'preserveLocal');
      const write = await fetch(url + 'reconcile', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + pc.session, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(write.status, 200);
      assert.equal(
        (await pc.runtime.query('SELECT operator_id FROM trusted_evidence_reconciliations')).rows[0]
          .operator_id,
        pc.operator,
      );
    } finally {
      if (server)
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
          server!.closeAllConnections();
        });
      await f.close();
    }
  },
);

type PC = Awaited<ReturnType<typeof identityFixture>>['pcs'][number];
async function request(
  pc: PC,
  sequence: string,
  decision: 'useCentral' | 'preserveLocal' = 'useCentral',
) {
  const view = await pc.reconcile.inspect(pc.session, sequence);
  return {
    requestId: randomUUID(),
    sequence,
    decision,
    reason: 'Reviewed both snapshots; preserve local work and use accepted central evidence',
    localFingerprint: view.localFingerprint,
    centralFingerprint: view.centralFingerprint,
    outboxFingerprint: view.outboxFingerprint,
    competingFingerprint: view.competingFingerprint,
  };
}
async function typeConflict() {
  const f = await identityFixture();
  try {
    await f.publish();
    for (const pc of f.pcs) await pc.identities();
    const id = randomUUID(),
      payload = f.central.typePayload();
    await f.central.commit('leaveType.create', id, 0, payload);
    for (const pc of f.pcs) {
      await pc.runtime.query(
        "INSERT INTO leave_types(id,organization_id,code,name,paid,requires_approval) VALUES($1,$2,'LOCAL','Unsubmitted local type',false,true)",
        [id, f.central.org],
      );
      await pc.runtime.query(
        "INSERT INTO sync_outbox(organization_id,entity_type,entity_id,operation,revision,payload) VALUES($1,'leave_types',$2,'CREATE',1,$3)",
        [f.central.org, id, JSON.stringify({ id, name: 'Unsubmitted local type' })],
      );
      await pc.pull();
      assert.equal((await pc.apply()).conflicts, 1);
    }
    const sequence = String(
      (await f.pcs[0]!.runtime.query('SELECT sequence FROM trusted_evidence_inbox')).rows[0]
        .sequence,
    );
    return { ...f, id, payload, sequence };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test(
  'explicit authenticated reconciliation preserves competing local work and converges two PCs without reissuing central acceptance',
  acceptanceOptions,
  async () => {
    const f = await typeConflict();
    try {
      for (const pc of f.pcs) {
        const view = await pc.reconcile.inspect(pc.session, f.sequence);
        assert.equal(view.local!.name, 'Unsubmitted local type');
        assert.equal(view.central.name, f.payload.name);
        assert.equal(view.pendingOutbox.length, 1);
        const input = await request(pc, f.sequence);
        await pc.reconcile.reconcile(pc.session, input);
        const replay = await pc.reconcile.reconcile(pc.session, input);
        assert.equal(replay.replayed, true);
        const audit = (await pc.runtime.query('SELECT * FROM trusted_evidence_reconciliations'))
          .rows[0];
        assert.equal(audit.local_snapshot.name, 'Unsubmitted local type');
        assert.equal(audit.outbox_snapshot[0].payload.name, 'Unsubmitted local type');
        assert.equal(audit.operator_id, pc.operator);
        assert.equal(audit.central_fingerprint, input.centralFingerprint);
        assert.equal(
          (await pc.runtime.query('SELECT name,revision FROM leave_types WHERE id=$1', [f.id]))
            .rows[0].name,
          f.payload.name,
        );
        assert.equal(
          (await pc.runtime.query('SELECT status,payload FROM sync_outbox')).rows[0].status,
          'failed',
        );
        assert.equal(
          (await pc.runtime.query('SELECT count(*)::int n FROM trusted_evidence_applications'))
            .rows[0].n,
          1,
        );
        await assert.rejects(
          pc.runtime.query('UPDATE trusted_evidence_reconciliations SET reason=reason'),
        );
        await assert.rejects(pc.runtime.query('DELETE FROM trusted_evidence_reconciled_outbox'));
        assert.equal((await pc.apply()).applied, 0);
      }
      assert.equal(
        (await f.central.runtime.query('SELECT count(*)::int n FROM central_evidence_acceptances'))
          .rows[0].n,
        1,
      );
      // The preserved outbox does not block later accepted revisions or masquerade as delivery.
      await f.central.commit('leaveType.update', f.id, 1, {
        ...f.payload,
        name: 'Central revision two',
      });
      for (const pc of f.pcs) {
        await pc.pull();
        assert.equal((await pc.apply()).applied, 1);
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'reconciliation rechecks operator session, roles, organization, permission and exact inspected content',
  acceptanceOptions,
  async () => {
    const f = await typeConflict();
    try {
      const pc = f.pcs[0]!,
        input = await request(pc, f.sequence);
      await assert.rejects(pc.reconcile.reconcile('x'.repeat(43), input));
      await assert.rejects(
        pc.reconcile.reconcile(pc.session, { ...input, operatorId: pc.operator }),
      );
      await assert.rejects(pc.reconcile.reconcile(pc.session, { ...input, reason: '' }));
      await assert.rejects(
        pc.reconcile.reconcile(pc.session, { ...input, centralFingerprint: '0'.repeat(64) }),
      );
      await pc.runtime.query('DELETE FROM user_roles WHERE user_id=$1', [pc.operator]);
      await assert.rejects(pc.reconcile.reconcile(pc.session, input));
      await pc.runtime.query(
        "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
        [pc.operator],
      );
      await pc.runtime.query("UPDATE leave_types SET name='Edited after inspection' WHERE id=$1", [
        f.id,
      ]);
      await assert.rejects(pc.reconcile.reconcile(pc.session, input));
      assert.equal(
        (await pc.runtime.query('SELECT count(*)::int n FROM trusted_evidence_reconciliations'))
          .rows[0].n,
        0,
      );
      await pc.runtime.query('DELETE FROM auth_sessions');
      await assert.rejects(pc.reconcile.inspect(pc.session, f.sequence));
    } finally {
      await f.close();
    }
  },
);

test(
  'operator preserveLocal is an immutable hold; it never dismisses the conflict or applies a receipt',
  acceptanceOptions,
  async () => {
    const f = await typeConflict();
    try {
      const pc = f.pcs[0]!,
        input = await request(pc, f.sequence, 'preserveLocal');
      await pc.reconcile.reconcile(pc.session, input);
      assert.equal(
        (await pc.runtime.query('SELECT code FROM trusted_evidence_application_state')).rows[0]
          .code,
        'OPERATOR_PRESERVED_LOCAL',
      );
      assert.equal(
        (await pc.runtime.query('SELECT count(*)::int n FROM trusted_evidence_applications'))
          .rows[0].n,
        0,
      );
      assert.equal(
        (await pc.runtime.query('SELECT status FROM sync_outbox')).rows[0].status,
        'pending',
      );
      assert.equal((await pc.apply()).applied, 0);
      await assert.rejects(
        pc.reconcile.reconcile(pc.session, { ...input, decision: 'useCentral' }),
      );
      await pc.reconcile.reconcile(pc.session, await request(pc, f.sequence));
      assert.equal(
        (await pc.runtime.query('SELECT count(*)::int n FROM trusted_evidence_reconciliations'))
          .rows[0].n,
        2,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'reconciliation audit, projection, receipt, outbox preservation and resolution roll back together',
  acceptanceOptions,
  async () => {
    const f = await typeConflict();
    try {
      const pc = f.pcs[0]!,
        input = await request(pc, f.sequence);
      await pc.migrator.query(
        "CREATE FUNCTION fail_reconciliation_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected final reconciliation failure'; END $$",
      );
      await pc.migrator.query(
        'CREATE TRIGGER fail_reconciliation BEFORE INSERT ON trusted_evidence_reconciliation_applications FOR EACH ROW EXECUTE FUNCTION fail_reconciliation_test()',
      );
      await assert.rejects(pc.reconcile.reconcile(pc.session, input));
      for (const t of [
        'trusted_evidence_reconciliations',
        'trusted_evidence_applications',
        'trusted_evidence_reconciled_outbox',
      ])
        assert.equal((await pc.runtime.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 0, t);
      assert.equal(
        (await pc.runtime.query('SELECT name FROM leave_types')).rows[0].name,
        'Unsubmitted local type',
      );
      assert.equal(
        (await pc.runtime.query('SELECT status FROM sync_outbox')).rows[0].status,
        'pending',
      );
      await pc.migrator.query(
        'DROP TRIGGER fail_reconciliation ON trusted_evidence_reconciliation_applications',
      );
      await pc.reconcile.reconcile(pc.session, input);
    } finally {
      await f.close();
    }
  },
);

test(
  'competing operator requests serialize; changed archived outbox content becomes new conflict rather than being ignored',
  acceptanceOptions,
  async () => {
    const f = await typeConflict();
    try {
      const pc = f.pcs[0]!,
        first = await request(pc, f.sequence),
        second = { ...first, requestId: randomUUID() };
      const outcomes = await Promise.allSettled([
        pc.reconcile.reconcile(pc.session, first),
        pc.reconcile.reconcile(pc.session, second),
      ]);
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        (
          await pc.runtime.query(
            'SELECT count(*)::int n FROM trusted_evidence_reconciliation_applications',
          )
        ).rows[0].n,
        1,
      );
      await pc.runtime.query('UPDATE sync_outbox SET payload=\'{"name":"new unreviewed change"}\'');
      await f.central.commit('leaveType.update', f.id, 1, {
        ...f.payload,
        name: 'New central type',
      });
      await pc.pull();
      assert.equal((await pc.apply()).conflicts, 1);
      assert.equal(
        (
          await pc.runtime.query(
            'SELECT code FROM trusted_evidence_application_state ORDER BY sequence DESC LIMIT 1',
          )
        ).rows[0].code,
        'PENDING_LOCAL_WORK',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'schedule, assignment and leave root conflicts reconcile against trusted predecessors while preserving immutable child/history',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      await f.publish();
      for (const pc of f.pcs) await pc.identities();
      const c = f.central,
        schedule = randomUUID(),
        assignment = randomUUID(),
        type = randomUUID(),
        leave = randomUUID();
      await c.commit('schedule.create', schedule, 0, c.schedulePayload());
      await c.commit('assignment.create', assignment, 0, c.assignmentPayload(schedule));
      await c.commit('leaveType.create', type, 0, c.typePayload());
      await c.commit('leave.request', leave, 0, c.leavePayload(type));
      for (const pc of f.pcs) {
        while (await pc.pull());
        for (let i = 0; i < 5; i++) await pc.apply();
        await pc.runtime.query(
          "UPDATE work_schedules SET name='Local schedule draft' WHERE id=$1",
          [schedule],
        );
        await pc.runtime.query(
          "UPDATE employee_schedule_assignments SET reason='Local range draft' WHERE id=$1",
          [assignment],
        );
        await pc.runtime.query("UPDATE leave_requests SET reason='Local leave draft' WHERE id=$1", [
          leave,
        ]);
      }
      await c.commit('schedule.status', schedule, 1, { status: 'inactive' });
      // Updating an assignment to an inactive schedule is forbidden centrally, so reactivate first.
      await c.commit('schedule.status', schedule, 2, { status: 'active' });
      await c.commit('assignment.update', assignment, 1, {
        ...c.assignmentPayload(schedule),
        effectiveTo: '2026-05-01',
        reason: 'Reviewed central range correction',
      });
      await c.commit('leave.approve', leave, 1, { remarks: 'Central approval' });
      for (const pc of f.pcs) {
        while (await pc.pull());
        assert.equal((await pc.apply()).conflicts, 3);
        const pending = (
          await pc.runtime.query(
            `SELECT i.sequence::text FROM trusted_evidence_inbox i LEFT JOIN trusted_evidence_applications a USING(organization_id,sequence) WHERE a.sequence IS NULL ORDER BY i.sequence`,
          )
        ).rows;
        for (const entry of pending) {
          const view = await pc.reconcile.inspect(pc.session, entry.sequence);
          if (view.localFingerprint === identityFingerprint(view.trustedPredecessor)) {
            await pc.apply();
            continue;
          }
          await pc.reconcile.reconcile(pc.session, await request(pc, entry.sequence));
        }
        for (let i = 0; i < 4; i++) await pc.apply();
        assert.equal(
          (await pc.runtime.query('SELECT count(*)::int n FROM schedule_assignment_history'))
            .rows[0].n,
          1,
        );
        assert.equal(
          (await pc.runtime.query('SELECT count(*)::int n FROM work_schedule_days')).rows[0].n,
          7,
        );
        assert.equal(
          (await pc.runtime.query('SELECT status,reason FROM leave_requests')).rows[0].status,
          'approved',
        );
        assert.equal(
          (await pc.runtime.query('SELECT count(*)::int n FROM trusted_evidence_applications'))
            .rows[0].n,
          8,
        );
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'incompatible immutable weekday history is a precise blocker, with no destructive reconciliation or audit partial write',
  acceptanceOptions,
  async () => {
    const f = await identityFixture();
    try {
      await f.publish();
      const pc = f.pcs[0]!;
      await pc.identities();
      const id = randomUUID();
      await f.central.commit('schedule.create', id, 0, f.central.schedulePayload());
      await pc.pull();
      await pc.apply();
      await pc.migrator.query('UPDATE work_schedule_days SET grace_minutes=23');
      await f.central.commit('schedule.status', id, 1, { status: 'inactive' });
      await pc.pull();
      await pc.apply();
      const sequence = String(
        (await pc.runtime.query('SELECT max(sequence) n FROM trusted_evidence_inbox')).rows[0].n,
      );
      await assert.rejects(
        pc.reconcile.reconcile(pc.session, await request(pc, sequence)),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'RECONCILIATION_IMMUTABLE_CHILD_BLOCKER',
      );
      assert.equal(
        (await pc.runtime.query('SELECT count(*)::int n FROM trusted_evidence_reconciliations'))
          .rows[0].n,
        0,
      );
      assert.equal(
        (await pc.runtime.query('SELECT grace_minutes FROM work_schedule_days LIMIT 1')).rows[0]
          .grace_minutes,
        23,
      );
      await pc.reconcile.reconcile(pc.session, await request(pc, sequence, 'preserveLocal'));
    } finally {
      await f.close();
    }
  },
);
