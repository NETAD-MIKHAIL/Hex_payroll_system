import { z } from 'zod';
import {
  attendanceDaysSchema,
  attendanceDetailSchema,
  attendanceConnectionSchema,
  centralAttendanceWorkspaceSchema,
  attendanceJsonSchema,
  type AttendanceDesktopCommand,
} from '@hexpayroll/shared';
import { foundationRequest } from './foundation';
const base = 'attendance-management/';
export const attendanceApi = {
  localEvidence: async (
    token: string,
    employeeId: string,
    workDate: string,
    kind: string,
    id: string,
  ) =>
    attendanceJsonSchema.parse(
      await foundationRequest(base + 'evidence', token, 'POST', { employeeId, workDate, kind, id }),
    ),
  days: async (token: string, date: string, search: string, page: number) =>
    attendanceDaysSchema.parse(
      await foundationRequest(
        base + 'days?' + new URLSearchParams({ date, search, page: String(page) }),
        token,
      ),
    ),
  detail: async (token: string, employeeId: string, workDate: string) =>
    attendanceDetailSchema.parse(
      await foundationRequest(
        base + 'detail?' + new URLSearchParams({ employeeId, workDate }),
        token,
      ),
    ),
  monitor: async (token: string) =>
    z
      .object({
        devices: z.array(attendanceJsonSchema),
        unmatched: z.array(attendanceJsonSchema),
        dependencies: z.array(attendanceJsonSchema),
        receipts: z.array(attendanceJsonSchema),
        checkpoints: z.array(attendanceJsonSchema),
        attempts: z.array(attendanceJsonSchema),
        generatedAt: z.string(),
      })
      .parse(await foundationRequest(base + 'monitor', token)),
  connection: async (token: string) =>
    attendanceConnectionSchema.parse(await foundationRequest(base + 'central/connection', token)),
  login: async (token: string, identifier: string, password: string) =>
    attendanceConnectionSchema.parse(
      await foundationRequest(base + 'central/login', token, 'POST', { identifier, password }),
    ),
  disconnect: async (token: string) =>
    foundationRequest(base + 'central/disconnect', token, 'POST', {}),
  workspace: async (token: string, employeeId: string, workDate: string) =>
    centralAttendanceWorkspaceSchema.parse(
      await foundationRequest(
        base + 'central/workspace',
        token,
        'POST',
        { employeeId, workDate },
        20000,
      ),
    ),
  evidence: async (token: string, employeeId: string, workDate: string, kind: string, id: string) =>
    attendanceJsonSchema.parse(
      await foundationRequest(base + 'central/evidence', token, 'POST', {
        employeeId,
        workDate,
        kind,
        id,
      }),
    ),
  requestId: async (token: string) =>
    z
      .object({ id: z.uuid() })
      .parse(await foundationRequest(base + 'request-id', token, 'POST', {})).id,
  command: async (token: string, body: AttendanceDesktopCommand) =>
    attendanceJsonSchema.parse(
      await foundationRequest(base + 'central/command', token, 'POST', body, 25000),
    ),
};
