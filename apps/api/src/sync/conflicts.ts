import { enqueueOutbox } from './outbox.js';
import { publishResolution } from './resolutions.js';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  conflictListQuerySchema,
  conflictResolutionRequestSchema,
  type ConflictResolution,
  type ConflictType,
  type Permission,
  departmentInputSchema,
  positionInputSchema,
  employeeInputSchema,
} from '@hexpayroll/shared';
import {
  audit,
  DomainError,
  getActor,
  normalize,
  requirePermission,
  transaction,
  type Actor,
} from '../foundation/repository.js';
import { updateFoundationRecord } from '../foundation/mutations.js';
import { redact, safeEvidence } from './conflict-policy.js';

export async function persistConflict(
  c: PoolClient,
  input: {
    organizationId: string;
    nodeId: string;
    eventId: string;
    entityType: string;
    entityId: string;
    incomingRevision: number;
    currentRevision: number | null;
    baseRevision: number | null;
    incoming: Record<string, unknown>;
    current: Record<string, unknown> | null;
    conflictType: ConflictType;
    reason: string;
    localEventId?: string;
    authority?: 'local' | 'remote';
  },
) {
  const result = await c.query<{ id: string }>(
    `INSERT INTO sync_conflicts(organization_id,node_id,source_event_id,entity_type,entity_id,incoming_revision,current_revision,base_revision,incoming_payload,current_payload,conflict_type,reason,local_event_id,authority)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(node_id,source_event_id) DO NOTHING RETURNING id`,
    [
      input.organizationId,
      input.nodeId,
      input.eventId,
      input.entityType,
      input.entityId,
      input.incomingRevision,
      input.currentRevision,
      input.baseRevision,
      JSON.stringify(safeEvidence(input.incoming)),
      input.current === null ? null : JSON.stringify(safeEvidence(input.current)),
      input.conflictType,
      input.reason,
      input.localEventId ?? null,
      input.authority ?? 'remote',
    ],
  );
  if (result.rows[0]) {
    await audit(
      c,
      { id: null, organizationId: input.organizationId },
      'CONFLICT_DETECTED',
      'sync_conflicts',
      result.rows[0].id,
      [],
      {
        conflictId: result.rows[0].id,
        entityType: input.entityType,
        entityId: input.entityId,
        conflictType: input.conflictType,
      },
    );
    return result.rows[0].id;
  }
  const old = await c.query<{ id: string }>(
    'SELECT id FROM sync_conflicts WHERE organization_id=$1 AND node_id=$2 AND source_event_id=$3',
    [input.organizationId, input.nodeId, input.eventId],
  );
  if (!old.rows[0]) throw new DomainError(409, 'CONFLICT', 'Conflict identity is unavailable');
  return old.rows[0].id;
}

const select = `SELECT c.*,n.device_name FROM sync_conflicts c JOIN sync_nodes n ON n.id=c.node_id AND n.organization_id=c.organization_id`;
type Row = Record<string, unknown> & {
  id: string;
  organization_id: string;
  entity_type: string;
  entity_id: string;
  status: string;
  version: number;
  authority: 'local' | 'remote';
  conflict_type: ConflictType;
  resolution_state: string;
  local_event_id: string | null;
  incoming_payload: Record<string, unknown>;
  current_payload: Record<string, unknown> | null;
};
function summary(r: Row) {
  return {
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    conflictType: r.conflict_type,
    status: r.status,
    originNodeId: r.node_id,
    deviceName: r.device_name,
    localRevision: r.incoming_revision,
    remoteRevision: r.current_revision,
    baseRevision: r.base_revision,
    version: r.version,
    detectedAt: new Date(String(r.created_at)).toISOString(),
    authority: r.authority,
    reason: r.reason,
    resolutionState: r.resolution_state,
  };
}
const domainPermission = (entity: string): Permission | null =>
  entity === 'employees'
    ? 'employees.update'
    : entity === 'departments'
      ? 'departments.manage'
      : entity === 'positions'
        ? 'positions.manage'
        : null;
const protectedPayroll = (row: Row) =>
  row.conflict_type === 'PAYROLL_CONFLICT' ||
  row.entity_type.startsWith('payroll_') ||
  row.entity_type === 'employee_payroll_results';
function actions(row: Row, actor: Actor): ConflictResolution[] {
  if (!['open', 'under_review'].includes(row.status) || row.resolution_state === 'pending')
    return [];
  const result: ConflictResolution[] = [];
  if (actor.permissions.includes('sync.conflicts.escalate')) result.push('escalate');
  if (!actor.permissions.includes('sync.conflicts.resolve') || protectedPayroll(row)) return result;
  result.push('accept_authoritative', 'reject_mutation');
  const permission = domainPermission(row.entity_type);
  if (
    permission &&
    actor.permissions.includes(permission) &&
    canReadPayload(actor, row.entity_type) &&
    row.conflict_type !== 'EVENT_IDENTITY'
  )
    result.push('reapply_local', 'manual_merge');
  return result;
}
async function read(c: Pool | PoolClient, actor: Actor, id: string, lock = false): Promise<Row> {
  const result = await c.query<Row>(
    select + ' WHERE c.organization_id=$1 AND c.id=$2' + (lock ? ' FOR UPDATE OF c' : ''),
    [actor.organizationId, id],
  );
  if (!result.rows[0]) throw new DomainError(404, 'NOT_FOUND', 'Conflict not found');
  return result.rows[0];
}
function canReadPayload(actor: Actor, entity: string) {
  const special: Record<string, Permission> = {
    organizations: 'organization.view',
    auth_users: 'users.view',
    payroll_configurations: 'payroll_config.view',
    biometric_devices: 'employees.view',
    biometric_mappings: 'employees.view',
  };
  if (special[entity]) return actor.permissions.includes(special[entity]);
  const permission: Permission | null =
    entity === 'employees'
      ? 'employees.view'
      : entity === 'departments'
        ? 'departments.view'
        : entity === 'positions'
          ? 'positions.view'
          : entity.startsWith('payroll') || entity === 'employee_payroll_results'
            ? 'payroll.view'
            : entity.startsWith('leave')
              ? 'leave.view'
              : entity.includes('schedule')
                ? 'schedules.view'
                : entity.startsWith('time_record')
                  ? 'time_records.view'
                  : entity.startsWith('attendance')
                    ? 'attendance.view'
                    : null;
  return permission !== null && actor.permissions.includes(permission);
}
export async function listConflicts(pool: Pool, actor: Actor, input: unknown) {
  requirePermission(actor, 'sync.conflicts.view');
  const q = conflictListQuerySchema.parse(input);
  const values: unknown[] = [actor.organizationId];
  const clauses = ['c.organization_id=$1'];
  for (const [column, value, operator] of [
    ['c.status', q.status, '='],
    ['c.entity_type', q.entityType, '='],
    ['c.conflict_type', q.conflictType, '='],
    ['c.node_id', q.device, '='],
    ['c.created_at', q.from, '>='],
    ['c.created_at', q.to ? q.to + 'T23:59:59.999999Z' : undefined, '<='],
  ] as const) {
    if (value !== undefined) {
      values.push(value);
      clauses.push(`${column}${operator}$${values.length}`);
    }
  }
  const where = ' WHERE ' + clauses.join(' AND ');
  const count = await pool.query(
    'SELECT count(*)::integer AS total FROM sync_conflicts c' + where,
    values,
  );
  const result = await pool.query<Row>(
    select +
      where +
      ` ORDER BY c.created_at DESC,c.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return {
    items: result.rows.map(summary),
    total: count.rows[0].total,
    page: q.page,
    pageSize: q.pageSize,
  };
}
export async function conflictDetails(pool: Pool, actor: Actor, id: string) {
  requirePermission(actor, 'sync.conflicts.view');
  z.uuid().parse(id);
  const row = await read(pool, actor, id);
  const history = await pool.query(
    'SELECT id,resolution,reason,created_at,actor_id,state FROM sync_conflict_resolutions WHERE organization_id=$1 AND conflict_id=$2 ORDER BY created_at,id',
    [actor.organizationId, id],
  );
  const visible = canReadPayload(actor, row.entity_type),
    sensitive = actor.permissions.includes('employees.sensitive.view');
  const latest =
    row.authority === 'local' && domainPermission(row.entity_type)
      ? (
          await pool.query(`SELECT * FROM ${row.entity_type} WHERE organization_id=$1 AND id=$2`, [
            actor.organizationId,
            row.entity_id,
          ])
        ).rows[0]
      : undefined;
  return {
    ...summary(row),
    ...(row.authority === 'local' && domainPermission(row.entity_type)
      ? {
          latestRevision: latest ? Number(latest.revision) : null,
          latestSnapshot:
            latest && visible ? redact(safeEvidence(normalize(latest)), sensitive) : null,
        }
      : {}),
    localPayload: visible ? redact(row.incoming_payload, sensitive) : {},
    remoteSnapshot: visible ? redact(row.current_payload, sensitive) : null,
    allowedActions: actions(row, actor),
    blockingReason: protectedPayroll(row)
      ? 'An approved payroll correction/reversal workflow is required.'
      : row.resolution_state === 'pending'
        ? 'Resolution awaits central confirmation.'
        : null,
    history: history.rows.map((r) => ({
      id: r.id,
      resolution: r.resolution,
      reason: r.reason,
      createdAt: new Date(r.created_at).toISOString(),
      actorId: r.actor_id,
      state: r.state,
    })),
  };
}

export async function resolveConflict(
  pool: Pool,
  actor: Actor,
  id: string,
  input: unknown,
  central = false,
) {
  z.uuid().parse(id);
  const request = conflictResolutionRequestSchema.parse(input);
  return transaction(pool, async (c) => {
    if (central) await c.query("SELECT set_config('hex.sync_remote','on',true)");
    // Permissions are refreshed inside the resolution transaction.
    const who = await getActor(c, actor.id);
    if (who.organizationId !== actor.organizationId)
      throw new DomainError(403, 'FORBIDDEN', 'Organization access changed');
    requirePermission(
      who,
      request.resolution === 'escalate' ? 'sync.conflicts.escalate' : 'sync.conflicts.resolve',
    );
    const row = await read(c, who, id, true);
    const existing = await c.query(
      'SELECT conflict_id,request,state FROM sync_conflict_resolutions WHERE organization_id=$1 AND request_id=$2',
      [who.organizationId, request.requestId],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].conflict_id !== id ||
        JSON.stringify(existing.rows[0].request) !==
          JSON.stringify(JSON.parse(JSON.stringify(request)))
      ) {
        // JSONB key order is not an identity authority.
        const equal = await c.query(
          'SELECT request=$3::jsonb equal FROM sync_conflict_resolutions WHERE organization_id=$1 AND request_id=$2',
          [who.organizationId, request.requestId, JSON.stringify(request)],
        );
        if (existing.rows[0].conflict_id !== id || !equal.rows[0].equal)
          throw new DomainError(409, 'CONFLICT', 'Resolution request identity reused');
      }
      return { id, state: existing.rows[0].state };
    }
    if (row.version !== request.expectedVersion || !actions(row, who).includes(request.resolution))
      throw new DomainError(409, 'CONFLICT', 'Conflict changed or resolution is unavailable');
    if (request.fields && request.resolution !== 'manual_merge')
      throw new DomainError(400, 'INVALID_REQUEST', 'Fields are only allowed for manual merge');
    const applying = ['reapply_local', 'manual_merge'].includes(request.resolution);
    if (applying && request.expectedRevision === undefined)
      throw new DomainError(400, 'INVALID_REQUEST', 'Expected entity revision is required');
    if (
      request.resolution === 'manual_merge' &&
      (!request.fields || !Object.keys(request.fields).length)
    )
      throw new DomainError(400, 'INVALID_REQUEST', 'Select fields to merge');
    let resultingRevision: number | undefined;
    if (applying) {
      const permission = domainPermission(row.entity_type);
      if (!permission) throw new DomainError(409, 'CONFLICT', 'Use the domain workflow');
      requirePermission(who, permission);
      if (!canReadPayload(who, row.entity_type))
        throw new DomainError(403, 'FORBIDDEN', 'Domain view permission required');
      const schema =
        row.entity_type === 'employees'
          ? employeeInputSchema.omit({ status: true, employeeNumber: true })
          : row.entity_type === 'departments'
            ? departmentInputSchema.omit({ status: true })
            : positionInputSchema.omit({ status: true });
      const proposed =
        request.resolution === 'manual_merge'
          ? request.fields
          : Object.fromEntries(
              Object.entries(row.incoming_payload).filter(([key]) => key in schema.shape),
            );
      const parsedFields = schema.partial().strict().parse(proposed);
      // Zod defaults inside optional fields must not clear unselected fields.
      const fields = Object.fromEntries(
        Object.entries(parsedFields).filter(([key]) => Object.hasOwn(proposed ?? {}, key)),
      );
      if (!Object.keys(fields).length)
        throw new DomainError(400, 'INVALID_REQUEST', 'No editable fields selected');
      const personal = ['sssNumber', 'philhealthNumber', 'pagibigNumber', 'tin'];
      if (personal.some((k) => k in fields)) {
        requirePermission(who, 'employees.sensitive.update');
        requirePermission(who, 'employees.sensitive.view');
      }
      if (row.authority === 'local') {
        const saved = await updateFoundationRecord(
          c,
          who,
          row.entity_type,
          row.entity_id,
          request.expectedRevision!,
          fields,
        );
        resultingRevision = Number(saved.revision);
      } else if (request.expectedRevision !== row.current_revision)
        throw new DomainError(409, 'CONFLICT', 'Authoritative snapshot changed');
    }
    const pending = row.authority === 'remote' && request.resolution !== 'escalate';
    const state = pending ? 'pending' : 'confirmed';
    await c.query(
      'INSERT INTO sync_conflict_resolutions(organization_id,conflict_id,request_id,actor_id,resolution,reason,state,request) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        who.organizationId,
        id,
        request.requestId,
        who.id,
        request.resolution,
        request.reason,
        state,
        JSON.stringify(request),
      ],
    );
    const closed = !pending && request.resolution !== 'escalate';
    await c.query(
      `UPDATE sync_conflicts SET status=$3,resolution_state=$4,version=version+1,updated_at=now(),resolved_at=CASE WHEN $5 THEN now() ELSE NULL END,resolved_by=CASE WHEN $5 THEN $6::uuid ELSE NULL END WHERE organization_id=$1 AND id=$2`,
      [
        who.organizationId,
        id,
        closed
          ? request.resolution === 'reject_mutation'
            ? 'dismissed'
            : 'resolved'
          : 'under_review',
        pending ? 'pending' : closed ? 'confirmed' : 'none',
        closed,
        who.id,
      ],
    );
    if (closed && row.local_event_id)
      await c.query(
        "UPDATE sync_outbox SET status=$3 WHERE organization_id=$1 AND id=$2 AND status='conflicted'",
        [who.organizationId, row.local_event_id, applying ? 'superseded' : 'rejected'],
      );
    if (pending)
      await enqueueOutbox(c, {
        organizationId: who.organizationId!,
        entityType: 'sync_resolution_proposals',
        entityId: request.requestId,
        operation: 'CREATE',
        revision: 1,
        baseRevision: 0,
        actorId: who.id,
        payload: {
          id: request.requestId,
          organizationId: who.organizationId,
          revision: 1,
          sourceEventId: row.source_event_id,
          entityType: row.entity_type,
          entityId: row.entity_id,
          incomingRevision: row.incoming_revision,
          baseRevision: row.base_revision,
          incoming: row.incoming_payload,
          request,
        },
      });
    if (central && closed)
      await publishResolution(
        c,
        who.organizationId!,
        row,
        who.id,
        request.requestId,
        request.resolution,
        request.reason,
      );
    await audit(
      c,
      who,
      request.resolution === 'escalate'
        ? 'CONFLICT_ESCALATED'
        : pending
          ? 'CONFLICT_REVIEWED'
          : request.resolution === 'reject_mutation'
            ? 'CONFLICT_REJECTED'
            : 'CONFLICT_RESOLVED',
      'sync_conflicts',
      id,
      [],
      {
        conflictId: id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        resolution: request.resolution,
        resolutionReason: request.reason,
        resultingRevision: resultingRevision ?? null,
        state,
      },
    );
    return { id, state, resultingRevision };
  });
}
