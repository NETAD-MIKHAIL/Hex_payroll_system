import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';

const require = createRequire(resolve('apps/web/package.json'));
const { _electron, expect } = require('@playwright/test');
const executablePath = resolve(
  process.argv[2] ?? 'apps/desktop/release/win-unpacked/Hex Payroll.exe',
);
const root = resolve('apps/desktop/build/ui-tests', randomUUID());
await mkdir(root, { recursive: true });
const env = { ...process.env, LOCALAPPDATA: root, PATH: process.env.SystemRoot + '\\System32' };
delete env.ELECTRON_RUN_AS_NODE;
const report = { root, executablePath, passed: [], failed: null };
let application;
const password = 'An isolated desktop test password 44!';
async function launch(args = []) {
  application = await _electron.launch({ executablePath, args, env, timeout: 180000 });
  const page = await application.firstWindow();
  await page.waitForURL('hexpayroll://app/index.html*', { timeout: 180000 });
  page.setDefaultTimeout(30000);
  return page;
}
async function login(page) {
  await page.getByLabel(/Username or Email/i).fill('desktop_admin');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
}
async function close() {
  await application.close();
  application = undefined;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (
      !(await stat(join(root, 'Hex Payroll/database/postmaster.pid')).then(
        () => true,
        () => false,
      ))
    )
      return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Private PostgreSQL did not stop');
}
try {
  let page = await launch();
  await expect(
    page.getByRole('heading', { name: 'Create your administrator account' }),
  ).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('desktop_admin');
  await page.getByLabel('Display name', { exact: true }).fill('Desktop Test Administrator');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click();
  await login(page);
  await page.getByLabel('Legal Name', { exact: false }).fill('Isolated Desktop Test Company');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Your local payroll workstation at a glance.')).toBeVisible();
  report.passed.push('packaged first-run account, login and company setup');
  const states = [
    'dashboard',
    'employees',
    'attendance',
    'leave',
    'schedules',
    'payroll/periods',
    'sync',
    'sync/conflicts',
    'settings',
  ];
  for (const route of states) {
    await page.evaluate((hash) => {
      globalThis.location.hash = '/' + hash;
    }, route);
    await expect(page.locator('main')).toBeVisible();
    assert.equal(
      await page.getByText('You do not have permission to access this page.').count(),
      0,
    );
  }
  await page.screenshot({ path: join(root, 'packaged-settings.png'), fullPage: true });
  await page.reload();
  await login(page);
  await expect(page.getByRole('heading', { name: 'Company Setup', exact: true })).toHaveCount(0);
  report.passed.push('packaged routes, static assets and refresh');
  const secondExit = await new Promise((resolveExit, reject) => {
    const child = spawn(executablePath, [], { env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Second instance did not exit'));
    }, 15000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  assert.equal(secondExit, 0);
  report.passed.push('second instance exits without competing services');
  const identity = JSON.parse(
    await readFile(join(root, 'Hex Payroll/configuration/cluster.json'), 'utf8'),
  ).identity;
  await close();
  report.passed.push('graceful packaged shutdown stops private PostgreSQL');
  page = await launch();
  await login(page);
  await expect(page.getByRole('heading', { name: 'Company Setup', exact: true })).toHaveCount(0);
  assert.equal(
    JSON.parse(await readFile(join(root, 'Hex Payroll/configuration/cluster.json'), 'utf8'))
      .identity,
    identity,
  );
  report.passed.push(
    'relaunch preserves account, company and cluster identity without a central server',
  );
  await close();
  page = await launch(['--admin']);
  await login(page);
  await expect(
    page.getByRole('heading', { name: 'Desktop administration', exact: true }),
  ).toBeVisible();
  report.passed.push('packaged administrator utility requires login and opens successfully');
  await close();
} catch (error) {
  report.failed = error instanceof Error ? error.message : 'Unknown failure';
  process.exitCode = 1;
  if (application) {
    const page = await application.firstWindow().catch(() => null);
    await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
  }
} finally {
  if (application) await close().catch(() => {});
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
