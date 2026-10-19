import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  scheduleInputSchema,
  scheduleUpdateSchema,
  scheduleStatusInputSchema,
  assignmentInputSchema,
  manualTimeRecordSchema,
  correctionInputSchema,
  biometricBatchSchema,
  leaveTypeInputSchema,
  leaveTypeUpdateSchema,
  leaveInputSchema,
  transitionInputSchema,
  reprocessInputSchema,
  adjustmentInputSchema,
  timekeepingQuerySchema,
  type Permission,
} from '@hexpayroll/shared';
import { requirePermission, normalize, type Actor } from '../foundation/repository.js';
import { authenticate, domainErrors } from './middleware.js';
import { captureLocalConflict } from '../sync/local-conflicts.js';
import {
  organization,
  find,
  createScheduleService,
  createTimeRecordService,
  createLeaveService,
  createAttendanceService,
} from './services.js';
export function createTimekeepingRouter(pool: Pool) {
  const router = Router();
  router.use(authenticate(pool));
  const schedules = createScheduleService(pool),
    records = createTimeRecordService(pool),
    leave = createLeaveService(pool),
    attendance = createAttendanceService(pool);
  const actor = (res: { locals: Record<string, unknown> }, permission: Permission) => {
    const a = res.locals.actor as Actor;
    organization(a);
    requirePermission(a, permission);
    return a;
  };
  const id = (value: unknown) => z.uuid().parse(value);
  router.get('/timekeeping/context', async (_req, res) => {
    const a = res.locals.actor as Actor;
    const org = organization(a);
    const r = await pool.query(
      'SELECT id,timezone,(now() AT TIME ZONE timezone)::date::text date FROM organizations WHERE id=$1',
      [org],
    );
    res.json(r.rows[0]);
  });
  for (const [path, table, permission] of [
    ['schedules', 'work_schedules', 'schedules.view'],
    ['time-records', 'time_records', 'time_records.view'],
    ['leave-types', 'leave_types', 'leave.view'],
    ['leave', 'leave_requests', 'leave.view'],
    ['attendance', 'attendance_records', 'attendance.view'],
  ] as const) {
    router.get('/' + path, async (req, res) => {
      const a = actor(res, permission),
        q = timekeepingQuerySchema.parse(req.query),
        values: unknown[] = [a.organizationId];
      const where = ['r.organization_id=$1'];
      const add = (sql: string, value: unknown) => {
        values.push(value);
        where.push(sql.replace('?', `$${values.length}`));
      };
      let joins = '',
        select = 'r.*',
        order = 'r.created_at DESC,r.id';
      if (table === 'work_schedules') {
        select += `,(SELECT jsonb_agg(jsonb_build_object('dayOfWeek',d.day_of_week,'isWorkDay',d.is_work_day,'startTime',d.start_time,'endTime',d.end_time,'endDayOffset',d.end_day_offset) ORDER BY d.day_of_week) FROM work_schedule_days d WHERE d.version_id=(SELECT id FROM work_schedule_versions WHERE schedule_id=r.id ORDER BY effective_from DESC LIMIT 1)) days`;
        select +=
          ' ,(SELECT count(DISTINCT employee_id)::integer FROM employee_schedule_assignments a WHERE a.schedule_id=r.id AND a.effective_from<=(now() AT TIME ZONE o.timezone)::date AND (a.effective_to IS NULL OR a.effective_to>(now() AT TIME ZONE o.timezone)::date)) assigned_employees';
        joins = ' JOIN organizations o ON o.id=r.organization_id';
      }
      if (['time_records', 'leave_requests', 'attendance_records'].includes(table)) {
        joins =
          ' JOIN employees e ON e.id=r.employee_id JOIN organizations o ON o.id=r.organization_id';
        select += " ,e.first_name||' '||e.last_name employee_name,e.employee_number";
        if (table === 'time_records')
          joins +=
            ' LEFT JOIN LATERAL (SELECT * FROM time_record_corrections WHERE time_record_id=r.id ORDER BY revision DESC LIMIT 1)c ON true';
        const dateExpr =
          table === 'attendance_records'
            ? 'r.work_date'
            : table === 'leave_requests'
              ? 'r.start_date'
              : '(COALESCE(c.recorded_at,r.recorded_at) AT TIME ZONE o.timezone)::date';
        joins += ` LEFT JOIN LATERAL (SELECT department_id FROM employment_versions WHERE employee_id=r.employee_id AND effective_from<=${dateExpr} AND (effective_to IS NULL OR effective_to>${dateExpr}) ORDER BY effective_from DESC LIMIT 1) emp ON true`;
        if (q.employeeId) add('r.employee_id=?', q.employeeId);
        if (q.departmentId) add('emp.department_id=?', q.departmentId);
        if (q.search)
          add(
            "(e.first_name||' '||e.last_name||' '||e.employee_number) ILIKE ?",
            '%' + q.search + '%',
          );
        if (table === 'time_records') {
          joins += ' LEFT JOIN biometric_devices d ON d.id=r.device_id';
          select +=
            ",COALESCE(c.revision,0) correction_revision,c.operation,CASE WHEN c.operation='void' THEN NULL ELSE COALESCE(c.recorded_at,r.recorded_at) END effective_recorded_at,COALESCE(c.record_type,r.record_type) effective_record_type,d.name device_name";
          if (q.source) add('r.source=?', q.source);
          if (q.recordType) add('COALESCE(c.record_type,r.record_type)=?', q.recordType);
          order = 'COALESCE(c.recorded_at,r.recorded_at) DESC,r.id';
        }
        if (table === 'leave_requests') {
          joins += ' JOIN leave_types t ON t.id=r.leave_type_id';
          select += ",r.type_snapshot->>'name' leave_type_name";
          if (q.leaveTypeId) add('r.leave_type_id=?', q.leaveTypeId);
        }
        if (table === 'attendance_records') {
          joins +=
            ' LEFT JOIN employee_schedule_assignments a ON a.id=r.schedule_assignment_id LEFT JOIN work_schedule_versions sv ON sv.id=r.schedule_version_id';
          select += ',sv.name schedule_name';
          if (q.scheduleId) add('a.schedule_id=?', q.scheduleId);
          order = 'r.work_date DESC,e.last_name,r.id';
        }
        if (q.date) {
          if (table === 'leave_requests') {
            add('r.start_date<=?', q.date);
            add('r.end_date>=?', q.date);
          } else add(dateExpr + '=?', q.date);
        }
        if (q.startDate)
          add((table === 'leave_requests' ? 'r.end_date' : dateExpr) + '>=?', q.startDate);
        if (q.endDate) add(dateExpr + '<=?', q.endDate);
      } else if (q.search) add("(r.code||' '||r.name) ILIKE ?", '%' + q.search + '%');
      if (q.status)
        add(table === 'attendance_records' ? 'r.attendance_status=?' : 'r.status=?', q.status);
      const from = `FROM ${table} r${joins} WHERE ${where.join(' AND ')}`;
      const count = await pool.query<{ total: number }>(
        `SELECT count(*)::integer total ${from}`,
        values,
      );
      values.push(q.pageSize, (q.page - 1) * q.pageSize);
      const result = await pool.query(
        `SELECT ${select} ${from} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      res.json({
        items: result.rows.map(normalize),
        total: count.rows[0]!.total,
        page: q.page,
        pageSize: q.pageSize,
      });
    });
  }
  router.post('/schedules', async (req, res) =>
    res
      .status(201)
      .json(
        await schedules.save(actor(res, 'schedules.create'), scheduleInputSchema.parse(req.body)),
      ),
  );
  router.get('/schedules/:id', async (req, res) =>
    res.json(await schedules.detail(actor(res, 'schedules.view'), id(req.params.id))),
  );
  router.put('/schedules/:id', async (req, res) =>
    res.json(
      await schedules.save(
        actor(res, 'schedules.update'),
        scheduleUpdateSchema.parse(req.body),
        id(req.params.id),
      ),
    ),
  );
  router.post('/schedules/:id/status', async (req, res) => {
    const a = actor(res, 'schedules.update'),
      v = scheduleStatusInputSchema.parse(req.body);
    res.json(await schedules.status(a, id(req.params.id), v.status, v.expectedRevision));
  });
  router.get('/employees/:id/schedules', async (req, res) =>
    res.json(await schedules.assignments(actor(res, 'schedules.view'), id(req.params.id))),
  );
  router.post('/employees/:id/schedules', async (req, res) =>
    res
      .status(201)
      .json(
        await schedules.assign(
          actor(res, 'schedules.assign'),
          id(req.params.id),
          assignmentInputSchema.parse(req.body),
        ),
      ),
  );
  router.put('/schedule-assignments/:id', async (req, res) =>
    res.json(
      await schedules.correctAssignment(
        actor(res, 'schedules.assign'),
        id(req.params.id),
        assignmentInputSchema.parse(req.body),
      ),
    ),
  );
  router.post('/time-records/manual', async (req, res) =>
    res
      .status(201)
      .json(
        await records.manual(
          actor(res, 'time_records.create_manual'),
          manualTimeRecordSchema.parse(req.body),
        ),
      ),
  );
  router.post('/time-records/ingest', async (req, res) =>
    res.json(
      await records.ingest(actor(res, 'time_records.ingest'), biometricBatchSchema.parse(req.body)),
    ),
  );
  router.get('/time-records/:id', async (req, res) =>
    res.json(await records.detail(actor(res, 'time_records.view'), id(req.params.id))),
  );
  router.post('/time-records/:id/corrections', async (req, res) =>
    res
      .status(201)
      .json(
        await records.correct(
          actor(res, 'time_records.correct'),
          id(req.params.id),
          correctionInputSchema.parse(req.body),
        ),
      ),
  );
  router.post('/leave-types', async (req, res) =>
    res
      .status(201)
      .json(
        await leave.saveType(actor(res, 'leave.configure'), leaveTypeInputSchema.parse(req.body)),
      ),
  );
  router.get('/leave-types/:id', async (req, res) => {
    const a = actor(res, 'leave.view');
    res.json(await find(pool, 'leave_types', id(req.params.id), organization(a)));
  });
  router.put('/leave-types/:id', async (req, res) =>
    res.json(
      await leave.saveType(
        actor(res, 'leave.configure'),
        leaveTypeUpdateSchema.parse(req.body),
        id(req.params.id),
      ),
    ),
  );
  router.post('/leave', async (req, res) =>
    res
      .status(201)
      .json(await leave.request(actor(res, 'leave.create'), leaveInputSchema.parse(req.body))),
  );
  router.get('/leave/:id', async (req, res) => {
    const a = actor(res, 'leave.view');
    res.json(await find(pool, 'leave_requests', id(req.params.id), organization(a)));
  });
  for (const action of ['approve', 'reject', 'cancel'] as const)
    router.post('/leave/:id/' + action, async (req, res) =>
      res.json(
        await leave.transition(
          actor(res, `leave.${action}`),
          id(req.params.id),
          action,
          transitionInputSchema.parse(req.body),
        ),
      ),
    );
  router.post('/attendance/reprocess', async (req, res) => {
    const a = actor(res, 'attendance.manage'),
      v = reprocessInputSchema.parse(req.body);
    res
      .status(202)
      .json(await attendance.reprocess(a, v.employeeId, v.startDate, v.endDate, v.reason));
  });
  router.get('/attendance/:id', async (req, res) =>
    res.json(await attendance.detail(actor(res, 'attendance.view'), id(req.params.id))),
  );
  router.get('/timekeeping/processing', async (_req, res) => {
    const a = actor(res, 'attendance.view');
    const counts = await pool.query(
      'SELECT count(*)::integer pending,count(*) FILTER(WHERE last_error IS NOT NULL)::integer failed FROM attendance_processing_jobs WHERE organization_id=$1',
      [a.organizationId],
    );
    res.json({ id: a.organizationId, ...counts.rows[0] });
  });
  for (const action of ['approve', 'reopen'] as const)
    router.post('/attendance/:id/' + action, async (req, res) => {
      const a = actor(res, action === 'approve' ? 'attendance.approve' : 'attendance.manage'),
        v = transitionInputSchema.parse(req.body);
      res.json(await attendance.transition(a, id(req.params.id), action, v.expectedRevision));
    });
  router.post('/attendance/:id/adjustments', async (req, res) =>
    res
      .status(201)
      .json(
        await attendance.adjust(
          actor(res, 'attendance.adjust'),
          id(req.params.id),
          adjustmentInputSchema.parse(req.body),
        ),
      ),
  );
  router.use(captureLocalConflict(pool));
  router.use(domainErrors);
  return router;
}
