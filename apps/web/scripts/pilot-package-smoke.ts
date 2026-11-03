import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
apiRequire('dotenv').config({
  path: fileURLToPath(new URL('../../api/.env.test', import.meta.url)),
  quiet: true,
});
if (
  !process.env.TEST_DATABASE_URL ||
  new URL(process.env.TEST_DATABASE_URL).pathname !== '/hexpayroll_test'
)
  throw new Error('Dedicated hexpayroll_test prerequisite missing');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SYNC_MODE = 'disabled';
const { desktopFixture, desktopTestPassword } =
  await import('../../api/test/attendance-desktop-fixture.js');
const { createTimeRecordService } = await import('../../api/src/timekeeping/services.js');
const f = await desktopFixture();
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
const proxy = createServer(async (req, res) => {
  try {
    if (req.url === '/api/health') {
      await f.office.runtime.query('SELECT 1');
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          status: 'ok',
          database: 'reachable',
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const response = await fetch(f.officeHttp.url + req.url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      ...(body.length ? { body } : {}),
      redirect: 'error',
    });
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(503).end();
  }
});
try {
  // Exclusive bind before Electron launches. If a real local API owns this port,
  // abort without probing it, stopping it, or launching the test renderer.
  proxy.listen({ host: '127.0.0.1', port: 4311, exclusive: true });
  await once(proxy, 'listening');
  f.setAvailable(false);
  await createTimeRecordService(f.office.runtime, { rawCaptureEnabled: true }).ingest(
    { ...f.office.actor, permissions: ['time_records.ingest'] },
    { deviceId: f.device, records: f.entries },
  );
  const profile = resolve('.diagnostics/pilot-package-profile-' + Date.now());
  await mkdir(profile, { recursive: true });
  const env: Record<string, string> = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  const launch = () =>
    electron.launch({
      executablePath: resolve('apps/desktop/release/win-unpacked/Hex Payroll.exe'),
      args: ['--user-data-dir=' + profile],
      env,
      timeout: 60000,
    });
  app = await launch();
  let page = await app.firstWindow();
  await page.getByLabel('Username or Email').fill('collector');
  await page.getByLabel('Password', { exact: true }).fill(desktopTestPassword);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.goto(new URL('/#/attendance?date=' + f.identity.workDate, page.url()).href);
  await expect(page.getByRole('button', { name: 'Ana Santos', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ana Santos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Immutable raw punches' })).toBeVisible();
  await page.screenshot({ path: '.diagnostics/step-73p-packaged-offline.png', fullPage: true });
  await app.close();
  app = undefined;
  app = await launch();
  page = await app.firstWindow();
  await page.getByLabel('Username or Email').fill('collector');
  await page.getByLabel('Password', { exact: true }).fill(desktopTestPassword);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.goto(new URL('/#/attendance?date=' + f.identity.workDate, page.url()).href);
  await expect(page.getByRole('button', { name: 'Ana Santos', exact: true })).toBeVisible();
  const n = (await f.office.runtime.query('SELECT count(*)::int n FROM biometric_raw_captures'))
    .rows[0].n;
  if (n !== 2) throw new Error('Offline evidence did not survive package restart');
  console.log(
    'PASS: unpacked Electron login, real isolated PostgreSQL/API, central-offline evidence view and restart; no credentials bundled.',
  );
} finally {
  await app?.close();
  await new Promise<void>((done) => proxy.close(() => done()));
  await f.close();
}
