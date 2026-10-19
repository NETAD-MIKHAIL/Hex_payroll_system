import { test, expect, type Page } from '@playwright/test';
import { permissionCodes } from '@hexpayroll/shared';
const id = '019a0000-0000-7000-8000-000000000001';
async function setup(page: Page, payroll = false, viewer = false) {
  let pending = false;
  const conflict = {
    id,
    entityType: payroll ? 'payroll_runs' : 'departments',
    entityId: id,
    conflictType: payroll ? 'PAYROLL_CONFLICT' : 'STALE_REVISION',
    status: 'open',
    originNodeId: id,
    deviceName: 'Offline workstation',
    localRevision: 2,
    remoteRevision: 3,
    baseRevision: 1,
    version: 1,
    detectedAt: '2026-10-16T00:00:00.000Z',
    authority: 'remote',
    reason: 'Authoritative revision changed',
    resolutionState: 'none',
  };
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    const user = {
      id,
      username: 'admin',
      displayName: 'Administrator',
      organizationId: id,
      roles: ['administrator'],
      permissions: viewer ? ['dashboard.view'] : permissionCodes,
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
    else if (path === '/api/sync/conflicts')
      body = {
        items: [
          {
            ...conflict,
            status: pending ? 'under_review' : 'open',
            resolutionState: pending ? 'pending' : 'none',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      };
    else if (path.endsWith('/resolve')) {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      pending = true;
      body = { id, state: 'pending' };
    } else if (path === `/api/sync/conflicts/${id}`)
      body = {
        ...conflict,
        status: pending ? 'under_review' : 'open',
        resolutionState: pending ? 'pending' : 'none',
        version: pending ? 2 : 1,
        localPayload: { name: 'Local department' },
        remoteSnapshot: { name: 'Central department' },
        allowedActions: pending
          ? []
          : payroll
            ? ['escalate']
            : ['accept_authoritative', 'reject_mutation', 'escalate'],
        blockingReason: payroll
          ? 'An approved payroll correction/reversal workflow is required.'
          : null,
        history: pending
          ? [
              {
                id,
                resolution: 'accept_authoritative',
                reason: 'Reviewed the authoritative record',
                createdAt: '2026-10-16T00:00:00.000Z',
                actorId: id,
                state: 'pending',
              },
            ]
          : [],
      };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/#/login');
  await page.getByLabel(/Username or Email/i).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('a secure test password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.evaluate(() => {
    window.location.hash = '/sync/conflicts';
  });
  return requests;
}
test('locally stored conflicts remain usable offline and remote confirmation stays pending', async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  const requests = await setup(page);
  await expect(page.getByRole('cell', { name: 'Offline workstation' })).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Local department', exact: false })).toBeVisible();
  await page.getByLabel('Resolution', { exact: true }).selectOption('accept_authoritative');
  await expect(page.getByRole('button', { name: 'Confirm resolution' })).toBeDisabled();
  await page.getByLabel('Resolution reason').fill('Reviewed the authoritative record');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Confirm resolution' }).click();
  await expect(page.getByRole('status')).toContainText('Pending synchronization');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.expectedVersion).toBe(1);
  await expect(page.getByRole('button', { name: 'Confirm resolution' })).toHaveCount(0);
});
test('payroll conflicts expose escalation and explain the blocked correction workflow', async ({
  page,
}) => {
  await setup(page, true);
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(
    page.getByText('An approved payroll correction/reversal workflow is required.'),
  ).toBeVisible();
  await expect(page.getByRole('option', { name: 'accept authoritative' })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'escalate' })).toHaveCount(1);
});
test('direct conflict route is guarded for users without conflict-view permission', async ({
  page,
}) => {
  await setup(page, false, true);
  await expect(page.getByRole('alert')).toContainText('permission');
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
});
