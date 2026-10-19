import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  computeEmployeePayroll,
  PAYROLL_ENGINE_VERSION,
  type EmployeePayrollContext,
  type AppliedRule,
} from '@hexpayroll/payroll-engine';
import { statutoryRulesSchema, payrollPeriodInputSchema } from '@hexpayroll/shared';
import { publishReference } from '../src/sync/references.js';
import { createPayrollService, event, saveResult, fingerprint } from '../src/payroll/services.js';
import { transaction, type Actor } from '../src/foundation/repository.js';

export async function publishSyntheticRules(central: Pool, actor: Actor, nodeId: string) {
  const rules: AppliedRule[] = [];
  for (const type of ['sss', 'philhealth', 'pagibig', 'bir'] as const) {
    const id = randomUUID();
    const content = statutoryRulesSchema.parse({
      basis: type === 'bir' ? 'taxable' : 'basic',
      frequency: 'monthly',
      effectiveDateBasis: 'period_end',
      employeeShareTaxDeductible: type !== 'bir',
      brackets: [
        {
          lower: 0,
          upper: null,
          fixedEmployee: 0,
          fixedEmployer: 0,
          employeeRate: { numerator: '1', denominator: '100' },
          employerRate: { numerator: '2', denominator: '100' },
          excessOver: 0,
        },
      ],
    });
    const payload = {
      id,
      organization_id: actor.organizationId,
      revision: 1,
      type,
      version: 'SYNTHETIC_TEST_ONLY',
      effective_from: '2025-01-01',
      effective_to: null,
      status: 'active',
      agency: 'Synthetic tests',
      source_title: 'Synthetic test rules',
      source_reference: 'Synthetic test, not real statutory rates',
      verification_note: 'Synthetic rates used only in isolated tests',
      content_checksum: fingerprint(content),
      rules: content,
      imported_by: actor.id,
      verified_by: actor.id,
      verified_at: '2025-01-01T00:00:00.000Z',
      created_at: '2025-01-01T00:00:00.000Z',
    };
    await publishReference(central, actor, {
      eventId: randomUUID(),
      entityType: 'statutory_rule_sets',
      entityId: id,
      operation: 'CREATE',
      revision: 1,
      baseRevision: 0,
      payloadVersion: 1,
      originNodeId: nodeId,
      actorId: actor.id,
      payload,
    });
    rules.push({ id, type, version: 'SYNTHETIC_TEST_ONLY', rules: content });
  }
  return rules;
}
/** Real engine output, real publication helpers, and PostgreSQL freeze guards. */
export async function finalizedPayrollFixture(
  local: Pool,
  actor: Actor,
  employeeId: string,
  rules: AppliedRule[],
) {
  const context: EmployeePayrollContext = {
    employeeId,
    period: {
      start: '2025-10-01',
      end: '2025-10-31',
      payDate: '2025-10-31',
      frequency: 'monthly',
      isLastPeriodOfMonth: true,
    },
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
    employment: [
      {
        id: randomUUID(),
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        hireDate: '2025-01-01',
        terminationDate: null,
        employmentStatus: 'active',
        payType: 'monthly',
        payFrequency: 'monthly',
        basicRateCentavos: 2500000,
      },
    ],
    days: Array.from({ length: 31 }, (_, i) => ({
      date: `2025-10-${String(i + 1).padStart(2, '0')}`,
      scheduledMinutes: 480,
      workedMinutes: 480,
      lateMinutes: 0,
      undertimeMinutes: 0,
      paidLeaveMinutes: 0,
      unpaidLeaveMinutes: 0,
      absent: false,
      approved: true,
      complete: true,
      revision: 1,
      attendanceId: randomUUID(),
    })),
    earnings: [],
    deductions: [],
    rules,
    monthlyBasis: { basic: 2500000, gross: 2500000 },
    priorContributions: {},
  };
  const result = computeEmployeePayroll(context);
  if (result.issues.length) throw new Error('Synthetic payroll fixture has calculation issues');
  const totals = {
    employees: 1,
    basicPay: result.basicPay,
    grossPay: result.grossPay,
    ordinaryDeductions: result.ordinaryDeductions,
    employeeContributions: result.employeeContributions,
    employerContributions: result.employerContributions,
    withholdingTax: result.withholdingTax,
    totalDeductions: result.totalDeductions,
    netPay: result.netPay,
  };
  const service = createPayrollService(local);
  const period = await service.createPeriod(
    actor,
    payrollPeriodInputSchema.parse({
      code: 'SYNC-OCT',
      name: 'Synthetic synchronization payroll',
      periodStart: '2025-10-01',
      periodEnd: '2025-10-31',
      payDate: '2025-10-31',
      payFrequency: 'monthly',
    }),
  );
  const run = await transaction(local, async (c) => {
    const r = (
      await c.query(
        "INSERT INTO payroll_runs(organization_id,period_id,idempotency_key,status,engine_version,input_hash,snapshot,totals,issues,prepared_by) VALUES($1,$2,$3,'computed',$4,$5,$6,$7,'[]',$8) RETURNING *",
        [
          actor.organizationId,
          period.id,
          randomUUID(),
          PAYROLL_ENGINE_VERSION,
          fingerprint(context),
          JSON.stringify({ ...context, sourceEvidence: 'x'.repeat(300000) }),
          JSON.stringify(totals),
          actor.id,
        ],
      )
    ).rows[0];
    await event(c, actor, 'payroll_runs', r, 'Synthetic engine output');
    await saveResult(c, actor, r.id, result, { context, engineVersion: PAYROLL_ENGINE_VERSION });
    const reviewed = (
      await c.query(
        "UPDATE payroll_periods SET status='review',latest_run_id=$2,reviewed_run_id=$2,reviewed_by=$3,reviewed_at=now(),revision=revision+1 WHERE id=$1 RETURNING *",
        [period.id, r.id, actor.id],
      )
    ).rows[0];
    await event(c, actor, 'payroll_periods', reviewed, 'Synthetic payroll reviewed', 'UPDATE');
    await c.query('UPDATE payroll_runs SET finalized=true,revision=revision+1 WHERE id=$1', [r.id]);
    const finalized = (
      await c.query(
        "UPDATE payroll_periods SET status='finalized',finalized_by=$2,finalized_at=now(),revision=revision+1 WHERE id=$1 RETURNING *",
        [period.id, actor.id],
      )
    ).rows[0];
    await event(c, actor, 'payroll_periods', finalized, 'Synthetic payroll finalized', 'UPDATE');
    return r;
  });
  return { periodId: period.id, runId: run.id, totals };
}
