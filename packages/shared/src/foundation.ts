import { z } from 'zod';
import { nonNegativeCentavosSchema, isoDateSchema } from './primitives.js';
// Kept literal here to avoid a foundation/payroll runtime import cycle.
export const permissionCodes = [
  'payroll.view',
  'payroll.create_period',
  'payroll.compute',
  'payroll.recompute',
  'payroll.review',
  'payroll.finalize',
  'earnings.view',
  'earnings.manage',
  'deductions.view',
  'deductions.manage',
  'contributions.view',
  'contributions.configure',
  'tax.view',
  'tax.configure',
  'dashboard.view',
  'employees.view',
  'employees.create',
  'employees.update',
  'employees.archive',
  'employees.sensitive.view',
  'employees.sensitive.update',
  'attendance.view',
  'attendance.manage',
  'attendance.adjust',
  'attendance.approve',
  'time_records.view',
  'time_records.create_manual',
  'time_records.correct',
  'time_records.ingest',
  'schedules.view',
  'schedules.create',
  'schedules.update',
  'schedules.assign',
  'leave.view',
  'leave.create',
  'leave.approve',
  'leave.reject',
  'leave.cancel',
  'leave.configure',
  'users.view',
  'users.create',
  'users.update',
  'users.disable',
  'roles.view',
  'roles.manage',
  'organization.view',
  'organization.update',
  'departments.view',
  'departments.manage',
  'positions.view',
  'positions.manage',
  'payroll_config.view',
  'payroll_config.update',
  'system_health.view',
  'audit.view',
  'sync.view',
  'sync.conflicts.view',
  'sync.conflicts.resolve',
  'sync.conflicts.escalate',
] as const;
export const permissionSchema = z.enum(permissionCodes);
export type Permission = z.infer<typeof permissionSchema>;
const text = z.string().trim().min(1).max(254);
const optionalText = z.string().trim().max(254).nullable().default(null);
const optionalId = z.uuid().nullable().default(null);
export const dateSchema = isoDateSchema;
export const statusSchema = z.enum(['active', 'inactive']);
export const employeeStatusSchema = z.enum(['active', 'inactive', 'on_leave', 'terminated']);
export const frequencySchema = z.enum(['monthly', 'semi_monthly', 'weekly', 'biweekly']);
export const organizationInputSchema = z
  .object({
    legalName: text,
    tradeName: optionalText,
    tin: optionalText,
    rdoCode: optionalText,
    sssNumber: optionalText,
    philhealthNumber: optionalText,
    pagibigNumber: optionalText,
    address: optionalText,
    barangay: optionalText,
    city: optionalText,
    province: optionalText,
    postalCode: optionalText,
    country: z.literal('PH').default('PH'),
    phone: optionalText,
    email: z.email().nullable().default(null),
    timezone: z
      .string()
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, 'Invalid timezone')
      .default('Asia/Manila'),
    currency: z.literal('PHP').default('PHP'),
    status: statusSchema.default('active'),
  })
  .strict();
export const organizationSetupSchema = organizationInputSchema.extend({
  id: z.uuid().optional(),
});
export const departmentInputSchema = z
  .object({
    code: text,
    name: text,
    description: optionalText,
    status: statusSchema.default('active'),
  })
  .strict();
export const positionInputSchema = departmentInputSchema.extend({ departmentId: optionalId });
export const employeeInputSchema = z
  .object({
    employeeNumber: text,
    firstName: text,
    middleName: optionalText,
    lastName: text,
    suffix: optionalText,
    birthDate: dateSchema.nullable().default(null),
    email: z.email().nullable().default(null),
    mobileNumber: optionalText,
    address: optionalText,
    barangay: optionalText,
    city: optionalText,
    province: optionalText,
    postalCode: optionalText,
    sssNumber: optionalText,
    philhealthNumber: optionalText,
    pagibigNumber: optionalText,
    tin: optionalText,
    status: employeeStatusSchema.default('active'),
  })
  .strict();
export const employmentInputSchema = z
  .object({
    departmentId: optionalId,
    positionId: optionalId,
    effectiveFrom: dateSchema,
    employmentType: z.enum([
      'regular',
      'probationary',
      'contractual',
      'project_based',
      'part_time',
    ]),
    employmentStatus: employeeStatusSchema,
    hireDate: dateSchema,
    regularizationDate: dateSchema.nullable().default(null),
    terminationDate: dateSchema.nullable().default(null),
    payType: z.enum(['monthly', 'daily', 'hourly']),
    payFrequency: frequencySchema,
    basicRateCentavos: nonNegativeCentavosSchema,
  })
  .strict()
  .refine(
    (v) =>
      (v.regularizationDate === null || v.regularizationDate >= v.hireDate) &&
      (v.terminationDate === null || v.terminationDate >= v.hireDate),
    'Employment dates must not precede hire date',
  );
export const deviceInputSchema = z
  .object({ code: text, name: text, status: statusSchema.default('active') })
  .strict();
export const mappingInputSchema = z
  .object({
    employeeId: z.uuid(),
    deviceId: z.uuid(),
    deviceEmployeeId: text,
    status: statusSchema.default('active'),
  })
  .strict();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const payrollConfigurationSchema = z
  .object({
    payFrequency: frequencySchema,
    cutoffs: z
      .array(
        z
          .object({
            startDay: z.number().int().min(1).max(31),
            endDay: z.union([z.number().int().min(1).max(31), z.literal('end_of_month')]),
          })
          .strict(),
      )
      .max(2)
      .default([]),
    weekday: z.number().int().min(0).max(6).nullable().default(null),
    anchorDate: dateSchema.nullable().default(null),
    workWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    workStart: clock,
    workEnd: clock,
    breakMinutes: z.number().int().min(0).max(1440),
    standardMinutesPerDay: z.number().int().min(1).max(1440),
    graceMinutes: z.number().int().min(0).max(1440),
    lateEnabled: z.boolean(),
    undertimeEnabled: z.boolean(),
    overtimeEnabled: z.boolean(),
    roundingMode: z.enum(['none', 'nearest', 'up', 'down']),
    roundingIncrementMinutes: z.number().int().min(1).max(60),
  })
  .strict()
  .superRefine((v, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (new Set(v.workWeekdays).size !== v.workWeekdays.length) bad('Work weekdays must be unique');
    if (v.breakMinutes + v.standardMinutesPerDay > 1440) bad('Work and break minutes exceed a day');
    if (v.payFrequency === 'monthly' || v.payFrequency === 'semi_monthly') {
      const count = v.payFrequency === 'monthly' ? 1 : 2;
      if (
        v.cutoffs.length !== count ||
        v.cutoffs[0]?.startDay !== 1 ||
        v.cutoffs.at(-1)?.endDay !== 'end_of_month'
      )
        bad('Cutoffs must cover the full month');
      if (count === 2) {
        const first = v.cutoffs[0];
        const second = v.cutoffs[1];
        if (
          !first ||
          !second ||
          typeof first.endDay !== 'number' ||
          first.endDay > 27 ||
          second.startDay !== first.endDay + 1
        )
          bad('Semi-monthly cutoffs must be contiguous and valid in February');
      }
      if (v.weekday !== null || v.anchorDate !== null)
        bad('Monthly frequencies do not use weekly anchors');
    } else {
      if (v.cutoffs.length !== 0 || v.weekday === null)
        bad('Weekly frequencies require a weekday and no month cutoffs');
      if (v.payFrequency === 'biweekly' && v.anchorDate === null)
        bad('Biweekly frequency requires an anchor date');
      if (v.payFrequency === 'weekly' && v.anchorDate !== null)
        bad('Weekly frequency does not use an anchor date');
      if (v.anchorDate && new Date(v.anchorDate + 'T00:00:00Z').getUTCDay() !== v.weekday)
        bad('Anchor date must match weekday');
    }
  });
export const roleInputSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    name: text,
    permissions: z.array(permissionSchema).max(permissionCodes.length),
  })
  .strict();
export const revisionSchema = z.number().int().positive();
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(254).default(''),
  status: employeeStatusSchema.optional(),
  departmentId: z.uuid().optional(),
  action: z.string().max(32).optional(),
  entityType: z.string().max(64).optional(),
  userId: z.uuid().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});
export interface FoundationRecord {
  id: string;
  organizationId?: string;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}
export interface PageResult {
  items: FoundationRecord[];
  total: number;
  page: number;
  pageSize: number;
}
export type OrganizationInput = z.infer<typeof organizationInputSchema>;
export type EmployeeInput = z.infer<typeof employeeInputSchema>;
export type EmploymentInput = z.infer<typeof employmentInputSchema>;
export type PayrollConfiguration = z.infer<typeof payrollConfigurationSchema>;
export const foundationRecordSchema = z.object({ id: z.uuid() }).catchall(z.unknown());
const entityMetadataSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.uuid().nullable(),
});
export const organizationSchema = organizationInputSchema.extend(
  entityMetadataSchema.omit({ organizationId: true }).shape,
);
export const departmentSchema = departmentInputSchema.extend(entityMetadataSchema.shape);
export const positionSchema = positionInputSchema.extend(entityMetadataSchema.shape);
export const employeeSchema = employeeInputSchema
  .partial({ sssNumber: true, philhealthNumber: true, pagibigNumber: true, tin: true })
  .extend(entityMetadataSchema.shape);
export const employmentSchema = z.object({
  ...employmentInputSchema.shape,
  basicRateCentavos: nonNegativeCentavosSchema.optional(),
  id: z.uuid(),
  organizationId: z.uuid(),
  employeeId: z.uuid(),
  effectiveTo: dateSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.uuid().nullable(),
});
export const managedUserSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    username: z.string(),
    displayName: z.string(),
    email: z.email().nullable(),
    active: z.boolean(),
    lastLoginAt: z.iso.datetime().nullable(),
    revision: revisionSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    roleIds: z.array(z.uuid()),
    roles: z.array(z.string()),
  })
  .strict();
export const roleSchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    system: z.boolean(),
    organizationId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    permissions: z.array(permissionSchema),
  })
  .strict();
export const auditEventSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid().nullable(),
    userId: z.uuid().nullable(),
    action: z.enum([
      'CREATE',
      'UPDATE',
      'ARCHIVE',
      'ACTIVATE',
      'DEACTIVATE',
      'LOGIN',
      'LOGOUT',
      'CONFIG_CHANGE',
      'ROLE_CHANGE',
      'CONFLICT_DETECTED',
      'CONFLICT_REVIEWED',
      'CONFLICT_RESOLVED',
      'CONFLICT_REJECTED',
      'CONFLICT_ESCALATED',
    ]),
    entityType: z.string(),
    entityId: z.uuid().nullable(),
    description: z.string(),
    metadata: z.object({ changedFields: z.array(z.string()) }),
    createdAt: z.iso.datetime(),
    userName: z.string().nullable(),
  })
  .strict();
export const syncSummarySchema = z
  .object({
    configured: z.boolean(),
    nodeProvisioned: z.boolean(),
    mode: z.enum(['disabled', 'local', 'central']),
    awaitingApplication: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    resolvedConflicts: z.number().int().nonnegative().default(0),
    lastSyncAttempt: z.iso.datetime().nullable().default(null),
    conflicted: z.number().int().nonnegative().default(0),
    rejected: z.number().int().nonnegative().default(0),
    superseded: z.number().int().nonnegative().default(0),
    lastSuccessfulPush: z.iso.datetime().nullable(),
    workerState: z.enum([
      'disabled',
      'starting',
      'idle',
      'running',
      'blocked',
      'stopping',
      'stopped',
    ]),
    transportAvailability: z.enum(['unconfigured', 'unknown', 'available', 'unavailable']),
    lastTransportVerification: z.iso.datetime().nullable(),
    pending: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    synced: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();
export const dashboardSummarySchema = z
  .object({
    id: z.uuid(),
    totalEmployees: z.number().int().nonnegative(),
    activeEmployees: z.number().int().nonnegative(),
    departments: z.number().int().nonnegative(),
    attendanceAvailable: z.boolean(),
    present: z.number().int().nonnegative().default(0),
    late: z.number().int().nonnegative().default(0),
    absent: z.number().int().nonnegative().default(0),
    onLeave: z.number().int().nonnegative().default(0),
    incomplete: z.number().int().nonnegative().default(0),
    processed: z.number().int().nonnegative().default(0),
    pending: z.number().int().nonnegative().default(0),
    stale: z.number().int().nonnegative().default(0),
  })
  .strict();
export type Organization = z.infer<typeof organizationSchema>;
export type Employee = z.infer<typeof employeeSchema>;
export type Employment = z.infer<typeof employmentSchema>;
export type Department = z.infer<typeof departmentSchema>;
export type Position = z.infer<typeof positionSchema>;
export type ManagedUser = z.infer<typeof managedUserSchema>;
export type Role = z.infer<typeof roleSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export const pageResultSchema = z.object({
  items: z.array(foundationRecordSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export const foundationErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      'INVALID_REQUEST',
      'SESSION_INVALID',
      'FORBIDDEN',
      'NOT_FOUND',
      'DUPLICATE',
      'CONFLICT',
      'SETUP_REQUIRED',
      'SERVICE_UNAVAILABLE',
      'INTERNAL_ERROR',
    ]),
    message: z.string(),
  }),
});
export const FOUNDATION_PATHS = {
  organization: '/api/organization',
  setup: '/api/organization/setup',
  users: '/api/users',
  roles: '/api/roles',
  permissions: '/api/permissions',
  departments: '/api/departments',
  positions: '/api/positions',
  employees: '/api/employees',
  devices: '/api/biometric-devices',
  mappings: '/api/biometric-mappings',
  payrollConfig: '/api/payroll-config',
  audit: '/api/audit',
  dashboard: '/api/dashboard/summary',
  sync: '/api/sync/summary',
} as const;
