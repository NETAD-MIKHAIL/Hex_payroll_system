import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import type { Server } from 'node:http';
import { permissionCodes, type FoundationRecord } from '@hexpayroll/shared';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { createAuthService } from '../src/auth/service.js';
import { createFoundationRouter } from '../src/foundation/router.js';
import { createTimekeepingRouter } from '../src/timekeeping/router.js';
import { transaction, normalize, type Actor } from '../src/foundation/repository.js';
import {
  createScheduleService,
  createTimeRecordService,
  createLeaveService,
  createAttendanceService,
  processAttendance,
} from '../src/timekeeping/services.js';
import { processNextJob, scheduleDueAttendance } from '../src/timekeeping/worker.js';

test(
  'persisted timekeeping: evidence, history, approval, permissions, rollback and rerunnable jobs',
  { skip: !databaseTestsEnabled },
  async () => {
    const f = await databaseFixture();
    let server: Server | undefined;
    try {
      await migrate(f.migrator, f.migrations);
      const auth = createAuthService(f.runtime);
      const password = 'Timekeeping integration password 123!';
      const org = (
        await f.runtime.query<{ id: string }>(
          "INSERT INTO organizations(legal_name) VALUES('Timekeeping test') RETURNING id",
        )
      ).rows[0]!.id;
      await f.runtime.query('UPDATE application_setup SET organization_id=$1 WHERE singleton', [
        org,
      ]);
      const user = await auth.createUser({
        username: 'tkadmin',
        displayName: 'Timekeeper',
        password,
      });
      await f.runtime.query(
        "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator' ON CONFLICT DO NOTHING",
        [user.id],
      );
      const actor: Actor = {
        id: user.id,
        organizationId: org,
        permissions: [...permissionCodes],
        roles: ['administrator'],
      };
      const employee = normalize(
        (
          await f.runtime.query(
            "INSERT INTO employees(organization_id,employee_number,first_name,last_name) VALUES($1,'E1','Ana','Reyes') RETURNING *",
            [org],
          )
        ).rows[0],
      );
      const schedules = createScheduleService(f.runtime),
        records = createTimeRecordService(f.runtime),
        leaves = createLeaveService(f.runtime),
        attendance = createAttendanceService(f.runtime);
      const days = Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        isWorkDay: dayOfWeek !== 0 && dayOfWeek !== 6,
        startTime: dayOfWeek !== 0 && dayOfWeek !== 6 ? '08:00' : null,
        endTime: dayOfWeek !== 0 && dayOfWeek !== 6 ? '17:00' : null,
        endDayOffset: 0,
        breakStart: dayOfWeek !== 0 && dayOfWeek !== 6 ? '12:00' : null,
        breakEnd: dayOfWeek !== 0 && dayOfWeek !== 6 ? '13:00' : null,
        breakStartDayOffset: 0,
        breakEndDayOffset: 0,
        graceMinutes: 5,
      }));
      // Keep the later revision after the fixed October 2025 evidence.
      // Use one date consistently across schedule and assignment history.
      const laterEffectiveFrom = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      ).toISOString().slice(0, 10);

      const schedule = await schedules.save(actor, {
        code: 'DAY',
        name: 'Day shift',
        description: null,
        status: 'active',
        effectiveFrom: '2025-01-01',
        reason: 'Historical setup',
        days,
      });
      await schedules.assign(actor, employee.id, {
        scheduleId: schedule.id,
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        reason: 'Historical setup',
        expectedRevision: 1,
      });
      await assert.rejects(
        () =>
          schedules.assign(actor, employee.id, {
            scheduleId: schedule.id,
            effectiveFrom: laterEffectiveFrom,
            effectiveTo: null,
            reason: null,
            expectedRevision: 1,
          }),
        /changed/,
      );
      const device = (
        await f.runtime.query<{ id: string }>(
          "INSERT INTO biometric_devices(organization_id,code,name) VALUES($1,'CLOCK','Clock') RETURNING id",
          [org],
        )
      ).rows[0]!.id;
      await f.runtime.query(
        "INSERT INTO biometric_mappings(organization_id,employee_id,device_id,device_employee_id) VALUES($1,$2,$3,'7')",
        [org, employee.id, device],
      );
      const batch = {
        deviceId: device,
        records: [
          {
            deviceEmployeeId: '7',
            recordedAt: '2025-10-02T08:00:00+08:00',
            recordType: 'in' as const,
            externalRecordId: '1',
          },
          {
            deviceEmployeeId: '7',
            recordedAt: '2025-10-02T17:00:00+08:00',
            recordType: 'out' as const,
            externalRecordId: '2',
          },
        ],
      };
      assert.equal((await records.ingest(actor, batch)).inserted, 2);
      assert.equal((await records.ingest(actor, batch)).duplicates, 2);
      await assert.rejects(
        () =>
          records.ingest(actor, {
            ...batch,
            records: [{ ...batch.records[0]!, recordedAt: '2025-10-02T08:03:00+08:00' }],
          }),
        /reused/,
      );
      assert.deepEqual(
        (
          await records.ingest(actor, {
            deviceId: device,
            records: [
              { ...batch.records[0]!, deviceEmployeeId: 'unmapped', externalRecordId: '3' },
            ],
          })
        ).unmatched,
        ['unmapped'],
      );
      const process = (date: string) =>
        transaction(f.runtime, (c) =>
          processAttendance(c, actor, employee.id, date, Date.parse('2026-12-01T00:00:00Z')),
        );
      let daily = await process('2025-10-02');
      assert.equal(daily.workedMinutes, 480);
      assert.equal(daily.attendanceStatus, 'present');
      assert.equal((await process('2025-10-02')).revision, daily.revision);
      // Remove fixture's long historical jobs, then approve a completed calculation.
      await f.runtime.query('DELETE FROM attendance_processing_jobs');
      daily = await attendance.transition(actor, daily.id, 'approve', Number(daily.revision));
      assert.equal(daily.approvalStatus, 'approved');
      await attendance.reprocess(actor, employee.id, '2025-10-02', '2025-10-02');
      assert.equal(await processNextJob(f.runtime), true);
      daily = await attendance.detail(actor, daily.id);
      assert.equal(daily.approvalStatus, 'approved');
      const raw = (
        await f.runtime.query<{ id: string }>(
          "SELECT id FROM time_records WHERE external_record_id='1'",
        )
      ).rows[0]!.id;
      await records.correct(actor, raw, {
        operation: 'replace',
        recordedAt: '2025-10-02T08:12:00+08:00',
        recordType: 'in',
        reason: 'Reviewed correction',
        expectedRevision: 0,
      });
      assert.equal((await attendance.detail(actor, daily.id)).approvalStatus, 'needs_review');
      await assert.rejects(
        () =>
          records.correct(actor, raw, {
            operation: 'void',
            recordedAt: null,
            recordType: null,
            reason: 'Stale correction',
            expectedRevision: 0,
          }),
        /changed/,
      );
      daily = await process('2025-10-02');
      assert.equal(daily.lateMinutes, 12);
      assert.equal(daily.workedMinutes, 468);
      assert.ok(
        ((await records.detail(actor, raw)).corrections as FoundationRecord[]).length === 1,
      );
      assert.equal(
        (
          await f.runtime.query('SELECT recorded_at FROM time_records WHERE id=$1', [raw])
        ).rows[0].recorded_at.toISOString(),
        '2025-10-02T00:00:00.000Z',
      );
      await assert.rejects(
        () => f.runtime.query("UPDATE time_records SET reason='destroy' WHERE id=$1", [raw]),
        (e) => Boolean(e && typeof e === 'object' && 'code' in e && e.code === '42501'),
      );
      const type = await leaves.saveType(actor, {
        code: 'VL',
        name: 'Vacation',
        description: null,
        status: 'active',
        paid: true,
        requiresApproval: true,
      });
      const leave = await leaves.request(actor, {
        employeeId: employee.id,
        leaveTypeId: type.id,
        startDate: '2025-10-06',
        endDate: '2025-10-06',
        durationType: 'full_day',
        reason: 'Vacation',
      });
      assert.equal((await process('2025-10-06')).attendanceStatus, 'absent');
      await leaves.transition(actor, leave.id, 'approve', {
        expectedRevision: 1,
        remarks: 'Approved',
      });
      assert.equal((await process('2025-10-06')).attendanceStatus, 'on_leave');
      await leaves.transition(actor, leave.id, 'cancel', {
        expectedRevision: 2,
        remarks: 'Cancelled',
      });
      assert.equal((await process('2025-10-06')).attendanceStatus, 'absent');
      const first = await leaves.request(actor, {
        employeeId: employee.id,
        leaveTypeId: type.id,
        startDate: '2025-10-07',
        endDate: '2025-10-07',
        durationType: 'first_half',
        reason: 'Appointment',
      });
      await leaves.request(actor, {
        employeeId: employee.id,
        leaveTypeId: type.id,
        startDate: '2025-10-07',
        endDate: '2025-10-07',
        durationType: 'second_half',
        reason: 'Appointment',
      });
      await assert.rejects(() =>
        leaves.request(actor, {
          employeeId: employee.id,
          leaveTypeId: type.id,
          startDate: '2025-10-07',
          endDate: '2025-10-07',
          durationType: 'full_day',
          reason: 'Overlapping',
        }),
      );
      await leaves.transition(actor, first.id, 'reject', {
        expectedRevision: 1,
        remarks: 'Rejected',
      });
      assert.equal((await process('2025-10-07')).attendanceStatus, 'absent');
      const manual = await records.manual(actor, {
        employeeId: employee.id,
        recordedAt: '2025-10-08T08:00:00+08:00',
        recordType: 'in',
        reason: 'Device unavailable',
      });
      assert.equal(manual.source, 'manual');
      assert.equal((await process('2025-10-08')).attendanceStatus, 'incomplete');
      await schedules.save(
        actor,
        {
          code: 'DAY',
          name: 'Later shift',
          description: null,
          status: 'active',
          effectiveFrom: laterEffectiveFrom,
          reason: 'Historical schedule revision for regression testing',
          days: days.map((d) => (d.isWorkDay ? { ...d, startTime: '09:00', endTime: '18:00' } : d)),
          expectedRevision: 1,
        },
        schedule.id,
      );
      assert.equal((await process('2025-10-02')).lateMinutes, 12);
      const historyBefore = (
        await f.runtime.query(
          'SELECT count(*)::integer n FROM attendance_history WHERE attendance_id=$1',
          [daily.id],
        )
      ).rows[0].n;
      daily = await attendance.adjust(actor, daily.id, {
        expectedRevision: Number(daily.revision),
        reason: 'Reviewed late minutes',
        overrides: { lateMinutes: 10 },
      });
      assert.equal(daily.lateMinutes, 10);
      assert.equal(daily.approvalStatus, 'needs_review');
      assert.equal((await process('2025-10-02')).lateMinutes, 10);
      assert.ok(
        (
          await f.runtime.query(
            'SELECT count(*)::integer n FROM attendance_history WHERE attendance_id=$1',
            [daily.id],
          )
        ).rows[0].n > historyBefore,
      );
      await schedules.assign(actor, employee.id, {
        scheduleId: schedule.id,
        effectiveFrom: laterEffectiveFrom,
        effectiveTo: null,
        expectedRevision: 2,
        reason: 'Future assignment',
      });
      const assignments = await schedules.assignments(actor, employee.id);
      const historical = assignments.find((a) => a.effectiveFrom === '2025-01-01')!;
      assert.equal(historical.effectiveTo, laterEffectiveFrom);
      assert.ok((historical.history as unknown[]).length > 0);
      await schedules.correctAssignment(actor, historical.id, {
        scheduleId: schedule.id,
        effectiveFrom: '2025-01-02',
        effectiveTo: laterEffectiveFrom,
        expectedRevision: Number(historical.revision),
        reason: 'Correct start date',
      });
      await assert.rejects(
        () =>
          schedules.correctAssignment(actor, historical.id, {
            scheduleId: schedule.id,
            effectiveFrom: '2025-01-03',
            effectiveTo: laterEffectiveFrom,
            expectedRevision: Number(historical.revision),
            reason: 'Stale correction',
          }),
        /changed/,
      );
      const nightEmployee = normalize(
        (
          await f.runtime.query(
            "INSERT INTO employees(organization_id,employee_number,first_name,last_name) VALUES($1,'E2','Night','Worker') RETURNING *",
            [org],
          )
        ).rows[0],
      );
      const night = await schedules.save(actor, {
        code: 'NIGHT',
        name: 'Night shift',
        description: null,
        status: 'active',
        effectiveFrom: '2025-01-01',
        reason: 'Historical shift',
        days: days.map((d) =>
          d.isWorkDay
            ? {
                ...d,
                startTime: '22:00',
                endTime: '06:00',
                endDayOffset: 1,
                breakStart: '02:00',
                breakEnd: '03:00',
                breakStartDayOffset: 1,
                breakEndDayOffset: 1,
              }
            : d,
        ),
      });
      await schedules.assign(actor, nightEmployee.id, {
        scheduleId: night.id,
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        expectedRevision: 1,
        reason: 'Historical assignment',
      });
      await records.manual(actor, {
        employeeId: nightEmployee.id,
        recordedAt: '2025-10-03T22:00:00+08:00',
        recordType: 'in',
        reason: 'Night start',
      });
      await records.manual(actor, {
        employeeId: nightEmployee.id,
        recordedAt: '2025-10-04T06:00:00+08:00',
        recordType: 'out',
        reason: 'Night end',
      });
      const nightResult = await transaction(f.runtime, (c) =>
        processAttendance(
          c,
          actor,
          nightEmployee.id,
          '2025-10-03',
          Date.parse('2026-12-01T00:00:00Z'),
        ),
      );
      assert.equal(nightResult.workedMinutes, 420);
      assert.equal(nightResult.attendanceStatus, 'present');
      const fallback = {
        deviceId: device,
        records: [
          {
            deviceEmployeeId: '7',
            recordedAt: '2025-10-09T08:00:00+08:00',
            recordType: 'in' as const,
            externalRecordId: null,
          },
        ],
      };
      assert.equal((await records.ingest(actor, fallback)).inserted, 1);
      assert.equal((await records.ingest(actor, fallback)).duplicates, 1);
      await f.runtime.query('DELETE FROM attendance_processing_jobs');
      await scheduleDueAttendance(f.runtime);
      assert.ok(
        (
          await f.runtime.query(
            'SELECT 1 FROM attendance_processing_jobs WHERE requested_by IS NULL',
          )
        ).rowCount,
      );
      assert.equal(await processNextJob(f.runtime), true);
      await f.runtime.query('DELETE FROM attendance_processing_jobs');
      // Outbox failure must roll back the punch, audit and pending job together.
      await f.migrator.query(
        "CREATE FUNCTION reject_tk_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Outbox unavailable'; END $$",
      );
      await f.migrator.query(
        'CREATE TRIGGER reject_tk_outbox BEFORE INSERT ON sync_outbox FOR EACH ROW EXECUTE FUNCTION reject_tk_outbox()',
      );
      const before = (await f.runtime.query('SELECT count(*)::integer n FROM time_records')).rows[0]
        .n;
      await assert.rejects(() =>
        records.manual(actor, {
          employeeId: employee.id,
          recordedAt: '2025-10-09T08:00:00+08:00',
          recordType: 'in',
          reason: 'Rollback test',
        }),
      );
      assert.equal(
        (await f.runtime.query('SELECT count(*)::integer n FROM time_records')).rows[0].n,
        before,
      );
      await f.runtime.query('DELETE FROM attendance_processing_jobs');
      await attendance.reprocess(
        actor,
        employee.id,
        '2025-10-10',
        '2025-10-10',
        'Worker recovery test',
      );
      assert.equal(await processNextJob(f.runtime), true);
      const failed = (await f.runtime.query('SELECT * FROM attendance_processing_jobs')).rows[0];
      assert.equal(failed.next_date, '2025-10-10');
      assert.ok(failed.last_error);
      assert.equal(failed.reason, 'Worker recovery test');
      assert.equal(
        (
          await f.runtime.query(
            "SELECT 1 FROM attendance_records WHERE employee_id=$1 AND work_date='2025-10-10'",
            [employee.id],
          )
        ).rowCount,
        0,
      );
      await f.migrator.query('DROP TRIGGER reject_tk_outbox ON sync_outbox');
      await attendance.reprocess(
        actor,
        employee.id,
        '2025-10-10',
        '2025-10-10',
        'Retry after repair',
      );
      assert.equal(await processNextJob(f.runtime), true);
      assert.equal((await process('2025-10-10')).attendanceStatus, 'absent');
      const overlapping = await Promise.allSettled(
        [1, 2].map((n) =>
          leaves.request(actor, {
            employeeId: employee.id,
            leaveTypeId: type.id,
            startDate: '2025-10-13',
            endDate: '2025-10-13',
            durationType: 'full_day',
            reason: 'Concurrent request ' + n,
          }),
        ),
      );
      assert.equal(overlapping.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(overlapping.filter((r) => r.status === 'rejected').length, 1);
      const independentTimezone = await transaction(f.runtime, async (c) => {
        await c.query("SET LOCAL TIME ZONE 'America/New_York'");
        return processAttendance(
          c,
          actor,
          nightEmployee.id,
          '2025-10-03',
          Date.parse('2026-12-01T00:00:00Z'),
        );
      });
      assert.equal(independentTimezone.workedMinutes, 420);
      assert.equal(independentTimezone.attendanceStatus, 'present');
      const session = await auth.login({ identifier: 'tkadmin', password });
      assert(session);
      const viewer = await auth.createUser({
        username: 'tkviewer',
        displayName: 'Viewer',
        password,
      });
      await f.runtime.query('UPDATE auth_users SET organization_id=$1 WHERE id=$2', [
        org,
        viewer.id,
      ]);
      await f.runtime.query(
        "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='viewer' ON CONFLICT DO NOTHING",
        [viewer.id],
      );
      const viewerSession = await auth.login({ identifier: 'tkviewer', password });
      assert(viewerSession);
      const app = express();
      app.use(express.json());
      app.use('/api', createTimekeepingRouter(f.runtime));
      app.use('/api', createFoundationRouter(f.runtime));
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert(address && typeof address === 'object');
      const base = `http://127.0.0.1:${address.port}/api/`;
      const request = async (
        path: string,
        method = 'GET',
        body?: unknown,
        token = session.accessToken,
      ) => {
        const r = await fetch(base + path, {
          method,
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: r.status, data: (await r.json()) as Record<string, unknown> };
      };
      for (const path of [
        'attendance?date=2025-10-02',
        'time-records?date=2025-10-02',
        'schedules',
        'leave',
        'leave-types',
        'dashboard/summary',
      ]) {
        const r = await request(path);
        assert.equal(r.status, 200, JSON.stringify(r.data));
      }
      for (const [path, body] of [
        ['time-records/manual', { employeeId: employee.id }],
        ['employees/' + employee.id + '/schedules', {}],
        ['leave/' + leave.id + '/approve', { expectedRevision: 1 }],
        ['attendance/' + daily.id + '/adjustments', {}],
      ] as const)
        assert.equal((await request(path, 'POST', body, viewerSession.accessToken)).status, 403);
      const other = (
        await f.runtime.query<{ id: string }>(
          "INSERT INTO organizations(legal_name) VALUES('Other') RETURNING id",
        )
      ).rows[0]!.id;
      const foreign = (
        await f.runtime.query<{ id: string }>(
          "INSERT INTO employees(organization_id,employee_number,first_name,last_name) VALUES($1,'OTHER','Other','Person') RETURNING id",
          [other],
        )
      ).rows[0]!.id;
      assert.equal(
        (
          await request('time-records/manual', 'POST', {
            employeeId: foreign,
            recordedAt: '2025-10-02T08:00:00+08:00',
            recordType: 'in',
            reason: 'Wrong organization',
          })
        ).status,
        404,
      );
      assert.ok(
        (
          await f.runtime.query(
            "SELECT 1 FROM audit_events WHERE entity_type='time_record_corrections'",
          )
        ).rowCount,
      );
      assert.ok(
        (await f.runtime.query("SELECT 1 FROM sync_outbox WHERE entity_type='attendance_records'"))
          .rowCount,
      );
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((e) => (e ? reject(e) : resolve())),
        );
      await f.close();
    }
  },
);
