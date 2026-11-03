import { test, expect, type Page } from '@playwright/test';
import { desktopFixture, desktopTestPassword } from '../../api/test/attendance-desktop-fixture';
import { pushNextBiometricBatch } from '../../api/src/sync/biometric-evidence';
import { pushNextSourceClosure } from '../../api/src/sync/source-closures';
import {
  pullNextTrustedAttendanceBatch,
  applyTrustedAttendanceBatch,
} from '../../api/src/sync/trusted-attendance';
import { pullNextTrustedEvidenceBatch } from '../../api/src/sync/client';
import { applyTrustedEvidenceBatch } from '../../api/src/sync/trusted-application';
import { processAttendance } from '../../api/src/timekeeping/services';
import { transaction } from '../../api/src/foundation/repository';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('real isolated Office offline capture → central UI approval → WFH trusted view → reopening audit', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const f = await desktopFixture();
  const officeContext = await browser.newContext({ baseURL: 'http://127.0.0.1:5273' }),
    wfhContext = await browser.newContext({ baseURL: 'http://127.0.0.1:5273' });
  try {
    const prepare = async (page: Page, url: string) => {
      await page.route('**/api/**', async (route) => {
        const incoming = new URL(route.request().url());
        if (!incoming.pathname.startsWith('/api/')) {
          await route.continue();
          return;
        }
        // Only translate the test API port. Every response and mutation below
        // comes from the real HTTP routers and isolated PostgreSQL fixtures.
        const response = await route.fetch({ url: url + incoming.pathname + incoming.search });
        await route.fulfill({ response });
      });
      await page.goto('/#/login');
      await page.getByLabel('Username or Email').fill('collector');
      await page.getByLabel('Password', { exact: true }).fill(desktopTestPassword);
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await expect(page).toHaveURL(/dashboard/);
      await page.goto('/#/attendance?date=' + f.identity.workDate);
      await page.getByRole('button', { name: 'Ana Santos', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Underlying time records' })).toBeVisible();
    };
    for (const db of [f.office, f.wfh]) {
      await pullNextTrustedEvidenceBatch(db.runtime, db.config);
      await applyTrustedEvidenceBatch(db.runtime, db.config, 'local');
    }
    const office = await officeContext.newPage();
    await prepare(office, f.officeHttp.url);
    f.setAvailable(false);
    await office.getByLabel('Central username').fill('acceptor');
    await office.getByLabel('Central password').fill(desktopTestPassword);
    await office.getByRole('button', { name: 'Sign in centrally' }).click();
    await expect(office.getByRole('alert').filter({ hasText: 'outage' })).toBeVisible();
    await office.getByRole('button', { name: 'Biometric monitoring', exact: true }).click();
    await office
      .getByLabel('Evidence JSON')
      .fill(JSON.stringify({ deviceId: f.device, records: f.entries }));
    await office.getByRole('button', { name: 'Capture locally', exact: true }).click();
    await expect(
      office.getByRole('status').filter({ hasText: 'Evidence captured durably' }),
    ).toBeVisible();
    await office.getByLabel('Evidence type').selectOption('closure');
    await office.getByLabel('Evidence JSON').fill(JSON.stringify(f.signed()));
    await office.getByRole('button', { name: 'Capture locally', exact: true }).click();
    await expect.poll(() => f.countLocal(f.office.runtime, 'biometric_source_closures')).toBe(1);
    {
      expect(await f.count('central_biometric_raw_evidence')).toBe(0);
      expect(await f.count('central_attendance_state')).toBe(0);
    }
    await transaction(f.office.runtime, (c) =>
      processAttendance(c, f.office.actor, f.employee, f.identity.workDate),
    );
    await office.getByRole('button', { name: 'Daily attendance', exact: true }).click();
    await office.getByRole('button', { name: 'Refresh attendance' }).click();
    await expect(office.getByText('Provisional · r1')).toBeVisible();
    await expect(office.getByTestId('trusted-result')).toContainText('not received');
    f.setAvailable(true);
    await office.getByLabel('Central password').fill(desktopTestPassword);
    await office.getByRole('button', { name: 'Sign in centrally' }).click();
    await expect(office.getByText('Acceptor', { exact: true })).toBeVisible();
    await pushNextBiometricBatch(f.office.runtime, f.office.config);
    await pushNextSourceClosure(f.office.runtime, f.office.config);
    const command = async (name: string, reason: string) => {
      await office.getByRole('button', { name, exact: true }).click();
      const dialog = office.getByRole('dialog', { name });
      await dialog.getByLabel('Review reason').fill(reason);
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: 'Confirm central command' }).click();
      await expect(dialog).toHaveCount(0);
    };
    await command('Certify source window', 'Verify complete signed inventory');
    await command('Prepare central proposal', 'Review accepted shift and source evidence');
    await command('Finalize centrally', 'Approve verified attendance for isolated employee');
    await expect(office.getByTestId('central-result')).toContainText('Canonical revision 2');
    await expect(office.getByTestId('trusted-result')).toContainText('not received');
    for (const db of [f.office, f.wfh]) {
      await pullNextTrustedAttendanceBatch(db.runtime, db.config);
      await applyTrustedAttendanceBatch(db.runtime, db.config);
    }
    const wfh = await wfhContext.newPage();
    await prepare(wfh, f.wfhHttp.url);
    await expect(wfh.getByTestId('trusted-result')).toContainText('Canonical revision 2');
    await expect(wfh.getByTestId('trusted-result')).toContainText('approved');
    await wfh.getByRole('button', { name: 'Inspect received snapshot' }).click();
    await expect(wfh.getByRole('dialog', { name: 'Trusted canonical snapshot' })).toContainText(
      'sourceSnapshot',
    );
    await wfh.getByRole('button', { name: 'Close evidence' }).click();
    await expect(
      wfh.getByRole('button', { name: 'Finalize centrally', exact: true }),
    ).toBeDisabled();
    await office.getByRole('button', { name: 'Refresh attendance' }).click();
    await expect(office.getByTestId('trusted-result')).toContainText('Canonical revision 2');
    const screenshots = fileURLToPath(new URL('../../../.diagnostics/', import.meta.url));
    await mkdir(screenshots, { recursive: true });
    await office.setViewportSize({ width: 1440, height: 1000 });
    await office.screenshot({
      path: screenshots + 'attendance-management-office.png',
      fullPage: true,
    });
    await wfh.screenshot({ path: screenshots + 'attendance-management-wfh.png', fullPage: true });
    await command('Reopen centrally', 'Investigate a reported attendance exception');
    await expect(office.getByTestId('central-result')).toContainText('Canonical revision 3');
    for (const db of [f.office, f.wfh]) {
      await pullNextTrustedAttendanceBatch(db.runtime, db.config);
      await applyTrustedAttendanceBatch(db.runtime, db.config);
    }
    await wfh.getByRole('button', { name: 'Refresh attendance' }).click();
    await expect(wfh.getByTestId('trusted-result')).toContainText('unreviewed');
    await office.getByRole('button', { name: 'Audit history', exact: true }).click();
    await expect(
      office.getByRole('heading', { name: 'Central immutable attendance revisions' }),
    ).toBeVisible();
    const history = office
      .locator('section')
      .filter({
        has: office.getByRole('heading', {
          name: 'Central immutable attendance revisions',
          exact: true,
        }),
      })
      .last();
    await history.getByRole('button', { name: 'Inspect immutable record' }).first().click();
    await expect(office.getByRole('dialog', { name: 'Immutable central evidence' })).toContainText(
      'new_state',
    );
    await office.getByRole('button', { name: 'Close evidence' }).click();
    expect(await f.count('central_attendance_acceptance_history')).toBe(3);
    expect(await f.countLocal(f.office.runtime, 'attendance_desktop_requests')).toBe(4);
    expect(await office.evaluate(() => Object.keys(localStorage))).toHaveLength(0);
  } finally {
    await officeContext.close();
    await wfhContext.close();
    await f.close();
  }
});
