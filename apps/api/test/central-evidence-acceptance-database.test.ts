import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalSyncJson } from '@hexpayroll/shared';
import { acceptanceFixture, acceptanceOptions } from './central-evidence-acceptance-fixture.js';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate, migrateCentral, readMigrations } from '../src/db/migrate.js';
import {
  createCentralEvidenceAcceptanceService,
  scheduleWeekdayId,
} from '../src/timekeeping/central-evidence-acceptance.js';
import { provisionCentralEvidenceWriter } from '../src/timekeeping/central-evidence-writer.js';
import { pullTrustedEvidence, verifyTrustedEvidence } from '../src/sync/trusted-evidence.js';

test(
  'ordinary runtime and migration-owner pools cannot act as acceptance writers',
  { skip: !databaseTestsEnabled },
  async () => {
    const db = await databaseFixture();
    try {
      await migrate(db.migrator, db.migrations);
      await migrateCentral(
        db.migrator,
        await readMigrations(
          fileURLToPath(new URL('../../../database/central-migrations/', import.meta.url)),
        ),
        db.migrations,
        { mode: 'central', expectedDatabase: 'hexpayroll_test' },
      );
      const request = {
        version: 1,
        requestId: randomUUID(),
        organizationId: randomUUID(),
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
      for (const pool of [db.runtime, db.migrator])
        await assert.rejects(
          createCentralEvidenceAcceptanceService(pool, 'central')(
            { nodeToken: 'a'.repeat(43), sessionToken: 'b'.repeat(43) },
            { authorizationDecisionId: randomUUID(), request },
          ),
          /restricted central evidence writer/,
        );
      await assert.rejects(
        provisionCentralEvidenceWriter(db.migrator, 'wrong_target'),
        /target mismatch/,
      );
      await assert.rejects(
        db.runtime.query('INSERT INTO central_evidence_acceptances DEFAULT VALUES'),
        { code: '42501' },
      );
      await assert.rejects(db.runtime.query('INSERT INTO central_evidence_events DEFAULT VALUES'), {
        code: '42501',
      });
    } finally {
      await db.close();
    }
  },
);

test(
  'all eleven actions materialize revisioned aggregates and publish exact immutable v2 audit snapshots',
  acceptanceOptions,
  async () => {
    const f = await acceptanceFixture();
    try {
      const scheduleId = randomUUID(),
        assignmentId = randomUUID(),
        typeId = randomUUID(),
        leaveId = randomUUID();
      const initial = f.schedulePayload();
      const created = await f.commit('schedule.create', scheduleId, 0, initial);
      const first = JSON.parse(created.acceptance.canonical_snapshot);
      assert.equal(first.versions.length, 1);
      assert.equal(first.versions[0].days.length, 7);
      for (const day of first.versions[0].days) {
        assert.equal(day.id, scheduleWeekdayId(initial.versionId, day.dayOfWeek));
        assert.equal(day.endDayOffset, 1);
        assert.equal(day.breakStartDayOffset, 1);
        assert.equal(day.graceMinutes, 10);
      }
      const revised = {
        ...f.schedulePayload('2026-02-01'),
        code: initial.code,
        name: 'Revised night',
      };
      const updated = await f.commit('schedule.update', scheduleId, 1, revised);
      const second = JSON.parse(updated.acceptance.canonical_snapshot);
      assert.equal(second.revision, 2);
      assert.deepEqual(second.versions[0], first.versions[0]);
      assert.equal(second.versions[1].timezone, 'Asia/Manila');
      await f.commit('assignment.create', assignmentId, 0, f.assignmentPayload(scheduleId));
      const corrected = await f.commit('assignment.update', assignmentId, 1, {
        ...f.assignmentPayload(scheduleId),
        effectiveTo: '2026-02-01',
      });
      assert.equal(JSON.parse(corrected.acceptance.canonical_snapshot).history.length, 1);
      await f.commit('schedule.status', scheduleId, 2, { status: 'inactive' });
      const type = f.typePayload();
      await f.commit('leaveType.create', typeId, 0, type);
      await f.commit('leaveType.update', typeId, 1, { ...type, paid: false });
      const requested = await f.commit('leave.request', leaveId, 0, f.leavePayload(typeId));
      assert.equal(JSON.parse(requested.acceptance.canonical_snapshot).status, 'pending');
      assert.equal(JSON.parse(requested.acceptance.canonical_snapshot).typeSnapshot.paid, false);
      await f.commit('leave.approve', leaveId, 1, { remarks: null });
      await f.commit('leave.cancel', leaveId, 2, { remarks: 'Cancelled' });
      const rejectedId = randomUUID();
      await f.commit('leave.request', rejectedId, 0, f.leavePayload(typeId, '2026-03-02'));
      await f.commit('leave.reject', rejectedId, 1, { remarks: 'Rejected with reason' });
      const actions = (
        await f.runtime.query('SELECT DISTINCT action FROM central_evidence_acceptances')
      ).rows
        .map((r) => r.action)
        .sort();
      assert.equal(actions.length, 11);
      const counts = await f.counts();
      assert.equal(counts.central_evidence_acceptances, 12);
      assert.equal(counts.central_evidence_events, 12);
      assert.equal(counts.sync_outbox, 0);
      assert.equal(counts.sync_changes, 0);
      assert.equal(counts.attendance_records, 0);
      assert.equal(counts.central_attendance_state, 0);
      assert.equal(counts.attendance_processing_jobs, 0);
      let after = '0',
        seen = 0;
      do {
        const page = await pullTrustedEvidence(f.runtime, f.credentials.nodeToken, after);
        if (!page.changes.length) break;
        for (const envelope of page.changes) {
          verifyTrustedEvidence(envelope);
          const record = (
            await f.runtime.query(
              'SELECT * FROM central_evidence_acceptances WHERE acceptance_id=$1',
              [envelope.acceptanceId],
            )
          ).rows[0];
          assert.equal(canonicalSyncJson(envelope.snapshot), record.canonical_snapshot);
          assert.equal(record.audit_snapshot.actingUserId, f.user);
          assert.deepEqual(record.audit_snapshot.after, envelope.snapshot);
          seen++;
        }
        after = page.nextSequence;
      } while (seen < 12);
      assert.equal(seen, 12);
      await assert.rejects(
        f.writer.query("UPDATE central_evidence_acceptances SET audit_snapshot='{}'"),
        { code: '42501' },
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'fresh node/session/user/permission checks and exact authorization bindings prevent acceptance',
  acceptanceOptions,
  async () => {
    const f = await acceptanceFixture();
    try {
      const input = await f.propose('leaveType.create', randomUUID(), 0, f.typePayload());
      const before = await f.counts();
      await assert.rejects(
        f.accept(f.credentials, {
          ...input,
          request: { ...input.request, payload: { ...input.request.payload, paid: false } },
        }),
        { code: 'EVIDENCE_AUTHORIZATION_MISMATCH' },
      );
      await assert.rejects(
        f.accept(f.credentials, { ...input, authorizationDecisionId: randomUUID() }),
        { code: 'EVIDENCE_AUTHORIZATION_MISMATCH' },
      );
      await assert.rejects(
        f.accept(f.credentials, {
          ...input,
          request: { ...input.request, organizationId: f.foreignOrg },
        }),
        { code: 'ORGANIZATION_MISMATCH' },
      );
      await assert.rejects(f.accept({ ...f.credentials, userId: f.user }, input), {
        code: 'AUTH_INVALID',
      });
      await f.runtime.query(
        "DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='leave.configure'",
        [f.role],
      );
      await assert.rejects(f.accept(f.credentials, input), { code: 'FORBIDDEN' });
      await f.runtime.query("INSERT INTO role_permissions VALUES($1,'leave.configure')", [f.role]);
      await f.runtime.query('UPDATE sync_nodes SET enabled=false,revoked_at=now() WHERE id=$1', [
        f.node,
      ]);
      await assert.rejects(f.accept(f.credentials, input), { code: 'NODE_INVALID' });
      await f.runtime.query('UPDATE sync_nodes SET enabled=true,revoked_at=null WHERE id=$1', [
        f.node,
      ]);
      await f.runtime.query('UPDATE auth_users SET active=false WHERE id=$1', [f.user]);
      await assert.rejects(f.accept(f.credentials, input), { code: 'SESSION_INVALID' });
      await f.runtime.query('UPDATE auth_users SET active=true WHERE id=$1', [f.user]);
      await f.runtime.query(
        "UPDATE auth_sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE user_id=$1",
        [f.user],
      );
      await assert.rejects(f.accept(f.credentials, input), { code: 'SESSION_INVALID' });
      assert.deepEqual(await f.counts(), before);
    } finally {
      await f.close();
    }
  },
);

test(
  'exact concurrent retries return one acceptance/event and competing revision proposals have one winner',
  acceptanceOptions,
  async () => {
    const f = await acceptanceFixture();
    try {
      const id = randomUUID(),
        payload = f.typePayload(),
        input = await f.propose('leaveType.create', id, 0, payload);
      const [a, b] = await Promise.all([
        f.accept(f.credentials, input),
        f.accept(f.credentials, input),
      ]);
      assert.deepEqual(a, b);
      const first = await f.propose('leaveType.update', id, 1, { ...payload, paid: false });
      const second = await f.propose('leaveType.update', id, 1, {
        ...payload,
        name: 'Competing change',
      });
      const results = await Promise.allSettled([
        f.accept(f.credentials, first),
        f.accept(f.credentials, second),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      for (const result of results)
        if (result.status === 'rejected')
          assert.equal(result.reason.code, 'EVIDENCE_REVISION_MISMATCH');
      assert.deepEqual(await f.accept(f.credentials, input), a); // Historical retry does not revert newer evidence.
      assert.equal(
        (await f.runtime.query('SELECT revision FROM leave_types WHERE id=$1', [id])).rows[0]
          .revision,
        2,
      );
      assert.equal((await f.counts()).central_evidence_events, 2);
      await f.runtime.query(
        "DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='leave.configure'",
        [f.role],
      );
      await assert.rejects(f.accept(f.credentials, input), { code: 'FORBIDDEN' });
    } finally {
      await f.close();
    }
  },
);

test(
  'assignment overlaps and unbound implicit closures are rejected; corrections require reasons',
  acceptanceOptions,
  async () => {
    const f = await acceptanceFixture();
    try {
      const schedule = randomUUID(),
        assignment = randomUUID();
      await f.commit('schedule.create', schedule, 0, f.schedulePayload());
      await f.commit('assignment.create', assignment, 0, f.assignmentPayload(schedule));
      const before = await f.counts();
      const overlap = await f.propose('assignment.create', randomUUID(), 0, {
        ...f.assignmentPayload(schedule),
        effectiveFrom: '2026-02-01',
      });
      await assert.rejects(f.accept(f.credentials, overlap), {
        code: 'EVIDENCE_ASSIGNMENT_OVERLAP',
      });
      const correction = await f.propose('assignment.update', assignment, 1, {
        ...f.assignmentPayload(schedule),
        effectiveFrom: '2099-01-01',
        reason: null,
      });
      await assert.rejects(f.accept(f.credentials, correction), {
        code: 'EVIDENCE_REASON_REQUIRED',
      });
      assert.deepEqual(await f.counts(), before);
      assert.equal(
        (
          await f.runtime.query(
            'SELECT effective_to,revision FROM employee_schedule_assignments WHERE id=$1',
            [assignment],
          )
        ).rows[0].revision,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'schedule dates/timezones/dependencies and cross-organization references fail without partial evidence',
  acceptanceOptions,
  async () => {
    const f = await acceptanceFixture();
    try {
      const id = randomUUID(),
        payload = f.schedulePayload();
      await f.commit('schedule.create', id, 0, payload);
      const before = await f.counts();
      for (const [patch, code] of [
        [{ effectiveFrom: '2025-12-31' }, 'EVIDENCE_EFFECTIVE_DATE_CONFLICT'],
        [{ timezone: 'UTC', effectiveFrom: '2026-02-01' }, 'EVIDENCE_TIMEZONE_MISMATCH'],
        [{ reason: null, effectiveFrom: '2000-01-01' }, 'EVIDENCE_REASON_REQUIRED'],
      ] as const) {
        const input = await f.propose('schedule.update', id, 1, {
          ...payload,
          versionId: randomUUID(),
          ...patch,
        });
        await assert.rejects(f.accept(f.credentials, input), { code });
      }
      const bad = await f.propose('assignment.create', randomUUID(), 0, {
        ...f.assignmentPayload(id),
        employeeId: randomUUID(),
      });
      await assert.rejects(f.accept(f.credentials, bad), { code: 'EVIDENCE_DEPENDENCY_MISSING' });
      const foreign = randomUUID();
      await f.runtime.query(
        "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'F1','Foreign','Employee')",
        [foreign, f.foreignOrg],
      );
      const scoped = await f.propose('assignment.create', randomUUID(), 0, {
        ...f.assignmentPayload(id),
        employeeId: foreign,
      });
      await assert.rejects(f.accept(f.credentials, scoped), {
        code: 'EVIDENCE_DEPENDENCY_MISSING',
      });
      assert.deepEqual(await f.counts(), before);
      await f.commit('schedule.status', id, 1, { status: 'inactive' });
      const inactive = await f.propose(
        'assignment.create',
        randomUUID(),
        0,
        f.assignmentPayload(id),
      );
      await assert.rejects(f.accept(f.credentials, inactive), {
        code: 'EVIDENCE_INACTIVE_SCHEDULE',
      });
    } finally {
      await f.close();
    }
  },
);

test(
  'leave approval policy, snapshots, transitions, overlap and rejection remarks are enforced',
  acceptanceOptions,
  async () => {
    const f = await acceptanceFixture();
    try {
      const type = randomUUID(),
        pending = randomUUID();
      await f.commit('leaveType.create', type, 0, f.typePayload());
      await f.commit('leave.request', pending, 0, f.leavePayload(type));
      const rejection = await f.propose('leave.reject', pending, 1, { remarks: null });
      await assert.rejects(f.accept(f.credentials, rejection), {
        code: 'EVIDENCE_REASON_REQUIRED',
      });
      const overlap = await f.propose('leave.request', randomUUID(), 0, f.leavePayload(type));
      await assert.rejects(f.accept(f.credentials, overlap), { code: '23514' });
      await f.commit('leave.approve', pending, 1, { remarks: null });
      const again = await f.propose('leave.approve', pending, 2, { remarks: null });
      await assert.rejects(f.accept(f.credentials, again), { code: 'EVIDENCE_LEAVE_TRANSITION' });
      await f.commit('leave.cancel', pending, 2, { remarks: null });
      const automaticType = randomUUID(),
        auto = f.typePayload(false);
      await f.commit('leaveType.create', automaticType, 0, auto);
      await f.runtime.query(
        "DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='leave.approve'",
        [f.role],
      );
      const automatic = await f.commit(
        'leave.request',
        randomUUID(),
        0,
        f.leavePayload(automaticType, '2026-03-02'),
      );
      const snapshot = JSON.parse(automatic.acceptance.canonical_snapshot);
      assert.equal(snapshot.status, 'approved');
      assert.equal(snapshot.approvedBy, f.user);
      assert.equal(snapshot.typeSnapshot.requiresApproval, false);
      await f.commit('leaveType.update', automaticType, 1, {
        ...auto,
        status: 'inactive',
        paid: false,
      });
      const inactive = await f.propose(
        'leave.request',
        randomUUID(),
        0,
        f.leavePayload(automaticType, '2026-03-03'),
      );
      await assert.rejects(f.accept(f.credentials, inactive), {
        code: 'EVIDENCE_INACTIVE_LEAVE_TYPE',
      });
      assert.equal(snapshot.typeSnapshot.paid, true);
    } finally {
      await f.close();
    }
  },
);

test(
  'publication and weekday failures roll back aggregate/history/acceptance/event writes; exact retry recovers',
  acceptanceOptions,
  async () => {
    const f = await acceptanceFixture();
    try {
      const input = await f.propose('leaveType.create', randomUUID(), 0, f.typePayload()),
        before = await f.counts();
      await f.migrator.query(
        'ALTER TABLE central_evidence_events ADD CONSTRAINT test_reject_publication CHECK(false)',
      );
      await assert.rejects(f.accept(f.credentials, input), { code: '23514' });
      assert.deepEqual(await f.counts(), before);
      await f.migrator.query(
        'ALTER TABLE central_evidence_events DROP CONSTRAINT test_reject_publication',
      );
      const result = await f.accept(f.credentials, input);
      assert.deepEqual(await f.accept(f.credentials, input), result);
      const schedule = await f.propose('schedule.create', randomUUID(), 0, f.schedulePayload()),
        afterType = await f.counts();
      await f.migrator.query(
        'ALTER TABLE work_schedule_days ADD CONSTRAINT test_reject_weekday CHECK(day_of_week<>3)',
      );
      await assert.rejects(f.accept(f.credentials, schedule), { code: '23514' });
      assert.deepEqual(await f.counts(), afterType);
      await f.migrator.query('ALTER TABLE work_schedule_days DROP CONSTRAINT test_reject_weekday');
      await f.accept(f.credentials, schedule);
      assert.equal((await f.counts()).work_schedule_days, 7);
    } finally {
      await f.close();
    }
  },
);

test(
  'writer privileges allow complete transaction but deny authority edits, canonical attendance and generic transport writes',
  acceptanceOptions,
  async () => {
    const f = await acceptanceFixture();
    try {
      for (const sql of [
        'SELECT password_hash FROM auth_users',
        'UPDATE auth_users SET active=false',
        "UPDATE role_permissions SET permission_code='leave.approve'",
        'INSERT INTO central_attendance_state DEFAULT VALUES',
        'INSERT INTO sync_changes DEFAULT VALUES',
        'INSERT INTO sync_nodes DEFAULT VALUES',
        'INSERT INTO auth_sessions DEFAULT VALUES',
        'DELETE FROM leave_types',
        'CREATE TABLE forbidden_writer_ddl(id integer)',
      ])
        await assert.rejects(f.writer.query(sql), { code: '42501' });
      await assert.rejects(
        f.writer.query('UPDATE auth_users SET id=$1 WHERE id=$2', [randomUUID(), f.user]),
        { code: '42501' },
      );
      const payload = f.typePayload(),
        result = await f.commit('leaveType.create', randomUUID(), 0, payload);
      assert.ok(result.event.event_id);
      await f.migrator.query(
        'REVOKE INSERT ON central_evidence_events FROM hexpayroll_acceptance_test_writer',
      );
      const before = await f.counts(),
        input = await f.propose('leaveType.create', randomUUID(), 0, f.typePayload());
      await assert.rejects(f.accept(f.credentials, input), { code: '42501' });
      assert.deepEqual(await f.counts(), before);
    } finally {
      await f.close();
    }
  },
);
