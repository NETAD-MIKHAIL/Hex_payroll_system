import { z } from 'zod';
import { isoDateSchema } from './primitives.js';
import { revisionSchema, statusSchema } from './foundation.js';

export const attendanceStatusSchema = z.enum([
  'present',
  'late',
  'absent',
  'on_leave',
  'rest_day',
  'incomplete',
]);
export const timeRecordTypeSchema = z.enum(['in', 'out', 'break_out', 'break_in', 'unknown']);
export const timeRecordSourceSchema = z.enum(['biometric', 'manual', 'import', 'system']);
export const leaveStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
export const approvalStatusSchema = z.enum(['unreviewed', 'approved', 'needs_review']);
export const processingSummarySchema = z.object({
  id: z.uuid(),
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const reason = z.string().trim().min(1).max(2000);
const optionalReason = reason.nullable().default(null);
const instant = z.iso.datetime({ offset: true });
export const clockMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export const scheduleDaySchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    isWorkDay: z.boolean(),
    startTime: clock.nullable(),
    endTime: clock.nullable(),
    endDayOffset: z.number().int().min(0).max(1).default(0),
    breakStart: clock.nullable().default(null),
    breakEnd: clock.nullable().default(null),
    breakStartDayOffset: z.number().int().min(0).max(1).default(0),
    breakEndDayOffset: z.number().int().min(0).max(1).default(0),
    graceMinutes: z.number().int().min(0).max(240).default(0),
  })
  .strict()
  .superRefine((d, c) => {
    if (!d.isWorkDay) {
      if (d.startTime || d.endTime || d.breakStart || d.breakEnd)
        c.addIssue({ code: 'custom', message: 'Rest days must not contain shift times' });
      return;
    }
    if (!d.startTime || !d.endTime) {
      c.addIssue({ code: 'custom', message: 'Work days require start and end' });
      return;
    }
    const start = clockMinutes(d.startTime),
      end = clockMinutes(d.endTime) + 1440 * d.endDayOffset;
    if (end <= start || end - start > 1440)
      c.addIssue({ code: 'custom', message: 'Shift must be positive and at most 24 hours' });
    if (d.breakStart !== null || d.breakEnd !== null) {
      if (!d.breakStart || !d.breakEnd)
        c.addIssue({ code: 'custom', message: 'Both break times are required' });
      else {
        const a = clockMinutes(d.breakStart) + 1440 * d.breakStartDayOffset,
          b = clockMinutes(d.breakEnd) + 1440 * d.breakEndDayOffset;
        if (a < start || b > end || b <= a || b - a >= end - start)
          c.addIssue({
            code: 'custom',
            message: 'Break must lie inside the shift and leave working time',
          });
      }
    }
  });
const days = z
  .array(scheduleDaySchema)
  .length(7)
  .refine((d) => new Set(d.map((v) => v.dayOfWeek)).size === 7, 'Each weekday must occur once');
const master = {
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(254),
  description: z.string().trim().max(2000).nullable().default(null),
  status: statusSchema.default('active'),
};
export const scheduleInputSchema = z
  .object({ ...master, effectiveFrom: isoDateSchema, reason: optionalReason, days })
  .strict();
export const scheduleUpdateSchema = scheduleInputSchema.extend({
  expectedRevision: revisionSchema,
});
export const scheduleStatusInputSchema = z
  .object({ status: statusSchema, expectedRevision: revisionSchema })
  .strict();
export const assignmentInputSchema = z
  .object({
    scheduleId: z.uuid(),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullable().default(null),
    expectedRevision: revisionSchema,
    reason: optionalReason,
  })
  .strict()
  .refine(
    (v) => v.effectiveTo === null || v.effectiveTo > v.effectiveFrom,
    'End must follow start',
  );
export const manualTimeRecordSchema = z
  .object({ employeeId: z.uuid(), recordedAt: instant, recordType: timeRecordTypeSchema, reason })
  .strict();
export const correctionInputSchema = z
  .object({
    operation: z.enum(['replace', 'void']),
    recordedAt: instant.nullable().default(null),
    recordType: timeRecordTypeSchema.nullable().default(null),
    expectedRevision: z.number().int().nonnegative(),
    reason,
  })
  .strict()
  .refine(
    (v) => v.operation === 'void' || (v.recordedAt !== null && v.recordType !== null),
    'Replacement requires timestamp and type',
  );
export const biometricSourceIdentitySchema = z
  .object({
    epoch: z.uuid(),
    sequence: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/)
      .refine((v) => BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER)),
    entryId: z.string().min(1).max(254),
  })
  .strict();
export const biometricBatchSchema = z
  .object({
    deviceId: z.uuid(),
    records: z
      .array(
        z
          .object({
            deviceEmployeeId: z.string().trim().min(1).max(254),
            recordedAt: instant,
            recordType: timeRecordTypeSchema,
            externalRecordId: z.string().trim().min(1).max(254).nullable().default(null),
            sourceIdentity: biometricSourceIdentitySchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export const leaveTypeInputSchema = z
  .object({ ...master, paid: z.boolean(), requiresApproval: z.boolean().default(true) })
  .strict();
export const leaveTypeUpdateSchema = leaveTypeInputSchema.extend({
  expectedRevision: revisionSchema,
});
export const leaveInputSchema = z
  .object({
    employeeId: z.uuid(),
    leaveTypeId: z.uuid(),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    durationType: z.enum(['full_day', 'first_half', 'second_half']),
    reason,
  })
  .strict()
  .refine(
    (v) => v.endDate >= v.startDate && (v.durationType === 'full_day' || v.startDate === v.endDate),
    'Invalid leave dates',
  );
export const transitionInputSchema = z
  .object({
    expectedRevision: revisionSchema,
    remarks: z.string().trim().max(2000).nullable().default(null),
  })
  .strict();
export const reprocessInputSchema = z
  .object({
    employeeId: z.uuid().optional(),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    reason,
  })
  .strict()
  .refine((v) => v.endDate >= v.startDate, 'Invalid date range');
export const adjustmentInputSchema = z
  .object({
    expectedRevision: revisionSchema,
    reason,
    overrides: z
      .object({
        workedMinutes: z.number().int().min(0).max(1440).optional(),
        lateMinutes: z.number().int().min(0).max(1440).optional(),
        undertimeMinutes: z.number().int().min(0).max(1440).optional(),
        attendanceStatus: attendanceStatusSchema.optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0, 'Provide an adjustment'),
  })
  .strict();
export const timekeepingQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().max(254).default(''),
    date: isoDateSchema.optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    employeeId: z.uuid().optional(),
    departmentId: z.uuid().optional(),
    scheduleId: z.uuid().optional(),
    leaveTypeId: z.uuid().optional(),
    status: z.string().max(40).optional(),
    source: timeRecordSourceSchema.optional(),
    recordType: timeRecordTypeSchema.optional(),
  })
  .strict();
const metadata = {
  id: z.uuid(),
  organizationId: z.uuid(),
  revision: revisionSchema,
  createdAt: instant,
};
export const workScheduleSchema = z.object({
  ...metadata,
  ...master,
  updatedAt: instant,
  assignedEmployees: z.number().int().nonnegative().optional(),
});
export const scheduleAssignmentSchema = z.object({
  ...metadata,
  employeeId: z.uuid(),
  scheduleId: z.uuid(),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable(),
});
export const timeRecordSchema = z.object({
  ...metadata,
  employeeId: z.uuid(),
  recordedAt: instant,
  recordType: timeRecordTypeSchema,
  source: timeRecordSourceSchema,
  deviceId: z.uuid().nullable(),
  reason: z.string().nullable(),
  createdBy: z.uuid(),
  correctionRevision: z.number().int().nonnegative().optional(),
  effectiveRecordedAt: instant.nullable().optional(),
  effectiveRecordType: timeRecordTypeSchema.nullable().optional(),
  operation: z.enum(['replace', 'void']).nullable().optional(),
});
export const attendanceRecordSchema = z.object({
  ...metadata,
  employeeId: z.uuid(),
  workDate: isoDateSchema,
  firstIn: instant.nullable(),
  lastOut: instant.nullable(),
  workedMinutes: z.number().int().nonnegative(),
  lateMinutes: z.number().int().nonnegative(),
  undertimeMinutes: z.number().int().nonnegative(),
  attendanceStatus: attendanceStatusSchema,
  approvalStatus: approvalStatusSchema,
  result: z.record(z.string(), z.unknown()),
  employeeName: z.string().optional(),
  scheduleName: z.string().nullable().optional(),
});
export const leaveTypeSchema = leaveTypeInputSchema.extend(metadata);
export const leaveRequestSchema = z.object({
  ...metadata,
  employeeId: z.uuid(),
  leaveTypeId: z.uuid(),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  durationType: leaveInputSchema.shape.durationType,
  status: leaveStatusSchema,
  reason: z.string(),
  requestedAt: instant,
});
export type WorkSchedule = z.infer<typeof workScheduleSchema>;
export type ScheduleDay = z.infer<typeof scheduleDaySchema>;
export type ScheduleAssignment = z.infer<typeof scheduleAssignmentSchema>;
export type TimeRecord = z.infer<typeof timeRecordSchema>;
export type TimeRecordType = z.infer<typeof timeRecordTypeSchema>;
export type TimeRecordSource = z.infer<typeof timeRecordSourceSchema>;
export type AttendanceRecord = z.infer<typeof attendanceRecordSchema>;
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;
export type LeaveType = z.infer<typeof leaveTypeSchema>;
export type LeaveRequest = z.infer<typeof leaveRequestSchema>;
export type LeaveStatus = z.infer<typeof leaveStatusSchema>;
