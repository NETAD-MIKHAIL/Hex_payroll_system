import { generateKeyPairSync, randomUUID, randomBytes, sign } from 'node:crypto';
import { canonicalSyncJson } from '@hexpayroll/shared';
import { acceptanceFixture } from './central-evidence-acceptance-fixture.js';
import { databaseFixture } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { provisionCentralAttendanceWriter } from '../src/timekeeping/central-attendance-writer.js';
import { provisionCentralEvidenceWriter } from '../src/timekeeping/central-evidence-writer.js';
import { createCentralAttendanceFinalizationService } from '../src/timekeeping/central-attendance-finalization.js';
import { createCentralBiometricEvidenceService } from '../src/timekeeping/central-biometric-evidence.js';
import { createSourceClosureReceiver } from '../src/timekeeping/source-period-receipt.js';
import { sourceManifestSchema } from '../src/timekeeping/source-period-protocol.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { tokenHash } from '../src/auth/service.js';

export async function finalizationFixture(
  options: { unsupported?: boolean; allowLimited?: boolean; leave?: boolean } = {},
) {
  const f = await acceptanceFixture();
  try {
    const device = randomUUID(),
      epoch = randomUUID(),
      scheduleId = randomUUID(),
      assignmentId = randomUUID();
    await f.runtime.query(
      "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'CERT_CLOCK','Certificate clock')",
      [device, f.org],
    );
    await f.runtime.query(
      "INSERT INTO biometric_mappings(organization_id,employee_id,device_id,device_employee_id) VALUES($1,$2,$3,'001')",
      [f.org, f.employee, device],
    );
    await f.migrator.query(
      'INSERT INTO central_biometric_sources(organization_id,device_id,node_id) VALUES($1,$2,$3)',
      [f.org, device, f.node],
    );
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await f.migrator.query(
      'INSERT INTO central_source_capabilities(organization_id,device_id,revision,contract,epoch,public_key,assessment) VALUES($1,$2,1,$3,$4,$5,$6)',
      [
        f.org,
        device,
        options.unsupported ? 'unsupported' : 'signed-inventory-v1',
        epoch,
        options.unsupported ? null : publicKey,
        JSON.stringify({
          contractVerified: !options.unsupported,
          reference: 'simulated-source-contract-v1',
          model: 'simulator only',
          sdkVersion: 'test-v1',
        }),
      ],
    );
    await f.migrator.query(
      "INSERT INTO central_attendance_coverage(organization_id,employee_id,effective_from,revision,sources) VALUES($1,$2,'2026-01-01',1,$3)",
      [f.org, f.employee, JSON.stringify([{ deviceId: device, deviceEmployeeId: '001' }])],
    );
    await f.migrator.query(
      "INSERT INTO central_attendance_exception_policies VALUES($1,1,$2,'reviewed test policy')",
      [f.org, options.allowLimited ?? false],
    );
    for (const permission of ['attendance.manage', 'attendance.approve', 'attendance.adjust'])
      await f.runtime.query('INSERT INTO role_permissions VALUES($1,$2) ON CONFLICT DO NOTHING', [
        f.role,
        permission,
      ]);
    const schedulePayload = f.schedulePayload();
    await f.commit('schedule.create', scheduleId, 0, schedulePayload);
    await f.commit('assignment.create', assignmentId, 0, f.assignmentPayload(scheduleId));
    if (options.leave) {
      const type = randomUUID(),
        leave = randomUUID();
      await f.commit('leaveType.create', type, 0, f.typePayload(true));
      await f.commit('leave.request', leave, 0, f.leavePayload(type, '2026-03-02'));
      await f.commit('leave.approve', leave, 1, { remarks: 'Reviewed full leave' });
    }
    await provisionCentralAttendanceWriter(f.migrator, 'hexpayroll_test');
    const service = createCentralAttendanceFinalizationService(f.writer, 'central', true);
    const identity = { organizationId: f.org, employeeId: f.employee, workDate: '2026-03-02' };
    const entries = [
      {
        deviceEmployeeId: '001',
        recordedAt: '2026-03-02T14:00:00.000000Z',
        recordType: 'in' as const,
        externalRecordId: 'log1',
        sourceIdentity: { epoch, sequence: '1', entryId: 'native-1' },
      },
      {
        deviceEmployeeId: '001',
        recordedAt: '2026-03-02T22:00:00.000000Z',
        recordType: 'out' as const,
        externalRecordId: 'log2',
        sourceIdentity: { epoch, sequence: '2', entryId: 'native-2' },
      },
    ];
    const records = entries.map((entry) => ({ id: randomUUID(), ...entry }));
    const receive = createCentralBiometricEvidenceService(f.runtime, 'central', true);
    let batchSequence = 0;
    const deliver = async (received: typeof records = records) =>
      receive.receive(f.credentials.nodeToken, {
        version: 1,
        batchId: randomUUID(),
        organizationId: f.org,
        deviceId: device,
        sequence: ++batchSequence,
        records: received,
      });
    const signed = (changes: Record<string, unknown> = {}) => {
      const manifest = sourceManifestSchema.parse({
        version: 1,
        contract: 'signed-inventory-v1',
        closureId: randomUUID(),
        organizationId: f.org,
        deviceId: device,
        capabilityRevision: 1,
        epoch,
        timezone: 'Asia/Manila',
        start: '2026-03-02T12:00:00Z',
        end: '2026-03-03T00:00:00Z',
        issuedAt: '2026-03-03T00:00:01Z',
        firstSequence: '1',
        lastSequence: '2',
        inventory: entries,
        ...changes,
      });
      return {
        manifest,
        signature: sign(null, Buffer.from(canonicalSyncJson(manifest)), keys.privateKey).toString(
          'base64',
        ),
      };
    };
    const closureReceiver = createSourceClosureReceiver(f.runtime, 'central', true);
    const closeSource = async (changes: Record<string, unknown> = {}) =>
      closureReceiver(f.credentials.nodeToken, signed(changes));
    const certify = async (expectedRevision = 0) =>
      service.certify(f.credentials, { requestId: randomUUID(), ...identity, expectedRevision });
    const uuid7 = async () => String((await f.runtime.query('SELECT uuidv7() id')).rows[0].id);
    const proposeAttendance = async (
      certificationId: string,
      expectedCanonicalRevision = 0,
      exceptionResolutionId: string | null = null,
    ) => {
      const proposalId = await uuid7();
      await service.propose(f.credentials, {
        proposalId,
        certificationId,
        exceptionResolutionId,
        expectedCanonicalRevision,
      });
      return proposalId;
    };
    const finalize = async (proposalId: string, requestId?: string) =>
      service.finalize(f.credentials, {
        requestId: requestId ?? (await uuid7()),
        proposalId,
        reason: 'Central attendance review complete',
      });
    const count = async (table: string) =>
      Number((await f.runtime.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
    const addReviewer = async () => {
      const user = randomUUID(),
        sessionToken = randomBytes(32).toString('base64url');
      await f.runtime.query(
        'INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,$3,$3,$4)',
        [user, f.org, 'reviewer_' + user.replaceAll('-', ''), DUMMY_PASSWORD_HASH],
      );
      await f.runtime.query('INSERT INTO user_roles VALUES($1,$2)', [user, f.role]);
      await f.runtime.query(
        "INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",
        [user, tokenHash(sessionToken)],
      );
      return { user, credentials: { nodeToken: f.credentials.nodeToken, sessionToken } };
    };
    const local = async (office = false) => {
      const db = await databaseFixture();
      try {
        await migrate(db.migrator, db.migrations);
        await db.runtime.query(
          "INSERT INTO organizations(id,legal_name) VALUES($1,'Local attendance')",
          [f.org],
        );
        await db.runtime.query('UPDATE application_setup SET organization_id=$1', [f.org]);
        await db.runtime.query(
          "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'E1','Ana','Santos')",
          [f.employee, f.org],
        );
        await db.runtime.query(
          "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'collector','Collector',$3)",
          [f.user, f.org, DUMMY_PASSWORD_HASH],
        );
        await db.runtime.query(
          "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'CERT_CLOCK','Clock')",
          [device, f.org],
        );
        await db.runtime.query(
          "INSERT INTO biometric_mappings(organization_id,employee_id,device_id,device_employee_id) VALUES($1,$2,$3,'001')",
          [f.org, f.employee, device],
        );
        const node = office ? f.node : randomUUID(),
          token = office ? f.credentials.nodeToken : randomBytes(32).toString('base64url');
        if (!office)
          await f.runtime.query(
            "INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,'WFH test',$3)",
            [node, f.org, tokenHash(token)],
          );
        await db.runtime.query(
          "INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,'Local test',$3)",
          [node, f.org, tokenHash(token)],
        );
        return {
          ...db,
          config: { url: '', nodeId: node, token },
          actor: { id: f.user, organizationId: f.org, permissions: [], roles: [] },
        };
      } catch (e) {
        await db.close();
        throw e;
      }
    };
    const changeAccepted = async (
      action: string,
      id: string,
      revision: number,
      payload: Record<string, unknown>,
    ) => {
      // Existing isolated test login alternates narrowly scoped capabilities;
      // production uses two distinct restricted logins. No global role changes.
      for (const table of [
        'central_attendance_requests',
        'central_attendance_decisions',
        'central_attendance_state',
        'central_attendance_acceptance_history',
        'central_attendance_certifications',
        'central_attendance_exception_resolutions',
        'central_attendance_events',
      ])
        await f.migrator.query(
          `REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON ${table} FROM hexpayroll_acceptance_test_writer`,
        );
      await provisionCentralEvidenceWriter(f.migrator, 'hexpayroll_test');
      try {
        await f.commit(action, id, revision, payload);
      } finally {
        await provisionCentralAttendanceWriter(f.migrator, 'hexpayroll_test');
      }
    };
    return {
      ...f,
      device,
      epoch,
      scheduleId,
      assignmentId,
      scheduleData: schedulePayload,
      identity,
      service,
      entries,
      records,
      deliver,
      signed,
      closeSource,
      closureReceiver,
      certify,
      uuid7,
      proposeAttendance,
      finalize,
      count,
      addReviewer,
      local,
      changeAccepted,
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
