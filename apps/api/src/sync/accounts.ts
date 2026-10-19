import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../foundation/repository.js';
/** Login accounts are installation-local. Never publish password verifiers. */
export async function enqueueAccount(_client: PoolClient, _userId: string) {
  return { eventId: null, status: 'local_only' };
}
export async function queueAccountByUsername(_pool: Pool, _username: string) {
  throw new DomainError(
    409,
    'ACCOUNT_LOCAL_ONLY',
    'Provision login accounts separately on each installation',
  );
}
