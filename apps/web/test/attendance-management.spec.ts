import { test, expect, type Page } from '@playwright/test';
import { permissionCodes } from '@hexpayroll/shared';
const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-29T00:00:00.000Z';
async function fixture(page: Page, options: { viewer?: boolean; unsupported?: boolean } = {}) {
  const user = {
    id: id(1),
    username: 'operator',
    displayName: 'Local operator',
    organizationId: id(2),
    roles: ['administrator'],
    permissions: options.viewer
      ? ['dashboard.view', 'attendance.view', 'employees.view', 'time_records.view']
      : [...permissionCodes],
  };
  const centralUser = {
    ...user,
    id: id(9),
    username: 'reviewer',
    displayName: 'Central reviewer',
    permissions: [...permissionCodes],
  };
  const employee = { id: id(3), employeeNumber: 'E1', name: 'Ana Reyes' };
  let connected = false,
    expired = false,
    lose = false;
  let n = 100;
  let trusted: Record<string, unknown> | null = null,
    head: Record<string, unknown> | null = null;
  const certifications: Record<string, unknown>[] = [],
    proposals: Record<string, unknown>[] = [],
    exceptions: Record<string, unknown>[] = [],
    history: Record<string, unknown>[] = [],
    requests: Record<string, unknown>[] = [];
  const snapshot = {
    blockers: options.unsupported ? ['SOURCE_UNSUPPORTED:' + id(4)] : [],
    sourceProofs: [
      {
        source: { deviceId: id(4) },
        capability: {
          contract: options.unsupported ? 'unsupported' : 'signed-inventory-v1',
          epoch: id(8),
        },
        proof: { missingRanges: [], receivedRanges: [{ first: '1', last: '2' }] },
      },
    ],
    policy: { revision: 1, allow_limited: true },
    result: { workedMinutes: 420 },
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.replace('/api/', '');
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    const method = req.method();
    let body: unknown = {},
      status = 200;
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
    else if (path === 'dashboard/summary')
      body = {
        id: id(2),
        totalEmployees: 1,
        activeEmployees: 1,
        departments: 0,
        attendanceAvailable: false,
      };
    else if (path === 'timekeeping/context')
      body = { id: id(2), timezone: 'Asia/Manila', date: '2026-10-29' };
    else if (path === 'sync/summary')
      body = {
        configured: false,
        nodeProvisioned: false,
        pending: 0,
        processing: 0,
        synced: 0,
        failed: 0,
      };
    else if (path === 'attendance-management/days')
      body = {
        date: '2026-10-29',
        timezone: 'Asia/Manila',
        total: 1,
        page: 1,
        pageSize: 25,
        features: { capture: true, finalization: true, centralConfigured: true },
        items: [
          {
            employee,
            provisional: {
              revision: 1,
              attendance_status: 'present',
              worked_minutes: 420,
              late_minutes: 0,
              undertime_minutes: 0,
              first_in: at,
              last_out: '2026-10-29T08:00:00Z',
            },
            canonical: trusted,
          },
        ],
      };
    else if (path === 'attendance-management/detail')
      body = {
        employee,
        date: '2026-10-29',
        timezone: 'Asia/Manila',
        provisional: {
          attendance_status: 'present',
          worked_minutes: 420,
          late_minutes: 0,
          undertime_minutes: 0,
          result: { flags: [] },
        },
        canonical: trusted,
        schedule: {
          scheduleName: 'Night shift',
          day: { breakStart: '02:00:00', breakEnd: '03:00:00' },
        },
        leave: [],
        timeRecords: [{ id: id(11), record_type: 'in', recorded_at: at }],
        rawPunches: [
          {
            id: id(12),
            record_type: 'in',
            recorded_at: at,
            source_identity: { epoch: id(8), sequence: '1', entryId: 'native1' },
          },
        ],
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
        devices: [{ id: id(4), name: 'Office clock', status: 'active', pendingBatches: 1 }],
        unmatched: [{ id: id(10), record_type: 'unknown', device_employee_id: 'UNMAPPED' }],
        dependencies: [{ sequence: '7', code: 'MISSING_TRUSTED_ACTOR', status: 'pending' }],
        receipts: [],
        checkpoints: [],
        attempts: [],
        generatedAt: at,
      };
    else if (path === 'attendance-management/central/login') {
      connected = true;
      body = {
        configured: true,
        connected: true,
        user: centralUser,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        checkedAt: at,
      };
    } else if (path === 'attendance-management/central/connection') {
      if (expired) {
        status = 409;
        body = {
          error: {
            code: 'CENTRAL_SESSION_EXPIRED',
            message: 'Central authorization expired; local session remains active',
          },
        };
      } else
        body = {
          configured: true,
          connected,
          user: connected ? centralUser : null,
          expiresAt: connected ? new Date(Date.now() + 3600000).toISOString() : null,
          checkedAt: connected ? at : null,
        };
    } else if (path === 'attendance-management/central/disconnect') {
      connected = false;
      body = { disconnected: true, revocationConfirmed: true };
    } else if (path === 'attendance-management/central/workspace')
      body = {
        organizationId: id(2),
        employeeId: id(3),
        workDate: '2026-10-29',
        canonical: head,
        certifications,
        proposals,
        exceptions,
        decisions: [],
        history,
        receipts: [],
        capabilities: [],
        coverage: [],
        generatedAt: at,
      };
    else if (path === 'attendance-management/request-id') body = { id: id(n++) };
    else if (path === 'attendance-management/central/evidence')
      body = { id: req.postDataJSON().id, snapshot, actor_user_id: id(9), decided_at: at };
    else if (path === 'attendance-management/central/command') {
      const data = req.postDataJSON();
      requests.push(data);
      if (data.action === 'certify') {
        const c = {
          id: data.requestId,
          revision: certifications.length + 1,
          status: options.unsupported ? 'unresolved' : 'verified',
          snapshot,
          fingerprint: 'f'.repeat(64),
          operator_id: id(1),
          created_at: at,
        };
        certifications.unshift(c);
        body = c;
      } else if (data.action === 'proposals') {
        const p = {
          proposal_id: data.requestId,
          action: 'calculate',
          expected_canonical_revision: head?.canonical_revision ?? 0,
          proposed_payload: { command: data.command },
        };
        proposals.unshift(p);
        body = p;
      } else if (data.action === 'exceptions') {
        const r = {
          id: data.requestId,
          certification_id: certifications[0]?.id,
          decision: data.command.decision,
          operator_id: id(9),
          created_at: at,
          request: data.command,
        };
        exceptions.unshift(r);
        body = r;
      } else if (data.action === 'finalize') {
        head = {
          canonical_attendance_id: id(20),
          canonical_revision: 2,
          approval_status: 'approved',
          approved_by: id(9),
          approved_at: at,
          worked_minutes: 420,
          result: {
            evidenceStatus: options.unsupported ? 'exception_authorized' : 'verified_complete',
            limitations: options.unsupported ? ['SOURCE_UNSUPPORTED:' + id(4)] : [],
          },
        };
        if (!history.length)
          history.push({
            history_id: id(21),
            new_revision: 2,
            action: 'approve',
            actor_user_id: id(9),
            created_at: at,
          });
        if (lose) {
          lose = false;
          status = 503;
          body = {
            error: { code: 'CENTRAL_UNAVAILABLE', message: 'Central response was not confirmed' },
          };
        } else body = { category: 'accepted', decision_id: id(22) };
      } else if (data.action === 'reopen') {
        head = { ...head, canonical_revision: 3, approval_status: 'unreviewed' };
        history.unshift({
          history_id: id(23),
          new_revision: 3,
          action: 'reopen',
          actor_user_id: id(9),
          created_at: at,
        });
        body = head;
      }
    } else if (
      method === 'POST' &&
      ['time-records/ingest', 'biometric-source-closures'].includes(path)
    )
      body = { captured: true, certified: false };
    else if (['departments', 'positions', 'biometric-devices'].includes(path))
      body = { items: [], total: 0, page: 1, pageSize: 25 };
    else {
      status = 404;
      body = { error: { code: 'NOT_FOUND', message: 'Fixture route not installed' } };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/#/login');
  await page.getByLabel('Username or Email').fill('operator');
  await page.getByLabel('Password', { exact: true }).fill('password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.goto('/#/attendance?date=2026-10-29');
  await page.getByRole('button', { name: 'Ana Reyes', exact: true }).click();
  return {
    requests,
    expire: () => {
      expired = true;
    },
    lose: () => {
      lose = true;
    },
    deliver: () => {
      trusted = head;
    },
    denyApprove: () => {
      centralUser.permissions = centralUser.permissions.filter((p) => p !== 'attendance.approve');
    },
  };
}
async function signCentral(page: Page) {
  await page.getByLabel('Central username').fill('reviewer');
  await page.getByLabel('Central password').fill('password');
  await page.getByRole('button', { name: 'Sign in centrally' }).click();
  await expect(page.getByText('Central reviewer', { exact: true })).toBeVisible();
}
async function command(page: Page, name: string, reason = 'Reviewed evidence for isolated test') {
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name });
  await dialog.getByLabel('Review reason').fill(reason);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Confirm central command' }).click();
  await expect(dialog).toHaveCount(0);
}

test('offline viewer distinguishes provisional and trusted state and cannot approve locally', async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await fixture(page, { viewer: true });
  await expect(page.getByTestId('trusted-result')).toContainText('not received');
  await expect(
    page.getByRole('button', { name: 'Finalize centrally', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Approve attendance', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Biometric monitoring', exact: true }).click();
  await expect(page.getByText('MISSING TRUSTED ACTOR', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Capture locally', exact: true })).toHaveCount(0);
});
test('central workflow requires reasons and explicit confirmation; local trust appears only after delivery', async ({
  page,
}) => {
  const f = await fixture(page);
  await signCentral(page);
  await page.getByRole('button', { name: 'Certify source window', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Certify source window' });
  await expect(dialog.getByRole('button', { name: 'Confirm central command' })).toBeDisabled();
  expect(f.requests).toHaveLength(0);
  await dialog.getByLabel('Review reason').fill('Source inventory reviewed');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Confirm central command' }).click();
  await expect(dialog).toHaveCount(0);
  await command(page, 'Prepare central proposal');
  await command(page, 'Finalize centrally');
  await expect(page.getByTestId('central-result')).toContainText('approved');
  await expect(page.getByTestId('trusted-result')).toContainText('not received');
  f.deliver();
  await page.getByRole('button', { name: 'Refresh attendance' }).click();
  await expect(page.getByTestId('trusted-result')).toContainText('Canonical revision 2');
  await command(page, 'Reopen centrally', 'Recheck late source evidence');
  await expect(page.getByTestId('central-result')).toContainText('unreviewed');
  await page.getByRole('button', { name: 'Audit history', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Central immutable attendance revisions' }),
  ).toBeVisible();
});
test('central expiry keeps local sign-in and disables approval actions', async ({ page }) => {
  const f = await fixture(page);
  await signCentral(page);
  f.expire();
  await page.getByRole('button', { name: 'Refresh attendance' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Central authorization expired' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Certify source window', exact: true }),
  ).toBeDisabled();
  await expect(page).toHaveURL(/attendance/);
  await expect(page.getByRole('heading', { name: 'Underlying time records' })).toBeVisible();
});
test('unconfirmed finalization freezes content and retries the same request identity', async ({
  page,
}) => {
  const f = await fixture(page);
  await signCentral(page);
  await command(page, 'Certify source window');
  await command(page, 'Prepare central proposal');
  f.lose();
  await page.getByRole('button', { name: 'Finalize centrally', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Finalize centrally' });
  await dialog.getByLabel('Review reason').fill('Approve reviewed source');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Confirm central command' }).click();
  await expect(dialog.getByLabel('Review reason')).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('not confirmed');
  await expect(dialog.getByRole('button', { name: 'Confirm central command' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Confirm central command' }).click();
  await expect(dialog).toHaveCount(0);
  const calls = f.requests.filter((r) => r.action === 'finalize');
  expect(calls).toHaveLength(2);
  expect(calls[0]!.requestId).toBe(calls[1]!.requestId);
});
test('unsupported evidence stays unresolved and limited authorization needs artifact commitments', async ({
  page,
}) => {
  const f = await fixture(page, { unsupported: true });
  await signCentral(page);
  await command(page, 'Certify source window');
  await expect(
    page.getByRole('button', { name: 'Prepare central proposal', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Resolve source exception' }).click();
  const dialog = page.getByRole('dialog', { name: 'Resolve source exception' });
  await dialog.getByLabel('Exception decision').selectOption('authorize_limited');
  await dialog.getByLabel('Review reason').fill('Review independent source limitations');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Confirm central command' }).click();
  expect(f.requests.filter((r) => r.action === 'exceptions')).toHaveLength(0);
  await dialog.getByLabel('Device export SHA-256').fill('a'.repeat(64));
  await dialog.getByLabel('Device export reference').fill('Reviewed export');
  await dialog.getByLabel('Independent attestation SHA-256').fill('b'.repeat(64));
  await dialog.getByLabel('Independent attestation reference').fill('Reviewed attestation');
  await dialog.getByRole('button', { name: 'Confirm central command' }).click();
  await expect(dialog).toHaveCount(0);
  await command(page, 'Prepare central proposal');
  await command(page, 'Finalize centrally');
  f.deliver();
  await page.getByRole('button', { name: 'Refresh attendance' }).click();
  await expect(page.getByTestId('trusted-result')).toContainText('exception authorized');
  await expect(page.getByTestId('trusted-result')).toContainText('SOURCE_UNSUPPORTED');
});
test('current central permission removal disables approval without hiding local evidence', async ({
  page,
}) => {
  const f = await fixture(page);
  await signCentral(page);
  await command(page, 'Certify source window');
  await command(page, 'Prepare central proposal');
  f.denyApprove();
  await page.getByRole('button', { name: 'Refresh attendance' }).click();
  await expect(
    page.getByRole('button', { name: 'Finalize centrally', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Immutable raw punches' })).toBeVisible();
});
