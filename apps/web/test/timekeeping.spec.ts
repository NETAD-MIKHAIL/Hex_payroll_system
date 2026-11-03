import { test, expect, type Page } from '@playwright/test';
import { permissionCodes } from '@hexpayroll/shared';
const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-02T00:00:00.000Z';
async function fixture(page: Page, viewer = false) {
  const user = {
    id: id(1),
    username: 'timekeeper',
    displayName: 'Timekeeper',
    organizationId: id(2),
    roles: [viewer ? 'viewer' : 'administrator'],
    permissions: viewer
      ? [
          'dashboard.view',
          'employees.view',
          'attendance.view',
          'schedules.view',
          'time_records.view',
          'leave.view',
          'departments.view',
          'positions.view',
        ]
      : [...permissionCodes],
  };
  const meta = {
    organizationId: id(2),
    revision: 1,
    createdAt: at,
    updatedAt: at,
    updatedBy: id(1),
  };
  const employee = {
    ...meta,
    id: id(3),
    employeeNumber: 'E1',
    firstName: 'Ana',
    lastName: 'Reyes',
    status: 'active',
    employmentVersions: [],
    biometricMappings: [],
  };
  const schedules: Record<string, unknown>[] = [],
    assignments: Record<string, unknown>[] = [],
    records: Record<string, unknown>[] = [],
    leaveTypes: Record<string, unknown>[] = [],
    leaves: Record<string, unknown>[] = [],
    attendance: Record<string, unknown>[] = [];
  const list = (items: Record<string, unknown>[]) => ({
    items,
    total: items.length,
    page: 1,
    pageSize: 25,
  });
  await page.route('**/api/**', async (route) => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api/', ''),
      method = req.method();
    let body: unknown;
    let status = 200;
    if (path === 'health') body = { status: 'ok', database: 'reachable', timestamp: at };
    else if (path === 'auth/login')
      body = {
        user,
        accessToken: 'a'.repeat(43),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    else if (path === 'auth/session')
      body = { user, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    else if (path === 'organization/setup') body = { required: false, administratorReady: true };
    else if (path === 'timekeeping/context')
      body = { id: id(2), timezone: 'Asia/Manila', date: '2026-10-02' };
    else if (path === 'timekeeping/processing') body = { id: id(2), pending: 0, failed: 0 };
    else if (path === 'sync/summary')
      body = {
        configured: false,
        nodeProvisioned: false,
        pending: 0,
        processing: 0,
        synced: 0,
        failed: 0,
      };
    else if (path === 'dashboard/summary')
      body = {
        id: id(2),
        totalEmployees: 1,
        activeEmployees: 1,
        departments: 0,
        attendanceAvailable: true,
      };
    else if (path === 'attendance-management/days')
      body = {
        date: '2026-10-02',
        timezone: 'Asia/Manila',
        page: 1,
        pageSize: 25,
        total: 1,
        features: { capture: false, finalization: false, centralConfigured: false },
        items: [
          {
            employee: { id: id(3), employeeNumber: 'E1', name: 'Ana Reyes' },
            canonical: null,
            provisional: attendance[0]
              ? {
                  ...attendance[0],
                  first_in: attendance[0].firstIn,
                  last_out: attendance[0].lastOut,
                  worked_minutes: attendance[0].workedMinutes,
                  late_minutes: 0,
                  undertime_minutes: 0,
                  attendance_status: 'present',
                }
              : null,
          },
        ],
      };
    else if (path === 'attendance-management/detail')
      body = {
        employee: { id: id(3), employeeNumber: 'E1', name: 'Ana Reyes' },
        date: '2026-10-02',
        timezone: 'Asia/Manila',
        provisional: attendance[0] ?? null,
        canonical: null,
        schedule: null,
        leave: leaves,
        timeRecords: records,
        rawPunches: [],
        batches: [],
        closures: [],
        devices: [],
        dependencies: [],
        history: [],
        mappings: [],
        commands: [],
        reconciliation: [],
      };
    else if (path === 'attendance-management/monitor')
      body = {
        devices: [],
        unmatched: [],
        dependencies: [],
        receipts: [],
        checkpoints: [],
        attempts: [],
        generatedAt: at,
      };
    else if (path === 'attendance-management/central/connection')
      body = {
        configured: false,
        connected: false,
        user: null,
        expiresAt: null,
        checkedAt: null,
        reason: 'Central finalization is disabled',
      };
    else if (path === 'employees') body = list([employee]);
    else if (path === 'employees/' + id(3)) body = employee;
    else if (['departments', 'positions', 'biometric-devices'].includes(path)) body = list([]);
    else if (path === 'schedules' && method === 'POST') {
      const data = req.postDataJSON() as Record<string, unknown>;
      const row = {
        ...meta,
        ...data,
        id: id(4),
        assignedEmployees: 0,
        versions: [
          {
            id: id(5),
            effectiveFrom: data.effectiveFrom,
            timezone: 'Asia/Manila',
            days: data.days,
          },
        ],
      };
      schedules.push(row);
      body = row;
      status = 201;
    } else if (path === 'schedules') body = list(schedules);
    else if (path === 'schedules/' + id(4)) body = schedules[0];
    else if (path === 'employees/' + id(3) + '/schedules' && method === 'POST') {
      const data = req.postDataJSON() as Record<string, unknown>;
      const row = {
        ...meta,
        ...data,
        id: id(6),
        employeeId: id(3),
        scheduleName: 'Day shift',
        effectiveTo: null,
      };
      assignments.push(row);
      employee.revision++;
      body = row;
      status = 201;
    } else if (path === 'employees/' + id(3) + '/schedules') body = assignments;
    else if (path === 'time-records/manual') {
      const data = req.postDataJSON() as Record<string, unknown>;
      const row = {
        ...meta,
        ...data,
        id: id(10 + records.length),
        employeeName: 'Ana Reyes',
        source: 'manual',
        createdBy: id(1),
        deviceId: null,
        deviceName: null,
        correctionRevision: 0,
        effectiveRecordedAt: data.recordedAt,
        effectiveRecordType: data.recordType,
      };
      records.push(row);
      body = row;
      status = 201;
    } else if (path === 'time-records') body = list(records);
    else if (path === 'leave-types' && method === 'POST') {
      const row = { ...meta, ...(req.postDataJSON() as Record<string, unknown>), id: id(20) };
      leaveTypes.push(row);
      body = row;
      status = 201;
    } else if (path === 'leave-types') body = list(leaveTypes);
    else if (path === 'leave' && method === 'POST') {
      const row = {
        ...meta,
        ...(req.postDataJSON() as Record<string, unknown>),
        id: id(21),
        employeeName: 'Ana Reyes',
        leaveTypeName: 'Vacation',
        status: 'pending',
        requestedAt: at,
        requestedBy: id(1),
      };
      leaves.push(row);
      body = row;
      status = 201;
    } else if (path === 'leave/' + id(21) + '/approve') {
      leaves[0]!.status = 'approved';
      leaves[0]!.revision = 2;
      body = leaves[0];
    } else if (path === 'leave') body = list(leaves);
    else if (path === 'attendance/reprocess') {
      attendance.splice(0, attendance.length, {
        ...meta,
        id: id(30),
        employeeId: id(3),
        employeeName: 'Ana Reyes',
        workDate: '2026-10-02',
        scheduleName: 'Day shift',
        firstIn: '2026-10-02T00:00:00.000Z',
        lastOut: '2026-10-02T09:00:00.000Z',
        workedMinutes: 480,
        lateMinutes: 0,
        undertimeMinutes: 0,
        attendanceStatus: 'present',
        approvalStatus: 'unreviewed',
        result: { complete: true, flags: [], evidence: records, leaves: [] },
      });
      body = { queued: 1 };
    } else if (path === 'attendance/' + id(30) + '/approve') {
      attendance[0]!.approvalStatus = 'approved';
      attendance[0]!.revision = 2;
      body = attendance[0];
    } else if (path === 'attendance/' + id(30))
      body = { ...attendance[0], history: [], adjustments: [] };
    else if (path === 'attendance') body = list(attendance);
    else {
      status = 404;
      body = { error: { code: 'NOT_FOUND', message: 'Fixture route missing' } };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/#/login');
  await page.getByLabel('Username or Email').fill('timekeeper');
  await page.getByLabel('Password', { exact: true }).fill('password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
}
test('schedule, assignment, manual punches, leave approval and provisional attendance remain usable with browser offline signal', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    window.dispatchEvent(new Event('offline'));
  });
  await page.goto('/#/schedules');
  await page.getByRole('button', { name: 'Create schedule', exact: true }).click();
  await page.getByLabel('Code', { exact: true }).fill('DAY');
  await page.getByLabel('Schedule name', { exact: true }).fill('Day shift');
  await page.getByLabel('Effective date', { exact: true }).fill('2026-01-01');
  await page.getByLabel('Reason (required for backdating)').fill('Historical schedule');
  await page.getByLabel('Monday', { exact: true }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'DAY', exact: true })).toBeVisible();
  await page.goto('/#/employees/' + id(3));
  await page.getByLabel('Schedule', { exact: true }).selectOption(id(4));
  await page.getByLabel('Effective from', { exact: true }).fill('2026-01-01');
  await page.getByLabel('Reason', { exact: true }).fill('Assignment setup');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Day shift · 2026-01-01', { exact: false })).toBeVisible();
  await page.goto('/#/time-records');
  for (const [type, time] of [
    ['in', '08:00'],
    ['out', '17:00'],
  ]) {
    await page.getByRole('button', { name: 'Add manual punch' }).click();
    await page.getByLabel('Employee', { exact: true }).last().selectOption(id(3));
    await page.getByLabel('Timestamp with offset').fill(`2026-10-02T${time}:00+08:00`);
    await page.getByLabel('Record type', { exact: true }).last().selectOption(type!);
    await page.getByLabel('Reason', { exact: true }).fill('Device unavailable');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByLabel('Timestamp with offset')).toHaveCount(0);
  }
  await expect(page.getByText('MANUAL', { exact: true })).toHaveCount(2);
  await page.goto('/#/leave');
  await page.getByRole('button', { name: 'Configure leave types' }).click();
  await page.getByLabel('Code', { exact: true }).fill('VL');
  await page.getByLabel('Name', { exact: true }).fill('Vacation');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Create leave request' }).click();
  await page.getByLabel('Employee', { exact: true }).selectOption(id(3));
  await page.getByLabel('Leave type', { exact: true }).selectOption(id(20));
  await page.getByLabel('Start date').fill('2026-10-05');
  await page.getByLabel('End date').fill('2026-10-05');
  await page.getByLabel('Reason', { exact: true }).fill('Vacation');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Ana Reyes', exact: true }).click();
  await page.getByLabel('Action').selectOption('approve');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'approved', exact: true })).toBeVisible();
  await page.goto('/#/attendance');
  await page.getByLabel('Work date').fill('2026-10-02');
  await page.getByRole('button', { name: 'Reprocess local results' }).click();
  await page.getByLabel('Local reprocessing reason').fill('Review test');
  await page.getByRole('button', { name: 'Schedule local calculation', exact: true }).click();
  await page.getByRole('button', { name: 'Ana Reyes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Underlying time records' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve attendance', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Finalize centrally', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('No trusted result received')).toBeVisible();
});
test('Viewer can inspect timekeeping pages but cannot access mutation controls', async ({
  page,
}) => {
  await fixture(page, true);
  for (const [path, button] of [
    ['/schedules', 'Create schedule'],
    ['/time-records', 'Add manual punch'],
    ['/leave', 'Create leave request'],
    ['/attendance', 'Reprocess attendance'],
  ]) {
    await page.goto('/#' + path!);
    await expect(page.getByRole('button', { name: button, exact: true })).toHaveCount(0);
  }
});
