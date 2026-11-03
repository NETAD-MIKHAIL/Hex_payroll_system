import type { PoolClient } from 'pg';
import { z } from 'zod';
import { positionInputSchema } from '@hexpayroll/shared';

const positionSnapshotSchema = positionInputSchema
  .extend({
    id: z.uuid(),
    organizationId: z.uuid(),
    revision: z.number().int().positive().max(2147483647),
  })
  .strict();

interface PositionInboxEvent {
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
  ['departmentId', 'department_id'],
] as const;

export async function applyPositionEvent(
  client: PoolClient,
  event: PositionInboxEvent,
): Promise<void> {
  const parsed = positionSnapshotSchema.safeParse(event.payload);

  if (!parsed.success || event.payload_version !== 1) {
    throw new Error('Invalid position snapshot or version');
  }

  const position = parsed.data;

  if (
    position.id !== event.entity_id ||
    position.organizationId !== event.organization_id ||
    position.revision !== event.revision
  ) {
    throw new Error('Position snapshot identity mismatch');
  }

  if (!['CREATE', 'UPDATE', 'ARCHIVE'].includes(event.operation)) {
    throw new Error('Invalid position operation');
  }

  if (event.operation === 'ARCHIVE' && position.status !== 'inactive') {
    throw new Error('Archived position must be inactive');
  }

  const setup = await client.query<{ organization_id: string | null }>(
    'SELECT organization_id FROM application_setup WHERE singleton FOR SHARE',
  );

  if (setup.rows[0]?.organization_id !== position.organizationId) {
    throw new Error('Position organization is not enrolled');
  }

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'positions:' + position.id,
  ]);

  const existing = await client.query<Record<string, unknown>>(
    'SELECT * FROM positions WHERE id=$1 FOR UPDATE',
    [position.id],
  );

  const current = existing.rows[0];

  if (current && current.organization_id !== position.organizationId) {
    throw new Error('Position organization mismatch');
  }

  if (current && Number(current.revision) > position.revision) {
    return;
  }

  if (position.departmentId !== null) {
    const department = await client.query(
      'SELECT id FROM departments WHERE id=$1 AND organization_id=$2 FOR KEY SHARE',
      [position.departmentId, position.organizationId],
    );

    if (!department.rows[0]) {
      throw new Error('Position department dependency missing locally');
    }
  }

  if (!current) {
    if (event.operation !== 'CREATE') {
      throw new Error('Position dependency missing locally');
    }

    await client.query(
      `INSERT INTO positions (
        id, organization_id, code, name,
        description, status, revision, department_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        position.id,
        position.organizationId,
        position.code,
        position.name,
        position.description,
        position.status,
        position.revision,
        position.departmentId,
      ],
    );

    return;
  }

  if (Number(current.revision) === position.revision) {
    const matches = fields.every(([property, column]) => current[column] === position[property]);

    if (!matches) {
      throw new Error('Position revision conflict; local data preserved');
    }

    return;
  }

  const values = fields.map(([property]) => position[property]);

  const assignments = fields.map(([, column], index) => `${column}=$${index + 3}`);

  await client.query(
    `UPDATE positions
     SET ${assignments.join(', ')},
         revision=$${fields.length + 3}
     WHERE id=$1 AND organization_id=$2`,
    [position.id, position.organizationId, ...values, position.revision],
  );
}
