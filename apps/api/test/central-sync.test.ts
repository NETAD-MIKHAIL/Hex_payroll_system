import { publishSyntheticRules, finalizedPayrollFixture } from './central-payroll-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.js';
import type { Pool } from 'pg';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { registerNode, pushEvents, rotateNode } from '../src/sync/service.js';
import { importLocalNode } from '../src/sync/import-node.js';
import { tokenHash } from '../src/auth/service.js';
import { resolveConflict } from '../src/sync/conflicts.js';
import {
  createLeaveService,
  createScheduleService,
  createTimeRecordService,
} from '../src/timekeeping/services.js';
import { outbox, transaction, getActor } from '../src/foundation/repository.js';
import { pushNextBatch, pullNextBatch, startSyncWorker } from '../src/sync/client.js';
import { applyRemotePage } from '../src/sync/remote.js';
import { writableDomains } from '../src/sync/receiver.js';
import {
  centralPushResponseSchema,
  centralPullResponseSchema,
  permissionCodes,
  type Actor,
  type CentralEvent,
} from '@hexpayroll/shared';

test(
  'central v2: actual HTTP and three isolated workstation stores',
  { skip: !databaseTestsEnabled },
  async (t) => {
    const stores = [];
    const originalRuntime = process.env.TEST_DATABASE_URL,
      originalMigration = process.env.TEST_MIGRATION_DATABASE_URL;
    try {
      for (const name of ['CENTRAL', 'A', 'B']) {
        process.env.TEST_DATABASE_URL =
          process.env['SYNC_TEST_' + name + '_RUNTIME'] ?? originalRuntime;
        process.env.TEST_MIGRATION_DATABASE_URL =
          process.env['SYNC_TEST_' + name + '_MIGRATION'] ?? originalMigration;
        stores.push(await databaseFixture());
      }
    } catch (error) {
      for (const store of stores.reverse()) await store.close();
      throw error;
    } finally {
      process.env.TEST_DATABASE_URL = originalRuntime;
      process.env.TEST_MIGRATION_DATABASE_URL = originalMigration;
    }
    const [central, a, b] = stores;
    assert.ok(central && a && b);
    let stop: (() => Promise<void>) | undefined;
    try {
      for (const db of stores) await migrate(db.migrator, db.migrations);
      const org = randomUUID(),
        otherOrg = randomUUID();
      for (const db of stores) {
        await db.runtime.query(
          "INSERT INTO organizations(id,legal_name) VALUES($1,'Central test')",
          [org],
        );
        await db.runtime.query('UPDATE application_setup SET organization_id=$1 WHERE singleton', [
          org,
        ]);
      }
      await central.runtime.query(
        "INSERT INTO organizations(id,legal_name) VALUES($1,'Other organization')",
        [otherOrg],
      );
      const na = await registerNode(central.runtime, org, 'A'),
        nb = await registerNode(central.runtime, org, 'B'),
        other = await registerNode(central.runtime, otherOrg, 'Other');
      for (const [db, node] of [
        [a, na],
        [b, nb],
      ] as const) {
        await db.runtime.query(
          'INSERT INTO sync_nodes(id,organization_id,device_name,token_hash,allowed_domains) VALUES($1,$2,$3,$4,$5)',
          [node.nodeId, org, 'Test', tokenHash(node.token), writableDomains],
        );
      }
      const app = createApp({ database: central.runtime, mode: 'central' });
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      stop = () =>
        new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      const addr = server.address();
      assert.ok(addr && typeof addr !== 'string');
      const url = `http://127.0.0.1:${addr.port}`,
        ca = { url, nodeId: na.nodeId, token: na.token },
        cb = { url, nodeId: nb.nodeId, token: nb.token };
      const actors: Actor[] = [];
      for (const [index, db] of stores.entries()) {
        const id = (
          await db.runtime.query(
            "INSERT INTO auth_users(organization_id,username,display_name,password_hash) VALUES($1,$2,'Administrator','test') RETURNING id",
            [org, 'admin' + index],
          )
        ).rows[0].id;
        await db.runtime.query(
          "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
          [id],
        );
        actors.push({
          id,
          organizationId: org,
          permissions: [...permissionCodes],
          roles: ['administrator'],
        });
      }
      const employeeId = randomUUID();
      const save = async (db: Pool, id: string, name: string, revision: number) =>
        transaction(db, async (c) => {
          const r =
            revision === 1
              ? await c.query(
                  "INSERT INTO employees(id,organization_id,employee_number,first_name,last_name) VALUES($1,$2,'EMP-01',$3,'Payroll') RETURNING *",
                  [id, org, name],
                )
              : await c.query(
                  'UPDATE employees SET first_name=$3,revision=revision+1 WHERE id=$1 AND organization_id=$2 RETURNING *',
                  [id, org, name],
                );
          const row = r.rows[0];
          await outbox(
            c,
            'employees',
            {
              id,
              organizationId: org,
              revision: row.revision,
              employeeNumber: row.employee_number,
              firstName: row.first_name,
              lastName: row.last_name,
            },
            revision === 1 ? 'CREATE' : 'UPDATE',
          );
        });
      await t.test(
        'A/B: local data entry, offline backlog, reconnect and propagation',
        async () => {
          await save(a.runtime, employeeId, 'Initial', 1);
          await assert.rejects(
            pushNextBatch(a.runtime, { ...ca, url: 'http://127.0.0.1:1' }, { timeoutMs: 100 }),
          );
          assert.equal(
            (await a.runtime.query('SELECT first_name FROM employees WHERE id=$1', [employeeId]))
              .rows[0].first_name,
            'Initial',
          );
          await a.runtime.query('UPDATE sync_outbox SET next_attempt_at=NULL');
          await pushNextBatch(a.runtime, ca);
          await pullNextBatch(a.runtime, ca);
          await pullNextBatch(b.runtime, cb);
          assert.deepEqual(
            (
              await b.runtime.query('SELECT id,first_name,revision FROM employees WHERE id=$1', [
                employeeId,
              ])
            ).rows[0],
            { id: employeeId, first_name: 'Initial', revision: 1 },
          );
          assert.equal(
            (await b.runtime.query('SELECT count(*)::int n FROM sync_outbox')).rows[0].n,
            0,
          );
        },
      );
      let original: CentralEvent;
      await t.test(
        'C/G: lost response retry, stable identity, durable receipt after restart',
        async () => {
          const row = (await a.runtime.query('SELECT * FROM sync_outbox LIMIT 1')).rows[0];
          original = {
            eventId: row.id,
            entityType: row.entity_type,
            entityId: row.entity_id,
            operation: row.operation,
            revision: row.revision,
            payloadVersion: 1,
            payload: row.payload,
            baseRevision: row.base_revision,
            originNodeId: row.origin_node_id,
            actorId: null,
          };
          const receipt = centralPushResponseSchema.parse(
            await pushEvents(central.runtime, na.token, { protocolVersion: 2, events: [original] }),
          );
          assert.equal(receipt.results[0]?.status, 'already_applied');
          assert.equal(
            (
              await central.runtime.query('SELECT count(*)::int n FROM employees WHERE id=$1', [
                employeeId,
              ])
            ).rows[0].n,
            1,
          );
          const reused = await pushEvents(central.runtime, na.token, {
            protocolVersion: 2,
            events: [{ ...original, payload: { ...original.payload, firstName: 'Tampered' } }],
          });
          assert.equal(reused.results[0]?.status, 'rejected');
        },
      );
      await t.test(
        'G: central process exits after commit; restarted transport replays without duplicate mutation',
        async () => {
          const id = randomUUID();
          await transaction(a.runtime, async (c) => {
            await c.query(
              "INSERT INTO departments(id,organization_id,code,name) VALUES($1,$2,'CRASH','Crash recovery')",
              [id, org],
            );
            await outbox(
              c,
              'departments',
              { id, organizationId: org, revision: 1, code: 'CRASH', name: 'Crash recovery' },
              'CREATE',
            );
          });
          const child = spawn(
            process.execPath,
            ['node_modules/tsx/dist/cli.mjs', 'test/central-crash-fixture.ts'],
            {
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: {
                ...process.env,
                CRASH_TEST_DATABASE_URL: central.runtime.options.connectionString,
                CRASH_TEST_DATABASE_OPTIONS: central.runtime.options.options,
              },
            },
          );
          child.stderr.resume();
          try {
            const port = await new Promise<number>((resolve, reject) => {
              let value = '';
              child.stdout.on('data', (b: Buffer) => {
                value += b.toString();
                if (value.includes('\n')) resolve(Number(value.trim()));
              });
              child.on('error', reject);
              child.on('exit', (code) => {
                if (!value) reject(new Error('Crash fixture startup failed: ' + code));
              });
            });
            await assert.rejects(
              pushNextBatch(a.runtime, { ...ca, url: 'http://127.0.0.1:' + port }),
            );
            assert.equal(
              (
                await central.runtime.query('SELECT count(*)::int n FROM departments WHERE id=$1', [
                  id,
                ])
              ).rows[0].n,
              1,
            );
            await a.runtime.query(
              'UPDATE sync_outbox SET next_attempt_at=NULL WHERE entity_id=$1',
              [id],
            );
            await pushNextBatch(a.runtime, ca);
            assert.equal(
              (
                await central.runtime.query('SELECT count(*)::int n FROM departments WHERE id=$1', [
                  id,
                ])
              ).rows[0].n,
              1,
            );
            assert.equal(
              (await a.runtime.query('SELECT status FROM sync_outbox WHERE entity_id=$1', [id]))
                .rows[0].status,
              'synced',
            );
          } finally {
            if (child.exitCode === null) child.kill();
          }
          while (await pullNextBatch(a.runtime, ca)) {
            /* drain committed changes */
          }
          while (await pullNextBatch(b.runtime, cb)) {
            /* drain committed changes */
          }
        },
      );
      await t.test('D: concurrent edits persist a conflict without overwrite', async () => {
        await save(a.runtime, employeeId, 'From A', 2);
        await save(b.runtime, employeeId, 'From B', 2);
        await pushNextBatch(a.runtime, ca);
        await pushNextBatch(b.runtime, cb);
        assert.equal(
          (
            await central.runtime.query('SELECT first_name FROM employees WHERE id=$1', [
              employeeId,
            ])
          ).rows[0].first_name,
          'From A',
        );
        assert.equal(
          (await b.runtime.query('SELECT status FROM sync_outbox WHERE entity_id=$1', [employeeId]))
            .rows[0].status,
          'conflicted',
        );
        assert.equal(
          (await b.runtime.query('SELECT count(*)::int n FROM sync_conflicts')).rows[0].n,
          1,
        );
      });
      await t.test(
        'offline proposal remains pending until central administrator confirms and propagates resolution',
        async () => {
          const conflict = (
            await b.runtime.query(
              'SELECT id,version FROM sync_conflicts WHERE local_event_id IS NOT NULL LIMIT 1',
            )
          ).rows[0];
          const request = {
            requestId: randomUUID(),
            resolution: 'accept_authoritative',
            reason: 'Keep accepted central edit',
            expectedVersion: conflict.version,
          };
          const local = await resolveConflict(
            b.runtime,
            await getActor(b.runtime, actors[2]!.id),
            conflict.id,
            request,
          );
          assert.equal(local.state, 'pending');
          await pushNextBatch(b.runtime, cb);
          assert.equal(
            (await central.runtime.query('SELECT count(*)::int n FROM sync_resolution_proposals'))
              .rows[0].n,
            1,
          );
          const centralConflict = (
            await central.runtime.query(
              'SELECT id,version FROM sync_conflicts WHERE entity_id=$1',
              [employeeId],
            )
          ).rows[0];
          await resolveConflict(
            central.runtime,
            actors[0]!,
            centralConflict.id,
            { ...request, expectedVersion: centralConflict.version },
            true,
          );
          while (await pullNextBatch(b.runtime, cb)) {
            /* drain bounded pages */
          }
          while (await pullNextBatch(a.runtime, ca)) {
            /* drain bounded pages */
          }
          assert.equal(
            (await b.runtime.query('SELECT first_name FROM employees WHERE id=$1', [employeeId]))
              .rows[0].first_name,
            'From A',
          );
          assert.equal(
            (
              await b.runtime.query('SELECT resolution_state FROM sync_conflicts WHERE id=$1', [
                conflict.id,
              ])
            ).rows[0].resolution_state,
            'confirmed',
          );
        },
      );
      await t.test(
        'a confirmed resolution preserves newer local edits and allows explicit central re-review',
        async () => {
          await save(a.runtime, employeeId, 'Next central edit', 3);
          await save(b.runtime, employeeId, 'Next local edit', 3);
          await pushNextBatch(a.runtime, ca);
          await pushNextBatch(b.runtime, cb);
          const old = (
            await b.runtime.query(
              "SELECT * FROM sync_conflicts WHERE entity_id=$1 AND status='open'",
              [employeeId],
            )
          ).rows[0];
          const request = {
            requestId: randomUUID(),
            resolution: 'accept_authoritative',
            reason: 'Use the central revision',
            expectedVersion: old.version,
          };
          await resolveConflict(
            b.runtime,
            await getActor(b.runtime, actors[2]!.id),
            old.id,
            request,
          );
          await pushNextBatch(b.runtime, cb);
          await save(b.runtime, employeeId, 'Later local work', 4);
          const authoritative = (
            await central.runtime.query('SELECT * FROM sync_conflicts WHERE source_event_id=$1', [
              old.source_event_id,
            ])
          ).rows[0];
          await resolveConflict(
            central.runtime,
            actors[0]!,
            authoritative.id,
            { ...request, expectedVersion: authoritative.version },
            true,
          );
          while (await pullNextBatch(b.runtime, cb)) {
            /* retain later local work durably */
          }
          assert.equal(
            (await b.runtime.query('SELECT first_name FROM employees WHERE id=$1', [employeeId]))
              .rows[0].first_name,
            'Later local work',
          );
          const next = (
            await b.runtime.query(
              "SELECT * FROM sync_conflicts WHERE entity_id=$1 AND status='open'",
              [employeeId],
            )
          ).rows[0];
          assert.ok(next);
          const review = {
            requestId: randomUUID(),
            resolution: 'accept_authoritative',
            reason: 'Explicitly reject the later local branch',
            expectedVersion: next.version,
          };
          await resolveConflict(
            b.runtime,
            await getActor(b.runtime, actors[2]!.id),
            next.id,
            review,
          );
          await pushNextBatch(b.runtime, cb);
          const centralReview = (
            await central.runtime.query('SELECT * FROM sync_conflicts WHERE source_event_id=$1', [
              next.source_event_id,
            ])
          ).rows[0];
          assert.ok(centralReview);
          await resolveConflict(
            central.runtime,
            actors[0]!,
            centralReview.id,
            { ...review, expectedVersion: centralReview.version },
            true,
          );
          while (await pullNextBatch(b.runtime, cb)) {
            /* apply the explicit rejection */
          }
          assert.equal(
            (await b.runtime.query('SELECT first_name FROM employees WHERE id=$1', [employeeId]))
              .rows[0].first_name,
            'Next central edit',
          );
        },
      );
      await t.test('E: incompatible offline leave decisions are protected', async () => {
        const la = createLeaveService(a.runtime),
          lb = createLeaveService(b.runtime);
        const type = await la.saveType(actors[1]!, {
          code: 'TEST',
          name: 'Test leave',
          description: null,
          paid: true,
          requiresApproval: true,
          status: 'active',
        });
        const leave = await la.request(actors[1]!, {
          employeeId,
          leaveTypeId: type.id,
          startDate: '2025-08-01',
          endDate: '2025-08-01',
          durationType: 'full_day',
          reason: 'Test leave',
        });
        while (await pushNextBatch(a.runtime, ca)) {
          /* drain bounded pages */
        }
        while (await pullNextBatch(b.runtime, cb)) {
          /* drain bounded pages */
        }
        await la.transition(actors[1]!, leave.id, 'approve', {
          expectedRevision: 1,
          remarks: 'Approved offline',
        });
        await lb.transition(actors[2]!, leave.id, 'reject', {
          expectedRevision: 1,
          remarks: 'Rejected offline',
        });
        while (await pushNextBatch(a.runtime, ca)) {
          /* drain bounded pages */
        }
        while (await pushNextBatch(b.runtime, cb)) {
          /* drain bounded pages */
        }
        assert.equal(
          (await central.runtime.query('SELECT status FROM leave_requests WHERE id=$1', [leave.id]))
            .rows[0].status,
          'approved',
        );
        assert.equal(
          (
            await b.runtime.query(
              "SELECT conflict_type FROM sync_conflicts WHERE entity_type='leave_requests' LIMIT 1",
            )
          ).rows[0].conflict_type,
          'LEAVE_CONFLICT',
        );
      });
      await t.test(
        'schedule aggregates and raw evidence preserve IDs without an outbound loop',
        async () => {
          const schedules = createScheduleService(a.runtime);
          const schedule = await schedules.save(actors[1]!, {
            code: 'SYNC-SCHEDULE',
            name: 'Day schedule',
            description: null,
            status: 'active',
            effectiveFrom: '2025-09-01',
            reason: 'Synchronization fixture',
            days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
              dayOfWeek,
              isWorkDay: true,
              startTime: '08:00',
              endTime: '17:00',
              endDayOffset: 0,
              breakStart: '12:00',
              breakEnd: '13:00',
              breakStartDayOffset: 0,
              breakEndDayOffset: 0,
              graceMinutes: 0,
            })),
          });
          const employee = (
            await a.runtime.query('SELECT revision FROM employees WHERE id=$1', [employeeId])
          ).rows[0];
          await schedules.assign(actors[1]!, employeeId, {
            scheduleId: schedule.id,
            effectiveFrom: '2025-09-01',
            effectiveTo: null,
            expectedRevision: employee.revision,
            reason: 'Synchronization fixture',
          });
          const punch = await createTimeRecordService(a.runtime).manual(actors[1]!, {
            employeeId,
            recordedAt: '2025-09-02T00:00:00.000Z',
            recordType: 'in',
            reason: 'Synchronization fixture',
          });
          const before = (await b.runtime.query('SELECT count(*)::int n FROM sync_outbox')).rows[0]
            .n;
          while (await pushNextBatch(a.runtime, ca)) {
            /* send ordered aggregates */
          }
          while (await pullNextBatch(b.runtime, cb)) {
            /* apply ordered aggregates */
          }
          assert.deepEqual(
            (
              await b.runtime.query(
                'SELECT id,recorded_at,record_type FROM time_records WHERE id=$1',
                [punch.id],
              )
            ).rows,
            (
              await a.runtime.query(
                'SELECT id,recorded_at,record_type FROM time_records WHERE id=$1',
                [punch.id],
              )
            ).rows,
          );
          const days =
            'SELECT d.id,d.day_of_week FROM work_schedule_days d JOIN work_schedule_versions v ON v.id=d.version_id WHERE v.schedule_id=$1 ORDER BY d.day_of_week';
          assert.deepEqual(
            (await b.runtime.query(days, [schedule.id])).rows,
            (await a.runtime.query(days, [schedule.id])).rows,
          );
          assert.equal(
            (await b.runtime.query('SELECT count(*)::int n FROM sync_outbox')).rows[0].n,
            before,
          );
        },
      );
      await t.test(
        'F: real engine snapshots finalize atomically and remain immutable on central and B',
        async () => {
          const rules = await publishSyntheticRules(central.runtime, actors[0]!, na.nodeId);
          while (await pullNextBatch(a.runtime, ca)) {
            /* drain bounded pages */
          }
          while (await pullNextBatch(b.runtime, cb)) {
            /* drain bounded pages */
          }
          const payroll = await finalizedPayrollFixture(a.runtime, actors[1]!, employeeId, rules);
          for (let page = 0; page < 30; page++) if (!(await pushNextBatch(a.runtime, ca))) break;
          const failure = await a.runtime.query(
            "SELECT entity_type,error FROM sync_outbox WHERE status IN ('conflicted','rejected','failed')",
          );
          assert.deepEqual(failure.rows, []);
          while (await pullNextBatch(b.runtime, cb)) {
            /* drain bounded pages */
          }
          for (const db of [central, b]) {
            const run = (
              await db.runtime.query(
                'SELECT finalized,totals,snapshot FROM payroll_runs WHERE id=$1',
                [payroll.runId],
              )
            ).rows[0];
            assert.equal(run.finalized, true);
            assert.deepEqual(run.totals, payroll.totals);
            assert.equal(run.snapshot.employeeId, employeeId);
            assert.equal(run.snapshot.sourceEvidence.length, 300000);
            assert.equal(
              (
                await db.runtime.query('SELECT status FROM payroll_periods WHERE id=$1', [
                  payroll.periodId,
                ])
              ).rows[0].status,
              'finalized',
            );
            const original = (
              await a.runtime.query(
                'SELECT snapshot,tax_trace,net_pay FROM employee_payroll_results WHERE payroll_run_id=$1',
                [payroll.runId],
              )
            ).rows;
            assert.deepEqual(
              (
                await db.runtime.query(
                  'SELECT snapshot,tax_trace,net_pay FROM employee_payroll_results WHERE payroll_run_id=$1',
                  [payroll.runId],
                )
              ).rows,
              original,
            );
            await assert.rejects(
              db.runtime.query(
                'UPDATE employee_payroll_results SET net_pay=0 WHERE payroll_run_id=$1',
                [payroll.runId],
              ),
            );
          }
        },
      );
      await t.test('I: authenticated organization is authoritative', async () => {
        const r = await pushEvents(central.runtime, other.token, {
          protocolVersion: 2,
          events: [{ ...original, eventId: randomUUID(), entityId: randomUUID() }],
        });
        assert.equal(r.results[0]?.status, 'rejected');
        const response = await fetch(url + '/api/sync/pull?after=0', {
          headers: { Authorization: `Bearer ${other.token}`, 'X-Hex-Sync-Protocol': '2' },
        });
        assert.ok(
          centralPullResponseSchema
            .parse(await response.json())
            .changes.every((change) => change.organizationId === otherOrg),
        );
      });
      await t.test(
        'partial batches keep dependency failures retryable and never persist submitted secrets',
        async () => {
          const departmentId = randomUUID(),
            positionId = randomUUID();
          const base = {
            operation: 'CREATE',
            revision: 1,
            baseRevision: 0,
            payloadVersion: 1,
            originNodeId: na.nodeId,
            actorId: null,
          };
          const events = [
            {
              ...base,
              eventId: randomUUID(),
              entityType: 'departments',
              entityId: departmentId,
              payload: {
                id: departmentId,
                organizationId: org,
                revision: 1,
                code: 'PARTIAL',
                name: 'Accepted independently',
              },
            },
            {
              ...base,
              eventId: randomUUID(),
              entityType: 'positions',
              entityId: positionId,
              payload: {
                id: positionId,
                organizationId: org,
                revision: 1,
                code: 'WAIT',
                name: 'Dependency not delivered',
                departmentId: randomUUID(),
              },
            },
            {
              ...base,
              eventId: randomUUID(),
              entityType: 'employees',
              entityId: randomUUID(),
              payload: { passwordHash: 'must-never-be-retained' },
            },
          ];
          const response = await fetch(url + '/api/sync/push', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + na.token,
              'X-Hex-Sync-Protocol': '2',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ protocolVersion: 2, events }),
          });
          const results = centralPushResponseSchema.parse(await response.json()).results;
          assert.deepEqual(
            results.map((r) => r.status),
            ['accepted', 'retryable_failure', 'rejected'],
          );
          const records = (
            await central.runtime.query(
              'SELECT request FROM sync_received_events WHERE event_id=$1',
              [events[2]!.eventId],
            )
          ).rows;
          assert.equal(JSON.stringify(records).includes('must-never-be-retained'), false);
          await central.runtime.query('UPDATE sync_nodes SET allowed_domains=$2 WHERE id=$1', [
            nb.nodeId,
            ['departments'],
          ]);
          const denied = await pushEvents(central.runtime, nb.token, {
            protocolVersion: 2,
            events: [{ ...events[1], eventId: randomUUID() }],
          });
          assert.equal(denied.results[0]?.status, 'rejected');
          await central.runtime.query('UPDATE sync_nodes SET allowed_domains=$2 WHERE id=$1', [
            nb.nodeId,
            writableDomains,
          ]);
        },
      );
      await t.test(
        'empty installation adopts canonical organization through enrollment and central pull',
        async () => {
          const fresh = await databaseFixture();
          try {
            await migrate(fresh.migrator, fresh.migrations);
            const user = (
              await fresh.runtime.query(
                "INSERT INTO auth_users(username,display_name,password_hash) VALUES('fresh-admin','Fresh administrator','test') RETURNING id",
              )
            ).rows[0].id;
            await fresh.runtime.query(
              'UPDATE application_setup SET administrator_id=$1 WHERE singleton',
              [user],
            );
            const node = await registerNode(central.runtime, org, 'New installation');
            await importLocalNode(fresh.runtime, { ...node, deviceName: 'New installation' });
            await pullNextBatch(fresh.runtime, { url, ...node });
            assert.equal(
              (await fresh.runtime.query('SELECT legal_name FROM organizations WHERE id=$1', [org]))
                .rows[0].legal_name,
              'Central test',
            );
            assert.equal(
              (
                await fresh.runtime.query(
                  'SELECT reference_bootstrap_pending FROM sync_local_identity WHERE organization_id=$1',
                  [org],
                )
              ).rows[0].reference_bootstrap_pending,
              false,
            );
            assert.equal(
              (await fresh.runtime.query('SELECT count(*)::int n FROM sync_outbox')).rows[0].n,
              0,
            );
          } finally {
            await fresh.close();
          }
        },
      );
      await t.test(
        'J: failure during application rolls back business data and checkpoint',
        async () => {
          const checkpoint = (
            await b.runtime.query(
              'SELECT applied_sequence::text sequence FROM sync_checkpoints WHERE node_id=$1',
              [nb.nodeId],
            )
          ).rows[0].sequence;
          const payload = {
            id: randomUUID(),
            organizationId: org,
            revision: 1,
            code: 'NEW',
            name: 'New',
          };
          const change = {
            eventId: randomUUID(),
            entityType: 'departments',
            entityId: payload.id,
            operation: 'CREATE',
            revision: 1,
            payloadVersion: 1,
            payload,
            baseRevision: 0,
            actorId: null,
            sourceNodeId: na.nodeId,
            organizationId: org,
            changeId: randomUUID(),
            sequence: String(BigInt(checkpoint) + 1n),
          };
          const invalid = {
            ...change,
            entityId: randomUUID(),
            eventId: randomUUID(),
            changeId: randomUUID(),
            sequence: String(BigInt(checkpoint) + 2n),
          };
          await assert.rejects(
            applyRemotePage(b.runtime, nb.nodeId, org, checkpoint, {
              protocolVersion: 2,
              changes: [change, invalid],
              nextSequence: invalid.sequence,
              hasMore: false,
            }),
          );
          assert.equal(
            (
              await b.runtime.query('SELECT count(*)::int n FROM departments WHERE id=$1', [
                payload.id,
              ])
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await b.runtime.query(
                'SELECT applied_sequence::text sequence FROM sync_checkpoints WHERE node_id=$1',
                [nb.nodeId],
              )
            ).rows[0].sequence,
            checkpoint,
          );
        },
      );
      await t.test(
        'K: commit serialization cannot publish a cursor past an uncommitted predecessor',
        async () => {
          const c1 = await central.runtime.connect(),
            c2 = await central.runtime.connect();
          try {
            await c1.query('BEGIN');
            await c2.query('BEGIN');
            const insert = (c: typeof c1) =>
              c.query(
                "INSERT INTO sync_changes(organization_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload_version,payload) VALUES($1,$2,$3,'departments',$4,'CREATE',1,1,'{}') RETURNING sequence::text",
                [org, na.nodeId, randomUUID(), randomUUID()],
              );
            const first = (await insert(c1)).rows[0].sequence;
            let finished = false;
            const second = insert(c2).then((r) => {
              finished = true;
              return r.rows[0].sequence;
            });
            // A round trip on a third connection observes the first transaction still open.
            await central.runtime.query('SELECT 1');
            assert.equal(finished, false);
            await c1.query('COMMIT');
            const next = await second;
            await c2.query('COMMIT');
            assert.ok(BigInt(next) > BigInt(first));
          } finally {
            await c1.query('ROLLBACK');
            await c2.query('ROLLBACK');
            c1.release();
            c2.release();
          }
        },
      );
      await t.test(
        'authorized Sync Now uses the existing worker and records durable history',
        async () => {
          const app = createApp({ database: a.runtime, mode: 'local' }),
            localServer = app.listen(0, '127.0.0.1');
          await once(localServer, 'listening');
          const address = localServer.address();
          assert.ok(address && typeof address !== 'string');
          const localUrl = 'http://127.0.0.1:' + address.port;
          const session = randomBytes(32).toString('base64url');
          await a.runtime.query(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
            [tokenHash(session), actors[1]!.id],
          );
          const headers = {
            Authorization: 'Bearer ' + session,
            'Content-Type': 'application/json',
          };
          const stopWorker = startSyncWorker(a.runtime, ca, 300000, () => {});
          try {
            const responses = await Promise.all([
              fetch(localUrl + '/api/sync/now', { method: 'POST', headers, body: '{}' }),
              fetch(localUrl + '/api/sync/now', { method: 'POST', headers, body: '{}' }),
            ]);
            for (const response of responses) assert.equal(response.status, 200);
            const history = await fetch(localUrl + '/api/sync/history', { headers });
            assert.equal(history.status, 200);
            const body = (await history.json()) as { items: { result: string }[] };
            assert.ok(body.items.length >= 1);
            assert.ok(body.items.every((h) => h.result !== 'running'));
            const state = await fetch(localUrl + '/api/sync/state', { headers });
            assert.equal(state.status, 200);
            assert.equal(
              (
                await fetch(localUrl + '/api/sync/now', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: '{}',
                })
              ).status,
              401,
            );
          } finally {
            await stopWorker();
            await new Promise<void>((resolve) => localServer.close(() => resolve()));
          }
        },
      );
      await t.test(
        'H: rotation invalidates old token and revocation denies push and pull',
        async () => {
          const actor = actors[0]!.id;
          const rotated = await rotateNode(central.runtime, org, na.nodeId, actor);
          await assert.rejects(
            pushEvents(central.runtime, na.token, { protocolVersion: 2, events: [original] }),
          );
          await central.runtime.query(
            'UPDATE sync_nodes SET enabled=false,revoked_at=now() WHERE id=$1',
            [na.nodeId],
          );
          const headers = {
            Authorization: `Bearer ${rotated.token}`,
            'X-Hex-Sync-Protocol': '2',
            'Content-Type': 'application/json',
          };
          assert.equal((await fetch(url + '/api/sync/pull?after=0', { headers })).status, 403);
          assert.equal(
            (
              await fetch(url + '/api/sync/push', {
                method: 'POST',
                headers,
                body: JSON.stringify({ protocolVersion: 2, events: [original] }),
              })
            ).status,
            403,
          );
        },
      );
    } finally {
      await stop?.();
      for (const db of stores.reverse()) await db.close();
    }
  },
);
