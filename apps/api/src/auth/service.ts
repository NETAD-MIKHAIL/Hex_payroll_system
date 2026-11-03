import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createUserSchema,
  SESSION_LIFETIME_MS,
  type CreateUserInput,
  type LoginRequest,
  type LoginResponse,
  type PublicUser,
  type SessionResponse,
} from '@hexpayroll/shared';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.js';
import { transaction, getActor, audit } from '../foundation/repository.js';
import { enqueueAccount } from '../sync/accounts.js';
interface UserRow {
  id: string;
  username: string;
  email: string | null;
  display_name: string;
  password_hash: string | null;
  active: boolean;
}
function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    ...(row.email === null ? {} : { email: row.email }),
    displayName: row.display_name,
  };
}
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function createAuthService(database: Pool) {
  return {
    async createUser(input: CreateUserInput): Promise<PublicUser> {
      const parsed = createUserSchema.parse(input);
      const hash = await hashPassword(parsed.password);
      return transaction(database, async (client) => {
        const result = await client.query<UserRow>(
          'INSERT INTO auth_users (username, email, display_name, password_hash,organization_id) VALUES ($1,$2,$3,$4,(SELECT organization_id FROM application_setup WHERE singleton)) RETURNING id, username, email, display_name',
          [parsed.username, parsed.email ?? null, parsed.displayName, hash],
        );
        const row = result.rows[0]!;
        await client.query("INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='viewer'", [
          row.id,
        ]);
        const actor = await getActor(client, row.id);
        await audit(client, actor, 'CREATE', 'auth_users', row.id, ['username', 'displayName']);
        await enqueueAccount(client, row.id);
        return publicUser(row);
      });
    },
    async login(input: LoginRequest): Promise<LoginResponse | null> {
      const column = input.identifier.includes('@') ? 'email' : 'username';
      const found = await database.query<UserRow>(
        `SELECT * FROM auth_users u WHERE lower(${column}) = lower($1) AND NOT identity_only AND NOT EXISTS(SELECT 1 FROM trusted_actor_identities t WHERE t.user_id=u.id AND NOT t.active)`,
        [input.identifier],
      );
      const row = found.rows[0];
      const valid = await verifyPassword(input.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
      if (!row || !valid || !row.active) return null;
      const accessToken = randomBytes(32).toString('base64url');
      // Recheck activation before inserting; protected requests also check activation.
      return transaction(database, async (client) => {
        const result = await client.query<{ expires_at: Date }>(
          "INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) SELECT $1, id, now(), now() + ($3 * interval '1 millisecond') FROM auth_users u WHERE id=$2 AND active AND NOT identity_only AND NOT EXISTS(SELECT 1 FROM trusted_actor_identities t WHERE t.user_id=u.id AND NOT t.active) RETURNING expires_at",
          [tokenHash(accessToken), row.id, SESSION_LIFETIME_MS],
        );
        if (!result.rows[0]) return null;
        await client.query('UPDATE auth_users SET last_login_at=now() WHERE id=$1', [row.id]);
        const actor = await getActor(client, row.id);
        await audit(client, actor, 'LOGIN', 'auth_users', row.id);
        return {
          user: {
            ...publicUser(row),
            organizationId: actor.organizationId,
            roles: actor.roles,
            permissions: actor.permissions,
          },
          accessToken,
          expiresAt: result.rows[0].expires_at.toISOString(),
        };
      });
    },
    async session(token: string): Promise<SessionResponse | null> {
      const result = await database.query<UserRow & { expires_at: Date }>(
        'SELECT u.*, s.expires_at FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active AND NOT u.identity_only AND NOT EXISTS(SELECT 1 FROM trusted_actor_identities t WHERE t.user_id=u.id AND NOT t.active)',
        [tokenHash(token)],
      );
      const row = result.rows[0];
      if (!row) return null;
      const actor = await getActor(database, row.id);
      return {
        user: {
          ...publicUser(row),
          organizationId: actor.organizationId,
          roles: actor.roles,
          permissions: actor.permissions,
        },
        expiresAt: row.expires_at.toISOString(),
      };
    },
    async logout(token: string): Promise<void> {
      await transaction(database, async (client) => {
        const session = await client.query<{ user_id: string }>(
          'DELETE FROM auth_sessions WHERE token_hash=$1 RETURNING user_id',
          [tokenHash(token)],
        );
        if (session.rows[0]) {
          const actor = await getActor(client, session.rows[0].user_id);
          await audit(client, actor, 'LOGOUT', 'auth_users', actor.id);
        }
      });
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
