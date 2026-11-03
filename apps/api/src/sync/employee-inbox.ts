import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  employeeInputSchema,
  employmentSchema,
  nonNegativeCentavosSchema,
} from '@hexpayroll/shared';

const historySchema = employmentSchema
  .extend({
    basicRateCentavos: nonNegativeCentavosSchema,
  })
  .strict()
  .refine(
    (v) =>
      (v.effectiveTo === null || v.effectiveTo > v.effectiveFrom) &&
      (v.regularizationDate === null || v.regularizationDate >= v.hireDate) &&
      (v.terminationDate === null || v.terminationDate >= v.hireDate),
    'Invalid employment dates',
  );

const snapshotSchema = employeeInputSchema
  .extend({
    id: z.uuid(),
    organizationId: z.uuid(),
    revision: z.number().int().positive().max(2147483647),
    employmentVersions: z.array(historySchema).optional(),
  })
  .strict();

interface EmployeeInboxEvent {
  organization_id: string;
  entity_id: string;
  operation: string;
  revision: number;
  payload_version: number;
  payload: unknown;
}

const employeeFields = [
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
] as const;
const historyFields = [
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
] as const;
const column = (key: string) => key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

// Snapshot nullable fields must be explicit: input-schema defaults must not hide data loss.
function requireFields(value: unknown, fields: readonly string[]) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    fields.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error('Incomplete employee or employment snapshot');
  }
}

function equalValue(key: string, stored: unknown, incoming: unknown): boolean {
  if (key === 'createdAt' || key === 'updatedAt') {
    return new Date(stored as string).getTime() === Date.parse(incoming as string);
  }
  if (key === 'basicRateCentavos') {
    return Number.isSafeInteger(Number(stored)) && Number(stored) === incoming;
  }
  // Explicit date casts in history reads avoid depending on global pg parser initialization.
  return stored === incoming;
}

export async function applyEmployeeEvent(
  client: PoolClient,
  event: EmployeeInboxEvent,
): Promise<void> {
  requireFields(event.payload, employeeFields);
  const parsed = snapshotSchema.safeParse(event.payload);
  if (!parsed.success || event.payload_version !== 1) {
    throw new Error('Invalid employee snapshot or version');
  }
  const employee = parsed.data;
  if (
    employee.id !== event.entity_id ||
    employee.organizationId !== event.organization_id ||
    employee.revision !== event.revision
  ) {
    throw new Error('Employee snapshot identity mismatch');
  }
  if (
    !['CREATE', 'UPDATE', 'ARCHIVE'].includes(event.operation) ||
    (event.operation === 'ARCHIVE' && !['inactive', 'terminated'].includes(employee.status))
  ) {
    throw new Error('Invalid employee operation or archive status');
  }
  const raw = event.payload as Record<string, unknown>;
  if (Object.hasOwn(raw, 'employmentVersions') && !Array.isArray(raw.employmentVersions)) {
    throw new Error('Invalid employment history collection');
  }
  const versions = employee.employmentVersions;
  if (versions) {
    for (const version of raw.employmentVersions as unknown[])
      requireFields(version, historyFields);
    const ids = new Set<string>();
    const ordered = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (let i = 0; i < ordered.length; i++) {
      const version = ordered[i]!;
      if (
        version.organizationId !== employee.organizationId ||
        version.employeeId !== employee.id ||
        ids.has(version.id)
      )
        throw new Error('Employment identity mismatch or duplicate version');
      ids.add(version.id);
      const previous = ordered[i - 1];
      if (
        previous &&
        (previous.effectiveTo === null ||
          previous.effectiveTo > version.effectiveFrom ||
          previous.effectiveFrom === version.effectiveFrom)
      ) {
        throw new Error('Employment periods overlap or duplicate effective date');
      }
    }
  }

  const setup = await client.query(
    'SELECT organization_id FROM application_setup WHERE singleton FOR SHARE',
  );
  if (setup.rows[0]?.organization_id !== employee.organizationId) {
    throw new Error('Employee organization is not enrolled');
  }
  // Match the organization lock taken by payroll source-write triggers before row locks.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,731))', [
    employee.organizationId,
  ]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'employees:' + employee.id,
  ]);
  const current = (
    await client.query<Record<string, unknown>>(
      'SELECT *,birth_date::text AS birth_date FROM employees WHERE id=$1 FOR UPDATE',
      [employee.id],
    )
  ).rows[0];
  if (current && current.organization_id !== employee.organizationId) {
    throw new Error('Employee organization mismatch');
  }
  if (current && Number(current.revision) > employee.revision) return;
  if (!current && event.operation !== 'CREATE')
    throw new Error('Employee dependency missing locally');

  const localHistory = (
    await client.query<Record<string, unknown>>(
      `SELECT *,effective_from::text AS effective_from,effective_to::text AS effective_to,
       hire_date::text AS hire_date,regularization_date::text AS regularization_date,
       termination_date::text AS termination_date
     FROM employment_versions AS ev WHERE ev.employee_id=$1 ORDER BY ev.effective_from FOR UPDATE`,
      [employee.id],
    )
  ).rows;
  const localById = new Map(localHistory.map((v) => [v.id, v]));
  if (versions) {
    const incomingIds = new Set(versions.map((v) => v.id));
    if (localHistory.some((v) => !incomingIds.has(v.id as string))) {
      throw new Error('Incomplete employment history; local records preserved');
    }
    for (const version of versions) {
      const owner = (
        await client.query(
          'SELECT employee_id,organization_id FROM employment_versions WHERE id=$1 FOR UPDATE',
          [version.id],
        )
      ).rows[0];
      if (
        owner &&
        (owner.employee_id !== employee.id || owner.organization_id !== employee.organizationId)
      ) {
        throw new Error('Employment version belongs to another employee or organization');
      }
      if (version.departmentId !== null) {
        const department = await client.query(
          'SELECT id FROM departments WHERE id=$1 AND organization_id=$2 FOR KEY SHARE',
          [version.departmentId, employee.organizationId],
        );
        if (!department.rows[0]) throw new Error('Employee department dependency missing locally');
      }
      if (version.positionId !== null) {
        const position = (
          await client.query(
            'SELECT department_id FROM positions WHERE id=$1 AND organization_id=$2 FOR SHARE',
            [version.positionId, employee.organizationId],
          )
        ).rows[0];
        if (!position) throw new Error('Employee position dependency missing locally');
        if (position.department_id !== null && position.department_id !== version.departmentId) {
          throw new Error('Employment position department mismatch');
        }
      }
      if (version.updatedBy !== null) {
        const user = await client.query(
          'SELECT id FROM auth_users WHERE id=$1 AND organization_id=$2 FOR KEY SHARE',
          [version.updatedBy, employee.organizationId],
        );
        if (!user.rows[0]) throw new Error('Employment user dependency missing locally');
      }
    }
  }
  if (current && Number(current.revision) === employee.revision) {
    const matches = employeeFields.every((key) =>
      equalValue(key, current[column(key)], employee[key]),
    );
    const historyMatches =
      versions === undefined ||
      (versions.length === localHistory.length &&
        versions.every((v) => {
          const local = localById.get(v.id);
          return local && historyFields.every((key) => equalValue(key, local[column(key)], v[key]));
        }));
    if (!matches || !historyMatches)
      throw new Error('Employee revision conflict; local data preserved');
    return;
  }

  // Existing history is immutable except for closing an open period and its update audit fields.
  if (versions) {
    for (const version of versions) {
      const local = localById.get(version.id);
      if (!local) continue;
      const immutable = historyFields.filter(
        (key) => !['effectiveTo', 'updatedAt', 'updatedBy'].includes(key),
      );
      if (
        !immutable.every((key) => equalValue(key, local[column(key)], version[key])) ||
        (local.effective_to !== null && local.effective_to !== version.effectiveTo)
      ) {
        throw new Error('Unsafe employment history rewrite; local records preserved');
      }
    }
  }
  if (!current) {
    const keys = ['id', 'organizationId', ...employeeFields, 'revision'] as const;
    await client.query(
      `INSERT INTO employees(${keys.map(column).join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
      keys.map((key) => employee[key]),
    );
  } else {
    await client.query(
      `UPDATE employees SET ${employeeFields.map((key, i) => column(key) + '=$' + (i + 3)).join(',')},
       revision=$${employeeFields.length + 3} WHERE id=$1 AND organization_id=$2`,
      [
        employee.id,
        employee.organizationId,
        ...employeeFields.map((key) => employee[key]),
        employee.revision,
      ],
    );
  }
  if (versions) {
    // Close existing open periods first, retaining trigger enforcement during all writes.
    for (const version of versions) {
      if (!localById.has(version.id)) continue;
      await client.query(
        `UPDATE employment_versions SET effective_to=$2,updated_at=$3,updated_by=$4
         WHERE id=$1 AND employee_id=$5 AND organization_id=$6`,
        [
          version.id,
          version.effectiveTo,
          version.updatedAt,
          version.updatedBy,
          employee.id,
          employee.organizationId,
        ],
      );
    }
    for (const version of [...versions].sort((a, b) =>
      a.effectiveFrom.localeCompare(b.effectiveFrom),
    )) {
      if (localById.has(version.id)) continue;
      await client.query(
        `INSERT INTO employment_versions(${historyFields.map(column).join(',')})
         VALUES(${historyFields.map((_, i) => '$' + (i + 1)).join(',')})`,
        historyFields.map((key) => version[key]),
      );
    }
  }
}
