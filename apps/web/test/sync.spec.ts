import { test, expect, type Page } from '@playwright/test';
import { permissionCodes } from '@hexpayroll/shared';
const id = '019a0000-0000-7000-8000-000000000001';
async function setup(page: Page, revoked = false) {
  let calls = 0;
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    const user = {
      id,
      username: 'admin',
      displayName: 'Admin',
      organizationId: id,
      roles: ['administrator'],
      permissions: permissionCodes,
    };
    let body: unknown = {};
    if (path === '/api/auth/login')
      body = {
        user,
        accessToken: 'a'.repeat(43),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    else if (path === '/api/auth/session')
      body = { user, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    else if (path === '/api/health')
      body = { status: 'ok', database: 'reachable', timestamp: new Date().toISOString() };
    else if (path === '/api/organization/setup')
      body = { required: false, administratorReady: true };
    else if (path === '/api/dashboard/summary')
      body = {
        id,
        totalEmployees: 0,
        activeEmployees: 0,
        departments: 0,
        attendanceAvailable: false,
      };
    else if (path === '/api/sync/state')
      body = {
        pending: 7,
        failed: 2,
        conflicts: 1,
        legacyDelivered: 3,
        lastPush: null,
        lastPull: null,
        worker: revoked ? 'blocked' : 'idle',
        authorization: revoked ? 'denied' : 'authorized',
        authorizationProblem: revoked ? 'NODE_REVOKED' : null,
        transportAvailability: 'unavailable',
        device: { device_name: 'Workstation A', registered: true, enabled: true, revoked_at: null },
      };
    else if (path === '/api/sync/history')
      body = {
        items: [
          {
            id,
            device_name: 'Workstation A',
            started_at: new Date().toISOString(),
            pushed: 3,
            pulled: 2,
            accepted: 2,
            conflicts: 1,
            failed: 0,
            duration_ms: '100',
            result: 'partial',
          },
        ],
      };
    else if (path === '/api/sync/now') {
      calls++;
      await gate;
      body = { result: 'partial', state: 'idle' };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/#/login');
  await page.getByLabel(/Username or Email/i).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('secure test password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.evaluate(() => {
    window.location.hash = '/sync';
  });
  return { finish, calls: () => calls };
}
test('sync displays actual queue/history, keeps offline status and prevents repeated clicks', async ({
  page,
}) => {
  const control = await setup(page);
  await expect(page.getByText('unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText(/3 legacy transport receipts/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'partial', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sync Now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Synchronizing…' })).toBeDisabled();
  expect(control.calls()).toBe(1);
  control.finish();
  await expect(page.getByRole('status')).toContainText('items requiring review');
});
test('revocation has an actionable status and blocks manual synchronization', async ({ page }) => {
  await setup(page, true);
  await expect(page.getByText('Revoked — contact an organization administrator')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync Now', exact: true })).toBeDisabled();
});
