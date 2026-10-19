import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../foundation/repository.js';
/** Legacy account replication is retired. Login credentials and roles are local. */
export async function applyAccountEvent(_client: PoolClient, _event: unknown): Promise<void> {
  throw new DomainError(
    409,
    'ACCOUNT_LOCAL_ONLY',
    'Account replication is disabled; provision login accounts separately',
  );
}
export async function applyInboxBatch(pool: Pool, organizationId: string) {
  const r = await pool.query(
    'SELECT count(*)::int AS pending FROM sync_inbox WHERE organization_id=$1 AND applied_at IS NULL',
    [organizationId],
  );
  return { applied: 0, pending: Number(r.rows[0].pending) };
}
