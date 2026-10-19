import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import type {
  scheduleInputSchema,
  scheduleUpdateSchema,
  assignmentInputSchema,
  manualTimeRecordSchema,
  correctionInputSchema,
  biometricBatchSchema,
  leaveTypeInputSchema,
  leaveTypeUpdateSchema,
  leaveInputSchema,
  transitionInputSchema,
  adjustmentInputSchema,
  FoundationRecord,
  TimeRecordType,
} from '@hexpayroll/shared';
import {
  DomainError,
  transaction,
  insert,
  update,
  normalize,
  audit,
  outbox,
  type Actor,
} from '../foundation/repository.js';
import { interpretAttendance, type Shift, type Punch } from './processor.js';
type Database = Pool | PoolClient;
export type ProcessingActor = Omit<Actor, 'id'> & { id: string | null };
export function organization(actor: Pick<Actor, 'organizationId'>): string {
  if (!actor.organizationId)
    throw new DomainError(409, 'SETUP_REQUIRED', 'Complete organization setup first');
  return actor.organizationId;
}
export const nextDate = (date: string, days = 1) =>
  new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
export async function today(db: Database, org: string): Promise<string> {
  return (
    await db.query<{ date: string }>(
      'SELECT (now() AT TIME ZONE timezone)::date::text date FROM organizations WHERE id=$1',
      [org],
    )
  ).rows[0]!.date;
}
export async function find(
  db: Database,
  table: string,
  id: string,
  org: string,
  lock = false,
): Promise<FoundationRecord> {
  const allowed = [
    'work_schedules',
    'employees',
    'time_records',
    'leave_types',
    'leave_requests',
    'attendance_records',
    'employee_schedule_assignments',
    'biometric_devices',
  ];
  if (!allowed.includes(table)) throw new Error('Invalid entity');
  const r = await db.query(
    `SELECT * FROM ${table} WHERE id=$1 AND organization_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [id, org],
  );
  if (!r.rows[0]) throw new DomainError(404, 'NOT_FOUND', 'Record not found');
  return normalize(r.rows[0]);
}
async function publish(
  client: PoolClient,
  actor: ProcessingActor,
  table: string,
  row: FoundationRecord,
  operation = 'CREATE',
  fields: string[] = [],
) {
  await audit(client, actor, operation, table, row.id, fields);
  await outbox(client, table, row, operation);
}
async function advanceEmployee(c: PoolClient, actor: Actor, employeeId: string) {
  const row = normalize(
    (
      await c.query(
        'UPDATE employees SET revision=revision+1,updated_at=now(),updated_by=$2 WHERE id=$1 RETURNING *',
        [employeeId, actor.id],
      )
    ).rows[0],
  );
  row.employmentVersions = (
    await c.query(
      'SELECT * FROM employment_versions WHERE employee_id=$1 ORDER BY effective_from',
      [employeeId],
    )
  ).rows.map(normalize);
  await publish(c, actor, 'employees', row, 'UPDATE', ['scheduleAssignments']);
}
async function archiveAssignment(c: PoolClient, row: FoundationRecord) {
  await c.query(
    'INSERT INTO schedule_assignment_history(organization_id,assignment_id,revision,snapshot) VALUES($1,$2,$3,$4)',
    [row.organizationId, row.id, row.revision, JSON.stringify(row)],
  );
}
export async function enqueue(
  client: PoolClient,
  actor: ProcessingActor,
  employeeId: string,
  start: string,
  end: string,
  invalidate = true,
  reason: string | null = null,
) {
  if (start > end) return;
  await client.query(
    'INSERT INTO attendance_processing_jobs(organization_id,employee_id,start_date,end_date,next_date,requested_by,priority,reason) VALUES($1,$2,$3,$4,$3,$5,$6,$7)',
    [
      organization(actor),
      employeeId,
      start,
      end,
      actor.id,
      Date.parse(end) - Date.parse(start) <= 7 * 86400000 ? 10 : 0,
      reason,
    ],
  );
  if (!invalidate) return;
  // Approval is immediately invalidated, before the asynchronous calculation runs.
  const affected = await client.query(
    "SELECT * FROM attendance_records WHERE organization_id=$1 AND employee_id=$2 AND work_date BETWEEN $3 AND $4 AND approval_status='approved' FOR UPDATE",
    [actor.organizationId, employeeId, start, end],
  );
  for (const raw of affected.rows) {
    const old = normalize(raw);
    await archive(client, old);
    const row = await update(
      client,
      'attendance_records',
      old.id,
      organization(actor),
      Number(old.revision),
      { approvalStatus: 'needs_review', approvedBy: null, approvedAt: null },
      actor,
    );
    await publish(client, actor, 'attendance_records', row, 'UPDATE', ['approvalStatus']);
  }
}
async function enqueuePunch(
  client: PoolClient,
  actor: Actor,
  employeeId: string,
  timestamp: string,
) {
  const r = await client.query<{ date: string }>(
    'SELECT ($1::timestamptz AT TIME ZONE timezone)::date::text date FROM organizations WHERE id=$2',
    [timestamp, organization(actor)],
  );
  const date = r.rows[0]!.date;
  await enqueue(client, actor, employeeId, nextDate(date, -2), nextDate(date, 2));
}
async function requireBackdate(
  client: PoolClient,
  actor: Actor,
  date: string,
  reason: string | null,
) {
  if (date < (await today(client, organization(actor))) && !reason)
    throw new DomainError(400, 'INVALID_REQUEST', 'Backdated changes require a reason');
}

export function createScheduleService(pool: Pool) {
  return {
    async save(
      actor: Actor,
      input: z.infer<typeof scheduleInputSchema> | z.infer<typeof scheduleUpdateSchema>,
      id?: string,
    ) {
      return transaction(pool, async (c) => {
        const org = organization(actor);
        await requireBackdate(c, actor, input.effectiveFrom, input.reason);
        const { days, effectiveFrom, reason, ...rest } = input;
        const { expectedRevision: unused, ...master } = rest as typeof rest & {
          expectedRevision?: number;
        };
        void unused;
        const schedule = id
          ? await update(
              c,
              'work_schedules',
              id,
              org,
              Number((input as z.infer<typeof scheduleUpdateSchema>).expectedRevision),
              master,
              actor,
            )
          : await insert(c, 'work_schedules', {
              ...master,
              organizationId: org,
              updatedBy: actor.id,
            });
        if (id) {
          const latest = await c.query<{ effective_from: string }>(
            'SELECT effective_from FROM work_schedule_versions WHERE schedule_id=$1 ORDER BY effective_from DESC LIMIT 1',
            [id],
          );
          if (latest.rows[0] && effectiveFrom <= latest.rows[0].effective_from)
            throw new DomainError(
              400,
              'INVALID_REQUEST',
              'New schedule version must follow the latest effective date',
            );
        }
        const timezone = (
          await c.query<{ timezone: string }>('SELECT timezone FROM organizations WHERE id=$1', [
            org,
          ])
        ).rows[0]!.timezone;
        const version = await insert(c, 'work_schedule_versions', {
          organizationId: org,
          scheduleId: schedule.id,
          effectiveFrom,
          reason,
          timezone,
          name: master.name,
          code: master.code,
          createdBy: actor.id,
        });
        const savedDays = [];
        for (const d of days)
          savedDays.push(
            await insert(c, 'work_schedule_days', {
              ...d,
              organizationId: org,
              versionId: version.id,
            }),
          );
        version.days = savedDays;
        await publish(
          c,
          actor,
          'work_schedules',
          schedule,
          id ? 'UPDATE' : 'CREATE',
          Object.keys(master),
        );
        await publish(c, actor, 'work_schedule_versions', version);
        const date = await today(c, org);
        const assignments = await c.query<{
          employee_id: string;
          effective_from: string;
          effective_to: string | null;
        }>(
          'SELECT * FROM employee_schedule_assignments WHERE organization_id=$1 AND schedule_id=$2 AND (effective_to IS NULL OR effective_to>$3)',
          [org, schedule.id, effectiveFrom],
        );
        for (const a of assignments.rows)
          await enqueue(
            c,
            actor,
            a.employee_id,
            a.effective_from > effectiveFrom ? a.effective_from : effectiveFrom,
            a.effective_to && a.effective_to <= date ? nextDate(a.effective_to, -1) : date,
          );
        return schedule;
      });
    },
    async status(actor: Actor, id: string, status: string, revision: number) {
      return transaction(pool, async (c) => {
        const row = await update(
          c,
          'work_schedules',
          id,
          organization(actor),
          revision,
          { status },
          actor,
        );
        await publish(c, actor, 'work_schedules', row, 'UPDATE', ['status']);
        return row;
      });
    },
    async detail(actor: Actor, id: string) {
      const org = organization(actor),
        row = await find(pool, 'work_schedules', id, org);
      const versions = await pool.query(
        'SELECT * FROM work_schedule_versions WHERE schedule_id=$1 AND organization_id=$2 ORDER BY effective_from DESC',
        [id, org],
      );
      row.versions = await Promise.all(
        versions.rows.map(async (raw) => {
          const v = normalize(raw);
          v.days = (
            await pool.query(
              'SELECT * FROM work_schedule_days WHERE version_id=$1 ORDER BY day_of_week',
              [v.id],
            )
          ).rows.map((r) => {
            const d = normalize(r);
            for (const k of ['startTime', 'endTime', 'breakStart', 'breakEnd'])
              if (typeof d[k] === 'string') d[k] = String(d[k]).slice(0, 5);
            return d;
          });
          return v;
        }),
      );
      return row;
    },
    async assign(actor: Actor, employeeId: string, input: z.infer<typeof assignmentInputSchema>) {
      return transaction(pool, async (c) => {
        const org = organization(actor);
        const employee = await find(c, 'employees', employeeId, org, true);
        if (employee.revision !== input.expectedRevision)
          throw new DomainError(409, 'CONFLICT', 'Employee changed; reload');
        await requireBackdate(c, actor, input.effectiveFrom, input.reason);
        const schedule = await find(c, 'work_schedules', input.scheduleId, org, true);
        if (schedule.status !== 'active')
          throw new DomainError(400, 'INVALID_REQUEST', 'Schedule is inactive');
        if (
          !(
            await c.query(
              'SELECT 1 FROM work_schedule_versions WHERE schedule_id=$1 AND effective_from<=$2',
              [schedule.id, input.effectiveFrom],
            )
          ).rowCount
        )
          throw new DomainError(400, 'INVALID_REQUEST', 'Schedule has no applicable version');
        const active = await c.query(
          'SELECT * FROM employee_schedule_assignments WHERE employee_id=$1 AND effective_from<$2 AND (effective_to IS NULL OR effective_to>$2) FOR UPDATE',
          [employeeId, input.effectiveFrom],
        );
        for (const raw of active.rows) {
          const old = normalize(raw);
          await archiveAssignment(c, old);
          const closed = await update(
            c,
            'employee_schedule_assignments',
            old.id,
            org,
            Number(old.revision),
            { effectiveTo: input.effectiveFrom },
            actor,
          );
          await publish(c, actor, 'employee_schedule_assignments', closed, 'UPDATE', [
            'effectiveTo',
          ]);
        }
        const row = await insert(c, 'employee_schedule_assignments', {
          organizationId: org,
          employeeId,
          scheduleId: input.scheduleId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          reason: input.reason,
          updatedBy: actor.id,
        });
        // Employee revision guards the assignment aggregate; keep the workforce sync snapshot intact.
        await advanceEmployee(c, actor, employeeId);
        await publish(c, actor, 'employee_schedule_assignments', row);
        const end = await today(c, org);
        await enqueue(
          c,
          actor,
          employeeId,
          input.effectiveFrom,
          input.effectiveTo && input.effectiveTo <= end ? nextDate(input.effectiveTo, -1) : end,
        );
        return row;
      });
    },
    async correctAssignment(
      actor: Actor,
      id: string,
      input: z.infer<typeof assignmentInputSchema>,
    ) {
      return transaction(pool, async (c) => {
        const org = organization(actor),
          initial = await find(c, 'employee_schedule_assignments', id, org);
        await find(c, 'employees', String(initial.employeeId), org, true);
        const old = await find(c, 'employee_schedule_assignments', id, org, true);
        if (!input.reason)
          throw new DomainError(400, 'INVALID_REQUEST', 'Assignment corrections require a reason');
        const schedule = await find(c, 'work_schedules', input.scheduleId, org, true);
        if (schedule.status !== 'active')
          throw new DomainError(400, 'INVALID_REQUEST', 'Schedule is inactive');
        if (
          !(
            await c.query(
              'SELECT 1 FROM work_schedule_versions WHERE schedule_id=$1 AND effective_from<=$2',
              [schedule.id, input.effectiveFrom],
            )
          ).rowCount
        )
          throw new DomainError(400, 'INVALID_REQUEST', 'Schedule has no applicable version');
        await archiveAssignment(c, old);
        const row = await update(
          c,
          'employee_schedule_assignments',
          id,
          org,
          input.expectedRevision,
          {
            scheduleId: input.scheduleId,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo,
            reason: input.reason,
          },
          actor,
        );
        await advanceEmployee(c, actor, String(old.employeeId));
        await publish(c, actor, 'employee_schedule_assignments', row, 'UPDATE', [
          'scheduleId',
          'effectiveFrom',
          'effectiveTo',
          'reason',
        ]);
        const date = await today(c, org);
        const start =
          String(old.effectiveFrom) < input.effectiveFrom
            ? String(old.effectiveFrom)
            : input.effectiveFrom;
        const oldEnd = old.effectiveTo ? nextDate(String(old.effectiveTo), -1) : date,
          newEnd = input.effectiveTo ? nextDate(input.effectiveTo, -1) : date;
        await enqueue(c, actor, String(old.employeeId), start, oldEnd > newEnd ? oldEnd : newEnd);
        return row;
      });
    },
    async assignments(actor: Actor, employeeId: string) {
      await find(pool, 'employees', employeeId, organization(actor));
      const rows = (
        await pool.query(
          'SELECT a.*,s.name schedule_name FROM employee_schedule_assignments a JOIN work_schedules s ON s.id=a.schedule_id WHERE a.organization_id=$1 AND a.employee_id=$2 ORDER BY effective_from DESC',
          [actor.organizationId, employeeId],
        )
      ).rows.map(normalize);
      const date = await today(pool, organization(actor));
      return Promise.all(
        rows.map(async (row) => {
          const applicable =
            String(row.effectiveFrom) > date
              ? String(row.effectiveFrom)
              : row.effectiveTo && String(row.effectiveTo) <= date
                ? nextDate(String(row.effectiveTo), -1)
                : date;
          const version = await pool.query<{ name: string }>(
            'SELECT name FROM work_schedule_versions WHERE schedule_id=$1 AND effective_from<=$2 ORDER BY effective_from DESC LIMIT 1',
            [row.scheduleId, applicable],
          );
          row.scheduleName = version.rows[0]?.name ?? row.scheduleName;
          row.days = (
            await pool.query(
              'SELECT d.* FROM work_schedule_days d WHERE version_id=(SELECT id FROM work_schedule_versions WHERE schedule_id=$1 AND effective_from<=$2 ORDER BY effective_from DESC LIMIT 1) ORDER BY day_of_week',
              [row.scheduleId, applicable],
            )
          ).rows.map((raw) => {
            const d = normalize(raw);
            for (const key of ['startTime', 'endTime', 'breakStart', 'breakEnd'])
              if (typeof d[key] === 'string') d[key] = String(d[key]).slice(0, 5);
            return d;
          });
          row.history = (
            await pool.query(
              'SELECT revision,snapshot,created_at FROM schedule_assignment_history WHERE assignment_id=$1 ORDER BY revision DESC',
              [row.id],
            )
          ).rows;
          return row;
        }),
      );
    },
  };
}

export function createTimeRecordService(pool: Pool) {
  return {
    async manual(actor: Actor, input: z.infer<typeof manualTimeRecordSchema>) {
      return transaction(pool, async (c) => {
        await find(c, 'employees', input.employeeId, organization(actor), true);
        const row = await insert(c, 'time_records', {
          ...input,
          organizationId: actor.organizationId,
          source: 'manual',
          createdBy: actor.id,
        });
        await publish(c, actor, 'time_records', row);
        await enqueuePunch(c, actor, input.employeeId, input.recordedAt);
        return row;
      });
    },
    async correct(actor: Actor, id: string, input: z.infer<typeof correctionInputSchema>) {
      return transaction(pool, async (c) => {
        const org = organization(actor);
        const record = await find(c, 'time_records', id, org);
        await find(c, 'employees', String(record.employeeId), org, true);
        const previous = await c.query(
          'SELECT * FROM time_record_corrections WHERE time_record_id=$1 ORDER BY revision DESC LIMIT 1',
          [id],
        );
        const latest = previous.rows[0] ? normalize(previous.rows[0]) : null;
        if (Number(latest?.revision ?? 0) !== input.expectedRevision)
          throw new DomainError(409, 'CONFLICT', 'Correction changed; reload');
        const row = await insert(c, 'time_record_corrections', {
          organizationId: org,
          timeRecordId: id,
          operation: input.operation,
          recordedAt: input.recordedAt,
          recordType: input.recordType,
          reason: input.reason,
          revision: input.expectedRevision + 1,
          createdBy: actor.id,
        });
        await publish(c, actor, 'time_record_corrections', row);
        await enqueuePunch(c, actor, String(record.employeeId), String(record.recordedAt));
        if (latest?.recordedAt)
          await enqueuePunch(c, actor, String(record.employeeId), String(latest.recordedAt));
        if (input.recordedAt)
          await enqueuePunch(c, actor, String(record.employeeId), input.recordedAt);
        return row;
      });
    },
    async ingest(actor: Actor, input: z.infer<typeof biometricBatchSchema>) {
      return transaction(pool, async (c) => {
        const org = organization(actor);
        const device = await find(c, 'biometric_devices', input.deviceId, org, true);
        if (device.status !== 'active')
          throw new DomainError(400, 'INVALID_REQUEST', 'Device inactive');
        let inserted = 0,
          duplicates = 0;
        const unmatched: string[] = [];
        let last: string | null = null;
        for (const p of input.records) {
          const mappings = await c.query<{ employee_id: string }>(
            "SELECT employee_id FROM biometric_mappings WHERE organization_id=$1 AND device_id=$2 AND device_employee_id=$3 AND status='active'",
            [org, input.deviceId, p.deviceEmployeeId],
          );
          if (!mappings.rows[0]) {
            unmatched.push(p.deviceEmployeeId);
            continue;
          }
          const employeeId = mappings.rows[0].employee_id;
          await find(c, 'employees', employeeId, org, true);
          const existing = await c.query(
            p.externalRecordId
              ? 'SELECT * FROM time_records WHERE device_id=$1 AND external_record_id=$2'
              : 'SELECT * FROM time_records WHERE device_id=$1 AND device_employee_id=$2 AND recorded_at=$3 AND record_type=$4 AND external_record_id IS NULL',
            p.externalRecordId
              ? [input.deviceId, p.externalRecordId]
              : [input.deviceId, p.deviceEmployeeId, p.recordedAt, p.recordType],
          );
          if (existing.rows[0]) {
            const old = normalize(existing.rows[0]);
            if (
              old.employeeId !== employeeId ||
              old.deviceEmployeeId !== p.deviceEmployeeId ||
              Date.parse(String(old.recordedAt)) !== Date.parse(p.recordedAt) ||
              old.recordType !== p.recordType
            )
              throw new DomainError(
                409,
                'CONFLICT',
                'External record ID reused with different evidence',
              );
            duplicates++;
          } else {
            const row = await insert(c, 'time_records', {
              ...p,
              deviceId: input.deviceId,
              employeeId,
              organizationId: org,
              source: 'biometric',
              createdBy: actor.id,
            });
            await publish(c, actor, 'time_records', row);
            await enqueuePunch(c, actor, employeeId, p.recordedAt);
            inserted++;
          }
          if (!last || Date.parse(p.recordedAt) > Date.parse(last)) last = p.recordedAt;
        }
        await c.query(
          'INSERT INTO biometric_ingestion_state(device_id,last_ingestion_at,last_record_at) VALUES($1,now(),$2) ON CONFLICT(device_id) DO UPDATE SET last_ingestion_at=now(),last_record_at=GREATEST(biometric_ingestion_state.last_record_at,EXCLUDED.last_record_at)',
          [input.deviceId, last],
        );
        return { inserted, duplicates, unmatched: [...new Set(unmatched)] };
      });
    },
    async detail(actor: Actor, id: string) {
      const row = await find(pool, 'time_records', id, organization(actor));
      row.corrections = (
        await pool.query(
          'SELECT * FROM time_record_corrections WHERE time_record_id=$1 ORDER BY revision DESC',
          [id],
        )
      ).rows.map(normalize);
      return row;
    },
  };
}

export function createLeaveService(pool: Pool) {
  return {
    async saveType(
      actor: Actor,
      input: z.infer<typeof leaveTypeInputSchema> | z.infer<typeof leaveTypeUpdateSchema>,
      id?: string,
    ) {
      return transaction(pool, async (c) => {
        const { expectedRevision: revision, ...data } = input as typeof input & {
          expectedRevision?: number;
        };
        const row = id
          ? await update(c, 'leave_types', id, organization(actor), Number(revision), data, actor)
          : await insert(c, 'leave_types', {
              ...data,
              organizationId: organization(actor),
              updatedBy: actor.id,
            });
        await publish(c, actor, 'leave_types', row, id ? 'UPDATE' : 'CREATE', Object.keys(data));
        return row;
      });
    },
    async request(actor: Actor, input: z.infer<typeof leaveInputSchema>) {
      return transaction(pool, async (c) => {
        const org = organization(actor);
        await find(c, 'employees', input.employeeId, org, true);
        const type = await find(c, 'leave_types', input.leaveTypeId, org, true);
        if (type.status !== 'active')
          throw new DomainError(400, 'INVALID_REQUEST', 'Leave type inactive');
        const automatic = type.requiresApproval === false;
        const row = await insert(c, 'leave_requests', {
          ...input,
          organizationId: org,
          status: automatic ? 'approved' : 'pending',
          typeSnapshot: {
            code: type.code,
            name: type.name,
            paid: type.paid,
            requiresApproval: type.requiresApproval,
          },
          requestedBy: actor.id,
          updatedBy: actor.id,
          ...(automatic ? { approvedBy: actor.id, approvedAt: new Date().toISOString() } : {}),
        });
        await publish(c, actor, 'leave_requests', row);
        if (automatic) await enqueue(c, actor, input.employeeId, input.startDate, input.endDate);
        return row;
      });
    },
    async transition(
      actor: Actor,
      id: string,
      action: 'approve' | 'reject' | 'cancel',
      input: z.infer<typeof transitionInputSchema>,
    ) {
      return transaction(pool, async (c) => {
        const org = organization(actor),
          initial = await find(c, 'leave_requests', id, org);
        await find(c, 'employees', String(initial.employeeId), org, true);
        const old = await find(c, 'leave_requests', id, org, true);
        if (old.status !== 'pending' && !(old.status === 'approved' && action === 'cancel'))
          throw new DomainError(409, 'CONFLICT', 'Transition is not permitted');
        if (action === 'reject' && !input.remarks)
          throw new DomainError(400, 'INVALID_REQUEST', 'Rejection requires remarks');
        const prefix =
          action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';
        const row = await update(
          c,
          'leave_requests',
          id,
          org,
          input.expectedRevision,
          {
            status: prefix,
            [prefix + 'By']: actor.id,
            [prefix + 'At']: new Date().toISOString(),
            remarks: input.remarks,
          },
          actor,
        );
        await publish(c, actor, 'leave_requests', row, 'UPDATE', [
          'status',
          prefix + 'By',
          prefix + 'At',
          'remarks',
        ]);
        if (action === 'approve' || old.status === 'approved')
          await enqueue(
            c,
            actor,
            String(old.employeeId),
            String(old.startDate),
            String(old.endDate),
          );
        return row;
      });
    },
  };
}

async function archive(c: PoolClient, row: FoundationRecord) {
  await c.query(
    'INSERT INTO attendance_history(organization_id,attendance_id,revision,snapshot) VALUES($1,$2,$3,$4)',
    [row.organizationId, row.id, row.revision, JSON.stringify(row)],
  );
}
interface Resolved {
  assignmentId: string;
  versionId: string;
  scheduleId: string;
  scheduleName: string;
  timezone: string;
  isRestDay: boolean;
  shift: Shift | null;
  day: Record<string, unknown>;
}
async function resolveShift(
  c: PoolClient,
  org: string,
  employeeId: string,
  date: string,
): Promise<Resolved | null> {
  const found = await c.query(
    `SELECT a.id assignment_id,s.id schedule_id,v.name schedule_name,v.id version_id,v.timezone,d.*,
 (($3::date+d.start_time) AT TIME ZONE v.timezone) start_at,
 (($3::date+d.end_day_offset+d.end_time) AT TIME ZONE v.timezone) end_at,
 (($3::date+d.break_start_day_offset+d.break_start) AT TIME ZONE v.timezone) break_start_at,
 (($3::date+d.break_end_day_offset+d.break_end) AT TIME ZONE v.timezone) break_end_at
 FROM employee_schedule_assignments a JOIN work_schedules s ON s.id=a.schedule_id
 JOIN LATERAL (SELECT * FROM work_schedule_versions WHERE schedule_id=s.id AND effective_from<=$3 ORDER BY effective_from DESC LIMIT 1) v ON true
 JOIN work_schedule_days d ON d.version_id=v.id AND d.day_of_week=extract(dow FROM $3::date)
 WHERE a.organization_id=$1 AND a.employee_id=$2 AND a.effective_from<=$3 AND (a.effective_to IS NULL OR a.effective_to>$3)`,
    [org, employeeId, date],
  );
  const r = found.rows[0];
  if (!r) return null;
  return {
    assignmentId: r.assignment_id,
    versionId: r.version_id,
    scheduleId: r.schedule_id,
    scheduleName: r.schedule_name,
    timezone: r.timezone,
    isRestDay: !r.is_work_day,
    shift: r.is_work_day
      ? {
          start: Date.parse(r.start_at),
          end: Date.parse(r.end_at),
          break: r.break_start_at
            ? [Date.parse(r.break_start_at), Date.parse(r.break_end_at)]
            : null,
          graceMinutes: r.grace_minutes,
        }
      : null,
    day: normalize(r),
  };
}
export async function processAttendance(
  c: PoolClient,
  actor: ProcessingActor,
  employeeId: string,
  date: string,
  now = Date.now(),
) {
  const org = organization(actor);
  await find(c, 'employees', employeeId, org, true);
  const resolved = await resolveShift(c, org, employeeId, date);
  const adjacent: (Resolved | null)[] = [];
  for (const offset of [-2, -1, 1, 2])
    adjacent.push(await resolveShift(c, org, employeeId, nextDate(date, offset)));
  const bounds = await c.query<{ start: Date; end: Date }>(
    'SELECT ($1::date::timestamp AT TIME ZONE timezone) start,(($1::date+1)::timestamp AT TIME ZONE timezone) "end" FROM organizations WHERE id=$2',
    [date, org],
  );
  const start = resolved?.shift
      ? resolved.shift.start - 7200000
      : Date.parse(String(bounds.rows[0]!.start)),
    end = resolved?.shift ? resolved.shift.end + 7200000 : Date.parse(String(bounds.rows[0]!.end));
  const records = await c.query(
    `SELECT t.*,c.operation,c.revision correction_revision,c.reason correction_reason,c.created_by correction_by,
 CASE WHEN c.operation='void' THEN NULL ELSE COALESCE(c.recorded_at,t.recorded_at) END effective_recorded_at,
 COALESCE(c.record_type,t.record_type) effective_record_type
 FROM time_records t LEFT JOIN LATERAL (SELECT * FROM time_record_corrections WHERE time_record_id=t.id ORDER BY revision DESC LIMIT 1)c ON true
 WHERE t.organization_id=$1 AND t.employee_id=$2 AND COALESCE(c.recorded_at,t.recorded_at)>=$3 AND COALESCE(c.recorded_at,t.recorded_at)${resolved?.shift ? '<=' : '<'}$4 ORDER BY effective_recorded_at,t.id`,
    [org, employeeId, new Date(start).toISOString(), new Date(end).toISOString()],
  );
  const evidence = records.rows.map(normalize);
  const punches: Punch[] = evidence
    .filter((r) => r.operation !== 'void')
    .flatMap((r) => {
      const at = Date.parse(String(r.effectiveRecordedAt)),
        others = adjacent.filter(
          (a) => a?.shift && at >= a.shift.start - 7200000 && at <= a.shift.end + 7200000,
        );
      if (!resolved?.shift && others.length) return [];
      return [
        {
          id: r.id,
          recordedAt: String(r.effectiveRecordedAt),
          recordType: r.effectiveRecordType as TimeRecordType,
          ambiguous: others.length > 0,
        },
      ];
    });
  const leaves = (
    await c.query(
      "SELECT * FROM leave_requests WHERE organization_id=$1 AND employee_id=$2 AND status='approved' AND start_date<=$3 AND end_date>=$3 ORDER BY id",
      [org, employeeId, date],
    )
  ).rows.map(normalize);
  const half = leaves.map((l) => String(l.durationType));
  const leave = half.includes('full_day')
    ? 'full_day'
    : half.includes('first_half') && half.includes('second_half')
      ? 'both_halves'
      : half.includes('first_half')
        ? 'first_half'
        : half.includes('second_half')
          ? 'second_half'
          : null;
  const computed = interpretAttendance({
    shift: resolved?.shift ?? null,
    isRestDay: resolved?.isRestDay ?? false,
    punches,
    leave,
    now,
  });
  if (!resolved?.shift) computed.complete = now >= Date.parse(String(bounds.rows[0]!.end));
  const input = {
    processorVersion: 1,
    schedule: resolved,
    evidence,
    leaves,
    complete: computed.complete,
  };
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const previous = await c.query(
    'SELECT * FROM attendance_records WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3 FOR UPDATE',
    [org, employeeId, date],
  );
  const old = previous.rows[0] ? normalize(previous.rows[0]) : null;
  if (old?.inputHash === hash) return old;
  const result = { ...computed, schedule: resolved, evidence, leaves, computed, adjustment: null };
  const data = {
    organizationId: org,
    employeeId,
    workDate: date,
    scheduleAssignmentId: resolved?.assignmentId ?? null,
    scheduleVersionId: resolved?.versionId ?? null,
    firstIn: computed.firstIn,
    lastOut: computed.lastOut,
    workedMinutes: computed.workedMinutes,
    lateMinutes: computed.lateMinutes,
    undertimeMinutes: computed.undertimeMinutes,
    attendanceStatus: computed.attendanceStatus,
    approvalStatus:
      old?.approvalStatus === 'approved' || old?.approvalStatus === 'needs_review'
        ? 'needs_review'
        : 'unreviewed',
    inputHash: hash,
    result,
    approvedBy: null,
    approvedAt: null,
  };
  if (old) await archive(c, old);
  const row = old
    ? await update(c, 'attendance_records', old.id, org, Number(old.revision), data, actor)
    : await insert(c, 'attendance_records', { ...data, updatedBy: actor.id });
  await publish(c, actor, 'attendance_records', row, old ? 'UPDATE' : 'CREATE', ['result']);
  return row;
}

export function createAttendanceService(pool: Pool) {
  return {
    async reprocess(
      actor: Actor,
      employeeId: string | undefined,
      start: string,
      end: string,
      reason = 'Requested attendance reprocessing',
    ) {
      return transaction(pool, async (c) => {
        const org = organization(actor);
        const employees = employeeId
          ? [await find(c, 'employees', employeeId, org)]
          : (
              await c.query(
                "SELECT * FROM employees WHERE organization_id=$1 AND status IN ('active','on_leave') ORDER BY id",
                [org],
              )
            ).rows.map(normalize);
        await c.query(
          'UPDATE attendance_processing_jobs SET last_error=NULL WHERE organization_id=$1 AND ($2::uuid IS NULL OR employee_id=$2) AND start_date<=$4 AND end_date>=$3',
          [org, employeeId ?? null, start, end],
        );
        for (const e of employees) await enqueue(c, actor, e.id, start, end, false, reason);
        await audit(c, actor, 'UPDATE', 'attendance_reprocessing', employeeId ?? null, [
          'startDate',
          'endDate',
        ]);
        return { queued: employees.length };
      });
    },
    async detail(actor: Actor, id: string) {
      const row = await find(pool, 'attendance_records', id, organization(actor));
      row.history = (
        await pool.query(
          'SELECT * FROM attendance_history WHERE attendance_id=$1 ORDER BY revision DESC',
          [id],
        )
      ).rows.map(normalize);
      row.adjustments = (
        await pool.query(
          'SELECT * FROM attendance_adjustments WHERE attendance_id=$1 ORDER BY revision DESC',
          [id],
        )
      ).rows.map(normalize);
      return row;
    },
    async transition(actor: Actor, id: string, action: 'approve' | 'reopen', revision: number) {
      return transaction(pool, async (c) => {
        const org = organization(actor),
          initial = await find(c, 'attendance_records', id, org);
        await find(c, 'employees', String(initial.employeeId), org, true);
        const old = await find(c, 'attendance_records', id, org, true);
        const result = old.result as Record<string, unknown>;
        if (action === 'approve') {
          if (
            old.attendanceStatus === 'incomplete' ||
            !result.complete ||
            (Array.isArray(result.flags) && result.flags.length)
          )
            throw new DomainError(
              409,
              'CONFLICT',
              'Resolve review flags and complete the shift before approval',
            );
          if (
            (
              await c.query(
                'SELECT 1 FROM attendance_processing_jobs WHERE organization_id=$1 AND employee_id=$2 AND next_date<=$3 AND end_date>=$3',
                [org, old.employeeId, old.workDate],
              )
            ).rowCount
          )
            throw new DomainError(409, 'CONFLICT', 'Attendance processing is pending');
        }
        await archive(c, old);
        const row = await update(
          c,
          'attendance_records',
          id,
          org,
          revision,
          {
            approvalStatus: action === 'approve' ? 'approved' : 'needs_review',
            approvedBy: action === 'approve' ? actor.id : null,
            approvedAt: action === 'approve' ? new Date().toISOString() : null,
          },
          actor,
        );
        await publish(c, actor, 'attendance_records', row, 'UPDATE', ['approvalStatus']);
        return row;
      });
    },
    async adjust(actor: Actor, id: string, input: z.infer<typeof adjustmentInputSchema>) {
      return transaction(pool, async (c) => {
        const org = organization(actor),
          initial = await find(c, 'attendance_records', id, org);
        await find(c, 'employees', String(initial.employeeId), org, true);
        const old = await find(c, 'attendance_records', id, org, true);
        if (old.revision !== input.expectedRevision)
          throw new DomainError(409, 'CONFLICT', 'Attendance changed; reload');
        const adjustment = await insert(c, 'attendance_adjustments', {
          organizationId: org,
          attendanceId: id,
          overrides: input.overrides,
          reason: input.reason,
          revision: input.expectedRevision + 1,
          createdBy: actor.id,
        });
        await publish(c, actor, 'attendance_adjustments', adjustment);
        const result = { ...(old.result as Record<string, unknown>), adjustment };
        await archive(c, old);
        const row = await update(
          c,
          'attendance_records',
          id,
          org,
          input.expectedRevision,
          {
            ...input.overrides,
            result,
            approvalStatus: 'needs_review',
            approvedBy: null,
            approvedAt: null,
          },
          actor,
        );
        await publish(c, actor, 'attendance_records', row, 'UPDATE', Object.keys(input.overrides));
        return row;
      });
    },
  };
}
