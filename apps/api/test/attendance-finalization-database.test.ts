import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { acceptanceOptions } from './central-evidence-acceptance-fixture.js';
import { finalizationFixture } from './attendance-finalization-fixture.js';
import { createTimeRecordService } from '../src/timekeeping/services.js';
import { createSyncRouter } from '../src/sync/router.js';
import { createAttendanceFinalizationRouter } from '../src/timekeeping/attendance-finalization-router.js';
import { pushNextBiometricBatch } from '../src/sync/biometric-evidence.js';
import { captureSourceClosure, pushNextSourceClosure } from '../src/sync/source-closures.js';
import {
  pullNextTrustedAttendanceBatch,
  applyTrustedAttendanceBatch,
} from '../src/sync/trusted-attendance.js';
import { createCentralAttendanceFinalizationService } from '../src/timekeeping/central-attendance-finalization.js';
import pg from 'pg';
import { pullTrustedAttendance } from '../src/sync/trusted-attendance.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { pushEvents } from '../src/sync/service.js';
import { createCentralBiometricEvidenceService } from '../src/timekeeping/central-biometric-evidence.js';
import { digest } from '../src/timekeeping/source-period-protocol.js';

test(
  'an invalid closure remains audited and pending without blocking independent valid closure delivery',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    const db = await f.local(true);
    const app = express();
    app.use(express.json());
    app.use('/api', createAttendanceFinalizationRouter(f.runtime, 'central', true, f.writer));
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback address');
      db.config.url = `http://127.0.0.1:${address.port}`;
      const invalid = f.signed();
      invalid.signature = (invalid.signature[0] === 'A' ? 'B' : 'A') + invalid.signature.slice(1);
      await captureSourceClosure(db.runtime, db.actor, invalid, true);
      await captureSourceClosure(db.runtime, db.actor, f.signed(), true);
      await assert.rejects(pushNextSourceClosure(db.runtime, db.config));
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM biometric_closure_deliveries')).rows[0]
          .n,
        0,
      );
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM biometric_closure_attempts')).rows[0]
          .n,
        1,
      );
      assert.equal(await pushNextSourceClosure(db.runtime, db.config), true);
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM biometric_source_closures')).rows[0].n,
        2,
      );
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM biometric_closure_deliveries')).rows[0]
          .n,
        1,
      );
      assert.equal(await f.count('central_source_closures'), 1);
      assert.equal(await f.count('central_attendance_state'), 0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await db.close();
      await f.close();
    }
  },
);

test(
  'a full page of deferred identities cannot starve newly received independent attendance',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    const db = await f.local();
    try {
      await f.migrator.query(
        "SELECT setval(pg_get_serial_sequence('central_attendance_events','sequence'),100)",
      );
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      await f.finalize(await f.proposeAttendance(cert.id));
      const page = await pullTrustedAttendance(f.runtime, db.config.token, '0');
      const insert = async (e: (typeof page.changes)[number]) =>
        db.runtime.query(
          'INSERT INTO trusted_attendance_inbox(sequence,event_id,organization_id,canonical_id,canonical_revision,envelope) VALUES($1,$2,$3,$4,$5,$6)',
          [
            e.sequence,
            e.eventId,
            e.organizationId,
            e.canonicalId,
            e.canonicalRevision,
            JSON.stringify(e),
          ],
        );
      // A dependency-only fixture models previously received unresolved identities.
      // These snapshots must remain unapplied; the real publications stay unchanged.
      for (let i = 1; i <= 30; i++) {
        const canonicalId = randomUUID(),
          employee = randomUUID();
        const snapshot = {
          ...page.changes[0]!.snapshot,
          canonical_attendance_id: canonicalId,
          employee_id: employee,
        };
        await insert({
          ...page.changes[0]!,
          sequence: String(i),
          eventId: randomUUID(),
          canonicalId,
          snapshot,
          snapshotFingerprint: digest(snapshot),
        });
        await db.runtime.query(
          "INSERT INTO trusted_attendance_application_state(sequence,status,code,next_attempt_at) VALUES($1,'pending','MISSING_EMPLOYEE',clock_timestamp()-interval '1 second')",
          [i],
        );
      }
      for (const e of page.changes) await insert(e);
      assert.equal((await applyTrustedAttendanceBatch(db.runtime, db.config)).applied, 2);
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM trusted_attendance_state')).rows[0].n,
        1,
      );
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM trusted_attendance_application_state'))
          .rows[0].n,
        30,
      );
      assert.equal(
        (await db.runtime.query('SELECT canonical_revision FROM trusted_attendance_state')).rows[0]
          .canonical_revision,
        2,
      );
    } finally {
      await db.close();
      await f.close();
    }
  },
);

test(
  'every expected source must certify before cross-device in/out evidence can be finalized',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      const second = randomUUID(),
        epoch = randomUUID();
      await f.runtime.query(
        "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'SECOND_CERT','Second source')",
        [second, f.org],
      );
      await f.runtime.query(
        "INSERT INTO biometric_mappings(organization_id,employee_id,device_id,device_employee_id) VALUES($1,$2,$3,'002')",
        [f.org, f.employee, second],
      );
      await f.migrator.query('INSERT INTO central_biometric_sources VALUES($1,$2,$3)', [
        f.org,
        second,
        f.node,
      ]);
      await f.migrator.query(
        'INSERT INTO central_source_capabilities SELECT organization_id,$1::uuid,1,contract,$2::uuid,public_key,assessment FROM central_source_capabilities WHERE device_id=$3',
        [second, epoch, f.device],
      );
      await f.migrator.query(
        "INSERT INTO central_attendance_coverage VALUES($1,$2,'2026-01-01',2,$3)",
        [
          f.org,
          f.employee,
          JSON.stringify([
            { deviceId: f.device, deviceEmployeeId: '001' },
            { deviceId: second, deviceEmployeeId: '002' },
          ]),
        ],
      );
      await f.deliver([f.records[0]!]);
      await f.closeSource({ inventory: [f.entries[0]!], lastSequence: '1' });
      const out = {
        ...f.entries[1]!,
        deviceEmployeeId: '002',
        externalRecordId: 'second-log1',
        sourceIdentity: { epoch, sequence: '1', entryId: 'second-native-1' },
      };
      await createCentralBiometricEvidenceService(f.runtime, 'central', true).receive(
        f.credentials.nodeToken,
        {
          version: 1,
          batchId: randomUUID(),
          organizationId: f.org,
          deviceId: second,
          sequence: 1,
          records: [{ id: randomUUID(), ...out }],
        },
      );
      const pending = await f.certify();
      assert.equal(pending.status, 'unresolved');
      assert.ok(pending.snapshot.blockers.includes('SOURCE_CLOSURE_MISSING:' + second));
      await f.closureReceiver(
        f.credentials.nodeToken,
        f.signed({ deviceId: second, epoch, inventory: [out], lastSequence: '1' }),
      );
      const cert = await f.certify(1);
      assert.equal(cert.status, 'verified', JSON.stringify(cert.snapshot.blockers));
      assert.equal(cert.snapshot.sourceProofs.length, 2);
      assert.equal(cert.snapshot.result.workedMinutes, 420);
      assert.equal((await f.finalize(await f.proposeAttendance(cert.id))).category, 'accepted');
    } finally {
      await f.close();
    }
  },
);

test(
  'proposal source snapshots are revalidated in full even when minute totals and certificate hash match',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const original = await f.proposeAttendance(cert.id),
        forged = await f.uuid7();
      await f.writer.query(
        `INSERT INTO central_attendance_requests(proposal_id,organization_id,employee_id,work_date,action,author_user_id,first_submitter_user_id,first_source_node_id,expected_canonical_revision,proposed_payload,evidence_fingerprint)
      SELECT $1::uuid,organization_id,employee_id,work_date,action,author_user_id,first_submitter_user_id,first_source_node_id,expected_canonical_revision,
      jsonb_set(jsonb_set(proposed_payload,'{command,proposalId}',to_jsonb($1::uuid::text)),'{result,sourceSnapshot}','{"forged":true}'::jsonb),evidence_fingerprint
      FROM central_attendance_requests WHERE proposal_id=$2`,
        [forged, original],
      );
      const denied = await f.finalize(forged);
      assert.equal(denied.category, 'conflict');
      assert.equal(denied.reason.code, 'CALCULATION_MISMATCH');
      assert.equal(await f.count('central_attendance_state'), 0);
      assert.equal((await f.finalize(original)).category, 'accepted');
    } finally {
      await f.close();
    }
  },
);

test(
  'runtime closure storage cannot rebind signed manifest identities or use a false proof fingerprint',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      const closure = f.signed();
      await assert.rejects(
        f.runtime.query(
          `INSERT INTO central_source_closures(closure_id,organization_id,device_id,capability_revision,node_id,manifest,signature,fingerprint) VALUES($1,$2,$3,1,$4,$5,$6,$7)`,
          [
            randomUUID(),
            f.org,
            f.device,
            f.node,
            JSON.stringify(closure.manifest),
            closure.signature,
            'f'.repeat(64),
          ],
        ),
        /identity binding mismatch/,
      );
      await f.runtime.query(
        `INSERT INTO central_source_closures(closure_id,organization_id,device_id,capability_revision,node_id,manifest,signature,fingerprint) VALUES($1,$2,$3,1,$4,$5,$6,$7)`,
        [
          closure.manifest.closureId,
          f.org,
          f.device,
          f.node,
          JSON.stringify(closure.manifest),
          closure.signature,
          'f'.repeat(64),
        ],
      );
      const cert = await f.certify();
      assert.equal(cert.status, 'unresolved');
      assert.ok(cert.snapshot.blockers.includes('SOURCE_CLOSURE_BINDING_CONFLICT:' + f.device));
      await assert.rejects(f.proposeAttendance(cert.id));
    } finally {
      await f.close();
    }
  },
);

test(
  'session expiry during a source lock wait rolls back finalization and the original request can retry',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    const holder = await f.migrator.connect();
    const requester = await f.writer.connect();
    const pinned = new Proxy(requester, {
      get(target, property) {
        if (property === 'release') return () => {};
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const pinnedService = createCentralAttendanceFinalizationService(
      { connect: async () => pinned } as unknown as pg.Pool,
      'central',
      true,
    );
    let active: Promise<unknown> | undefined;
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const proposal = await f.proposeAttendance(cert.id),
        requestId = await f.uuid7();
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(736614)');
      const requesterPid = (await requester.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const holderPid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await f.runtime.query(
        "UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE user_id=$1",
        [f.user],
      );
      active = pinnedService.finalize(f.credentials, {
        proposalId: proposal,
        requestId,
        reason: 'Central attendance review complete',
      });
      // Attach rejection handling immediately while the transaction waits.
      const denied = assert.rejects(active, /session invalid/);
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = Boolean(
          (
            await f.runtime.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) waiting', [
              requesterPid,
              holderPid,
            ])
          ).rows[0].waiting,
        );
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      await holder.query('COMMIT');
      await denied;
      assert.equal(await f.count('central_attendance_state'), 0);
      assert.equal(await f.count('central_attendance_events'), 0);
      assert.equal(await f.count('central_attendance_decisions'), 0);
      await f.runtime.query(
        "UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE user_id=$1",
        [f.user],
      );
      assert.equal((await f.finalize(proposal, requestId)).category, 'accepted');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (active) await active.catch(() => {});
      requester.release();
      await f.close();
    }
  },
);

test(
  'certification retries are exact, immutable and CAS-bound under concurrency',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const cmd = { requestId: randomUUID(), ...f.identity, expectedRevision: 0 };
      const results = await Promise.all([
        f.service.certify(f.credentials, cmd),
        f.service.certify(f.credentials, cmd),
      ]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(await f.count('central_attendance_certifications'), 1);
      await assert.rejects(
        f.service.certify(f.credentials, { ...cmd, expectedRevision: 1 }),
        /identity reused/,
      );
      await assert.rejects(f.certify(0), /revision changed/);
      await assert.rejects(f.runtime.query('DELETE FROM central_attendance_certifications'));
    } finally {
      await f.close();
    }
  },
);

test(
  'native source ordering is independent of batch ordering and identity collisions cannot be rewritten',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver([f.records[1]!]);
      await f.closeSource();
      await f.deliver([f.records[0]!]);
      await f.deliver([f.records[1]!]);
      assert.equal((await f.certify()).status, 'verified');
      assert.equal(await f.count('central_biometric_raw_evidence'), 2);
      await assert.rejects(
        f.deliver([
          {
            ...f.records[1]!,
            sourceIdentity: { ...f.records[1]!.sourceIdentity, entryId: 'forged' },
          },
        ]),
        /identity mismatch/,
      );
      assert.equal(await f.count('central_biometric_raw_evidence'), 2);
    } finally {
      await f.close();
    }
  },
);

test(
  'conflicting signed closures remain unresolved and cannot authorize attendance',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      await f.closeSource({
        issuedAt: '2026-03-03T00:01:00Z',
        inventory: [],
        firstSequence: '1',
        lastSequence: '0',
      });
      const cert = await f.certify();
      assert.equal(cert.status, 'unresolved');
      assert.ok(cert.snapshot.blockers.includes('SOURCE_CLOSURE_CONFLICT:' + f.device));
      await assert.rejects(f.proposeAttendance(cert.id));
    } finally {
      await f.close();
    }
  },
);

test(
  'capability revision changes stale proposals and require a new closure under the assessed contract',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const proposal = await f.proposeAttendance(cert.id);
      await f.migrator.query(
        'INSERT INTO central_source_capabilities SELECT organization_id,device_id,2,contract,epoch,public_key,assessment FROM central_source_capabilities WHERE device_id=$1',
        [f.device],
      );
      const stale = await f.finalize(proposal);
      assert.equal(stale.category, 'conflict');
      assert.equal(stale.reason.code, 'STALE_EVIDENCE');
      const pending = await f.certify(1);
      assert.ok(pending.snapshot.blockers.includes('SOURCE_CLOSURE_MISSING:' + f.device));
      await f.closeSource({ capabilityRevision: 2 });
      assert.equal((await f.certify(2)).status, 'verified');
    } finally {
      await f.close();
    }
  },
);

test(
  'generic v1 cannot forge source certification, exception authority or finalized attendance publications',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      for (const entityType of [
        'central_source_capabilities',
        'central_attendance_coverage',
        'central_attendance_exception_policies',
        'central_attendance_certifications',
        'central_attendance_exception_resolutions',
        'central_attendance_events',
        'trusted_attendance_state',
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
      assert.equal(await f.count('central_attendance_state'), 0);
      assert.equal(await f.count('central_attendance_certifications'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'malformed trusted pages and injected inbox failures never advance the attendance checkpoint',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    const db = await f.local();
    let tamper = true;
    const app = express();
    app.get('/api/sync/attendance/pull', async (req, res, next) => {
      try {
        const page = await pullTrustedAttendance(
          f.runtime,
          db.config.token,
          String(req.query.after ?? '0'),
        );
        res.json(
          tamper
            ? {
                ...page,
                changes: page.changes.map((e) => ({
                  ...e,
                  snapshot: { ...e.snapshot, worked_minutes: 999 },
                })),
              }
            : page,
        );
      } catch (e) {
        next(e);
      }
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('Missing loopback address');
      db.config.url = `http://127.0.0.1:${addr.port}`;
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      await f.finalize(await f.proposeAttendance(cert.id));
      await assert.rejects(pullNextTrustedAttendanceBatch(db.runtime, db.config));
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM trusted_attendance_checkpoints'))
          .rows[0].n,
        0,
      );
      tamper = false;
      await db.migrator.query(
        "CREATE FUNCTION fail_attendance_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected attendance inbox failure'; END $$; CREATE TRIGGER fail_attendance_inbox BEFORE INSERT ON trusted_attendance_inbox FOR EACH ROW EXECUTE FUNCTION fail_attendance_inbox()",
      );
      await assert.rejects(
        pullNextTrustedAttendanceBatch(db.runtime, db.config),
        /injected attendance inbox failure/,
      );
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM trusted_attendance_checkpoints'))
          .rows[0].n,
        0,
      );
      await db.migrator.query('DROP TRIGGER fail_attendance_inbox ON trusted_attendance_inbox');
      assert.equal(await pullNextTrustedAttendanceBatch(db.runtime, db.config), 2);
      assert.equal((await applyTrustedAttendanceBatch(db.runtime, db.config)).applied, 2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await db.close();
      await f.close();
    }
  },
);

test(
  'accepted schedule revision changes make proposed source snapshots stale',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const proposal = await f.proposeAttendance(cert.id);
      await f.changeAccepted('schedule.update', f.scheduleId, 1, f.schedulePayload('2026-02-01'));
      const outcome = await f.finalize(proposal);
      assert.equal(outcome.category, 'conflict');
      assert.equal(outcome.reason.code, 'STALE_EVIDENCE');
      assert.equal(await f.count('central_attendance_state'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'signed closure scope, signature, epoch and capability revision must all verify',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      const forged = f.signed();
      forged.signature = (forged.signature[0] === 'A' ? 'B' : 'A') + forged.signature.slice(1);
      await assert.rejects(f.closureReceiver(f.credentials.nodeToken, forged), /signature invalid/);
      await assert.rejects(
        f.closeSource({
          epoch: randomUUID(),
          inventory: [],
          firstSequence: '1',
          lastSequence: '0',
        }),
        /does not verify/,
      );
      await f.closeSource({ start: '2026-03-02T14:00:00Z', end: '2026-03-02T22:00:00Z' });
      const cert = await f.certify();
      assert.equal(cert.status, 'unresolved');
      assert.ok(
        cert.snapshot.blockers.some((s: string) => s.startsWith('SOURCE_CLOSURE_MISSING:')),
      );
      await assert.rejects(
        f.runtime.query(
          'INSERT INTO central_source_capabilities SELECT * FROM central_source_capabilities',
        ),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'absent required device cannot be hidden by punches from another device',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const absent = randomUUID();
      await f.runtime.query(
        "INSERT INTO biometric_devices(id,organization_id,code,name) VALUES($1,$2,'ABSENT','Absent source')",
        [absent, f.org],
      );
      await f.runtime.query(
        "INSERT INTO biometric_mappings(organization_id,employee_id,device_id,device_employee_id) VALUES($1,$2,$3,'other')",
        [f.org, f.employee, absent],
      );
      await f.migrator.query(
        "INSERT INTO central_attendance_coverage(organization_id,employee_id,effective_from,revision,sources) VALUES($1,$2,'2026-01-01',2,$3)",
        [
          f.org,
          f.employee,
          JSON.stringify([
            { deviceId: f.device, deviceEmployeeId: '001' },
            { deviceId: absent, deviceEmployeeId: 'other' },
          ]),
        ],
      );
      const cert = await f.certify();
      assert.equal(cert.status, 'unresolved');
      assert.ok(cert.snapshot.blockers.includes('SOURCE_CAPABILITY_MISSING:' + absent));
      await assert.rejects(f.proposeAttendance(cert.id), /cannot be finalized/);
    } finally {
      await f.close();
    }
  },
);

test(
  'overnight shift, threshold grace, break and undertime use accepted local timezone rules',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      const entries = f.entries.map((r, i) => ({
        ...r,
        recordedAt: i === 0 ? '2026-03-02T14:11:00.000000Z' : '2026-03-02T21:30:00.000000Z',
      }));
      await f.deliver(entries.map((r, i) => ({ ...r, id: f.records[i]!.id })));
      await f.closeSource({ inventory: entries });
      const cert = await f.certify();
      assert.equal(cert.status, 'verified', JSON.stringify(cert.snapshot.blockers));
      assert.equal(cert.snapshot.result.workedMinutes, 379);
      assert.equal(cert.snapshot.result.lateMinutes, 11);
      assert.equal(cert.snapshot.result.undertimeMinutes, 30);
      assert.equal(cert.snapshot.accepted.version.timezone, 'Asia/Manila');
      assert.equal(cert.snapshot.accepted.day.endDayOffset, 1);
      assert.equal(cert.snapshot.window.end, '2026-03-03T00:00:00.000Z');
    } finally {
      await f.close();
    }
  },
);

test(
  'accepted full leave binds immutable leave revisions and an empty signed inventory',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture({ leave: true });
    try {
      await f.closeSource({ inventory: [], lastSequence: '0' });
      const cert = await f.certify();
      assert.equal(cert.status, 'verified', JSON.stringify(cert.snapshot.blockers));
      assert.equal(cert.snapshot.result.attendanceStatus, 'on_leave');
      assert.equal(cert.snapshot.result.workedMinutes, 0);
      const proposal = await f.proposeAttendance(cert.id);
      const leave = cert.snapshot.accepted.leaves[0];
      await f.changeAccepted('leave.cancel', leave.id, leave.revision, {
        remarks: 'Cancelled leave after review',
      });
      const result = await f.finalize(proposal);
      assert.equal(result.category, 'conflict');
      assert.equal(result.reason.code, 'STALE_EVIDENCE');
    } finally {
      await f.close();
    }
  },
);

test(
  'default-denied unsupported source can be held durably without certifying absent evidence',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture({ unsupported: true });
    try {
      await f.deliver();
      const cert = await f.certify();
      const reviewer = await f.addReviewer();
      const command = {
        requestId: randomUUID(),
        certificationId: cert.id,
        expectedFingerprint: cert.fingerprint,
        policyRevision: 1,
        decision: 'authorize_limited',
        reason: 'Manual review',
        artifacts: [],
      };
      await assert.rejects(
        f.service.resolveException(reviewer.credentials, command),
        /cannot waive/,
      );
      const held = await f.service.resolveException(reviewer.credentials, {
        ...command,
        decision: 'hold',
      });
      assert.equal(held.decision, 'hold');
      assert.ok(held.limitations.length);
      await assert.rejects(f.proposeAttendance(cert.id, 0, held.id), /separately authorized/);
      await assert.rejects(f.runtime.query('DELETE FROM central_attendance_exception_resolutions'));
      assert.equal(await f.count('central_attendance_state'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'competing canonical proposals use CAS; approval must be reopened before a replacement',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const a = await f.proposeAttendance(cert.id),
        b = await f.proposeAttendance(cert.id);
      const results = await Promise.all([f.finalize(a), f.finalize(b)]);
      assert.equal(results.filter((r) => r.category === 'accepted').length, 1);
      assert.equal(results.filter((r) => r.category === 'conflict').length, 1);
      const direct = await f.proposeAttendance(cert.id, 2);
      assert.equal((await f.finalize(direct)).reason.code, 'REOPEN_REQUIRED');
      const requestId = await f.uuid7();
      const command = {
        requestId,
        ...f.identity,
        expectedCanonicalRevision: 2,
        reason: 'Reviewed recalculation',
      };
      const reopened = await f.service.reopen(f.credentials, command);
      assert.equal(reopened.canonical_revision, 3);
      assert.equal(reopened.approval_status, 'unreviewed');
      assert.deepEqual(await f.service.reopen(f.credentials, command), reopened);
      const replacement = await f.proposeAttendance(cert.id, 3);
      assert.equal((await f.finalize(replacement)).category, 'accepted');
      assert.equal(
        (await f.runtime.query('SELECT canonical_revision FROM central_attendance_state')).rows[0]
          .canonical_revision,
        5,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'local application failure rolls back projection and receipts; a fresh pool resumes and historical pulls never regress',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    const db = await f.local();
    let fresh: pg.Pool | undefined;
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      await f.finalize(await f.proposeAttendance(cert.id));
      const page = await pullTrustedAttendance(f.runtime, db.config.token, '0');
      for (const event of page.changes)
        await db.runtime.query(
          'INSERT INTO trusted_attendance_inbox(sequence,event_id,organization_id,canonical_id,canonical_revision,envelope) VALUES($1,$2,$3,$4,$5,$6)',
          [
            event.sequence,
            event.eventId,
            event.organizationId,
            event.canonicalId,
            event.canonicalRevision,
            JSON.stringify(event),
          ],
        );
      await db.migrator.query(
        "CREATE FUNCTION fail_local_attendance_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected local attendance receipt failure'; END $$; CREATE TRIGGER fail_local_attendance_receipt BEFORE INSERT ON trusted_attendance_applications FOR EACH ROW EXECUTE FUNCTION fail_local_attendance_receipt()",
      );
      await assert.rejects(
        applyTrustedAttendanceBatch(db.runtime, db.config),
        /injected local attendance receipt/,
      );
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM trusted_attendance_state')).rows[0].n,
        0,
      );
      await db.migrator.query(
        'DROP TRIGGER fail_local_attendance_receipt ON trusted_attendance_applications',
      );
      const schema = (await db.runtime.query('SELECT current_schema() name')).rows[0].name;
      fresh = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      assert.equal((await applyTrustedAttendanceBatch(fresh, db.config)).applied, 2);
      assert.equal((await applyTrustedAttendanceBatch(fresh, db.config)).applied, 0);
      assert.equal(
        (await db.runtime.query('SELECT canonical_revision FROM trusted_attendance_state')).rows[0]
          .canonical_revision,
        2,
      );
      assert.equal(
        (await db.runtime.query('SELECT count(*)::int n FROM trusted_attendance_applications'))
          .rows[0].n,
        2,
      );
    } finally {
      if (fresh) await fresh.end();
      await db.close();
      await f.close();
    }
  },
);

test(
  'missing local actor defers received authority and resumes without v1 account synchronization',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    const db = await f.local();
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      await f.finalize(await f.proposeAttendance(cert.id));
      const page = await pullTrustedAttendance(f.runtime, db.config.token, '0');
      for (const e of page.changes)
        await db.runtime.query(
          'INSERT INTO trusted_attendance_inbox(sequence,event_id,organization_id,canonical_id,canonical_revision,envelope) VALUES($1,$2,$3,$4,$5,$6)',
          [
            e.sequence,
            e.eventId,
            e.organizationId,
            e.canonicalId,
            e.canonicalRevision,
            JSON.stringify(e),
          ],
        );
      await db.runtime.query('DELETE FROM auth_users WHERE id=$1', [f.user]);
      const pending = await applyTrustedAttendanceBatch(db.runtime, db.config);
      assert.ok(pending.pending > 0);
      assert.equal(pending.applied, 0);
      await db.runtime.query(
        "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash) VALUES($1,$2,'collector','Collector',$3)",
        [f.user, f.org, DUMMY_PASSWORD_HASH],
      );
      await db.runtime.query(
        "UPDATE trusted_attendance_application_state SET next_attempt_at=clock_timestamp()-interval '1 second'",
      );
      assert.equal((await applyTrustedAttendanceBatch(db.runtime, db.config)).applied, 2);
    } finally {
      await db.close();
      await f.close();
    }
  },
);

test(
  'offline capture -> signed closure -> proposal -> central finalization -> two isolated PCs converge without echo',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    const office = await f.local(true),
      wfh = await f.local();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', createSyncRouter(f.runtime, true, undefined, true));
    app.use('/api', createAttendanceFinalizationRouter(f.runtime, 'central', true, f.writer));
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback address');
      office.config.url = wfh.config.url = `http://127.0.0.1:${address.port}`;
      const post = async (path: string, body: unknown) => {
        const response = await fetch(office.config.url + '/api/sync/attendance/' + path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + f.credentials.nodeToken,
            'X-Central-Session': f.credentials.sessionToken,
          },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        assert.equal(response.status, 200, JSON.stringify(data));
        return data;
      };
      await createTimeRecordService(office.runtime, { rawCaptureEnabled: true }).ingest(
        office.actor,
        { deviceId: f.device, records: f.entries },
      );
      await captureSourceClosure(office.runtime, office.actor, f.signed(), true);
      assert.equal(await f.count('central_biometric_raw_evidence'), 0);
      await pushNextBiometricBatch(office.runtime, office.config);
      await pushNextSourceClosure(office.runtime, office.config);
      const cert = await post('certify', {
        requestId: randomUUID(),
        ...f.identity,
        expectedRevision: 0,
      });
      assert.equal(cert.status, 'verified', JSON.stringify(cert.snapshot.blockers));
      assert.equal(cert.snapshot.result.workedMinutes, 420);
      const proposalId = await f.uuid7(),
        requestId = await f.uuid7();
      await post('proposals', {
        proposalId,
        certificationId: cert.id,
        exceptionResolutionId: null,
        expectedCanonicalRevision: 0,
      });
      assert.equal(await f.count('central_attendance_state'), 0);
      const finalCommand = { requestId, proposalId, reason: 'Central attendance review complete' };
      const result = await post('finalize', finalCommand);
      assert.equal(result.category, 'accepted');
      assert.deepEqual(await post('finalize', finalCommand), result);
      assert.equal(await f.count('central_attendance_acceptance_history'), 2);
      assert.equal(await f.count('central_attendance_events'), 2);
      const before = Number(
        (await office.runtime.query('SELECT count(*) n FROM sync_outbox')).rows[0].n,
      );
      for (const db of [office, wfh]) {
        assert.equal(await pullNextTrustedAttendanceBatch(db.runtime, db.config), 2);
        assert.equal((await applyTrustedAttendanceBatch(db.runtime, db.config)).applied, 2);
        assert.equal((await applyTrustedAttendanceBatch(db.runtime, db.config)).applied, 0);
        assert.equal(await pullNextTrustedAttendanceBatch(db.runtime, db.config), 0);
      }
      const a = (await office.runtime.query('SELECT snapshot FROM trusted_attendance_state'))
        .rows[0].snapshot;
      const b = (await wfh.runtime.query('SELECT snapshot FROM trusted_attendance_state')).rows[0]
        .snapshot;
      assert.deepEqual(a, b);
      assert.equal(a.canonical_revision, 2);
      assert.equal(a.approval_status, 'approved');
      assert.equal(a.result.evidenceStatus, 'verified_complete');
      assert.equal(
        Number((await office.runtime.query('SELECT count(*) n FROM sync_outbox')).rows[0].n),
        before,
      );
      assert.equal(
        Number((await wfh.runtime.query('SELECT count(*) n FROM sync_outbox')).rows[0].n),
        0,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await office.close();
      await wfh.close();
      await f.close();
    }
  },
);

test(
  'missing trailing native log entry remains unresolved despite contiguous transport and recovers after delay',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver([f.records[0]!]);
      await f.closeSource();
      const missing = await f.certify();
      assert.equal(missing.status, 'unresolved');
      assert.ok(
        missing.snapshot.blockers.some((s: string) => s.startsWith('MISSING_SOURCE_ENTRIES:')),
      );
      assert.deepEqual(missing.snapshot.sourceProofs[0].proof.missingRanges, [
        { first: '2', last: '2' },
      ]);
      await assert.rejects(f.proposeAttendance(missing.id), /cannot be finalized/);
      await f.deliver([f.records[1]!]);
      const complete = await f.certify(1);
      assert.equal(complete.status, 'verified', JSON.stringify(complete.snapshot.blockers));
      assert.equal(missing.status, 'unresolved');
    } finally {
      await f.close();
    }
  },
);

test(
  'raw punches and timestamp checkpoints without signed closure never certify a period',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      const cert = await f.certify();
      assert.equal(cert.status, 'unresolved');
      assert.ok(
        cert.snapshot.blockers.some((s: string) => s.startsWith('SOURCE_CLOSURE_MISSING:')),
      );
      await assert.rejects(f.proposeAttendance(cert.id));
    } finally {
      await f.close();
    }
  },
);

test(
  'unsupported device exceptions require policy, independent reviewer and supporting artifact commitments',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture({ unsupported: true, allowLimited: true });
    try {
      await f.deliver();
      const cert = await f.certify();
      assert.equal(cert.status, 'unresolved');
      const reviewer = await f.addReviewer();
      const request = {
        requestId: randomUUID(),
        certificationId: cert.id,
        expectedFingerprint: cert.fingerprint,
        policyRevision: 1,
        decision: 'authorize_limited',
        reason: 'Reviewed device limitation',
        artifacts: [
          { sha256: 'a'.repeat(64), reference: 'test device export', kind: 'device_export' },
          {
            sha256: 'b'.repeat(64),
            reference: 'independent signed attestation',
            kind: 'independent_attestation',
          },
        ],
      };
      await assert.rejects(
        f.service.resolveException(f.credentials, request),
        /different central reviewer/,
      );
      await assert.rejects(
        f.service.resolveException(reviewer.credentials, { ...request, artifacts: [] }),
        /commitments are required/,
      );
      const resolution = await f.service.resolveException(reviewer.credentials, request);
      const proposal = await f.proposeAttendance(cert.id, 0, resolution.id);
      const selfApproval = await f.service.finalize(reviewer.credentials, {
        requestId: await f.uuid7(),
        proposalId: proposal,
        reason: 'Reviewer attempts own exception approval',
      });
      assert.equal(selfApproval.category, 'conflict');
      assert.equal(selfApproval.reason.code, 'INDEPENDENT_APPROVAL_REQUIRED');
      const approved = await f.finalize(proposal);
      assert.equal(approved.category, 'accepted');
      const state = (await f.runtime.query('SELECT * FROM central_attendance_state')).rows[0];
      assert.equal(state.result.evidenceStatus, 'exception_authorized');
      assert.ok(state.result.limitations.some((s: string) => s.startsWith('SOURCE_UNSUPPORTED:')));
      assert.equal(cert.status, 'unresolved');
      assert.equal(await f.count('central_attendance_exception_resolutions'), 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'exception policy defaults deny; a reason cannot waive a supported source gap',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture({ allowLimited: true });
    try {
      await f.deliver([f.records[0]!]);
      await f.closeSource();
      const cert = await f.certify();
      const reviewer = await f.addReviewer();
      await assert.rejects(
        f.service.resolveException(reviewer.credentials, {
          requestId: randomUUID(),
          certificationId: cert.id,
          expectedFingerprint: cert.fingerprint,
          policyRevision: 1,
          decision: 'authorize_limited',
          reason: 'Please approve',
          artifacts: [],
        }),
        /cannot waive/,
      );
      assert.equal(await f.count('central_attendance_state'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'changed employee mapping invalidates a prepared attendance proposal without a canonical write',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const proposal = await f.proposeAttendance(cert.id);
      await f.runtime.query(
        "UPDATE biometric_mappings SET status='inactive',revision=revision+1 WHERE device_id=$1",
        [f.device],
      );
      const result = await f.finalize(proposal);
      assert.equal(result.category, 'conflict');
      assert.equal(result.reason.code, 'STALE_EVIDENCE');
      assert.equal(await f.count('central_attendance_state'), 0);
      assert.equal(await f.count('central_attendance_events'), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'new delayed evidence after closure invalidates proposals and exposes a source closure conflict',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const proposal = await f.proposeAttendance(cert.id);
      await f.deliver([
        {
          ...f.records[0]!,
          id: randomUUID(),
          recordedAt: '2026-03-02T15:00:00.000000Z',
          externalRecordId: 'late3',
          sourceIdentity: { epoch: f.epoch, sequence: '3', entryId: 'native-3' },
        },
      ]);
      const result = await f.finalize(proposal);
      assert.equal(result.category, 'conflict');
      assert.equal(result.reason.code, 'STALE_EVIDENCE');
      const later = await f.certify(1);
      assert.ok(
        later.snapshot.blockers.some((s: string) => s.startsWith('SOURCE_CLOSURE_CONFLICT:')),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'concurrent exact finalization retries produce one canonical history and deterministic receipts',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const proposal = await f.proposeAttendance(cert.id),
        id = await f.uuid7();
      const result = await Promise.all([f.finalize(proposal, id), f.finalize(proposal, id)]);
      assert.deepEqual(result[0], result[1]);
      assert.equal(await f.count('central_attendance_events'), 2);
      assert.equal(await f.count('central_attendance_state'), 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'publication failure rolls back both acceptance revisions and exact request retry recovers',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const proposal = await f.proposeAttendance(cert.id),
        id = await f.uuid7();
      await f.migrator.query(
        "CREATE FUNCTION fail_attendance_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected attendance publication failure'; END $$; CREATE TRIGGER fail_attendance_event BEFORE INSERT ON central_attendance_events FOR EACH ROW EXECUTE FUNCTION fail_attendance_event()",
      );
      await assert.rejects(f.finalize(proposal, id), /injected attendance publication failure/);
      assert.equal(await f.count('central_attendance_decisions'), 0);
      assert.equal(await f.count('central_attendance_acceptance_history'), 0);
      assert.equal(await f.count('central_attendance_state'), 0);
      await f.migrator.query('DROP TRIGGER fail_attendance_event ON central_attendance_events');
      assert.equal((await f.finalize(proposal, id)).category, 'accepted');
    } finally {
      await f.close();
    }
  },
);

test(
  'ordinary runtime, owner, local mode, revoked sessions and unauthorized users cannot finalize',
  acceptanceOptions,
  async () => {
    const f = await finalizationFixture();
    try {
      await f.deliver();
      await f.closeSource();
      const cert = await f.certify();
      const proposal = await f.proposeAttendance(cert.id),
        request = { requestId: await f.uuid7(), proposalId: proposal, reason: 'Review' };
      for (const pool of [f.runtime, f.migrator])
        await assert.rejects(
          createCentralAttendanceFinalizationService(pool, 'central', true).finalize(
            f.credentials,
            request,
          ),
          /restricted attendance writer/,
        );
      assert.throws(
        () =>
          createCentralAttendanceFinalizationService(f.writer, 'local', true).finalize(
            f.credentials,
            request,
          ),
        /disabled/,
      );
      await f.runtime.query(
        "DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='attendance.approve'",
        [f.role],
      );
      await assert.rejects(f.service.finalize(f.credentials, request), /permission required/);
      await f.runtime.query('DELETE FROM auth_sessions WHERE user_id=$1', [f.user]);
      await assert.rejects(f.service.finalize(f.credentials, request), /session invalid/);
      assert.equal(await f.count('central_attendance_state'), 0);
      await assert.rejects(
        f.runtime.query(
          'INSERT INTO central_attendance_certifications SELECT * FROM central_attendance_certifications',
        ),
      );
    } finally {
      await f.close();
    }
  },
);
