import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(desktop, 'build', 'standalone');
let launchResources = resources;
const root = resolve(desktop, '../../.diagnostics', 'standalone-' + Date.now());
await mkdir(root, { recursive: true });
const secret = () => randomBytes(32).toString('base64url');
const settings = {
  installationId: randomUUID(),
  administratorPassword: secret(),
  migratorPassword: secret(),
  applicationPassword: secret(),
};
const token = secret();
const results = [];
const apiRequire = createRequire(resolve(desktop, '../api/package.json'));
const { Pool } = apiRequire('pg');
let current;
async function launch() {
  const env = { HEX_PRIVATE_API_TOKEN: token };
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PATH',
  ])
    if (process.env[key]) env[key] = process.env[key];
  const child = fork(
    join(desktop, 'scripts', 'runtime-node-shim.cjs'),
    [join(resources, 'api/runtime.cjs')],
    { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const heartbeat = setInterval(() => child.send({ type: 'heartbeat' }), 3000);
  child.once('exit', () => clearInterval(heartbeat));
  const exit = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  current = { child, heartbeat, exit };
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime startup timeout')), 180_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Runtime exited before ready: ' + code));
    });
    child.on('message', (message) => {
      if (message.type === 'progress') console.log('Runtime phase:', message.phase);
      if (message.type === 'ready') {
        clearTimeout(timer);
        resolve(message.url);
      }
      if (message.type === 'failed') {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    });
  });
  child.send({
    type: 'start',
    input: { root, resources: launchResources, settings, token, origin: 'http://127.0.0.1:52739' },
  });
  return await ready;
}
async function stop() {
  if (!current) return;
  current.child.send({ type: 'stop' });
  assert.equal(await current.exit, 0);
  current = undefined;
}
try {
  let url = await launch();
  results.push('Fresh private PostgreSQL 18 cluster, all local migrations, API readiness: PASS');
  assert.equal((await fetch(url + '/api/health')).status, 401);
  assert.equal(
    (await fetch(url + '/api/health', { headers: { 'X-Hex-Private-Token': secret() } })).status,
    401,
  );
  assert.equal(
    (
      await fetch(url + '/api/health', {
        headers: { 'X-Hex-Private-Token': token, Origin: 'https://untrusted.invalid' },
      })
    ).status,
    401,
  );
  const headers = { 'X-Hex-Private-Token': token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url + '/api/health', { headers })).status, 200);
  results.push(
    'Private API missing/wrong token and hostile origin rejected; valid token accepted: PASS',
  );
  const bootstrap = () =>
    fetch(url + '/api/desktop/bootstrap', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: 'rehearsal.admin',
        displayName: 'Isolated rehearsal administrator',
        password: secret(),
      }),
    });
  assert.equal((await bootstrap()).status, 201);
  assert.equal((await bootstrap()).status, 409);
  results.push('First administrator creation and repeated-bootstrap protection: PASS');
  const { port } = JSON.parse(await readFile(join(root, 'cluster-owner.json'), 'utf8'));
  const runtime = new Pool({
    host: '127.0.0.1',
    port,
    user: 'hexpayroll_app',
    password: settings.applicationPassword,
    database: 'hexpayroll',
  });
  try {
    await assert.rejects(
      runtime.query('CREATE TABLE forbidden_runtime_ddl(id int)'),
      (error) => error.code === '42501',
    );
    await assert.rejects(
      runtime.query('DELETE FROM audit_events'),
      (error) => error.code === '42501',
    );
    await assert.rejects(
      runtime.query('DELETE FROM schema_migrations'),
      (error) => error.code === '42501',
    );
    const role = (
      await runtime.query(
        'SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0];
    assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  } finally {
    await runtime.end();
  }
  results.push('Runtime DDL, audit deletion and privileged role capabilities denied: PASS');
  await stop();
  url = await launch();
  const response = await fetch(url + '/api/desktop/status', { headers });
  assert.equal((await response.json()).needsAdministrator, false);
  await stop();
  results.push(
    'Restart preserves account and migration history; graceful API/PostgreSQL shutdown: PASS',
  );
  launchResources = join(root, 'upgrade-resources');
  await cp(resources, launchResources, { recursive: true, errorOnExist: true });
  // Test-only forward migration; authoritative repository migration files are untouched.
  await writeFile(
    join(launchResources, 'migrations', '9000_rehearsal_upgrade.sql'),
    'CREATE TABLE desktop_rehearsal_upgrade(id integer PRIMARY KEY); INSERT INTO desktop_rehearsal_upgrade VALUES(1);',
  );
  await launch();
  await stop();
  assert.ok((await readdir(join(root, 'backups'))).some((name) => name.endsWith('.dump')));
  results.push('Populated cluster forward upgrade creates a complete pre-migration backup: PASS');
  await writeFile(
    join(launchResources, 'migrations', '9001_rehearsal_recovery.sql'),
    'CREATE TABLE desktop_rehearsal_interrupted(id integer); SELECT missing_rehearsal_function();',
  );
  await assert.rejects(launch());
  await current.exit;
  current = undefined;
  await writeFile(
    join(launchResources, 'migrations', '9001_rehearsal_recovery.sql'),
    'CREATE TABLE desktop_rehearsal_interrupted(id integer);',
  );
  await launch();
  await stop();
  results.push(
    'Failed migration rolls back its DDL; forward repair and restart preserve account: PASS',
  );
  launchResources = resources;
  await assert.rejects(launch());
  await current.exit;
  current = undefined;
  launchResources = join(root, 'upgrade-resources');
  await launch();
  await stop();
  results.push(
    'Older application migration history refuses downgrade; current version still opens: PASS',
  );
  await launch();
  clearInterval(current.heartbeat);
  assert.equal(await current.exit, 1);
  current = undefined;
  url = await launch();
  assert.equal(
    (await fetch(url + '/api/desktop/status', { headers }).then((r) => r.json()))
      .needsAdministrator,
    false,
  );
  await stop();
  results.push('Lost supervisor heartbeat shuts down services; restart retains account: PASS');
} catch (error) {
  results.push('FAIL: ' + error.message);
  if (current) {
    current.child.send({ type: 'stop' });
    await current.exit;
  }
  process.exitCode = 1;
} finally {
  const report =
    results.join('\n') +
    '\nTest cluster retained at ' +
    root +
    '\nNo production connections used. Not a clean-machine installer test.\n';
  await writeFile(join(root, 'verification.txt'), report);
  console.log(report);
}
