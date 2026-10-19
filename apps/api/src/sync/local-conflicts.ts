import { createHash } from 'node:crypto';
import type { ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { type ConflictType } from '@hexpayroll/shared';
import {
  databaseErrorCode,
  DomainError,
  normalize,
  transaction,
  type Actor,
} from '../foundation/repository.js';
import { persistConflict } from './conflicts.js';
import { detectConflict } from './conflict-policy.js';

const targets: Record<string, string> = {
  employees: 'employees',
  departments: 'departments',
  positions: 'positions',
  schedules: 'work_schedules',
  'schedule-assignments': 'employee_schedule_assignments',
  leave: 'leave_requests',
  attendance: 'attendance_records',
  'time-records': 'time_records',
};
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
/** Called after the domain transaction rolls back, so evidence survives a rejected
 * write. Only known authenticated domain conflicts are captured, never outages. */
export const captureLocalConflict =
  (pool: Pool): ErrorRequestHandler =>
  async (error: unknown, req, res, next) => {
    const actor = res.locals.actor as Actor | undefined;
    const dbCode = databaseErrorCode(error);
    if (
      !actor?.organizationId ||
      !['POST', 'PUT', 'PATCH'].includes(req.method) ||
      !(
        (error instanceof DomainError && error.status === 409) ||
        ['23505', '23P01'].includes(dbCode)
      )
    )
      return next(error);
    const path = req.originalUrl.split('?')[0]!.replace(/^\/api\//, '/');
    const parts = path.split('/').filter(Boolean);
    const table =
      parts[0] === 'payroll' && parts[1] === 'periods'
        ? 'payroll_periods'
        : targets[parts[0] ?? ''];
    if (!table || !req.body || typeof req.body !== 'object') return next(error);
    try {
      await transaction(pool, async (c) => {
        let entityId = z.uuid().safeParse(parts[table === 'payroll_periods' ? 2 : 1]);
        let current: Record<string, unknown> | null = null;
        if (entityId.success)
          current =
            (
              await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 AND id=$2`, [
                actor.organizationId,
                entityId.data,
              ])
            ).rows[0] ?? null;
        else if (
          ['departments', 'positions', 'employees'].includes(table) &&
          typeof req.body[table === 'employees' ? 'employeeNumber' : 'code'] === 'string'
        ) {
          const column = table === 'employees' ? 'employee_number' : 'code';
          current =
            (
              await c.query(
                `SELECT * FROM ${table} WHERE organization_id=$1 AND lower(${column})=lower($2)`,
                [actor.organizationId, req.body[table === 'employees' ? 'employeeNumber' : 'code']],
              )
            ).rows[0] ?? null;
          if (current) entityId = z.uuid().safeParse(current.id);
        }
        // Missing/foreign targets are never disclosed or turned into cross-tenant evidence.
        if (!entityId.success || !current) return;
        const incoming = { ...req.body };
        delete incoming.expectedRevision;
        if (parts[0] === 'leave' && ['approve', 'reject', 'cancel'].includes(parts[2] ?? ''))
          incoming.status =
            parts[2] === 'approve' ? 'approved' : parts[2] === 'reject' ? 'rejected' : 'cancelled';
        const baseRevision = Number.isInteger(req.body.expectedRevision)
          ? Number(req.body.expectedRevision)
          : 0;
        const result = detectConflict({
          entityType: table,
          operation: req.method === 'POST' && parts.length === 1 ? 'CREATE' : 'UPDATE',
          baseRevision,
          incoming,
          authoritative: normalize(current),
          authorized: true,
          duplicateIdentity: dbCode === '23505',
          overlaps: dbCode === '23P01',
        });
        const category: ConflictType =
          table === 'payroll_periods'
            ? 'PAYROLL_CONFLICT'
            : parts.includes('schedules') || parts[0] === 'schedule-assignments'
              ? 'SCHEDULE_CONFLICT'
              : result.outcome === 'conflict'
                ? result.conflictType
                : 'UPDATE_UPDATE';
        const hash = createHash('sha256')
          .update(
            JSON.stringify(
              canonical({
                actor: actor.id,
                path,
                body: req.body,
                currentRevision: current.revision,
              }),
            ),
          )
          .digest('hex');
        const eventId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const node = (await c.query('SELECT hex_local_sync_node($1) AS id', [actor.organizationId]))
          .rows[0].id;
        await persistConflict(c, {
          organizationId: actor.organizationId!,
          nodeId: node,
          eventId,
          entityType: table,
          entityId: entityId.data,
          incomingRevision: Math.max(1, baseRevision + 1),
          currentRevision: Number(current.revision),
          baseRevision,
          incoming,
          current: normalize(current),
          conflictType: category,
          reason: 'Local mutation rejected by revision or domain validation',
          authority: 'local',
        });
      });
      next(error);
    } catch {
      next(
        new DomainError(
          503,
          'SERVICE_UNAVAILABLE',
          'Unable to preserve conflict evidence; retry the operation',
        ),
      );
    }
  };
