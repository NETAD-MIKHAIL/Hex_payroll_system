import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptanceOptions } from './central-evidence-acceptance-fixture.js';
import { finalizationFixture } from './attendance-finalization-fixture.js';
import { pilotActive, pilotBoundary } from '../src/sync/pilot-scope.js';
import express from 'express';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRenderer } from '../../desktop/src/main/renderer-server.js';
import { pushEvents, pullChanges } from '../src/sync/service.js';
import { pushNextBatch, type SyncClientConfig } from '../src/sync/client.js';
import { createTimeRecordService } from '../src/timekeeping/services.js';
import { createAttendanceFinalizationRouter } from '../src/timekeeping/attendance-finalization-router.js';
import {
  pullNextTrustedAttendanceBatch,
  applyTrustedAttendanceBatch,
} from '../src/sync/trusted-attendance.js';

test('packaged renderer serves only static allowlisted files over loopback with restricted API CSP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hex-pilot-renderer-'));
  await writeFile(join(dir, 'index.html'), '<html>isolated renderer</html>');
  await writeFile(join(dir, '.env'), 'not-shipped-test-placeholder');
  const { server, url } = await serveRenderer(dir);
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-security-policy') ?? '',
      /connect-src 'self';/,
    );
    assert.equal((await fetch(url + '/.env')).status, 404);
    assert.equal((await fetch(url + '/%2e%2e%5c.env')).status, 404);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await unlink(join(dir, 'index.html'));
    await unlink(join(dir, '.env'));
    await rmdir(dir);
  }
});

test(
  'pilot fence defaults off; owner-only activation rejects mixed historical datasets atomically',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      assert.equal(await pilotActive(f.runtime), false);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      const schema = (await f.runtime.query('SELECT current_schema() s')).rows[0].s;
      const diagnostics = spawnSync(
        'psql',
        [
          '-X',
          '-q',
          '-v',
          'ON_ERROR_STOP=1',
          '-f',
          fileURLToPath(
            new URL('../../../database/diagnostics/pilot-readiness.sql', import.meta.url),
          ),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PGHOST: url.hostname,
            PGPORT: url.port || '5432',
            PGDATABASE: 'hexpayroll_test',
            PGUSER: decodeURIComponent(url.username),
            PGPASSWORD: decodeURIComponent(url.password),
            PGOPTIONS: `-c search_path=${schema} -c default_transaction_read_only=on`,
          },
        },
      );
      assert.equal(diagnostics.status, 0, 'Metadata-only read-only diagnostics must succeed');
      assert.ok(!diagnostics.stdout.includes('Santos'));
      const scope = {
        organizations: [f.org],
        employees: [randomUUID()],
        devices: [f.device],
        nodes: [f.node],
        nativeEmployees: ['001'],
      };
      await assert.rejects(
        f.runtime.query('INSERT INTO attendance_pilot_scope(scope) VALUES($1)', [scope]),
        /permission denied/,
      );
      await assert.rejects(
        f.migrator.query('INSERT INTO attendance_pilot_scope(scope) VALUES($1)', [scope]),
        /PILOT_SCOPE_HOLD/,
      );
      assert.equal(await pilotActive(f.runtime), false);
    } finally {
      await f.close();
    }
  },
);

test(
  'pilot scope fences capture and central receipt including nested native identities; broad streams cannot advance',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    const local = await f.local(true);
    const wfh = await f.local();
    try {
      // Fixture-only foreign organization has no operational records. Real mixed
      // databases must remain held; this is a purpose-built pilot dataset.
      await f.migrator.query('DELETE FROM organizations WHERE id=$1', [f.foreignOrg]);
      const scope = {
        organizations: [f.org],
        employees: [f.employee],
        devices: [f.device],
        nodes: [f.node, wfh.config.nodeId],
        nativeEmployees: ['001'],
      };
      for (const db of [f, local, wfh])
        await db.migrator.query('INSERT INTO attendance_pilot_scope(scope) VALUES($1)', [scope]);
      assert.equal(await pilotActive(f.runtime), true);
      const app = express();
      app.use(pilotBoundary(f.runtime));
      app.use((_req, res) => res.status(204).end());
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const url = `http://127.0.0.1:${address.port}`;
        assert.equal((await fetch(url + '/api/payroll/periods', { method: 'POST' })).status, 403);
        assert.equal(
          (await fetch(url + '/api/sync/local-evidence/reconcile', { method: 'POST' })).status,
          403,
        );
        assert.equal(
          (await fetch(url + '/api/sync/attendance/certify', { method: 'POST' })).status,
          204,
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await assert.rejects(
        f.runtime.query(
          "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'OUTSIDE','Test','Only')",
          [randomUUID(), f.org],
        ),
        /PILOT_SCOPE_HOLD/,
      );
      await assert.rejects(
        f.runtime.query(
          "UPDATE biometric_mappings SET device_employee_id='outside' WHERE device_id=$1",
          [f.device],
        ),
        /PILOT_SCOPE_HOLD/,
      );
      const before = await f.count('central_biometric_receipts');
      await assert.rejects(
        f.deliver(f.records.map((r) => ({ ...r, deviceEmployeeId: 'outside' }))),
        /PILOT_SCOPE_HOLD/,
      );
      assert.equal(await f.count('central_biometric_receipts'), before);
      await assert.rejects(
        pushEvents(f.runtime, f.credentials.nodeToken, {}),
        /Broad synchronization/,
      );
      await assert.rejects(
        pullChanges(f.runtime, f.credentials.nodeToken, '0'),
        /Broad synchronization/,
      );
      await assert.rejects(pushNextBatch(local.runtime, local.config), /Broad synchronization/);
      await createTimeRecordService(local.runtime, { rawCaptureEnabled: true }).ingest(
        { ...local.actor, permissions: ['time_records.ingest'] },
        { deviceId: f.device, records: f.entries },
      );
      const captured = (
        await local.runtime.query('SELECT count(*)::int n FROM biometric_raw_captures')
      ).rows[0].n;
      await assert.rejects(
        createTimeRecordService(local.runtime, { rawCaptureEnabled: true }).ingest(
          { ...local.actor, permissions: ['time_records.ingest'] },
          {
            deviceId: f.device,
            records: f.entries.map((r) => ({
              ...r,
              deviceEmployeeId: 'outside',
              externalRecordId: 'outside-' + r.externalRecordId,
            })),
          },
        ),
      );
      assert.equal(
        (await local.runtime.query('SELECT count(*)::int n FROM biometric_raw_captures')).rows[0].n,
        captured,
      );
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const proposal = await f.proposeAttendance(cert.id);
      await f.finalize(proposal);
      assert.equal(await f.count('central_attendance_state'), 1);
      const delivery = express();
      delivery.use(
        '/api',
        createAttendanceFinalizationRouter(f.runtime, 'central', true, f.writer),
      );
      const central = delivery.listen(0, '127.0.0.1');
      await once(central, 'listening');
      try {
        const address = central.address();
        assert.ok(address && typeof address !== 'string');
        for (const db of [local, wfh]) {
          const config: SyncClientConfig = {
            ...db.config,
            url: `http://127.0.0.1:${address.port}`,
          };
          await pullNextTrustedAttendanceBatch(db.runtime, config);
          assert.equal((await applyTrustedAttendanceBatch(db.runtime, config)).applied, 2);
        }
        const a = (await local.runtime.query('SELECT snapshot FROM trusted_attendance_state')).rows;
        const b = (await wfh.runtime.query('SELECT snapshot FROM trusted_attendance_state')).rows;
        assert.deepEqual(a, b);
      } finally {
        await new Promise<void>((done) => central.close(() => done()));
      }
      await assert.rejects(
        f.writer.query("UPDATE attendance_pilot_scope SET scope='{}'"),
        /permission denied/,
      );
    } finally {
      await local.close();
      await wfh.close();
      await f.close();
    }
  },
);
