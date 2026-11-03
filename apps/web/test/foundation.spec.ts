import { test, expect, type Page } from '@playwright/test';
import { permissionCodes, employeeInputSchema } from '@hexpayroll/shared';
const organizationId = '019a0000-0000-7000-8000-000000000001';
const userId = '019a0000-0000-7000-8000-000000000002';
const employeeId = '019a0000-0000-7000-8000-000000000003';
const roleId = '019a0000-0000-7000-8000-000000000004';
const timestamp = '2026-10-02T00:00:00.000Z';
async function mockApi(page: Page, viewer = false, setup = false) {
  const permissions = viewer
    ? ['dashboard.view', 'employees.view', 'departments.view', 'positions.view']
    : permissionCodes;
  const user = {
    id: userId,
    username: viewer ? 'viewer' : 'admin',
    displayName: viewer ? 'Viewer' : 'Administrator',
    organizationId: setup ? null : organizationId,
    roles: [viewer ? 'viewer' : 'administrator'],
    permissions,
  };
  const employees: Record<string, unknown>[] = [];
  const users: Record<string, unknown>[] = [
    {
      id: userId,
      organizationId,
      username: 'admin',
      displayName: 'Administrator',
      email: null,
      active: true,
      lastLoginAt: timestamp,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      roleIds: [roleId],
      roles: ['Administrator'],
    },
  ];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    let body: unknown;
    let status = 200;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (path === '/api/health') body = { status: 'ok', database: 'reachable', timestamp };
    else if (path === '/api/auth/login')
      body = {
        user,
        accessToken: 'a'.repeat(43),
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      };
    else if (path === '/api/auth/session')
      body = { user, expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() };
    else if (path === '/api/organization/setup') {
      if (method === 'POST') {
        user.organizationId = organizationId;
        status = 201;
        body = { id: organizationId };
      } else body = { required: setup, administratorReady: true };
    } else if (path === '/api/dashboard/summary')
      body = {
        id: organizationId,
        totalEmployees: employees.length,
        activeEmployees: employees.length,
        departments: 0,
        attendanceAvailable: false,
      };
    else if (path === '/api/sync/summary')
      body = {
        configured: false,
        nodeProvisioned: false,
        pending: employees.length,
        processing: 0,
        synced: 0,
        failed: 0,
      };
    else if (path === '/api/employees' && method === 'POST') {
      const input = employeeInputSchema.parse(request.postDataJSON());
      const employee = {
        ...input,
        id: employeeId,
        organizationId,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        updatedBy: userId,
      };
      employees.push(employee);
      status = 201;
      body = employee;
    } else if (path === '/api/employees')
      body = { items: employees, total: employees.length, page: 1, pageSize: 25 };
    else if (path === `/api/employees/${employeeId}`)
      body = { ...employees[0], employmentVersions: [], biometricMappings: [] };
    else if (['/api/departments', '/api/positions', '/api/biometric-devices'].includes(path))
      body = { items: [], total: 0, page: 1, pageSize: 100 };
    else if (path === '/api/roles')
      body = [
        {
          id: roleId,
          name: 'Administrator',
          code: 'administrator',
          permissions: permissionCodes,
          system: true,
          organizationId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ];
    else if (path === '/api/users' && method === 'POST') {
      const input = request.postDataJSON() as Record<string, unknown>;
      const created = {
        ...users[0],
        id: employeeId,
        username: input.username,
        displayName: input.displayName,
      };
      users.push(created);
      body = { id: employeeId, username: input.username, displayName: input.displayName };
      status = 201;
    } else if (path === '/api/users')
      body = { items: users, total: users.length, page: 1, pageSize: 25 };
    else if (path === '/api/payroll-config') body = { configured: false };
    else if (path === '/api/audit') body = { items: [], total: 0, page: 1, pageSize: 25 };
    else {
      status = 404;
      body = { error: { code: 'NOT_FOUND', message: 'Not configured in UI fixture' } };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return employees;
}
async function login(page: Page) {
  await page.goto('/#/login');
  await page.getByLabel(/Username or Email/i).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('a secure payroll test password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
}
test('employee creation and profile work when browser reports no Internet', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await mockApi(page);
  await login(page);
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByText('Workforce', { exact: true })).toHaveCount(1);
  await expect(navigation.getByText('System', { exact: true })).toHaveCount(1);
  await page.getByRole('link', { name: 'Employees', exact: true }).click();
  await page.getByRole('button', { name: 'Create Employee', exact: true }).click();
  await page.getByLabel('Employee Number', { exact: false }).fill('EMP-001');
  await page.getByLabel('First Name', { exact: false }).fill('Ana');
  await page.getByLabel('Last Name', { exact: false }).fill('Reyes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Ana Reyes', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Employee Profile', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Government Information', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test('viewer navigation hides administration and direct routes are guarded', async ({ page }) => {
  await mockApi(page, true);
  await login(page);
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByText('Workforce', { exact: true })).toHaveCount(1);
  await expect(navigation.getByText('System', { exact: true })).toHaveCount(0);
  await expect(
    navigation.getByRole('link', { name: 'Attendance Management', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sync Status', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.location.hash = '/settings/users';
  });
  await expect(page.getByRole('alert')).toContainText('permission');
  await page.evaluate(() => {
    window.location.hash = '/employees';
  });
  await expect(page.getByRole('button', { name: 'Create Employee', exact: true })).toHaveCount(0);
});
test('first-run setup requires a real legal name and refreshes session context', async ({
  page,
}) => {
  await mockApi(page, false, true);
  await login(page);
  await expect(page.getByRole('heading', { name: 'Company Setup', exact: true })).toBeVisible();
  await page.getByLabel('Legal Name', { exact: false }).fill('Local Test Company');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Company Setup', exact: true })).toHaveCount(0);
  await expect(page.getByText('Your local payroll workstation at a glance.')).toBeVisible();
});
test('persisted user management reuses the account table and supports creation with roles', async ({
  page,
}) => {
  await mockApi(page);
  await login(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Users →', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'admin', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create User', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Administrator', exact: true }).check();
  await page.getByLabel('Username', { exact: false }).fill('new_clerk');
  await page.getByLabel('Full Name', { exact: false }).fill('New Clerk');
  await page.getByLabel('Password', { exact: false }).fill('a secure payroll test password');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'new_clerk', exact: true })).toBeVisible();
});
