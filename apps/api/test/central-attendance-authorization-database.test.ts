import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { tokenHash } from '../src/auth/service.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { DomainError } from '../src/foundation/repository.js';
import {
  createCentralAttendanceAuthorizationResolver,
  type AttendanceAuthorizationOperation,
} from '../src/timekeeping/central-attendance-authorization.js';

const options = { skip: !databaseTestsEnabled };
const denied = (code: string) => (error: unknown) =>
  error instanceof DomainError && error.code === code;
async function fixture() {
  const db = await databaseFixture();
  try {
    await migrate(db.migrator, db.migrations);
    const org = randomUUID(),
      foreignOrg = randomUUID(),
      user = randomUUID(),
      node = randomUUID();
    const role = randomUUID();
    const credentials = {
      sessionToken: randomBytes(32).toString('base64url'),
      nodeToken: randomBytes(32).toString('base64url'),
    };
    await db.runtime.query(
      "INSERT INTO organizations(id,legal_name) VALUES($1,'Authorization'),($2,'Foreign')",
      [org, foreignOrg],
    );
    await db.runtime.query('UPDATE application_setup SET organization_id=$1', [org]);
    await db.runtime.query(
      `INSERT INTO auth_users(id,organization_id,username,display_name,password_hash)
       VALUES($1,$2,'attendance_user','Attendance user',$3)`,
      [user, org, DUMMY_PASSWORD_HASH],
    );
    await db.runtime.query(
      "INSERT INTO roles(id,code,name,organization_id) VALUES($1,'attendance_test','Attendance test',$2)",
      [role, org],
    );
    await db.runtime.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [user, role]);
    await db.runtime.query(
      `INSERT INTO role_permissions(role_id,permission_code) VALUES
       ($1,'attendance.manage'),($1,'attendance.adjust'),($1,'attendance.approve')`,
      [role],
    );
    await db.runtime.query(
      `INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')`,
      [tokenHash(credentials.sessionToken), user],
    );
    await db.runtime.query(
      "INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,'Enrolled laptop',$3)",
      [node, org, tokenHash(credentials.nodeToken)],
    );
    const operation: AttendanceAuthorizationOperation = {
      organizationId: org,
      authorUserId: user,
      action: 'calculate',
    };
    const resolve = createCentralAttendanceAuthorizationResolver(db.runtime, 'central');
    return { ...db, org, foreignOrg, user, node, role, credentials, operation, resolve };
  } catch (error) {
    await db.close();
    throw error;
  }
}

test(
  'central attendance authorizes actual node/session and returns only audit-safe fields',
  options,
  async () => {
    const f = await fixture();
    try {
      const result = await f.resolve(f.credentials, f.operation);
      assert.equal(result.organizationId, f.org);
      assert.equal(result.nodeId, f.node);
      assert.equal(result.submitterUserId, f.user);
      assert.equal(result.authorUserId, f.user);
      assert.equal(result.permission, 'attendance.manage');
      assert.equal(result.action, 'calculate');
      assert.ok(Date.parse(result.authorizedAt) < Date.parse(result.sessionExpiresAt));
      assert.deepEqual(
        Object.keys(result).sort(),
        [
          'organizationId',
          'nodeId',
          'submitterUserId',
          'authorUserId',
          'action',
          'permission',
          'authorizedAt',
          'sessionExpiresAt',
        ].sort(),
      );
      assert.ok(Object.isFrozen(result));
      const state = (
        await f.runtime.query('SELECT last_seen_at FROM sync_nodes WHERE id=$1', [f.node])
      ).rows[0];
      assert.equal(state.last_seen_at, null);
      assert.equal(
        (await f.runtime.query('SELECT count(*)::int n FROM sync_changes')).rows[0].n,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test('central attendance checks all four action permissions separately', options, async () => {
  const f = await fixture();
  try {
    for (const [action, permission] of [
      ['calculate', 'attendance.manage'],
      ['adjust', 'attendance.adjust'],
      ['approve', 'attendance.approve'],
      ['reopen', 'attendance.manage'],
    ] as const) {
      await f.runtime.query('DELETE FROM role_permissions WHERE role_id=$1', [f.role]);
      await assert.rejects(
        f.resolve(f.credentials, { ...f.operation, action }),
        denied('FORBIDDEN'),
      );
      await f.runtime.query('INSERT INTO role_permissions VALUES($1,$2)', [f.role, permission]);
      assert.equal(
        (await f.resolve(f.credentials, { ...f.operation, action })).permission,
        permission,
      );
    }
  } finally {
    await f.close();
  }
});

test('central attendance rejects invalid, expired and deleted sessions', options, async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.resolve(
        { ...f.credentials, sessionToken: randomBytes(32).toString('base64url') },
        f.operation,
      ),
      denied('SESSION_INVALID'),
    );
    await f.runtime.query(
      "UPDATE auth_sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'",
    );
    await assert.rejects(f.resolve(f.credentials, f.operation), denied('SESSION_INVALID'));
    await f.runtime.query('DELETE FROM auth_sessions');
    await assert.rejects(f.resolve(f.credentials, f.operation), denied('SESSION_INVALID'));
  } finally {
    await f.close();
  }
});

test(
  'central attendance rejects inactive users even with unexpired sessions',
  options,
  async () => {
    const f = await fixture();
    try {
      await f.runtime.query('UPDATE auth_users SET active=false WHERE id=$1', [f.user]);
      await assert.rejects(f.resolve(f.credentials, f.operation), denied('SESSION_INVALID'));
    } finally {
      await f.close();
    }
  },
);

test('central attendance rejects invalid, disabled and revoked nodes', options, async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.resolve(
        { ...f.credentials, nodeToken: randomBytes(32).toString('base64url') },
        f.operation,
      ),
      denied('NODE_INVALID'),
    );
    await f.runtime.query('UPDATE sync_nodes SET enabled=false WHERE id=$1', [f.node]);
    await assert.rejects(f.resolve(f.credentials, f.operation), denied('NODE_INVALID'));
    await f.runtime.query('UPDATE sync_nodes SET revoked_at=now() WHERE id=$1', [f.node]);
    await assert.rejects(f.resolve(f.credentials, f.operation), denied('NODE_INVALID'));
  } finally {
    await f.close();
  }
});

test(
  'central attendance rejects requested and authenticated organization mismatches',
  options,
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        f.resolve(f.credentials, { ...f.operation, organizationId: f.foreignOrg }),
        denied('ORGANIZATION_MISMATCH'),
      );
      await f.runtime.query('UPDATE sync_nodes SET organization_id=$2 WHERE id=$1', [
        f.node,
        f.foreignOrg,
      ]);
      await assert.rejects(f.resolve(f.credentials, f.operation), denied('ORGANIZATION_MISMATCH'));
      await assert.rejects(
        f.resolve(f.credentials, { ...f.operation, organizationId: f.foreignOrg }),
        denied('ORGANIZATION_MISMATCH'),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'central attendance rejects forged author/submitter and client permission claims',
  options,
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        f.resolve(f.credentials, { ...f.operation, authorUserId: randomUUID() }),
        denied('AUTHOR_MISMATCH'),
      );
      const forged = { ...f.operation, submitterUserId: randomUUID() };
      await assert.rejects(f.resolve(f.credentials, forged), denied('INVALID_REQUEST'));
      const claims = { ...f.credentials, roles: ['administrator'], nodeId: f.node, userId: f.user };
      await assert.rejects(f.resolve(claims, f.operation), denied('AUTH_INVALID'));
      await assert.rejects(
        f.resolve({ ...f.credentials, sessionToken: '' }, f.operation),
        denied('AUTH_INVALID'),
      );
      await assert.rejects(
        f.resolve({ ...f.credentials, sessionToken: f.credentials.nodeToken }, f.operation),
        denied('SESSION_INVALID'),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'central attendance reloads revoked permissions and role assignments between attempts',
  options,
  async () => {
    const f = await fixture();
    try {
      await f.resolve(f.credentials, f.operation);
      await f.runtime.query(
        "DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='attendance.manage'",
        [f.role],
      );
      await assert.rejects(f.resolve(f.credentials, f.operation), denied('FORBIDDEN'));
      await f.runtime.query("INSERT INTO role_permissions VALUES($1,'attendance.manage')", [
        f.role,
      ]);
      await f.resolve(f.credentials, f.operation);
      await f.runtime.query('DELETE FROM user_roles WHERE user_id=$1', [f.user]);
      await assert.rejects(f.resolve(f.credentials, f.operation), denied('FORBIDDEN'));
    } finally {
      await f.close();
    }
  },
);

// Observe a real PostgreSQL lock wait, rather than assuming a timeout proves concurrency.
async function concurrentRevocation(kind: 'session' | 'node' | 'permission', commit: boolean) {
  const f = await fixture();
  const revoker = await f.runtime.connect(),
    reader = await f.runtime.connect();
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await reader.query("SET statement_timeout='10s'");
    const pid = (await reader.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    await revoker.query('BEGIN');
    if (kind === 'session')
      await revoker.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
        tokenHash(f.credentials.sessionToken),
      ]);
    else if (kind === 'node')
      await revoker.query('UPDATE sync_nodes SET enabled=false,revoked_at=now() WHERE id=$1', [
        f.node,
      ]);
    else
      await revoker.query(
        "DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='attendance.manage'",
        [f.role],
      );
    const pinned = new Proxy(f.runtime, {
      get(target, property) {
        if (property === 'connect')
          return async () =>
            new Proxy(reader, {
              get(client, key) {
                if (key === 'release') return () => {};
                const value = Reflect.get(client, key);
                return typeof value === 'function' ? value.bind(client) : value;
              },
            });
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Pool;
    pending = Promise.allSettled([
      createCentralAttendanceAuthorizationResolver(pinned, 'central')(f.credentials, f.operation),
    ]);
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      blocked = (
        await f.runtime.query<{ blocked: boolean }>(
          'SELECT cardinality(pg_blocking_pids($1))>0 blocked',
          [pid],
        )
      ).rows[0]!.blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(blocked, 'Resolver must wait for the concurrent revocation transaction');
    await revoker.query(commit ? 'COMMIT' : 'ROLLBACK');
    const [result] = await pending;
    if (commit) {
      assert.equal(result!.status, 'rejected');
      if (result!.status === 'rejected')
        assert.ok(
          denied(
            kind === 'session' ? 'SESSION_INVALID' : kind === 'node' ? 'NODE_INVALID' : 'FORBIDDEN',
          )(result!.reason),
        );
    } else assert.equal(result!.status, 'fulfilled');
  } finally {
    await revoker.query('ROLLBACK');
    if (pending) await pending;
    await reader.query('RESET statement_timeout');
    revoker.release();
    reader.release();
    await f.close();
  }
}

test(
  'central attendance waits for concurrent session revocation and fails closed',
  options,
  async () => {
    await concurrentRevocation('session', true);
  },
);
test(
  'central attendance waits for concurrent node revocation and fails closed',
  options,
  async () => {
    await concurrentRevocation('node', true);
  },
);
test(
  'central attendance waits for permission revocation and recovers after rollback',
  options,
  async () => {
    await concurrentRevocation('permission', true);
    await concurrentRevocation('session', false);
    await concurrentRevocation('node', false);
  },
);
