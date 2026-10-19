import type { PoolClient } from 'pg';
import type { FoundationRecord } from '@hexpayroll/shared';
import {
  audit,
  DomainError,
  lockEmployee,
  normalize,
  outbox,
  requirePermission,
  sensitiveFields,
  update,
  type Actor,
} from './repository.js';

/** Shared transactional mutation used by ordinary edits and conflict resolution.
 * Inputs are validated by the corresponding domain schema before entry. */
export async function updateFoundationRecord(
  client: PoolClient,
  who: Actor,
  table: string,
  id: string,
  expectedRevision: number,
  input: Record<string, unknown>,
): Promise<FoundationRecord> {
  const data = { ...input };
  if (table === 'employees') {
    requirePermission(who, 'employees.update');
    await lockEmployee(client, who.organizationId!, id, expectedRevision);
    const old = (
      await client.query('SELECT * FROM employees WHERE id=$1 AND organization_id=$2', [
        id,
        who.organizationId,
      ])
    ).rows[0];
    if ('status' in data && old.status !== data.status) requirePermission(who, 'employees.archive');
    if (!who.permissions.includes('employees.sensitive.update'))
      for (const key of sensitiveFields) {
        if (key in data && data[key] != null && data[key] !== normalize(old)[key])
          throw new DomainError(403, 'FORBIDDEN', 'Sensitive field permission required');
        delete data[key];
      }
  }
  if (table === 'departments') requirePermission(who, 'departments.manage');
  if (table === 'positions') {
    requirePermission(who, 'positions.manage');
    if (data.departmentId) {
      const ref = await client.query(
        "SELECT id FROM departments WHERE organization_id=$1 AND id=$2 AND status='active' FOR SHARE",
        [who.organizationId, data.departmentId],
      );
      if (!ref.rowCount) throw new DomainError(409, 'CONFLICT', 'Department is unavailable');
    }
  }
  const saved = await update(client, table, id, who.organizationId!, expectedRevision, data, who);
  await audit(
    client,
    who,
    data.status === 'inactive' || data.status === 'terminated' ? 'ARCHIVE' : 'UPDATE',
    table,
    id,
    Object.keys(data),
  );
  const snapshot = { ...saved };
  if (table === 'employees')
    snapshot.employmentVersions = (
      await client.query(
        'SELECT * FROM employment_versions WHERE organization_id=$1 AND employee_id=$2 ORDER BY effective_from',
        [who.organizationId, id],
      )
    ).rows.map(normalize);
  await outbox(client, table, snapshot, 'UPDATE');
  return saved;
}
