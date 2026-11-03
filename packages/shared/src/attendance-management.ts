import { z } from 'zod';
import { isoDateSchema } from './primitives.js';
import { publicUserSchema } from './auth.js';
export const attendanceJsonSchema = z.record(z.string(), z.unknown());
export const attendanceEmployeeSchema = z.object({
  id: z.uuid(),
  employeeNumber: z.string(),
  name: z.string(),
});
export const attendanceDaySchema = z.object({
  employee: attendanceEmployeeSchema,
  provisional: attendanceJsonSchema.nullable(),
  canonical: attendanceJsonSchema.nullable(),
});
export const attendanceDaysSchema = z.object({
  date: isoDateSchema,
  timezone: z.string(),
  items: z.array(attendanceDaySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  features: z.object({
    capture: z.boolean(),
    finalization: z.boolean(),
    centralConfigured: z.boolean(),
  }),
});
export const attendanceDetailSchema = z.object({
  employee: attendanceEmployeeSchema,
  date: isoDateSchema,
  timezone: z.string(),
  provisional: attendanceJsonSchema.nullable(),
  canonical: attendanceJsonSchema.nullable(),
  schedule: attendanceJsonSchema.nullable(),
  leave: z.array(attendanceJsonSchema),
  timeRecords: z.array(attendanceJsonSchema),
  rawPunches: z.array(attendanceJsonSchema),
  batches: z.array(attendanceJsonSchema),
  closures: z.array(attendanceJsonSchema),
  devices: z.array(attendanceJsonSchema),
  dependencies: z.array(attendanceJsonSchema),
  history: z.array(attendanceJsonSchema),
  mappings: z.array(attendanceJsonSchema),
  commands: z.array(attendanceJsonSchema),
  reconciliation: z.array(attendanceJsonSchema),
});
export const centralAttendanceWorkspaceSchema = z.object({
  organizationId: z.uuid(),
  employeeId: z.uuid(),
  workDate: isoDateSchema,
  canonical: attendanceJsonSchema.nullable(),
  certifications: z.array(attendanceJsonSchema),
  exceptions: z.array(attendanceJsonSchema),
  proposals: z.array(attendanceJsonSchema),
  decisions: z.array(attendanceJsonSchema),
  history: z.array(attendanceJsonSchema),
  receipts: z.array(attendanceJsonSchema),
  coverage: z.array(attendanceJsonSchema),
  capabilities: z.array(attendanceJsonSchema),
  generatedAt: z.string(),
});
export const attendanceConnectionSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  user: publicUserSchema.nullable(),
  expiresAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
  reason: z.string().optional(),
});
export const attendanceCommandActionSchema = z.enum([
  'certify',
  'exceptions',
  'proposals',
  'finalize',
  'reopen',
]);
export const attendanceDesktopCommandSchema = z.object({
  requestId: z.uuid().refine((v) => v[14] === '7', 'UUIDv7 required'),
  action: attendanceCommandActionSchema,
  employeeId: z.uuid(),
  workDate: isoDateSchema,
  command: attendanceJsonSchema,
});
export type AttendanceJson = z.infer<typeof attendanceJsonSchema>;
export type AttendanceDays = z.infer<typeof attendanceDaysSchema>;
export type AttendanceDetail = z.infer<typeof attendanceDetailSchema>;
export type CentralAttendanceWorkspace = z.infer<typeof centralAttendanceWorkspaceSchema>;
export type AttendanceConnection = z.infer<typeof attendanceConnectionSchema>;
export type AttendanceDesktopCommand = z.infer<typeof attendanceDesktopCommandSchema>;
