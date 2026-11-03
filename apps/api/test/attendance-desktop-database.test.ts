import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptanceOptions } from './central-evidence-acceptance-fixture.js';
import { desktopFixture, desktopTestPassword } from './attendance-desktop-fixture.js';
import { createTimeRecordService } from '../src/timekeeping/services.js';
import { hashPassword } from '../src/auth/password.js';
import {
  pullNextTrustedAttendanceBatch,
  applyTrustedAttendanceBatch,
} from '../src/sync/trusted-attendance.js';

test(
  'desktop offline reads retain durable punches and never imply central receipt or approval',
  acceptanceOptions,
  async () => {
    const f = await desktopFixture();
    try {
      const token = await f.localLogin();
      f.setAvailable(false);
      await createTimeRecordService(f.office.runtime, { rawCaptureEnabled: true }).ingest(
        f.office.actor,
        { deviceId: f.device, records: f.entries },
      );
      const days = await f.request(
        f.officeHttp.url,
        'attendance-management/days?date=' + f.identity.workDate,
        token,
      );
      assert.equal(days.status, 200);
      assert.equal(days.data.items[0].canonical, null);
      const detail = await f.request(
        f.officeHttp.url,
        'attendance-management/detail?employeeId=' +
          f.employee +
          '&workDate=' +
          f.identity.workDate,
        token,
      );
      assert.equal(detail.status, 200, JSON.stringify(detail.data));
      assert.equal(detail.data.rawPunches.length, 2);
      assert.equal(detail.data.batches[0].delivery, null);
      const monitor = await f.request(f.officeHttp.url, 'attendance-management/monitor', token);
      assert.equal(monitor.status, 200);
      assert.equal(monitor.data.devices[0].pendingBatches, 1);
      assert.equal((await f.centralLogin(token)).status, 503);
      assert.equal((await f.request(f.officeHttp.url, 'auth/session', token)).status, 200);
      assert.equal(await f.count('central_attendance_state'), 0);
      assert.equal(
        (
          await f.request(
            f.officeHttp.url,
            'attendance-management/days?date=' + f.identity.workDate,
            f.office.config.token,
          )
        ).status,
        401,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'desktop bridge uses private central credentials, real source commands and immutable exact retry journal',
  acceptanceOptions,
  async () => {
    const f = await desktopFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const token = await f.localLogin();
      const signed = await f.centralLogin(token);
      assert.equal(signed.status, 200);
      assert.equal('accessToken' in signed.data, false);
      assert.equal(JSON.stringify(signed.data).includes(f.credentials.nodeToken), false);
      const cert = await f.command(token, 'certify', { expectedRevision: 0 });
      assert.equal(cert.status, 200, JSON.stringify(cert.data));
      assert.equal(cert.data.status, 'verified');
      const different = randomUUID();
      await f.office.runtime.query(
        "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'CONTEXT','Context','Test')",
        [different, f.org],
      );
      const mismatched = await f.request(
        f.officeHttp.url,
        'attendance-management/central/command',
        token,
        {
          requestId: await f.uuid7(),
          action: 'proposals',
          employeeId: different,
          workDate: f.identity.workDate,
          command: {
            certificationId: cert.data.id,
            exceptionResolutionId: null,
            expectedCanonicalRevision: 0,
            reason: 'Incorrect selected employee',
          },
        },
      );
      assert.equal(mismatched.status, 404);
      const proposalId = await f.uuid7();
      assert.equal(
        (
          await f.command(
            token,
            'proposals',
            {
              certificationId: cert.data.id,
              exceptionResolutionId: null,
              expectedCanonicalRevision: 0,
            },
            proposalId,
          )
        ).status,
        200,
      );
      const finalId = await f.uuid7();
      f.loseFinalResponse();
      const unconfirmed = await f.command(token, 'finalize', { proposalId }, finalId);
      assert.equal(unconfirmed.status, 503);
      assert.equal(await f.count('central_attendance_events'), 2);
      const confirmed = await f.command(token, 'finalize', { proposalId }, finalId);
      assert.equal(confirmed.status, 200);
      assert.equal(confirmed.data.category, 'accepted');
      assert.equal(await f.count('central_attendance_events'), 2);
      assert.equal(
        (await f.command(token, 'finalize', { proposalId, reason: 'Altered reason' }, finalId))
          .status,
        409,
      );
      const outcomes = (
        await f.office.runtime.query(
          'SELECT outcome FROM attendance_desktop_outcomes WHERE request_id=$1 ORDER BY observed_at',
          [finalId],
        )
      ).rows.map((r) => r.outcome);
      assert.deepEqual(outcomes, ['unconfirmed', 'confirmed']);
      const workspace = await f.request(
        f.officeHttp.url,
        'attendance-management/central/workspace',
        token,
        { employeeId: f.employee, workDate: f.identity.workDate },
      );
      assert.equal(workspace.status, 200, JSON.stringify(workspace.data));
      assert.equal(workspace.data.canonical.approval_status, 'approved');
      assert.equal(workspace.data.history.length, 2);
      const history = workspace.data.history[0];
      const inspected = await f.request(
        f.officeHttp.url,
        'attendance-management/central/evidence',
        token,
        {
          employeeId: f.employee,
          workDate: f.identity.workDate,
          kind: 'history',
          id: history.history_id,
        },
      );
      assert.equal(inspected.status, 200);
      assert.equal(inspected.data.new_state.result.sourceSnapshot.employeeId, f.employee);
      assert.equal(
        (await f.command(token, 'reopen', { expectedCanonicalRevision: 2 })).status,
        200,
      );
      assert.equal(await f.count('central_attendance_events'), 3);
      await pullNextTrustedAttendanceBatch(f.office.runtime, f.office.config);
      await applyTrustedAttendanceBatch(f.office.runtime, f.office.config);
      const localDetail = await f.request(
        f.officeHttp.url,
        'attendance-management/detail?employeeId=' +
          f.employee +
          '&workDate=' +
          f.identity.workDate,
        token,
      );
      const old = localDetail.data.history.find(
        (r: Record<string, unknown>) => r.kind === 'trusted' && r.revision === 2,
      );
      const offline = await f.request(f.officeHttp.url, 'attendance-management/evidence', token, {
        employeeId: f.employee,
        workDate: f.identity.workDate,
        kind: 'trusted',
        id: old.id,
      });
      assert.equal(offline.status, 200);
      assert.equal(offline.data.envelope.snapshot.approval_status, 'approved');
      assert.equal(offline.data.envelope.snapshot.result.sourceSnapshot.employeeId, f.employee);
      await assert.rejects(f.office.runtime.query('DELETE FROM attendance_desktop_requests'));
    } finally {
      await f.close();
    }
  },
);

test(
  'central expiry, removed grants and missing local permissions do not invalidate the local session or grant approval',
  acceptanceOptions,
  async () => {
    const f = await desktopFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const token = await f.localLogin();
      await f.centralLogin(token);
      await f.runtime.query('DELETE FROM auth_sessions WHERE user_id=$1', [f.user]);
      const expired = await f.request(
        f.officeHttp.url,
        'attendance-management/central/connection',
        token,
      );
      assert.equal(expired.status, 409);
      assert.equal(expired.data.error.code, 'CENTRAL_SESSION_EXPIRED');
      assert.equal((await f.request(f.officeHttp.url, 'auth/session', token)).status, 200);
      await f.centralLogin(token);
      await f.runtime.query(
        "DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='attendance.approve'",
        [f.role],
      );
      const denied = await f.command(token, 'finalize', { proposalId: await f.uuid7() });
      assert.equal(denied.status, 403);
      assert.equal(denied.data.error.code, 'CENTRAL_PERMISSION_DENIED');
      await f.office.runtime.query('DELETE FROM user_roles WHERE user_id=$1', [f.user]);
      const role = randomUUID();
      await f.office.runtime.query(
        "INSERT INTO roles(id,organization_id,code,name) VALUES($1,$2,'desktop_viewer','Viewer')",
        [role, f.org],
      );
      await f.office.runtime.query("INSERT INTO role_permissions VALUES($1,'attendance.view')", [
        role,
      ]);
      await f.office.runtime.query('INSERT INTO user_roles VALUES($1,$2)', [f.user, role]);
      assert.equal((await f.command(token, 'certify', { expectedRevision: 0 })).status, 403);
      assert.equal(await f.count('central_attendance_state'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'desktop reads and central sign-in isolate organizations and a process restart forgets central secrets but retains commands',
  acceptanceOptions,
  async () => {
    const f = await desktopFixture();
    try {
      const token = await f.localLogin();
      const foreignEmployee = randomUUID();
      await f.office.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Other test org')",
        [f.foreignOrg],
      );
      await f.office.runtime.query(
        "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'OTHER','Other','Test')",
        [foreignEmployee, f.foreignOrg],
      );
      assert.equal(
        (
          await f.request(
            f.officeHttp.url,
            'attendance-management/detail?employeeId=' +
              foreignEmployee +
              '&workDate=' +
              f.identity.workDate,
            token,
          )
        ).status,
        404,
      );
      const foreignUser = randomUUID();
      await f.runtime.query(
        "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'other_central','Other central',$3)",
        [foreignUser, f.foreignOrg, await hashPassword(desktopTestPassword)],
      );
      assert.equal((await f.centralLogin(token, f.officeHttp.url, 'other_central')).status, 403);
      await f.centralLogin(token);
      await f.deliver();
      await f.closeSource();
      assert.equal((await f.command(token, 'certify', { expectedRevision: 0 })).status, 200);
      const restarted = await f.resetLocalBridge();
      const connection = await f.request(
        restarted.url,
        'attendance-management/central/connection',
        token,
      );
      assert.equal(connection.status, 200);
      assert.equal(connection.data.connected, false);
      assert.equal(await f.countLocal(f.office.runtime, 'attendance_desktop_requests'), 1);
    } finally {
      await f.close();
    }
  },
);
