import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { migrate, migrationChecksum } from '../src/db/migrate.js';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { createAuthService, tokenHash } from '../src/auth/service.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { loginResponseSchema, SESSION_LIFETIME_MS } from '@hexpayroll/shared';
import { corsMiddleware } from '../src/middleware/cors.js';
test(
  'PostgreSQL migrations and local authentication end to end',
  { skip: !databaseTestsEnabled },
  async () => {
    const fixture = await databaseFixture();
    const { migrator, runtime, migrations } = fixture;
    const nextNumber = String(Number(migrations.at(-1)!.name.split('_')[0]) + 1).padStart(4, '0');
    try {
      assert.equal((await migrate(migrator, migrations)).length, migrations.length);
      assert.deepEqual(await migrate(migrator, migrations), []);
      const changed = migrations.map((item) => ({
        ...item,
        checksum: migrationChecksum(item.sql + '-- changed'),
      }));
      await assert.rejects(() => migrate(migrator, changed), /changed/);
      await assert.rejects(
        () => runtime.query('CREATE TABLE forbidden_test (id integer)'),
        (error) =>
          Boolean(error && typeof error === 'object' && 'code' in error && error.code === '42501'),
      );
      const org = (
        await runtime.query<{ id: string }>(
          "INSERT INTO organizations(legal_name) VALUES('Authentication test') RETURNING id",
        )
      ).rows[0]!.id;
      await runtime.query('UPDATE application_setup SET organization_id=$1 WHERE singleton', [org]);
      const service = createAuthService(runtime);
      const password = '  payroll test password 😃  ';
      const user = await service.createUser({
        username: 'Clerk',
        email: 'Clerk@example.com',
        displayName: 'Payroll Clerk',
        password,
      });
      await assert.rejects(
        () => service.createUser({ username: 'clerk', displayName: 'Other', password }),
        (error) =>
          Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505'),
      );
      await assert.rejects(
        () =>
          service.createUser({
            username: 'other',
            email: 'clerk@EXAMPLE.com',
            displayName: 'Other',
            password,
          }),
        (error) =>
          Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505'),
      );
      const app = express();
      app.use(corsMiddleware);
      app.use('/api/auth', createAuthRouter(service));
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert(address && typeof address === 'object');
      const base = `http://127.0.0.1:${address.port}/api/auth`;
      const login = async (identifier: string, supplied = password) => {
        const response = await fetch(base + '/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5273' },
          body: JSON.stringify({ identifier, password: supplied }),
        });
        return { response, payload: (await response.json()) as unknown };
      };
      try {
        const first = await login('clerk');
        assert.equal(first.response.status, 200);
        const session = loginResponseSchema.parse(first.payload);
        assert.equal(session.user.id, user.id);
        assert(Math.abs(Date.parse(session.expiresAt) - Date.now() - SESSION_LIFETIME_MS) < 5000);
        assert.equal(
          first.response.headers.get('access-control-allow-origin'),
          'http://127.0.0.1:5273',
        );
        const byEmail = await login('CLERK@EXAMPLE.COM');
        assert.equal(byEmail.response.status, 200);
        const stored = await runtime.query(
          'SELECT token_hash FROM auth_sessions WHERE token_hash=$1',
          [tokenHash(session.accessToken)],
        );
        assert.equal(stored.rows.length, 1);
        assert.notEqual(stored.rows[0].token_hash, session.accessToken);
        const headers = { authorization: `Bearer ${session.accessToken}` };
        assert.equal((await fetch(base + '/session', { headers })).status, 200);
        for (const identifier of ['clerk', 'unknown']) {
          const failure = await login(identifier, 'wrong');
          assert.equal(failure.response.status, 401);
          assert.deepEqual(failure.payload, { error: { code: 'INVALID_CREDENTIALS' } });
        }
        await runtime.query('UPDATE auth_users SET active=false WHERE id=$1', [user.id]);
        assert.equal((await fetch(base + '/session', { headers })).status, 401);
        assert.equal((await login('clerk')).response.status, 401);
        await runtime.query('UPDATE auth_users SET active=true WHERE id=$1', [user.id]);
        await runtime.query(
          "UPDATE auth_sessions SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE token_hash=$1",
          [tokenHash(session.accessToken)],
        );
        assert.equal((await fetch(base + '/session', { headers })).status, 401);
        const fresh = loginResponseSchema.parse((await login('clerk')).payload);
        const freshHeaders = { authorization: `Bearer ${fresh.accessToken}` };
        assert.equal(
          (await fetch(base + '/logout', { method: 'POST', headers: freshHeaders })).status,
          204,
        );
        assert.equal(
          (await fetch(base + '/logout', { method: 'POST', headers: freshHeaders })).status,
          204,
        );
        assert.equal((await fetch(base + '/session', { headers: freshHeaders })).status, 401);
        const preflight = await fetch(base + '/login', {
          method: 'OPTIONS',
          headers: { origin: 'null', 'access-control-request-method': 'POST' },
        });
        assert.equal(preflight.headers.get('access-control-allow-origin'), null);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      const rollbackSql = 'CREATE TABLE rolled_back_test (id integer); SELECT missing_column;';
      await assert.rejects(() =>
        migrate(migrator, [
          ...migrations,
          {
            name: `${nextNumber}_rollback.sql`,
            sql: rollbackSql,
            checksum: migrationChecksum(rollbackSql),
          },
        ]),
      );
      assert.equal(
        (await migrator.query("SELECT to_regclass('rolled_back_test') AS name")).rows[0].name,
        null,
      );
      // Two runners share the advisory lock and only one applies a migration.
      const concurrentSql = 'CREATE TABLE concurrent_test (id integer);';
      const concurrent = [
        ...migrations,
        {
          name: `${nextNumber}_concurrent.sql`,
          sql: concurrentSql,
          checksum: migrationChecksum(concurrentSql),
        },
      ];
      const results = await Promise.all([
        migrate(migrator, concurrent),
        migrate(migrator, concurrent),
      ]);
      assert.equal(results.flat().length, 1);
    } finally {
      await fixture.close();
    }
  },
);
