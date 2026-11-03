import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scheduleInputSchema } from '@hexpayroll/shared';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate, migrateCentral, readMigrations } from '../src/db/migrate.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { tokenHash } from '../src/auth/service.js';
import {
  createCentralEvidenceDecisionService,
  evidenceActions,
} from '../src/timekeeping/central-evidence-decisions.js';

const options = { skip: !databaseTestsEnabled };
async function fixture() {
  const db = await databaseFixture();
  try {
    await migrate(db.migrator, db.migrations);
    assert.equal(
      (await db.runtime.query("SELECT to_regclass('central_evidence_authorizations') present"))
        .rows[0].present,
      null,
    );
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../../database/central-migrations/', import.meta.url)),
    );
    await migrateCentral(db.migrator, migrations, db.migrations, {
      mode: 'central',
      expectedDatabase: 'hexpayroll_test',
    });
    const org = randomUUID(),
      otherOrg = randomUUID(),
      user = randomUUID(),
      node = randomUUID(),
      role = randomUUID();
    const credentials = {
      nodeToken: randomBytes(32).toString('base64url'),
      sessionToken: randomBytes(32).toString('base64url'),
    };
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Evidence'),($2,'Foreign')",
      [org, otherOrg],
    );
    await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
    await db.runtime.query(
      "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'evidence_user','Evidence',$3)",
      [user, org, DUMMY_PASSWORD_HASH],
    );
    await db.runtime.query(
      "INSERT INTO roles(id,organization_id,code,name) VALUES($1,$2,'evidence_role','Evidence')",
      [role, org],
    );
    await db.runtime.query('INSERT INTO user_roles VALUES($1,$2)', [user, role]);
    for (const permission of new Set(Object.values(evidenceActions).map((a) => a.permission)))
      await db.runtime.query('INSERT INTO role_permissions VALUES($1,$2)', [role, permission]);
    await db.runtime.query(
      "INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,'Laptop',$3)",
      [node, org, tokenHash(credentials.nodeToken)],
    );
    await db.runtime.query(
      "INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [user, tokenHash(credentials.sessionToken)],
    );
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
    const decide = createCentralEvidenceDecisionService(db.runtime, 'central');
    return { ...db, org, otherOrg, user, node, role, credentials, input, decide };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test(
  'all eleven evidence actions use existing permissions and persist only authorization',
  options,
  async () => {
    const f = await fixture();
    try {
      const employee = randomUUID(),
        scheduleId = randomUUID(),
        assignmentId = randomUUID(),
        typeId = randomUUID(),
        leaveId = randomUUID();
      await f.runtime.query(
        "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'E1','Ana','Santos')",
        [employee, f.org],
      );
      await f.runtime.query(
        "INSERT INTO work_schedules(id,organization_id,code,name) VALUES($1,$2,'DAY','Day')",
        [scheduleId, f.org],
      );
      await f.runtime.query(
        "INSERT INTO employee_schedule_assignments(id,organization_id,employee_id,schedule_id,effective_from) VALUES($1,$2,$3,$4,'2026-01-01')",
        [assignmentId, f.org, employee, scheduleId],
      );
      await f.runtime.query(
        "INSERT INTO leave_types(id,organization_id,code,name,paid) VALUES($1,$2,'VL','Vacation',true)",
        [typeId, f.org],
      );
      await f.runtime.query(
        `INSERT INTO leave_requests(id,organization_id,employee_id,leave_type_id,start_date,end_date,duration_type,reason,status,type_snapshot,requested_by)
      VALUES($1,$2,$3,$4,'2026-01-01','2026-01-01','full_day','Requested','pending','{}',$5)`,
        [leaveId, f.org, employee, typeId, f.user],
      );
      const schedule = {
        ...scheduleInputSchema.parse({
          code: 'NIGHT',
          name: 'Night',
          effectiveFrom: '2026-01-01',
          reason: 'Initial rules',
          days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            dayOfWeek,
            isWorkDay: true,
            startTime: '22:00',
            endTime: '06:00',
            endDayOffset: 1,
            breakStart: '02:00',
            breakEnd: '03:00',
            breakStartDayOffset: 1,
            breakEndDayOffset: 1,
            graceMinutes: 10,
          })),
        }),
        versionId: randomUUID(),
        timezone: 'Asia/Manila',
      };
      for (const [action, spec] of Object.entries(evidenceActions)) {
        const entityId = spec.create
          ? randomUUID()
          : spec.table === 'work_schedules'
            ? scheduleId
            : spec.table === 'employee_schedule_assignments'
              ? assignmentId
              : spec.table === 'leave_types'
                ? typeId
                : leaveId;
        const payload =
          action === 'schedule.status'
            ? { status: 'inactive' }
            : action.startsWith('schedule.')
              ? schedule
              : action.startsWith('assignment.')
                ? {
                    employeeId: employee,
                    scheduleId,
                    effectiveFrom: '2026-01-01',
                    effectiveTo: null,
                    reason: 'Authorized assignment',
                  }
                : action.startsWith('leaveType.')
                  ? f.input.payload
                  : action === 'leave.request'
                    ? {
                        employeeId: employee,
                        leaveTypeId: typeId,
                        startDate: '2026-01-01',
                        endDate: '2026-01-01',
                        durationType: 'first_half',
                        reason: 'Requested leave',
                      }
                    : { remarks: 'Decision reason' };
        const input = {
          ...f.input,
          requestId: randomUUID(),
          entityId,
          action,
          expectedRevision: spec.create ? 0 : 1,
          payload,
        };
        await f.runtime.query(
          'DELETE FROM role_permissions WHERE role_id=$1 AND permission_code=$2',
          [f.role, spec.permission],
        );
        await assert.rejects(f.decide(f.credentials, input), { code: 'FORBIDDEN' });
        await f.runtime.query('INSERT INTO role_permissions VALUES($1,$2)', [
          f.role,
          spec.permission,
        ]);
        const decision = await f.decide(f.credentials, input);
        assert.equal(decision.permission_code, spec.permission);
        assert.equal(decision.action, action);
        assert.deepEqual(JSON.parse(decision.canonical_request).payload, payload);
      }
      assert.equal(
        (await f.runtime.query('SELECT status FROM leave_requests WHERE id=$1', [leaveId])).rows[0]
          .status,
        'pending',
      );
      assert.equal((await f.runtime.query('SELECT count(*)::int n FROM sync_outbox')).rows[0].n, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'evidence decisions wait for revocation and hold authorization locks through persistence',
  options,
  async () => {
    const f = await fixture();
    const revoker = await f.runtime.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query(
        "DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='leave.configure'",
        [f.role],
      );
      const pending = Promise.allSettled([f.decide(f.credentials, f.input)]);
      let blocked = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        blocked = (
          await f.runtime.query(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0
        AND $1=ANY(pg_blocking_pids(pid))) blocked`,
            [(await revoker.query('SELECT pg_backend_pid() pid')).rows[0].pid],
          )
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await revoker.query('COMMIT');
      const [result] = await pending;
      assert.ok(blocked, 'Decision must wait for uncommitted permission removal');
      assert.equal(result!.status, 'rejected');
      if (result!.status === 'rejected') assert.equal(result.reason.code, 'FORBIDDEN');
      assert.equal(
        (await f.runtime.query('SELECT count(*)::int n FROM central_evidence_authorizations'))
          .rows[0].n,
        0,
      );
    } finally {
      await revoker.query('ROLLBACK');
      revoker.release();
      await f.close();
    }
  },
);

test(
  'evidence decisions persist immutable audit bindings without evidence, outbox or canonical writes',
  options,
  async () => {
    const f = await fixture();
    try {
      const first = await f.decide(f.credentials, f.input);
      assert.equal(first.acting_user_id, f.user);
      assert.equal(first.source_node_id, f.node);
      assert.equal(first.permission_code, 'leave.configure');
      assert.equal(first.request_version, 1);
      assert.match(first.payload_fingerprint, /^[a-f0-9]{64}$/);
      const reordered = {
        ...f.input,
        payload: Object.fromEntries(Object.entries(f.input.payload).reverse()),
      };
      assert.deepEqual(await f.decide(f.credentials, reordered), first);
      for (const table of [
        'leave_types',
        'work_schedules',
        'leave_requests',
        'sync_outbox',
        'central_attendance_state',
        'sync_changes',
      ])
        assert.equal((await f.runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
      assert.equal(
        (await f.runtime.query('SELECT last_seen_at FROM sync_nodes WHERE id=$1', [f.node])).rows[0]
          .last_seen_at,
        null,
      );
      await assert.rejects(
        f.runtime.query('UPDATE central_evidence_authorizations SET expected_revision=2'),
      );
      await assert.rejects(f.runtime.query('DELETE FROM central_evidence_authorizations'));
      await assert.rejects(f.migrator.query('TRUNCATE central_evidence_authorizations'));
    } finally {
      await f.close();
    }
  },
);

test(
  'evidence request identity rejects altered content, entity, action, revision and organization',
  options,
  async () => {
    const f = await fixture();
    try {
      await f.decide(f.credentials, f.input);
      for (const patch of [
        { payload: { ...f.input.payload, paid: false } },
        { entityId: randomUUID() },
        { action: 'leaveType.update', expectedRevision: 1 },
      ])
        await assert.rejects(f.decide(f.credentials, { ...f.input, ...patch }), {
          code: 'EVIDENCE_REQUEST_CONFLICT',
        });
      await assert.rejects(f.decide(f.credentials, { ...f.input, organizationId: f.otherOrg }), {
        code: 'ORGANIZATION_MISMATCH',
      });
      await assert.rejects(f.decide(f.credentials, { ...f.input, authorUserId: randomUUID() }), {
        code: 'INVALID_REQUEST',
      });
      await assert.rejects(f.decide({ ...f.credentials, userId: f.user }, f.input), {
        code: 'AUTH_INVALID',
      });
      assert.equal(
        (await f.runtime.query('SELECT count(*)::int n FROM central_evidence_authorizations'))
          .rows[0].n,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'evidence decisions check current revision and foreign entity ownership',
  options,
  async () => {
    const f = await fixture();
    try {
      await f.runtime.query(
        "INSERT INTO leave_types(id,organization_id,code,name,paid) VALUES($1,$2,'VL','Vacation',true)",
        [f.input.entityId, f.org],
      );
      await assert.rejects(f.decide(f.credentials, f.input), {
        code: 'EVIDENCE_REVISION_MISMATCH',
      });
      const update = { ...f.input, action: 'leaveType.update', expectedRevision: 2 };
      await assert.rejects(f.decide(f.credentials, update), { code: 'EVIDENCE_REVISION_MISMATCH' });
      await f.decide(f.credentials, { ...update, expectedRevision: 1 });
      await f.runtime.query('UPDATE leave_types SET organization_id=$1 WHERE id=$2', [
        f.otherOrg,
        f.input.entityId,
      ]);
      await assert.rejects(
        f.decide(f.credentials, { ...update, requestId: randomUUID(), expectedRevision: 1 }),
        { code: 'ORGANIZATION_MISMATCH' },
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'evidence replay reauthenticates revoked nodes, sessions, users and grants',
  options,
  async () => {
    const f = await fixture();
    try {
      await f.decide(f.credentials, f.input);
      await f.runtime.query('UPDATE sync_nodes SET enabled=false WHERE id=$1', [f.node]);
      await assert.rejects(f.decide(f.credentials, f.input), { code: 'NODE_INVALID' });
      await f.runtime.query('UPDATE sync_nodes SET enabled=true WHERE id=$1', [f.node]);
      await f.runtime.query('UPDATE auth_users SET active=false WHERE id=$1', [f.user]);
      await assert.rejects(f.decide(f.credentials, f.input), { code: 'SESSION_INVALID' });
      await f.runtime.query('UPDATE auth_users SET active=true WHERE id=$1', [f.user]);
      await f.runtime.query(
        "DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='leave.configure'",
        [f.role],
      );
      await assert.rejects(f.decide(f.credentials, f.input), { code: 'FORBIDDEN' });
      await f.runtime.query("INSERT INTO role_permissions VALUES($1,'leave.configure')", [f.role]);
      await f.runtime.query('DELETE FROM auth_sessions WHERE user_id=$1', [f.user]);
      await assert.rejects(f.decide(f.credentials, f.input), { code: 'SESSION_INVALID' });
    } finally {
      await f.close();
    }
  },
);

test(
  'concurrent evidence retries persist once and changed requests conflict',
  options,
  async () => {
    const f = await fixture();
    try {
      const [a, b] = await Promise.all([
        f.decide(f.credentials, f.input),
        f.decide(f.credentials, f.input),
      ]);
      assert.equal(a.decision_id, b.decision_id);
      const requestId = randomUUID();
      const results = await Promise.allSettled([
        f.decide(f.credentials, { ...f.input, requestId }),
        f.decide(f.credentials, {
          ...f.input,
          requestId,
          payload: { ...f.input.payload, paid: false },
        }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        (await f.runtime.query('SELECT count(*)::int n FROM central_evidence_authorizations'))
          .rows[0].n,
        2,
      );
    } finally {
      await f.close();
    }
  },
);
