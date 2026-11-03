import { z } from 'zod';
import { isoDateSchema, canonicalSyncJson, type TrustedEvidenceEnvelope } from '@hexpayroll/shared';
import { scheduleWeekdayId } from '../timekeeping/schedule-identity.js';

const instant = z.iso.datetime({ offset: true });
const revision = z.number().int().positive().max(2147483647);
const text = z.string().min(1).max(254);
const reason = z.string().min(1).max(2000);
const meta = {
  id: z.uuid(),
  organizationId: z.uuid(),
  revision,
  updatedBy: z.uuid().nullable(),
  createdAt: instant,
  updatedAt: instant,
};
const master = {
  code: z.string().min(1).max(80),
  name: text,
  description: z.string().max(2000).nullable(),
  status: z.enum(['active', 'inactive']),
};
const clock = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/)
  .nullable();
const offset = z.number().int().min(0).max(1);
const seconds = (time: string) =>
  time.split(':').reduce((sum, part, index) => sum + Number(part) * [3600, 60, 1][index]!, 0);
const day = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    versionId: z.uuid(),
    dayOfWeek: z.number().int().min(0).max(6),
    isWorkDay: z.boolean(),
    startTime: clock,
    endTime: clock,
    endDayOffset: offset,
    breakStart: clock,
    breakEnd: clock,
    breakStartDayOffset: offset,
    breakEndDayOffset: offset,
    graceMinutes: z.number().int().min(0).max(240),
  })
  .strict()
  .refine((d) => {
    if (!d.isWorkDay)
      return [d.startTime, d.endTime, d.breakStart, d.breakEnd].every((v) => v === null);
    if (d.startTime === null || d.endTime === null) return false;
    const start = seconds(d.startTime),
      end = seconds(d.endTime) + d.endDayOffset * 86400;
    if (end <= start || end - start > 86400) return false;
    if (d.breakStart === null && d.breakEnd === null) return true;
    if (d.breakStart === null || d.breakEnd === null) return false;
    const a = seconds(d.breakStart) + d.breakStartDayOffset * 86400,
      b = seconds(d.breakEnd) + d.breakEndDayOffset * 86400;
    return a >= start && b <= end && b > a && b - a < end - start;
  }, 'Invalid accepted weekday rules');
const version = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    scheduleId: z.uuid(),
    effectiveFrom: isoDateSchema,
    reason: reason.nullable(),
    timezone: z.string().min(1).max(100),
    revision: z.literal(1),
    createdBy: z.uuid(),
    createdAt: instant,
    name: text,
    code: z.string().min(1).max(80),
    days: z.array(day).length(7),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.days.map((d) => d.dayOfWeek)).size === 7 &&
      new Set(v.days.map((d) => d.id)).size === 7 &&
      v.days.every((d) => d.versionId === v.id && d.organizationId === v.organizationId),
  );
export const trustedScheduleSchema = z
  .object({ ...meta, ...master, versions: z.array(version).min(1) })
  .strict()
  .refine((s) => {
    const ids = new Set<string>();
    let previous = '';
    return s.versions.every((v) => {
      if (
        ids.has(v.id) ||
        v.scheduleId !== s.id ||
        v.organizationId !== s.organizationId ||
        v.effectiveFrom <= previous
      )
        return false;
      ids.add(v.id);
      previous = v.effectiveFrom;
      return true;
    });
  });
export const trustedAssignmentRowSchema = z
  .object({
    ...meta,
    employeeId: z.uuid(),
    scheduleId: z.uuid(),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullable(),
    reason: reason.nullable(),
  })
  .strict()
  .refine((s) => s.effectiveTo === null || s.effectiveTo > s.effectiveFrom);
const history = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    assignmentId: z.uuid(),
    revision,
    snapshot: trustedAssignmentRowSchema,
    createdAt: instant,
  })
  .strict();
export const trustedAssignmentSchema = z
  .object({ ...trustedAssignmentRowSchema.shape, history: z.array(history) })
  .strict()
  .refine((s) => {
    let previous = 0;
    const ids = new Set<string>();
    return (
      (s.effectiveTo === null || s.effectiveTo > s.effectiveFrom) &&
      s.history.every((h) => {
        if (
          ids.has(h.id) ||
          h.organizationId !== s.organizationId ||
          h.assignmentId !== s.id ||
          h.revision <= previous ||
          h.revision >= s.revision ||
          h.snapshot.id !== s.id ||
          h.snapshot.organizationId !== s.organizationId ||
          h.snapshot.revision !== h.revision ||
          h.snapshot.employeeId !== s.employeeId
        )
          return false;
        ids.add(h.id);
        previous = h.revision;
        return true;
      })
    );
  });
export const trustedLeaveTypeSchema = z
  .object({ ...meta, ...master, paid: z.boolean(), requiresApproval: z.boolean() })
  .strict();
export const trustedLeaveSchema = z
  .object({
    ...meta,
    employeeId: z.uuid(),
    leaveTypeId: z.uuid(),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    durationType: z.enum(['full_day', 'first_half', 'second_half']),
    reason,
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
    typeSnapshot: z
      .object({
        code: z.string().min(1).max(80),
        name: text,
        paid: z.boolean(),
        requiresApproval: z.boolean(),
      })
      .strict(),
    requestedBy: z.uuid(),
    requestedAt: instant,
    approvedBy: z.uuid().nullable(),
    approvedAt: instant.nullable(),
    rejectedBy: z.uuid().nullable(),
    rejectedAt: instant.nullable(),
    cancelledBy: z.uuid().nullable(),
    cancelledAt: instant.nullable(),
    remarks: z.string().max(2000).nullable(),
  })
  .strict()
  .refine(
    (s) =>
      s.endDate >= s.startDate &&
      (s.durationType === 'full_day' || s.startDate === s.endDate) &&
      (s.approvedBy === null) === (s.approvedAt === null) &&
      (s.rejectedBy === null) === (s.rejectedAt === null) &&
      (s.cancelledBy === null) === (s.cancelledAt === null) &&
      (s.status !== 'pending' ||
        (s.approvedBy === null && s.rejectedBy === null && s.cancelledBy === null)) &&
      (s.status !== 'approved' || (s.rejectedBy === null && s.cancelledBy === null)) &&
      (s.status !== 'rejected' || (s.approvedBy === null && s.cancelledBy === null)) &&
      (s.status !== 'cancelled' || s.rejectedBy === null) &&
      (s.status !== 'approved' || s.approvedBy !== null) &&
      (s.status !== 'rejected' || (s.rejectedBy !== null && Boolean(s.remarks?.trim()))) &&
      (s.status !== 'cancelled' || s.cancelledBy !== null),
  );
export const trustedSnapshotSchemas = {
  work_schedules: trustedScheduleSchema,
  employee_schedule_assignments: trustedAssignmentSchema,
  leave_types: trustedLeaveTypeSchema,
  leave_requests: trustedLeaveSchema,
};

export function validateTrustedSnapshot(event: TrustedEvidenceEnvelope) {
  const snapshot = trustedSnapshotSchemas[event.entityType].parse(event.snapshot);
  if (
    canonicalSyncJson(snapshot) !== canonicalSyncJson(event.snapshot) ||
    snapshot.updatedBy !== event.acceptedBy
  )
    throw new Error('Accepted snapshot attribution or shape mismatch');
  if (event.entityType === 'work_schedules')
    for (const version of trustedScheduleSchema.parse(snapshot).versions) {
      new Intl.DateTimeFormat('en', { timeZone: version.timezone });
      if (version.days.some((day) => day.id !== scheduleWeekdayId(version.id, day.dayOfWeek)))
        throw new Error('Invalid accepted weekday identity');
    }
  if (event.action === 'leave.request') {
    const leave = trustedLeaveSchema.parse(snapshot);
    if (
      leave.requestedBy !== event.acceptedBy ||
      leave.status !== (leave.typeSnapshot.requiresApproval ? 'pending' : 'approved') ||
      (!leave.typeSnapshot.requiresApproval && leave.approvedBy !== event.acceptedBy)
    )
      throw new Error('Invalid accepted leave request policy');
  }
  for (const [action, status, actor] of [
    ['leave.approve', 'approved', 'approvedBy'],
    ['leave.reject', 'rejected', 'rejectedBy'],
    ['leave.cancel', 'cancelled', 'cancelledBy'],
  ] as const)
    if (event.action === action) {
      const leave = trustedLeaveSchema.parse(snapshot);
      if (leave.status !== status || leave[actor] !== event.acceptedBy)
        throw new Error('Invalid accepted leave decision attribution');
    }
  return snapshot;
}
