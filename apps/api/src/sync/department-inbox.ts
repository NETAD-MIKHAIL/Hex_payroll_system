import type { PoolClient } from 'pg';
import { z } from 'zod';
import { departmentInputSchema } from '@hexpayroll/shared';

const departmentSnapshotSchema = departmentInputSchema
  .extend({
    id: z.uuid(),
    organizationId: z.uuid(),
    revision: z.number().int().positive().max(2147483647),
  })
  .strict();

interface DepartmentInboxEvent {
  organization_id: string;
  entity_id: string;
  operation: string;
  revision: number;
  payload_version: number;
  payload: unknown;
}

const fields = [
  ['code', 'code'],
  ['name', 'name'],
  ['description', 'description'],
  ['status', 'status'],
] as const;

export async function applyDepartmentEvent(
  client: PoolClient,
  event: DepartmentInboxEvent,
): Promise<void> {
  const parsed = departmentSnapshotSchema.safeParse(event.payload);

  if (!parsed.success || event.payload_version !== 1) {
    throw new Error('Invalid department snapshot or version');
  }

  const department = parsed.data;

  if (
    department.id !== event.entity_id ||
    department.organizationId !== event.organization_id ||
    department.revision !== event.revision
  ) {
    throw new Error('Department snapshot identity mismatch');
  }

  if (!['CREATE', 'UPDATE', 'ARCHIVE'].includes(event.operation)) {
    throw new Error('Invalid department operation');
  }

  if (event.operation === 'ARCHIVE' && department.status !== 'inactive') {
    throw new Error('Archived department must be inactive');
  }

  const setup = await client.query<{ organization_id: string | null }>(
    'SELECT organization_id FROM application_setup WHERE singleton FOR SHARE',
  );

  if (setup.rows[0]?.organization_id !== department.organizationId) {
    throw new Error('Department organization is not enrolled');
  }

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'departments:' + department.id,
  ]);

  const existing = await client.query<Record<string, unknown>>(
    'SELECT * FROM departments WHERE id=$1 FOR UPDATE',
    [department.id],
  );

  const current = existing.rows[0];

  if (!current) {
    if (event.operation !== 'CREATE') {
      throw new Error('Department dependency missing locally');
    }

    await client.query(
      `INSERT INTO departments (
        id, organization_id, code, name,
        description, status, revision
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        department.id,
        department.organizationId,
        department.code,
        department.name,
        department.description,
        department.status,
        department.revision,
      ],
    );

    return;
  }

  if (current.organization_id !== department.organizationId) {
    throw new Error('Department organization mismatch');
  }

  if (Number(current.revision) > department.revision) {
    return;
  }

  if (Number(current.revision) === department.revision) {
    const matches = fields.every(([property, column]) => current[column] === department[property]);

    if (!matches) {
      throw new Error('Department revision conflict; local data preserved');
    }

    return;
  }

  const values = fields.map(([property]) => department[property]);

  const assignments = fields.map(([, column], index) => `${column}=$${index + 3}`);

  await client.query(
    `UPDATE departments
     SET ${assignments.join(', ')},
         revision=$${fields.length + 3}
     WHERE id=$1 AND organization_id=$2`,
    [department.id, department.organizationId, ...values, department.revision],
  );
}
