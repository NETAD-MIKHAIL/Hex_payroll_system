import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import {
  permissionCodes,
  payrollPolicyInputSchema,
  statutoryImportSchema,
  payrollEntryInputSchema,
  payrollPeriodInputSchema,
  type StatutoryType,
} from '@hexpayroll/shared';
import { databaseFixture, databaseTestsEnabled } from './database-fixture.js';
import { migrate } from '../src/db/migrate.js';
import { createAuthService } from '../src/auth/service.js';
import { transaction, DomainError, type Actor } from '../src/foundation/repository.js';
import {
  createScheduleService,
  processAttendance,
  createAttendanceService,
} from '../src/timekeeping/services.js';
import { createPayrollService, payrollLock } from '../src/payroll/services.js';
import { createPayrollRouter } from '../src/payroll/router.js';

test(
  'payroll database workflow, concurrency, immutability, snapshots, and rollback',
  { skip: !databaseTestsEnabled },
  async (t) => {
    const f = await databaseFixture();
    try {
      await migrate(f.migrator, f.migrations);
      const auth = createAuthService(f.runtime),
        password = 'Payroll integration test password 123!';
      const org = (
        await f.runtime.query(
          "INSERT INTO organizations(legal_name) VALUES('Payroll isolated test') RETURNING id",
        )
      ).rows[0]!.id as string;
      await f.runtime.query('UPDATE application_setup SET organization_id=$1 WHERE singleton', [
        org,
      ]);
      const user = await auth.createUser({
        username: 'payrolltest',
        displayName: 'Payroll Test',
        password,
      });
      await f.runtime.query(
        "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='administrator'",
        [user.id],
      );
      const actor: Actor = {
        id: user.id,
        organizationId: org,
        permissions: [...permissionCodes],
        roles: ['administrator'],
      };
      const employee = (
        await f.runtime.query(
          "INSERT INTO employees(organization_id,employee_number,first_name,last_name) VALUES($1,'PAY-1','Ana','Reyes') RETURNING id",
          [org],
        )
      ).rows[0]!.id as string;
      await f.runtime.query(
        "INSERT INTO employment_versions(organization_id,employee_id,effective_from,employment_type,employment_status,hire_date,pay_type,pay_frequency,basic_rate_centavos) VALUES($1,$2,'2025-01-01','regular','active','2025-01-01','monthly','monthly',2500000)",
        [org, employee],
      );
      const schedules = createScheduleService(f.runtime),
        attendance = createAttendanceService(f.runtime),
        service = createPayrollService(f.runtime);
      const schedule = await schedules.save(actor, {
        code: 'ALLDAYS',
        name: 'Synthetic all-day test schedule',
        description: null,
        status: 'active',
        effectiveFrom: '2025-01-01',
        reason: 'Integration test fixture',
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
      await schedules.assign(actor, employee, {
        scheduleId: schedule.id,
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        expectedRevision: 1,
        reason: 'Test fixture',
      });
      await f.runtime.query('DELETE FROM attendance_processing_jobs WHERE organization_id=$1', [
        org,
      ]);
      await f.runtime.query(
        "INSERT INTO time_records(organization_id,employee_id,recorded_at,record_type,source,reason,created_by) SELECT $1,$2,day+CASE WHEN type='in' THEN interval '0 hours' ELSE interval '9 hours' END,type,'manual','Integration test',$3 FROM generate_series('2025-02-01T00:00:00Z'::timestamptz,'2025-02-28T00:00:00Z'::timestamptz,interval '1 day')day CROSS JOIN (VALUES('in'),('out'))types(type)",
        [org, employee, user.id],
      );
      for (let i = 1; i <= 28; i++) {
        const date = `2025-02-${String(i).padStart(2, '0')}`;
        const row = await transaction(f.runtime, (c) =>
          processAttendance(c, actor, employee, date, Date.parse('2025-03-02T00:00:00Z')),
        );
        await attendance.transition(actor, row.id, 'approve', row.revision);
      }
      let p = await service.createPeriod(
        actor,
        payrollPeriodInputSchema.parse({
          code: '2025-FEB',
          name: 'February test payroll',
          periodStart: '2025-02-01',
          periodEnd: '2025-02-28',
          payDate: '2025-02-28',
          payFrequency: 'monthly',
        }),
      );
      const input = () => ({ expectedRevision: p.revision as number, warningAcknowledgments: [] });
      const refresh = async () => {
        p = (await service.detail(actor, p.id as string)).period;
      };
      await t.test(
        'short monthly and incorrect weekly windows are rejected before salary can be overpaid',
        async () => {
          const base = {
            code: 'INVALID',
            name: 'Invalid window',
            periodStart: '2025-03-01',
            periodEnd: '2025-03-15',
            payDate: '2025-03-20',
            payFrequency: 'monthly',
          };
          await assert.rejects(
            () => service.createPeriod(actor, payrollPeriodInputSchema.parse(base)),
            (e) => e instanceof DomainError && e.code === 'INVALID_PERIOD_WINDOW',
          );
          await assert.rejects(
            () =>
              service.createPeriod(
                actor,
                payrollPeriodInputSchema.parse({ ...base, payFrequency: 'weekly' }),
              ),
            (e) => e instanceof DomainError && e.code === 'INVALID_PERIOD_WINDOW',
          );
          await service.createPeriod(
            actor,
            payrollPeriodInputSchema.parse({
              ...base,
              code: 'VALID_WEEK',
              payFrequency: 'weekly',
              periodEnd: '2025-03-07',
            }),
          );
          await service.createPeriod(
            actor,
            payrollPeriodInputSchema.parse({
              ...base,
              code: 'VALID_BIWEEK',
              payFrequency: 'biweekly',
              periodEnd: '2025-03-14',
            }),
          );
        },
      );
      await t.test('overlap is rejected and another organization is isolated', async () => {
        await assert.rejects(() =>
          service.createPeriod(
            actor,
            payrollPeriodInputSchema.parse({
              code: 'OVERLAP',
              name: 'Overlap',
              periodStart: '2025-02-01',
              periodEnd: '2025-02-28',
              payDate: '2025-02-28',
              payFrequency: 'monthly',
            }),
          ),
        );
        await assert.rejects(
          () => service.detail({ ...actor, organizationId: randomUUID() }, p.id as string),
          /not found/,
        );
      });
      p = await service.transition(actor, p.id as string, 'open', input());
      await t.test('missing policies and verified rules block finalization', async () => {
        const run = await service.compute(actor, p.id as string, {
          ...input(),
          idempotencyKey: randomUUID(),
        });
        assert.equal(run.status, 'failed');
        await refresh();
        await assert.rejects(
          () => service.transition(actor, p.id as string, 'finalize', input()),
          /errors/,
        );
      });
      await service.createPolicy(
        actor,
        payrollPolicyInputSchema.parse({
          version: 'SYNTHETIC_POLICY',
          effectiveFrom: '2025-01-01',
          effectiveTo: '2026-01-01',
          policy: {
            monthlyAllocation: 'calendar_month',
            prorationBasis: 'calendar_days',
            monthlyDailyDivisor: { numerator: '25', denominator: '1' },
            standardMinutesPerDay: 480,
            deductLate: true,
            deductUndertime: true,
            deductAbsence: true,
            contributionCutoff: 'last_period_of_month',
          },
        }),
      );
      for (const type of ['sss', 'philhealth', 'pagibig', 'bir'] as StatutoryType[]) {
        const row = await service.importRules(
          actor,
          statutoryImportSchema.parse({
            type,
            version: 'SYNTHETIC_TEST_ONLY',
            effectiveFrom: '2025-01-01',
            effectiveTo: '2026-01-01',
            agency: 'Synthetic fixture, not a government agency',
            sourceTitle: 'Not legal reference data',
            sourceReference: 'test fixture only',
            verificationNote: 'Verified synthetic evaluator fixture; never use in production',
            rules: {
              basis: type === 'bir' ? 'taxable' : 'basic',
              frequency: 'monthly',
              effectiveDateBasis: 'period_end',
              employeeShareTaxDeductible: true,
              brackets: [
                {
                  lower: 0,
                  upper: null,
                  fixedEmployee: type === 'bir' ? 50 : 100,
                  fixedEmployer: type === 'bir' ? 0 : 200,
                  employeeRate: { numerator: '0', denominator: '1' },
                  employerRate: { numerator: '0', denominator: '1' },
                  excessOver: 0,
                },
              ],
            },
          }),
        );
        await service.activateRules(actor, row.id as string, row.revision as number);
        await assert.rejects(() =>
          f.runtime.query('UPDATE statutory_rule_sets SET version=$2 WHERE id=$1', [
            row.id,
            'rewritten',
          ]),
        );
      }
      let run = await service.compute(
        actor,
        p.id as string,
        { ...input(), idempotencyKey: randomUUID() },
        true,
      );
      assert.equal(run.status, 'computed', JSON.stringify(run.issues));
      await refresh();
      await t.test('recomputation retries return one persisted run', async () => {
        const key = randomUUID();
        const args = { ...input(), idempotencyKey: key };
        const first = await service.compute(actor, p.id as string, args, true);
        const second = await service.compute(actor, p.id as string, args, true);
        assert.equal(first.id, second.id);
        assert.equal(
          (
            await f.runtime.query(
              'SELECT count(*) FROM employee_payroll_results WHERE payroll_run_id=$1',
              [first.id],
            )
          ).rows[0]!.count,
          '1',
        );
        run = first;
        await refresh();
      });
      const type = await service.createType(actor, {
        kind: 'earning',
        code: 'ALLOW',
        name: 'Allowance',
        taxable: false,
        category: 'other',
        active: true,
      });
      await t.test(
        'manual earning makes the reviewed inputs stale and old results stay intact',
        async () => {
          const before = (await service.detail(actor, p.id as string)).results[0]!;
          await service.createEntry(
            actor,
            payrollEntryInputSchema.parse({
              employeeId: employee,
              typeId: type.id,
              amount: 10000,
              reason: 'Synthetic one-time allowance',
              periodId: p.id,
            }),
          );
          assert.equal((await service.detail(actor, p.id as string)).stale, true);
          await assert.rejects(
            () => service.transition(actor, p.id as string, 'review', input()),
            /inputs changed/,
          );
          run = await service.compute(
            actor,
            p.id as string,
            { ...input(), idempotencyKey: randomUUID() },
            true,
          );
          await refresh();
          const after = (await service.detail(actor, p.id as string)).results[0]!;
          assert.equal(Number(after.gross_pay), Number(before.gross_pay) + 10000);
          assert.equal(
            (
              await f.runtime.query('SELECT gross_pay FROM employee_payroll_results WHERE id=$1', [
                before.id,
              ])
            ).rows[0]!.gross_pay,
            before.gross_pay,
          );
        },
      );
      await t.test('concurrent recomputations use revisions and preserve one winner', async () => {
        const revision = p.revision as number;
        const attempts = await Promise.allSettled([
          service.compute(
            actor,
            p.id as string,
            { expectedRevision: revision, idempotencyKey: randomUUID() },
            true,
          ),
          service.compute(
            actor,
            p.id as string,
            { expectedRevision: revision, idempotencyKey: randomUUID() },
            true,
          ),
        ]);
        assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
        await refresh();
        run = (await f.runtime.query('SELECT * FROM payroll_runs WHERE id=$1', [p.latest_run_id]))
          .rows[0]!;
      });
      await t.test(
        'an unprocessed correction invalidates approved facts without reading punch mathematics',
        async () => {
          const punch = (
            await f.runtime.query(
              "SELECT id FROM time_records WHERE employee_id=$1 AND record_type='out' ORDER BY recorded_at LIMIT 1",
              [employee],
            )
          ).rows[0]!.id;
          await f.runtime.query(
            "INSERT INTO time_record_corrections(organization_id,time_record_id,operation,reason,revision,created_by) VALUES($1,$2,'void','Synthetic correction',1,$3)",
            [org, punch, user.id],
          );
          run = await service.compute(
            actor,
            p.id as string,
            { ...input(), idempotencyKey: randomUUID() },
            true,
          );
          await refresh();
          assert.equal(run.status, 'failed');
          assert((run.issues as { code: string }[]).some((i) => i.code === 'OUTDATED_ATTENDANCE'));
          await f.runtime.query(
            "INSERT INTO time_records(organization_id,employee_id,recorded_at,record_type,source,reason,created_by) VALUES($1,$2,'2025-02-01T09:00:00Z','out','manual','Replacement synthetic evidence',$3)",
            [org, employee, user.id],
          );
          const fact = await transaction(f.runtime, (c) =>
            processAttendance(c, actor, employee, '2025-02-01'),
          );
          await attendance.transition(actor, fact.id, 'approve', fact.revision);
          run = await service.compute(
            actor,
            p.id as string,
            { ...input(), idempotencyKey: randomUUID() },
            true,
          );
          await refresh();
          assert.equal(run.status, 'computed', JSON.stringify(run.issues));
        },
      );
      await t.test(
        'batch retains valid employees when another employee has invalid payable time',
        async () => {
          const second = (
            await f.runtime.query(
              "INSERT INTO employees(organization_id,employee_number,first_name,last_name) VALUES($1,'PAY-2','Ben','Santos') RETURNING id",
              [org],
            )
          ).rows[0]!.id as string;
          await f.runtime.query(
            "INSERT INTO employment_versions(organization_id,employee_id,effective_from,employment_type,employment_status,hire_date,termination_date,pay_type,pay_frequency,basic_rate_centavos) VALUES($1,$2,'2025-02-28','regular','active','2025-02-28','2025-02-28','hourly','monthly',12500)",
            [org, second],
          );
          await schedules.assign(actor, second, {
            scheduleId: schedule.id,
            effectiveFrom: '2025-02-28',
            effectiveTo: null,
            expectedRevision: 1,
            reason: 'Synthetic hire',
          });
          await f.runtime.query('DELETE FROM attendance_processing_jobs WHERE employee_id=$1', [
            second,
          ]);
          await f.runtime.query(
            "INSERT INTO time_records(organization_id,employee_id,recorded_at,record_type,source,reason,created_by) SELECT $1,$2,at,type,'manual','Synthetic evidence',$3 FROM (VALUES('2025-02-28T00:00:00Z'::timestamptz,'in'),('2025-02-28T09:00:00Z'::timestamptz,'out'))facts(at,type)",
            [org, second, user.id],
          );
          const fact = await transaction(f.runtime, (c) =>
            processAttendance(c, actor, second, '2025-02-28'),
          );
          await attendance.transition(actor, fact.id, 'approve', fact.revision);
          await f.runtime.query(
            'UPDATE attendance_records SET worked_minutes=1000,revision=revision+1 WHERE id=$1',
            [fact.id],
          );
          run = await service.compute(
            actor,
            p.id as string,
            { ...input(), idempotencyKey: randomUUID() },
            true,
          );
          await refresh();
          const detail = await service.detail(actor, p.id as string);
          assert.equal(detail.results.length, 2);
          assert.equal(detail.results.find((e) => e.employee_id === employee)!.status, 'computed');
          assert.equal(detail.results.find((e) => e.employee_id === second)!.status, 'failed');
          assert.equal(run.status, 'failed');
          await f.runtime.query(
            'UPDATE attendance_records SET worked_minutes=480,revision=revision+1 WHERE id=$1',
            [fact.id],
          );
          run = await service.compute(
            actor,
            p.id as string,
            { ...input(), idempotencyKey: randomUUID() },
            true,
          );
          await refresh();
          assert.equal(run.status, 'computed', JSON.stringify(run.issues));
        },
      );
      await t.test('oversized employee events roll back the entire new run', async () => {
        const before = (
          await f.runtime.query('SELECT count(*) FROM payroll_runs WHERE period_id=$1', [p.id])
        ).rows[0]!.count;
        await f.runtime.query(
          "UPDATE employees SET first_name=repeat('X',270000),revision=revision+1 WHERE id=$1",
          [employee],
        );
        try {
          await assert.rejects(
            () =>
              service.compute(
                actor,
                p.id as string,
                { ...input(), idempotencyKey: randomUUID() },
                true,
              ),
            (e) => e instanceof DomainError && e.code === 'PAYROLL_SNAPSHOT_TOO_LARGE',
          );
          assert.equal(
            (await f.runtime.query('SELECT count(*) FROM payroll_runs WHERE period_id=$1', [p.id]))
              .rows[0]!.count,
            before,
          );
        } finally {
          await f.runtime.query(
            "UPDATE employees SET first_name='Ana',revision=revision+1 WHERE id=$1",
            [employee],
          );
        }
        run = await service.compute(
          actor,
          p.id as string,
          { ...input(), idempotencyKey: randomUUID() },
          true,
        );
        await refresh();
      });
      await t.test('finalization requires review and service permissions', async () => {
        await assert.rejects(
          () => service.transition(actor, p.id as string, 'finalize', input()),
          /Review the latest/,
        );
        await assert.rejects(
          () =>
            service.compute(
              { ...actor, permissions: ['payroll.view'] },
              p.id as string,
              { ...input(), idempotencyKey: randomUUID() },
              true,
            ),
          /Permission required/,
        );
      });
      p = await service.transition(actor, p.id as string, 'review', input());
      await t.test(
        'source transaction serializes with finalization and stale inputs are rejected',
        async () => {
          const source = await f.runtime.connect();
          try {
            await source.query('BEGIN');
            await payrollLock(source, org);
            await source.query(
              'UPDATE employees SET first_name=$2,revision=revision+1 WHERE id=$1',
              [employee, 'Changed'],
            );
            const final = service.transition(actor, p.id as string, 'finalize', input());
            const rejected = assert.rejects(
              () => final,
              (e) => e instanceof DomainError && e.code === 'STALE_PAYROLL',
            );
            await source.query('COMMIT');
            await rejected;
          } finally {
            source.release();
          }
          assert.equal((await service.detail(actor, p.id as string)).stale, true);
          run = await service.compute(
            actor,
            p.id as string,
            { ...input(), idempotencyKey: randomUUID() },
            true,
          );
          await refresh();
          p = await service.transition(actor, p.id as string, 'review', input());
        },
      );
      await t.test(
        'outbox failure rolls back finalization, freeze, and success audit',
        async () => {
          await f.migrator.query(
            "ALTER TABLE sync_outbox ADD CONSTRAINT test_reject_finalization CHECK(NOT(entity_type='payroll_periods' AND payload->>'status'='finalized'))",
          );
          try {
            await assert.rejects(() =>
              service.transition(actor, p.id as string, 'finalize', input()),
            );
            assert.equal((await service.detail(actor, p.id as string)).period.status, 'review');
            assert.equal(
              (await f.runtime.query('SELECT finalized FROM payroll_runs WHERE id=$1', [run.id]))
                .rows[0]!.finalized,
              false,
            );
            assert.equal(
              (
                await f.runtime.query(
                  "SELECT count(*) FROM audit_events WHERE entity_id=$1 AND description='Payroll finalized'",
                  [p.id],
                )
              ).rows[0]!.count,
              '0',
            );
          } finally {
            await f.migrator.query(
              'ALTER TABLE sync_outbox DROP CONSTRAINT test_reject_finalization',
            );
          }
        },
      );
      await t.test(
        'two finalizers produce one immutable payroll and one finalization event',
        async () => {
          const attempts = await Promise.allSettled([
            service.transition(actor, p.id as string, 'finalize', input()),
            service.transition(actor, p.id as string, 'finalize', input()),
          ]);
          assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
          assert.equal((await service.detail(actor, p.id as string)).period.status, 'finalized');
          assert.equal(
            (
              await f.runtime.query(
                "SELECT count(*) FROM audit_events WHERE entity_id=$1 AND description='Payroll finalized'",
                [p.id],
              )
            ).rows[0]!.count,
            '1',
          );
        },
      );
      await t.test(
        'database guards prevent historical writes and insertion of extra finalized lines',
        async () => {
          const detail = await service.detail(actor, p.id as string),
            result = detail.results[0]!;
          await assert.rejects(() =>
            f.runtime.query(
              'UPDATE employee_payroll_results SET basic_pay=basic_pay+1 WHERE id=$1',
              [result.id],
            ),
          );
          await assert.rejects(() =>
            f.runtime.query(
              "INSERT INTO payroll_earning_lines(organization_id,result_id,code,description,amount,taxable,metadata) VALUES($1,$2,'EXTRA','Extra',1,true,'{}')",
              [org, result.id],
            ),
          );
          await assert.rejects(() =>
            f.runtime.query('UPDATE payroll_runs SET finalized=false WHERE id=$1', [run.id]),
          );
          await assert.rejects(() =>
            f.runtime.query("UPDATE payroll_periods SET status='open' WHERE id=$1", [p.id]),
          );
          await assert.rejects(() =>
            service.compute(
              actor,
              p.id as string,
              { ...input(), idempotencyKey: randomUUID() },
              true,
            ),
          );
          const stored = await service.result(actor, p.id as string, result.id as string);
          const frozen = JSON.stringify(stored);
          await f.runtime.query(
            'UPDATE employment_versions SET basic_rate_centavos=3000000 WHERE employee_id=$1',
            [employee],
          );
          assert.equal(
            JSON.stringify(await service.result(actor, p.id as string, result.id as string)),
            frozen,
          );
        },
      );
      await t.test(
        'new monetary policies supersede future applicability without changing finalized snapshots',
        async () => {
          const original = (await service.configuration(actor, 'policies'))[0]!;
          const before = JSON.stringify((await service.detail(actor, p.id as string)).results);
          const next = await service.createPolicy(
            actor,
            payrollPolicyInputSchema.parse({
              version: 'SYNTHETIC_POLICY_V2',
              effectiveFrom: '2025-03-01',
              effectiveTo: null,
              policy: original.policy,
              supersedesId: original.id,
            }),
          );
          const predecessor = (
            await f.runtime.query('SELECT * FROM payroll_policies WHERE id=$1', [original.id])
          ).rows[0]!;
          assert.equal(predecessor.effective_to, '2025-03-01');
          assert.deepEqual(predecessor.policy, original.policy);
          await service.createPolicy(
            actor,
            payrollPolicyInputSchema.parse({
              version: 'SYNTHETIC_POLICY_V3',
              effectiveFrom: '2025-04-01',
              effectiveTo: null,
              policy: original.policy,
              supersedesId: next.id,
            }),
          );
          await assert.rejects(
            () =>
              service.createPolicy(
                actor,
                payrollPolicyInputSchema.parse({
                  version: 'BAD_RETROACTIVE_POLICY',
                  effectiveFrom: '2025-02-01',
                  effectiveTo: '2025-03-01',
                  policy: original.policy,
                  supersedesId: original.id,
                }),
              ),
            /finalized payroll applicability/,
          );
          assert.equal(
            JSON.stringify((await service.detail(actor, p.id as string)).results),
            before,
          );
        },
      );
      await t.test(
        'statutory frequency versions coexist and explicit supersession preserves finalized shares',
        async () => {
          const old = (await service.configuration(actor, 'rules'))[0]!;
          const inputFor = (
            type: StatutoryType,
            version: string,
            from: string,
            frequency = 'monthly',
          ) =>
            statutoryImportSchema.parse({
              type,
              version,
              effectiveFrom: from,
              effectiveTo: null,
              agency: 'Synthetic fixture only',
              sourceTitle: 'Not legal data',
              sourceReference: 'Isolated test fixture',
              verificationNote: 'Synthetic validation only',
              rules: {
                ...(old.rules as object),
                basis: type === 'bir' ? 'taxable' : 'basic',
                frequency,
              },
            });
          const semi = await service.importRules(
            actor,
            inputFor('bir', 'SYNTHETIC_SEMI', '2025-01-01', 'semi_monthly'),
          );
          await service.activateRules(actor, semi.id as string, semi.revision as number);
          const conflict = await service.importRules(
            actor,
            inputFor('bir', 'SYNTHETIC_CONFLICT', '2025-01-01'),
          );
          await assert.rejects(
            () => service.activateRules(actor, conflict.id as string, conflict.revision as number),
            /overlap/,
          );
          const previous = (
            await f.runtime.query(
              "SELECT * FROM statutory_rule_sets WHERE organization_id=$1 AND type='sss' AND status='active'",
              [org],
            )
          ).rows[0]!;
          const next = await service.importRules(
            actor,
            inputFor('sss', 'SYNTHETIC_SSS_V2', '2025-03-01'),
          );
          await service.activateRules(
            actor,
            next.id as string,
            next.revision as number,
            previous.id as string,
          );
          assert.equal(
            (
              await f.runtime.query('SELECT effective_to FROM statutory_rule_sets WHERE id=$1', [
                previous.id,
              ])
            ).rows[0]!.effective_to,
            '2025-03-01',
          );
          const bad = await service.importRules(
            actor,
            inputFor('sss', 'SYNTHETIC_BAD_RETRO', '2025-02-01'),
          );
          await assert.rejects(
            () =>
              service.activateRules(
                actor,
                bad.id as string,
                bad.revision as number,
                previous.id as string,
              ),
            /finalized payroll applicability/,
          );
          assert.deepEqual(
            (
              await f.runtime.query('SELECT rules FROM statutory_rule_sets WHERE id=$1', [
                previous.id,
              ])
            ).rows[0]!.rules,
            previous.rules,
          );
          assert.equal(
            (
              await f.runtime.query(
                "SELECT sum(employee_share)::text total FROM payroll_contribution_lines l JOIN employee_payroll_results e ON e.id=l.result_id WHERE e.payroll_run_id=$1 AND l.type='sss'",
                [run.id],
              )
            ).rows[0]!.total,
            '200',
          );
        },
      );
      await t.test(
        'HTTP permission checks deny actions even when a caller bypasses the UI',
        async () => {
          const viewer = await auth.createUser({
            username: 'payrollviewer',
            displayName: 'Viewer',
            password,
          });
          await f.runtime.query('UPDATE auth_users SET organization_id=$1 WHERE id=$2', [
            org,
            viewer.id,
          ]);
          await f.runtime.query(
            "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='viewer' ON CONFLICT DO NOTHING",
            [viewer.id],
          );
          const login = await auth.login({ identifier: 'payrollviewer', password });
          assert(login);
          const app = express();
          app.use(express.json());
          app.use('/api', createPayrollRouter(f.runtime));
          const server = app.listen(0, '127.0.0.1');
          await once(server, 'listening');
          try {
            const address = server.address();
            assert(address && typeof address === 'object');
            const listUrl = `http://127.0.0.1:${address.port}/api/payroll/periods`;
            const viewerResponse = await fetch(listUrl, {
              headers: { authorization: 'Bearer ' + login.accessToken },
            });
            assert.equal(viewerResponse.status, 403);
            await f.runtime.query(
              "INSERT INTO user_roles SELECT $1,id FROM roles WHERE code='payroll_viewer'",
              [viewer.id],
            );
            const financialResponse = await fetch(listUrl, {
              headers: { authorization: 'Bearer ' + login.accessToken },
            });
            assert.equal(financialResponse.status, 200);
            const response = await fetch(
              `http://127.0.0.1:${address.port}/api/payroll/periods/${p.id}/finalize`,
              {
                method: 'POST',
                headers: {
                  authorization: 'Bearer ' + login.accessToken,
                  'content-type': 'application/json',
                },
                body: JSON.stringify(input()),
              },
            );
            assert.equal(response.status, 403);
          } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
