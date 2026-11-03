import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireWeb = createRequire(resolve(desktop, '../web/package.json'));
const requirePlaywright = createRequire(requireWeb.resolve('@playwright/test'));
const { _electron: electron } = requirePlaywright('playwright');
const profile = resolve(desktop, '../../.diagnostics', 'packaged-' + Date.now());
await mkdir(profile, { recursive: true });
const executablePath = join(desktop, 'release/win-unpacked/Hex Payroll.exe');
const env = {};
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
let instance;
const results = [];
async function launch() {
  instance = await electron.launch({
    executablePath,
    args: ['--user-data-dir=' + profile],
    env,
    timeout: 240_000,
  });
  const page = await instance.firstWindow({ timeout: 240_000 });
  page.setDefaultTimeout(30_000);
  return page;
}
async function close() {
  await instance?.close();
  instance = undefined;
  const status = spawnSync(
    join(desktop, 'release/win-unpacked/resources/postgres/bin/pg_ctl.exe'),
    ['-D', join(profile, 'private-runtime/pgdata'), 'status'],
    { stdio: 'ignore', windowsHide: true },
  );
  assert.equal(status.status, 3, 'Private PostgreSQL must be stopped after closing Electron');
}
try {
  let page = await launch();
  await page.getByRole('heading', { name: 'Set up Hex Payroll' }).waitFor();
  const password = randomBytes(24).toString('base64url');
  await page.getByLabel('Username', { exact: true }).fill('packaged.admin');
  await page.getByLabel('Display name').fill('Packaged rehearsal administrator');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await page.getByLabel('Username or Email').waitFor();
  results.push('Packaged Electron, DPAPI storage, private cluster and first-run form: PASS');
  await page.getByLabel('Username or Email').fill('packaged.admin');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForURL(/#\/(dashboard|setup)/);
  results.push('Packaged UI sign-in through authenticated same-origin API proxy: PASS');
  const origin = new URL(page.url()).origin;
  assert.equal(
    (await fetch(origin + '/api/health')).status,
    401,
    'Other local clients must not use renderer proxy',
  );
  const vault = await readFile(join(profile, 'private-runtime/credentials.dpapi'));
  assert.ok(!vault.includes(Buffer.from(password)));
  await page.screenshot({ path: join(profile, 'signed-in.png') });
  await close();
  page = await launch();
  await page.getByLabel('Username or Email').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create administrator' }).count(), 0);
  results.push(
    'Other local clients rejected; restart decrypts retained credentials; closing stops PostgreSQL: PASS',
  );
  // Kill only this isolated app's named utility process, never a system database.
  const utilityPid = await instance.evaluate(({ app, dialog }) => {
    const service = app
      .getAppMetrics()
      .find((metric) => metric.name === 'Hex Payroll local services');
    if (!service) throw new Error('Isolated local utility process not found');
    dialog.showErrorBox = () => undefined;
    return service.pid;
  });
  const terminated = new Promise((resolve) => instance.process().once('exit', resolve));
  process.kill(utilityPid);
  let deadline;
  try {
    await Promise.race([
      terminated,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Supervisor recovery timeout')), 90_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  instance = undefined;
  const stopped = spawnSync(
    join(desktop, 'release/win-unpacked/resources/postgres/bin/pg_ctl.exe'),
    ['-D', join(profile, 'private-runtime/pgdata'), 'status'],
    { stdio: 'ignore', windowsHide: true },
  );
  assert.equal(
    stopped.status,
    3,
    'Supervisor must stop its private PostgreSQL after utility failure',
  );
  page = await launch();
  await page.getByLabel('Username or Email').waitFor();
  await close();
  results.push(
    'Forced local utility failure triggers owned-cluster cleanup; reopening retains administrator: PASS',
  );
} catch (error) {
  results.push('FAIL: ' + error.message);
  if (instance) await instance.close().catch(() => undefined);
  process.exitCode = 1;
} finally {
  const report =
    results.join('\n') +
    '\nIsolated profile: ' +
    profile +
    '\nUnpacked app on development workstation; NOT clean-machine installation/uninstall verification.\n';
  await writeFile(join(profile, 'verification.txt'), report);
  console.log(report);
}
