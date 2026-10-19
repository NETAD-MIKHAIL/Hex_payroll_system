import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// Explicitly isolated: never reads .env, never touches the development PostgreSQL service.
if (process.platform !== 'win32') throw new Error('Windows is required');
const stage = resolve('apps/desktop/build/runtime');
const root = resolve('apps/desktop/build/test-runs', randomUUID());
for (const name of ['configuration', 'logs', 'backups'])
  await mkdir(join(root, name), { recursive: true });
const require = createRequire(join(stage, 'api/package.json'));
const pg = require('pg');
const { PrivateDatabase, command, connectionUrl } = await import(
  pathToFileURL(join(stage, 'api/dist/desktop/database.js'))
);
const configuration = {
  root,
  postgres: join(stage, 'postgres'),
  migrations: join(stage, 'migrations'),
  secrets: {
    bootstrap: randomBytes(32).toString('hex'),
    migrator: randomBytes(32).toString('hex'),
    application: randomBytes(32).toString('hex'),
  },
};
let database = new PrivateDatabase(configuration);
let runtimePool;
let admin;
const report = { root, passed: [], failed: null };
try {
  const url = await database.start();
  report.passed.push('fresh private initialization and all migrations');
  runtimePool = new pg.Pool({ connectionString: url });
  const count = (await runtimePool.query('SELECT count(*)::int AS count FROM schema_migrations'))
    .rows[0].count;
  assert.equal(
    count,
    (await readdir(configuration.migrations)).filter((name) => name.endsWith('.sql')).length,
  );
  await assert.rejects(runtimePool.query('CREATE TABLE forbidden_desktop_test(id integer)'));
  report.passed.push('runtime DDL denied');
  process.env.DATABASE_URL = url;
  process.env.SYNC_MODE = 'disabled';
  process.env.NODE_ENV = 'test';
  process.env.DOTENV_CONFIG_PATH = '__no_desktop_test_dotenv__';
  const { createApp } = await import(pathToFileURL(join(stage, 'api/dist/app.js')));
  const { pool: healthPool } = await import(pathToFileURL(join(stage, 'api/dist/db/pool.js')));
  const { desktopGuard } = await import(pathToFileURL(join(stage, 'api/dist/desktop/security.js')));
  const { desktopBootstrapRouter } = await import(
    pathToFileURL(join(stage, 'api/dist/desktop/bootstrap.js'))
  );
  const token = randomBytes(32).toString('base64url');
  const app = createApp({
    database: runtimePool,
    desktop: { guard: desktopGuard(token), bootstrap: desktopBootstrapRouter(runtimePool) },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolveReady) => server.once('listening', resolveReady));
  try {
    const api = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'x-hex-desktop': token, 'content-type': 'application/json' };
    assert.equal((await globalThis.fetch(api + '/api/health')).status, 403);
    assert.equal((await globalThis.fetch(api + '/api/health', { headers })).status, 200);
    const body = JSON.stringify({
      username: 'desktop_test_admin',
      displayName: 'Desktop Test Administrator',
      password: randomBytes(24).toString('hex'),
    });
    const responses = await Promise.all(
      [1, 2].map(() =>
        globalThis.fetch(api + '/api/desktop/setup', { method: 'POST', headers, body }),
      ),
    );
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    assert.equal(
      (await runtimePool.query('SELECT count(*)::int AS count FROM auth_users')).rows[0].count,
      1,
    );
    assert.equal(
      (await globalThis.fetch(api + '/api/desktop/setup', { method: 'POST', headers, body }))
        .status,
      409,
    );
    const input = JSON.parse(body);
    const login = await globalThis.fetch(api + '/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ identifier: input.username, password: input.password }),
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    assert(session.user.roles.includes('administrator'));
    assert.equal((await globalThis.fetch(api + '/api/employees', { headers })).status, 401);
    report.passed.push(
      'API guard, bootstrap concurrency/replay, administrator login and protected routes',
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClosed) => server.close(resolveClosed));
  }
  await runtimePool.end();
  await healthPool.end();
  runtimePool = undefined;
  if (process.argv.includes('--integration')) {
    const cluster = JSON.parse(await readFile(join(root, 'configuration/cluster.json'), 'utf8'));
    const env = {
      ...process.env,
      TEST_ADMIN_DATABASE_URL: connectionUrl(
        cluster.port,
        'hexpayroll_bootstrap',
        configuration.secrets.bootstrap,
        'postgres',
      ),
      TEST_MIGRATION_DATABASE_URL: connectionUrl(
        cluster.port,
        'hexpayroll_migrator',
        configuration.secrets.migrator,
      ),
      TEST_DATABASE_URL: url,
      DOTENV_CONFIG_PATH: '__isolated_desktop_integration__',
    };
    await new Promise((resolveTests, reject) => {
      const child = spawn(process.execPath, ['dist/cli/test-integration.js', '--all'], {
        cwd: resolve('apps/api'),
        env,
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolveTests() : reject(new Error('Isolated API integration suite failed')),
      );
    });
    report.passed.push(
      'existing API integration suite against disposable databases on the staged PostgreSQL runtime',
    );
  }
  await database.stop();
  const identity = JSON.parse(
    await readFile(join(root, 'configuration/cluster.json'), 'utf8'),
  ).identity;
  const oldPort = JSON.parse(await readFile(join(root, 'configuration/cluster.json'), 'utf8')).port;
  const unrelated = createServer();
  await new Promise((resolveListening) => unrelated.listen(oldPort, '127.0.0.1', resolveListening));
  database = new PrivateDatabase(configuration);
  try {
    await database.start();
    assert(unrelated.listening);
    assert.notEqual(
      JSON.parse(await readFile(join(root, 'configuration/cluster.json'), 'utf8')).port,
      oldPort,
    );
    report.passed.push('unrelated listener on previous database port is preserved');
  } finally {
    await new Promise((resolveClosed) => unrelated.close(resolveClosed));
  }
  assert.equal(
    JSON.parse(await readFile(join(root, 'configuration/cluster.json'), 'utf8')).identity,
    identity,
  );
  report.passed.push('cluster identity and administrator persist across restart');
  const stalePid = await readFile(join(root, 'database/postmaster.pid'));
  await database.stop();
  await writeFile(join(root, 'database/postmaster.pid'), stalePid);
  database = new PrivateDatabase(configuration);
  await database.start();
  await database.stop();
  report.passed.push('supported pg_ctl recovery of a stale lock after process exit');
  const postgresConfigPath = join(root, 'database/postgresql.conf');
  const originalPostgresConfig = await readFile(postgresConfigPath, 'utf8');
  try {
    await writeFile(
      postgresConfigPath,
      originalPostgresConfig + "\ninvalid_desktop_test_setting='x'\n",
    );
    await assert.rejects(new PrivateDatabase(configuration).start(), /DATABASE_START_FAILED/);
  } finally {
    await writeFile(postgresConfigPath, originalPostgresConfig);
  }
  report.passed.push('database startup failure preserves cluster without reset');
  const interruptedRoot = join(root, 'interrupted-install');
  await mkdir(join(interruptedRoot, 'configuration'), { recursive: true });
  await mkdir(join(interruptedRoot, 'database-initializing'));
  await assert.rejects(
    new PrivateDatabase({ ...configuration, root: interruptedRoot }).start(),
    /INITIALIZATION_INTERRUPTED/,
  );
  report.passed.push('interrupted initialization is preserved for review');
  const testMigrations = join(root, 'test-migrations');
  await cp(configuration.migrations, testMigrations, { recursive: true });
  await writeFile(
    join(testMigrations, '0037_desktop_smoke.sql'),
    'CREATE TABLE desktop_upgrade_probe(id integer PRIMARY KEY);',
  );
  database = new PrivateDatabase({ ...configuration, migrations: testMigrations });
  await database.start();
  const backups = (await readdir(join(root, 'backups'))).filter((name) => name.endsWith('.dump'));
  assert.equal(backups.length, 1);
  const cluster = JSON.parse(await readFile(join(root, 'configuration/cluster.json'), 'utf8'));
  admin = new pg.Pool({
    connectionString: connectionUrl(
      cluster.port,
      'hexpayroll_bootstrap',
      configuration.secrets.bootstrap,
      'postgres',
    ),
  });
  await admin.query('CREATE DATABASE desktop_restore_probe OWNER hexpayroll_migrator');
  await command(
    join(configuration.postgres, 'bin/pg_restore.exe'),
    [
      '-h',
      '127.0.0.1',
      '-p',
      String(cluster.port),
      '-U',
      'hexpayroll_bootstrap',
      '-d',
      'desktop_restore_probe',
      '--exit-on-error',
      join(root, 'backups', backups[0]),
    ],
    { PGPASSWORD: configuration.secrets.bootstrap },
    120000,
  );
  const restored = new pg.Pool({
    connectionString: connectionUrl(
      cluster.port,
      'hexpayroll_bootstrap',
      configuration.secrets.bootstrap,
      'desktop_restore_probe',
    ),
  });
  try {
    assert.equal(
      (await restored.query('SELECT count(*)::int AS count FROM auth_users')).rows[0].count,
      1,
    );
    assert.equal(
      (await restored.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count,
      count,
    );
    assert.equal(
      (await restored.query("SELECT to_regclass('desktop_upgrade_probe') AS name")).rows[0].name,
      null,
    );
  } finally {
    await restored.end();
  }
  await admin.end();
  admin = undefined;
  report.passed.push(
    'pending upgrade creates backup; backup restores pre-upgrade records and schema',
  );
  await database.stop();
  await writeFile(
    join(testMigrations, '0038_desktop_failure.sql'),
    "DO $$ BEGIN RAISE EXCEPTION 'isolated test failure'; END $$;",
  );
  database = new PrivateDatabase({ ...configuration, migrations: testMigrations });
  await assert.rejects(database.start());
  await database.stop();
  report.passed.push('failed migration blocks startup and preserves cluster');
  await writeFile(join(root, 'database/PG_VERSION'), '17');
  await assert.rejects(new PrivateDatabase(configuration).start(), /CLUSTER_VERSION_INCOMPATIBLE/);
  await writeFile(join(root, 'database/PG_VERSION'), '18');
  await assert.rejects(
    new PrivateDatabase({ ...configuration, postgres: join(root, 'missing-runtime') }).start(),
  );
  report.passed.push('incompatible cluster and missing binaries rejected');
} catch (error) {
  report.failed = error instanceof Error ? error.message : 'Unknown failure';
  process.exitCode = 1;
} finally {
  await runtimePool?.end();
  await admin?.end();
  await database.stop().catch(() => {});
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
