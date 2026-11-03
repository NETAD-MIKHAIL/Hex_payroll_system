import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Permission } from '@hexpayroll/shared';
import { tokenHash } from '../auth/service.js';
import { authenticateNode } from '../sync/service.js';
import { DomainError, transaction } from '../foundation/repository.js';

export const centralCredentialsSchema = z
  .object({
    nodeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const operationSchema = z
  .object({
    organizationId: z.uuid(),
    authorUserId: z.uuid(),
    action: z.enum(['calculate', 'adjust', 'approve', 'reopen']),
  })
  .strict();
export type AttendanceAuthorizationOperation = z.infer<typeof operationSchema>;
export type AttendanceAuthorizationCredentials = z.infer<typeof centralCredentialsSchema>;
const permissions = {
  calculate: 'attendance.manage',
  adjust: 'attendance.adjust',
  approve: 'attendance.approve',
  reopen: 'attendance.manage',
} as const satisfies Record<AttendanceAuthorizationOperation['action'], Permission>;

export interface CentralAttendanceAuthorization {
  readonly organizationId: string;
  readonly nodeId: string;
  readonly submitterUserId: string;
  readonly authorUserId: string;
  readonly action: AttendanceAuthorizationOperation['action'];
  readonly permission: Permission;
  readonly authorizedAt: string;
  readonly sessionExpiresAt: string;
}

/** Server configuration, never request data, supplies mode and the central pool.
 * The returned snapshot is NOT a capability for a later canonical write.
 * Future acceptance must authenticate again inside its own write transaction.
 */
export function createCentralAttendanceAuthorizationResolver(
  pool: Pool,
  mode: 'local' | 'central',
) {
  return async function resolve(
    credentials: AttendanceAuthorizationCredentials,
    operation: AttendanceAuthorizationOperation,
  ): Promise<CentralAttendanceAuthorization> {
    if (mode !== 'central')
      throw new DomainError(403, 'CENTRAL_ONLY', 'Central attendance authorization is unavailable');
    const parsedCredentials = centralCredentialsSchema.safeParse(credentials);
    if (!parsedCredentials.success)
      throw new DomainError(401, 'AUTH_INVALID', 'Valid node and user credentials are required');
    const parsedOperation = operationSchema.safeParse(operation);
    if (!parsedOperation.success)
      throw new DomainError(400, 'INVALID_REQUEST', 'Invalid attendance authorization operation');
    const requested = parsedOperation.data;
    return transaction(pool, async (client) => {
      const identity = await authorizeCentralUser(
        client,
        parsedCredentials.data,
        requested.organizationId,
        permissions[requested.action],
        requested.authorUserId,
      );
      return Object.freeze({ ...identity, action: requested.action });
    });
  };
}

// Internal transaction helper. Caller validates credentials and owns the transaction.
export async function authorizeCentralUser(
  client: PoolClient,
  credentials: AttendanceAuthorizationCredentials,
  organizationId: string,
  permission: Permission,
  authorUserId?: string,
) {
  const { nodeToken, sessionToken } = credentials;
  // Match existing RBAC administration's lock order. No setup/heartbeat writes.
  await client.query('SELECT singleton FROM application_setup WHERE singleton FOR SHARE');
  const authenticatedNode = await authenticateNode(client, nodeToken);
  const node = (
    await client.query<{ id: string; organization_id: string }>(
      `SELECT id,organization_id FROM sync_nodes
         WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL FOR SHARE`,
      [authenticatedNode.id, tokenHash(nodeToken)],
    )
  ).rows[0];
  if (!node) throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
  const hash = tokenHash(sessionToken);
  const initialSession = (
    await client.query<{ user_id: string }>(
      'SELECT user_id FROM auth_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()',
      [hash],
    )
  ).rows[0];
  if (!initialSession) throw new DomainError(401, 'SESSION_INVALID', 'User session invalid');
  // User before session matches account changes that update users then delete sessions.
  const user = (
    await client.query<{ id: string; organization_id: string | null }>(
      'SELECT id,organization_id FROM auth_users WHERE id=$1 AND active FOR SHARE',
      [initialSession.user_id],
    )
  ).rows[0];
  if (!user) throw new DomainError(401, 'SESSION_INVALID', 'User session invalid');
  const session = (
    await client.query(
      `SELECT user_id FROM auth_sessions WHERE token_hash=$1 AND user_id=$2
         AND expires_at>clock_timestamp() FOR SHARE`,
      [hash, user.id],
    )
  ).rows[0];
  if (!session) throw new DomainError(401, 'SESSION_INVALID', 'User session invalid');
  if (user.organization_id !== node.organization_id || organizationId !== node.organization_id)
    throw new DomainError(403, 'ORGANIZATION_MISMATCH', 'Attendance organization mismatch');
  if (authorUserId !== undefined && authorUserId !== user.id)
    throw new DomainError(403, 'AUTHOR_MISMATCH', 'Delegated attendance submission is unavailable');
  // Lock actual grants, rather than trusting a cached actor or caller role list.
  const grants = await client.query(
    `SELECT ur.role_id FROM user_roles ur JOIN roles r ON r.id=ur.role_id
         JOIN role_permissions rp ON rp.role_id=r.id
         JOIN permissions p ON p.code=rp.permission_code
         WHERE ur.user_id=$1 AND rp.permission_code=$2
           AND (r.system OR r.organization_id=$3)
         ORDER BY r.id FOR SHARE OF ur,r,rp,p`,
    [user.id, permission, node.organization_id],
  );
  if (!grants.rowCount) throw new DomainError(403, 'FORBIDDEN', 'Attendance permission required');
  // A lock wait can outlive expiry; transaction-start now() would be unsafe here.
  const timing = (
    await client.query<{ authorized_at: string; expires_at: string }>(
      `SELECT clock_timestamp()::text authorized_at,expires_at::text
         FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()`,
      [hash, user.id],
    )
  ).rows[0];
  if (!timing) throw new DomainError(401, 'SESSION_INVALID', 'User session invalid');
  return Object.freeze({
    organizationId: node.organization_id,
    nodeId: node.id,
    submitterUserId: user.id,
    authorUserId: user.id,
    permission,
    authorizedAt: timing.authorized_at,
    sessionExpiresAt: timing.expires_at,
  });
}
