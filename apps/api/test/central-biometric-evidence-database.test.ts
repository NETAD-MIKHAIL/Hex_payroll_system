import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { acceptanceFixture, acceptanceOptions } from './central-evidence-acceptance-fixture.js';
import { createCentralBiometricEvidenceService } from '../src/timekeeping/central-biometric-evidence.js';
import { createAttendanceEvidenceReviewService } from '../src/timekeeping/attendance-evidence-review.js';
import express from 'express';
import { once } from 'node:events';
import { databaseFixture } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { tokenHash } from '../src/auth/service.js';
import { createTimeRecordService } from '../src/timekeeping/services.js';
import { pushNextBiometricBatch } from '../src/sync/biometric-evidence.js';
import { pushEvents } from '../src/sync/service.js';

async function fixture() {
  const f = await acceptanceFixture();
  try {
    const device = randomUUID();
    await f.runtime.query(
      "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'CLOCK','Clock')",
      [device, f.org],
    );
    await f.migrator.query(
      'INSERT INTO central_biometric_sources(organization_id,device_id,node_id) VALUES($1,$2,$3)',
      [f.org, device, f.node],
    );
    const batch = {
      version: 1 as const,
      batchId: randomUUID(),
      organizationId: f.org,
      deviceId: device,
      sequence: 1,
      records: [
        {
          id: randomUUID(),
          deviceEmployeeId: '001',
          recordedAt: '2026-10-01T00:00:00.123456Z',
          recordType: 'in' as const,
          externalRecordId: '1',
        },
      ],
    };
    const service = createCentralBiometricEvidenceService(f.runtime, 'central', true);
    const receive = (body: unknown = batch) => service.receive(f.credentials.nodeToken, body);
    const count = async (table: string) =>
      Number((await f.runtime.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
    return { ...f, device, batch, receive, count };
  } catch (e) {
    await f.close();
    throw e;
  }
}

test(
  'another enrolled node cannot forge device origin and generic v1 cannot supply attendance authority',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const token = randomBytes(32).toString('base64url');
      await f.runtime.query(
        "INSERT INTO sync_nodes(organization_id,device_name,token_hash) VALUES($1,'Other collector',$2)",
        [f.org, tokenHash(token)],
      );
      await assert.rejects(
        createCentralBiometricEvidenceService(f.runtime, 'central', true).receive(token, f.batch),
        /not bound/,
      );
      for (const entityType of [
        'central_biometric_sources',
        'central_biometric_receipts',
        'central_biometric_raw_evidence',
        'central_attendance_evidence_reviews',
        'central_attendance_state',
      ]) {
        await assert.rejects(
          pushEvents(f.runtime, f.credentials.nodeToken, {
            events: [
              {
                eventId: randomUUID(),
                entityType,
                entityId: randomUUID(),
                operation: 'CREATE',
                revision: 1,
                payloadVersion: 1,
                payload: { approved: true },
              },
            ],
          }),
          /require central administration/,
        );
      }
      await f.runtime.query('UPDATE sync_nodes SET enabled=false WHERE id=$1', [f.node]);
      await assert.rejects(f.receive(), /credential invalid/);
      assert.equal(await f.count('central_biometric_receipts'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'two-device offline capture delivers between isolated schemas and invalid acknowledgments never advance delivery',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    const local = await databaseFixture();
    const app = express();
    let corrupt = true;
    app.use(express.json());
    app.post('/api/sync/biometric/receive', async (req, res, next) => {
      try {
        const receipt = await f.receive(req.body);
        res.json(corrupt ? { ...receipt, batchId: randomUUID() } : receipt);
      } catch (error) {
        next(error);
      }
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      await migrate(local.migrator, local.migrations);
      await local.runtime.query("INSERT INTO organizations(id,legal_name) VALUES($1,'Office')", [
        f.org,
      ]);
      await local.runtime.query('UPDATE application_setup SET organization_id=$1', [f.org]);
      await local.runtime.query(
        "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'collector','Collector',$3)",
        [f.user, f.org, DUMMY_PASSWORD_HASH],
      );
      await local.runtime.query(
        "INSERT INTO sync_nodes(id,organization_id,device_name,token_hash) VALUES($1,$2,'Office',$3)",
        [f.node, f.org, tokenHash(f.credentials.nodeToken)],
      );
      const second = randomUUID();
      await f.runtime.query(
        "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'CLOCK2','Clock2')",
        [second, f.org],
      );
      await f.migrator.query(
        'INSERT INTO central_biometric_sources(organization_id,device_id,node_id) VALUES($1,$2,$3)',
        [f.org, second, f.node],
      );
      for (const [i, device] of [f.device, second].entries()) {
        await local.runtime.query(
          'INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,$3,$3)',
          [device, f.org, 'CLOCK' + i],
        );
        await createTimeRecordService(local.runtime, { rawCaptureEnabled: true }).ingest(
          { id: f.user, organizationId: f.org, permissions: [], roles: [] },
          {
            deviceId: device,
            records: [
              {
                deviceEmployeeId: 'unmapped',
                recordedAt: '2026-10-01T00:00:00.123456Z',
                recordType: 'in',
                externalRecordId: '1',
              },
            ],
          },
        );
      }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback address');
      const config = {
        url: `http://127.0.0.1:${address.port}`,
        nodeId: f.node,
        token: f.credentials.nodeToken,
      };
      await assert.rejects(pushNextBiometricBatch(local.runtime, config));
      assert.equal(
        (await local.runtime.query('SELECT count(*)::int n FROM biometric_batch_deliveries'))
          .rows[0].n,
        0,
      );
      assert.equal(await f.count('central_biometric_receipts'), 1);
      corrupt = false;
      await pushNextBiometricBatch(local.runtime, config);
      await pushNextBiometricBatch(local.runtime, config);
      assert.equal(await pushNextBiometricBatch(local.runtime, config), false);
      assert.equal(
        (await local.runtime.query('SELECT count(*)::int n FROM biometric_batch_deliveries'))
          .rows[0].n,
        2,
      );
      assert.equal(await f.count('central_biometric_receipts'), 2);
      assert.equal(await f.count('central_biometric_raw_evidence'), 2);
      assert.equal(await f.count('central_attendance_state'), 0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await local.close();
      await f.close();
    }
  },
);

test(
  'central evidence review exposes gaps, freezes snapshots and never certifies a timestamp checkpoint',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      await f.runtime.query(
        "INSERT INTO role_permissions VALUES($1,'attendance.manage') ON CONFLICT DO NOTHING",
        [f.role],
      );
      await f.receive({ ...f.batch, sequence: 3 });
      const review = createAttendanceEvidenceReviewService(f.runtime, 'central', true);
      const command = {
        requestId: randomUUID(),
        organizationId: f.org,
        employeeId: f.employee,
        workDate: '2026-10-01',
        expectedRevision: 0,
        reason: 'Review outage evidence',
      };
      const first = await review(f.credentials, command);
      assert.equal(first.snapshot.finalized, false);
      assert.equal(first.snapshot.status, 'pending_review');
      assert.deepEqual(first.snapshot.gaps, [
        { device_id: f.device, first_missing: '1', last_missing: '2' },
      ]);
      assert.ok(first.snapshot.blockers.includes('SOURCE_PERIOD_CLOSURE_UNVERIFIED'));
      const replay = await review(f.credentials, command);
      assert.equal(replay.fingerprint, first.fingerprint);
      await f.receive({ ...f.batch, batchId: randomUUID(), sequence: 1 });
      const second = await review(f.credentials, {
        ...command,
        requestId: randomUUID(),
        expectedRevision: 1,
      });
      assert.notEqual(second.fingerprint, first.fingerprint);
      assert.deepEqual(second.snapshot.gaps, [
        { device_id: f.device, first_missing: '2', last_missing: '2' },
      ]);
      assert.equal((await review(f.credentials, command)).fingerprint, first.fingerprint);
      await assert.rejects(
        review(f.credentials, { ...command, requestId: randomUUID() }),
        /revision changed/,
      );
      await assert.rejects(f.runtime.query('DELETE FROM central_attendance_evidence_reviews'));
      assert.equal(await f.count('central_attendance_state'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'concurrent review CAS has one winner and current session revocation prevents retries',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      await f.runtime.query(
        "INSERT INTO role_permissions VALUES($1,'attendance.manage') ON CONFLICT DO NOTHING",
        [f.role],
      );
      const review = createAttendanceEvidenceReviewService(f.runtime, 'central', true);
      const command = {
        requestId: randomUUID(),
        organizationId: f.org,
        employeeId: f.employee,
        workDate: '2026-10-01',
        expectedRevision: 0,
        reason: 'Review device closure',
      };
      const results = await Promise.allSettled([
        review(f.credentials, command),
        review(f.credentials, { ...command, requestId: randomUUID() }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(await f.count('central_attendance_evidence_reviews'), 1);
      await f.runtime.query('DELETE FROM auth_sessions WHERE user_id=$1', [f.user]);
      await assert.rejects(review(f.credentials, command), /session invalid/);
    } finally {
      await f.close();
    }
  },
);
test(
  'central receipt is durable and idempotent under concurrent retries, without attendance approval',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      const results = await Promise.all([f.receive(), f.receive()]);
      assert.equal(results[0]!.finalized, false);
      assert.equal(await f.count('central_biometric_receipts'), 1);
      assert.equal(await f.count('central_biometric_raw_evidence'), 1);
      assert.equal(await f.count('central_attendance_state'), 0);
      await assert.rejects(f.receive({ ...f.batch, sequence: 2 }), /Batch identity reused/);
      await assert.rejects(f.runtime.query('DELETE FROM central_biometric_receipts'));
    } finally {
      await f.close();
    }
  },
);
test(
  'central receipt rejects foreign organizations, unbound collectors and disabled entry points',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        f.receive({ ...f.batch, organizationId: f.foreignOrg }),
        /organization mismatch/,
      );
      await assert.rejects(f.receive({ ...f.batch, deviceId: randomUUID() }), /not bound/);
      await assert.rejects(
        createCentralBiometricEvidenceService(f.runtime, 'central').receive(
          f.credentials.nodeToken,
          f.batch,
        ),
        /disabled/,
      );
      await assert.rejects(
        createCentralBiometricEvidenceService(f.runtime, 'local', true).receive(
          f.credentials.nodeToken,
          f.batch,
        ),
        /disabled/,
      );
      await assert.rejects(
        f.runtime.query(
          'INSERT INTO central_biometric_sources SELECT * FROM central_biometric_sources',
        ),
      );
      assert.equal(await f.count('central_biometric_receipts'), 0);
    } finally {
      await f.close();
    }
  },
);
test(
  'out of order central batches and delayed punches remain distinct durable evidence',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      await f.receive({ ...f.batch, sequence: 3 });
      await f.receive({ ...f.batch, batchId: randomUUID(), sequence: 1 });
      await f.receive({
        ...f.batch,
        batchId: randomUUID(),
        sequence: 2,
        records: [
          {
            ...f.batch.records[0]!,
            id: randomUUID(),
            externalRecordId: 'earlier',
            recordedAt: '2026-09-30T00:00:00Z',
          },
        ],
      });
      assert.equal(await f.count('central_biometric_receipts'), 3);
      assert.equal(await f.count('central_biometric_raw_evidence'), 2);
      await assert.rejects(
        f.receive({
          ...f.batch,
          batchId: randomUUID(),
          sequence: 4,
          records: [{ ...f.batch.records[0]!, recordType: 'out' }],
        }),
        /identity mismatch/,
      );
      assert.equal(await f.count('central_biometric_receipts'), 3);
    } finally {
      await f.close();
    }
  },
);
test(
  'injected central raw write failure rolls back receipt; same batch recovers after restart',
  acceptanceOptions,
  async () => {
    const f = await fixture();
    try {
      await f.migrator.query(
        "CREATE FUNCTION fail_raw_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$; CREATE TRIGGER fail_raw_receipt BEFORE INSERT ON central_biometric_raw_evidence FOR EACH ROW EXECUTE FUNCTION fail_raw_receipt()",
      );
      await assert.rejects(f.receive(), /injected receipt failure/);
      assert.equal(await f.count('central_biometric_receipts'), 0);
      assert.equal(await f.count('central_biometric_raw_evidence'), 0);
      await f.migrator.query('DROP TRIGGER fail_raw_receipt ON central_biometric_raw_evidence');
      await f.receive();
      assert.equal(await f.count('central_biometric_receipts'), 1);
    } finally {
      await f.close();
    }
  },
);
