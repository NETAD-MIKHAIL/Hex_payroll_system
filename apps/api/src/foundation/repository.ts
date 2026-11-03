import { drizzle } from 'drizzle-orm/node-postgres';
import '../db/types.js';
import { sql, eq } from 'drizzle-orm';
import { organizations } from '../db/generated/schema.js';
import type { Pool, PoolClient } from 'pg';
import type { FoundationRecord, Permission } from '@hexpayroll/shared';
export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function databaseErrorCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== 'object' || current === null) return '';
    if ('code' in current) return String(current.code);
    if (!('cause' in current)) return '';
    current = current.cause;
  }
  return '';
}
export interface Actor {
  id: string;
  organizationId: string | null;
  permissions: Permission[];
  roles: string[];
}
export const sensitiveFields = [
  'sssNumber',
  'philhealthNumber',
  'pagibigNumber',
  'tin',
  'basicRateCentavos',
];
export function project(row: FoundationRecord, actor: Actor): FoundationRecord {
  const result = { ...row };
  if (!actor.permissions.includes('employees.sensitive.view'))
    for (const key of sensitiveFields) delete result[key];
  return result;
}
export function normalize(row: Record<string, unknown>): FoundationRecord {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const name = key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    result[name] =
      value instanceof Date
        ? name.endsWith('Date')
          ? value.toISOString().slice(0, 10)
          : value.toISOString()
        : name === 'basicRateCentavos'
          ? Number(value)
          : value;
  }
  return result as FoundationRecord;
}
export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
export async function readOrganization(database: Pool, id: string) {
  const rows = await drizzle(database)
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  if (!rows[0]) throw new DomainError(404, 'NOT_FOUND', 'Organization not found');
  return normalize(rows[0]);
}
export async function getActor(database: Pool | PoolClient, userId: string): Promise<Actor> {
  const found = await database.query<{
    id: string;
    organization_id: string | null;
    permissions: Permission[];
    roles: string[];
  }>(
    `SELECT u.id,u.organization_id,COALESCE(array_agg(DISTINCT p.permission_code) FILTER(WHERE p.permission_code IS NOT NULL),'{}') permissions,COALESCE(array_agg(DISTINCT r.code) FILTER(WHERE r.code IS NOT NULL),'{}') roles FROM auth_users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id LEFT JOIN role_permissions p ON p.role_id=r.id WHERE u.id=$1 AND u.active AND NOT u.identity_only AND NOT EXISTS(SELECT 1 FROM trusted_actor_identities t WHERE t.user_id=u.id AND NOT t.active) GROUP BY u.id`,
    [userId],
  );
  const row = found.rows[0];
  if (!row) throw new DomainError(401, 'SESSION_INVALID', 'Session invalid');
  return {
    id: row.id,
    organizationId: row.organization_id,
    permissions: row.permissions,
    roles: row.roles,
  };
}
export function requirePermission(actor: Actor, permission: Permission) {
  if (!actor.permissions.includes(permission))
    throw new DomainError(403, 'FORBIDDEN', 'Permission required');
}
export async function audit(
  client: PoolClient,
  actor: Pick<Actor, 'organizationId'> & { id: string | null },
  action: string,
  entityType: string,
  entityId: string | null,
  fields: string[] = [],
) {
  await client.query(
    'INSERT INTO audit_events(organization_id,user_id,action,entity_type,entity_id,description,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      actor.organizationId,
      actor.id,
      action,
      entityType,
      entityId,
      `${action} ${entityType}`,
      JSON.stringify({ changedFields: fields }),
    ],
  );
}
const payloadFields: Record<string, readonly string[]> = {
  work_schedules: ['code', 'name', 'description', 'status'],
  work_schedule_versions: [
    'scheduleId',
    'effectiveFrom',
    'timezone',
    'name',
    'code',
    'reason',
    'days',
    'createdBy',
  ],
  employee_schedule_assignments: [
    'employeeId',
    'scheduleId',
    'effectiveFrom',
    'effectiveTo',
    'reason',
  ],
  time_records: [
    'employeeId',
    'recordedAt',
    'recordType',
    'source',
    'deviceId',
    'deviceEmployeeId',
    'externalRecordId',
    'reason',
    'createdBy',
  ],
  time_record_corrections: [
    'timeRecordId',
    'operation',
    'recordedAt',
    'recordType',
    'reason',
    'createdBy',
  ],
  leave_types: ['code', 'name', 'description', 'paid', 'requiresApproval', 'status'],
  leave_requests: [
    'employeeId',
    'leaveTypeId',
    'startDate',
    'endDate',
    'durationType',
    'reason',
    'status',
    'typeSnapshot',
    'requestedBy',
    'requestedAt',
    'approvedBy',
    'approvedAt',
    'rejectedBy',
    'rejectedAt',
    'cancelledBy',
    'cancelledAt',
    'remarks',
  ],
  attendance_records: [
    'employeeId',
    'workDate',
    'scheduleAssignmentId',
    'scheduleVersionId',
    'firstIn',
    'lastOut',
    'workedMinutes',
    'lateMinutes',
    'undertimeMinutes',
    'attendanceStatus',
    'approvalStatus',
    'inputHash',
    'result',
    'approvedBy',
    'approvedAt',
  ],
  attendance_adjustments: ['attendanceId', 'overrides', 'reason', 'createdBy'],
  organizations: [
    'legalName',
    'tradeName',
    'tin',
    'rdoCode',
    'sssNumber',
    'philhealthNumber',
    'pagibigNumber',
    'address',
    'barangay',
    'city',
    'province',
    'postalCode',
    'country',
    'phone',
    'email',
    'timezone',
    'currency',
    'status',
  ],
  departments: ['code', 'name', 'description', 'status'],
  positions: ['code', 'name', 'description', 'status', 'departmentId'],
  employees: [
    'employeeNumber',
    'firstName',
    'middleName',
    'lastName',
    'suffix',
    'birthDate',
    'email',
    'mobileNumber',
    'address',
    'barangay',
    'city',
    'province',
    'postalCode',
    'sssNumber',
    'philhealthNumber',
    'pagibigNumber',
    'tin',
    'status',
    'employmentVersions',
  ],
  biometric_devices: ['code', 'name', 'status'],
  biometric_mappings: ['employeeId', 'deviceId', 'deviceEmployeeId', 'status'],
  payroll_configurations: ['configuration'],
};
export async function outbox(
  client: PoolClient,
  table: string,
  row: FoundationRecord,
  operation: string,
) {
  const fields = payloadFields[table];
  if (!fields) throw new Error('Entity is not synchronizable');
  const payload: Record<string, unknown> = {
    id: row.id,
    organizationId: row.organizationId ?? row.id,
    revision: row.revision,
  };
  for (const field of fields) if (field in row) payload[field] = row[field];
  if (table === 'employees' && Array.isArray(row.employmentVersions)) {
    const allowed = [
      'id',
      'organizationId',
      'employeeId',
      'departmentId',
      'positionId',
      'effectiveFrom',
      'effectiveTo',
      'employmentType',
      'employmentStatus',
      'hireDate',
      'regularizationDate',
      'terminationDate',
      'payType',
      'payFrequency',
      'basicRateCentavos',
      'createdAt',
      'updatedAt',
      'updatedBy',
    ];
    payload.employmentVersions = row.employmentVersions.map((version: unknown) => {
      if (typeof version !== 'object' || version === null)
        throw new Error('Invalid employment snapshot');
      return Object.fromEntries(Object.entries(version).filter(([key]) => allowed.includes(key)));
    });
  }
  await client.query(
    'INSERT INTO sync_outbox(organization_id,entity_type,entity_id,operation,revision,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [row.organizationId ?? row.id, table, row.id, operation, row.revision, JSON.stringify(payload)],
  );
}
const snake = (key: string) => key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
export async function insert(
  client: PoolClient,
  table: string,
  data: Record<string, unknown>,
): Promise<FoundationRecord> {
  const entries = Object.entries(data);
  const query = sql`INSERT INTO ${sql.identifier(table)} (${sql.join(
    entries.map(([k]) => sql.identifier(snake(k))),
    sql`,`,
  )}) VALUES (${sql.join(
    entries.map(([, v]) => sql`${v}`),
    sql`,`,
  )}) RETURNING *`;
  const result = await drizzle(client).execute(query);
  return normalize(result.rows[0]!);
}
export async function update(
  client: PoolClient,
  table: string,
  id: string,
  organizationId: string,
  revision: number,
  data: Record<string, unknown>,
  actor: { id: string | null },
): Promise<FoundationRecord> {
  const parts = Object.entries(data).map(([k, v]) => sql`${sql.identifier(snake(k))}=${v}`);
  const scope =
    table === 'organizations' ? sql`id=${organizationId}` : sql`organization_id=${organizationId}`;
  const result = await drizzle(client).execute(
    sql`UPDATE ${sql.identifier(table)} SET ${sql.join(parts, sql`,`)},revision=revision+1,updated_at=now(),updated_by=${actor.id} WHERE id=${id} AND ${scope} AND revision=${revision} RETURNING *`,
  );
  if (!result.rows[0])
    throw new DomainError(
      409,
      'CONFLICT',
      'Record changed or is no longer available; reload before saving',
    );
  return normalize(result.rows[0]);
}
export async function lockEmployee(
  client: PoolClient,
  organizationId: string,
  id: string,
  revision: number,
) {
  const result = await client.query(
    'SELECT id FROM employees WHERE organization_id=$1 AND id=$2 AND revision=$3 FOR UPDATE',
    [organizationId, id, revision],
  );
  if (!result.rowCount)
    throw new DomainError(409, 'CONFLICT', 'Employee changed; reload before saving');
}
export const createNodeRepository = (pool: Pool) => ({
  async find(id: string, organizationId: string) {
    const result = await pool.query('SELECT * FROM sync_nodes WHERE id=$1 AND organization_id=$2', [
      id,
      organizationId,
    ]);
    return result.rows[0] ? normalize(result.rows[0]) : null;
  },
  async provision(organizationId: string, deviceName: string) {
    return transaction(pool, (client) =>
      insert(client, 'sync_nodes', { organizationId, deviceName }),
    );
  },
});
