import type { PoolClient } from 'pg';
import { z } from 'zod';
import { organizationInputSchema } from '@hexpayroll/shared';

const organizationSnapshotSchema = organizationInputSchema
  .extend({
    id: z.uuid(),
    organizationId: z.uuid(),
    revision: z.number().int().positive().max(2147483647),
  })
  .strict();

interface OrganizationInboxEvent {
  organization_id: string;
  entity_id: string;
  operation: string;
  revision: number;
  payload_version: number;
  payload: unknown;
}

const fields = [
  ['legalName', 'legal_name'],
  ['tradeName', 'trade_name'],
  ['tin', 'tin'],
  ['rdoCode', 'rdo_code'],
  ['sssNumber', 'sss_number'],
  ['philhealthNumber', 'philhealth_number'],
  ['pagibigNumber', 'pagibig_number'],
  ['address', 'address'],
  ['barangay', 'barangay'],
  ['city', 'city'],
  ['province', 'province'],
  ['postalCode', 'postal_code'],
  ['country', 'country'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['timezone', 'timezone'],
  ['currency', 'currency'],
  ['status', 'status'],
] as const;

export async function applyOrganizationEvent(
  client: PoolClient,
  event: OrganizationInboxEvent,
): Promise<void> {
  const parsed = organizationSnapshotSchema.safeParse(event.payload);

  if (!parsed.success || event.payload_version !== 1) {
    throw new Error('Invalid organization snapshot or version');
  }

  const organization = parsed.data!;

  if (
    organization.id !== event.entity_id ||
    organization.organizationId !== event.organization_id ||
    organization.id !== organization.organizationId ||
    organization.revision !== event.revision
  ) {
    throw new Error('Organization snapshot identity mismatch');
  }

  if (!['CREATE', 'UPDATE', 'ARCHIVE'].includes(event.operation)) {
    throw new Error('Invalid organization operation');
  }

  if (event.operation === 'ARCHIVE' && organization.status !== 'inactive') {
    throw new Error('Archived organization must be inactive');
  }

  const setup = await client.query<{ organization_id: string | null }>(
    'SELECT organization_id FROM application_setup WHERE singleton FOR SHARE',
  );

  if (setup.rows[0]?.organization_id !== organization.id) {
    throw new Error('Organization is not enrolled on this installation');
  }

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'organizations:' + organization.id,
  ]);

  const existing = await client.query<Record<string, unknown>>(
    'SELECT * FROM organizations WHERE id=$1 FOR UPDATE',
    [organization.id],
  );

  const current = existing.rows[0];

  if (!current) {
    throw new Error('Enrolled organization is missing locally');
  }

  if (Number(current.revision) > organization.revision) {
    return;
  }

  if (Number(current.revision) === organization.revision) {
    const matches = fields.every(([property, column]) => {
      return current[column] === organization[property];
    });

    if (!matches) {
      throw new Error('Organization revision conflict; local data preserved');
    }

    return;
  }

  const values = fields.map(([property]) => organization[property]);

  const assignments = fields.map(([, column], index) => `${column}=$${index + 2}`);

  await client.query(
    `UPDATE organizations
     SET ${assignments.join(', ')},
         revision=$${fields.length + 2}
     WHERE id=$1`,
    [organization.id, ...values, organization.revision],
  );
}
