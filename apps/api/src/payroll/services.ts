import { chunkRunSnapshot } from '../sync/snapshots.js';
import { enqueueOutbox } from '../sync/outbox.js';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import type {
  payrollPeriodInputSchema,
  payrollTypeInputSchema,
  payrollEntryInputSchema,
  payrollPolicyInputSchema,
  statutoryImportSchema,
} from '@hexpayroll/shared';
import {
  payrollPolicySchema,
  statutoryRulesSchema,
  type PayrollIssue,
  type PayrollResult,
  type PayrollPolicy,
  type PayrollLine,
  type Permission,
} from '@hexpayroll/shared';
import {
  computeEmployeePayroll,
  exactSum,
  PAYROLL_ENGINE_VERSION,
  type Compensation,
  type EmployeePayrollContext,
  type AppliedRule,
  type PayrollDay,
} from '@hexpayroll/payroll-engine';
import {
  DomainError,
  transaction,
  requirePermission,
  type Actor,
} from '../foundation/repository.js';
import '../db/types.js';

export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}
export const fingerprint = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
export async function payrollLock(c: PoolClient, org: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,731))', [org]);
}
function organization(actor: Actor): string {
  if (!actor.organizationId)
    throw new DomainError(409, 'ORGANIZATION_REQUIRED', 'Configure an organization first');
  return actor.organizationId;
}
export interface PeriodRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  pay_frequency: Compensation['payFrequency'];
  status: string;
  revision: number;
  latest_run_id: string | null;
  reviewed_run_id: string | null;
  warning_acknowledgments: string[];
}
async function period(
  c: Pool | PoolClient,
  org: string,
  id: string,
  lock = false,
): Promise<PeriodRow> {
  const r = await c.query<PeriodRow>(
    `SELECT * FROM payroll_periods WHERE organization_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
    [org, id],
  );
  if (!r.rows[0]) throw new DomainError(404, 'NOT_FOUND', 'Payroll period not found');
  return r.rows[0];
}
function editable(p: PeriodRow) {
  if (['finalized', 'cancelled'].includes(p.status))
    throw new DomainError(409, 'PAYROLL_CLOSED', 'Closed payroll cannot be changed');
}
function revision(p: PeriodRow, expected: number) {
  if (p.revision !== expected)
    throw new DomainError(409, 'REVISION_CONFLICT', 'Payroll changed; refresh before continuing');
}
export async function event(
  c: PoolClient,
  a: Actor,
  entity: string,
  row: Record<string, unknown>,
  description: string,
  operation = 'CREATE',
) {
  // Finalization publishes one compact manifest over previously published immutable
  // snapshots. The receiver verifies all components before freezing run + period.
  if (entity === 'payroll_runs' && row.finalized === true) {
    await c.query(
      'INSERT INTO audit_events(organization_id,user_id,action,entity_type,entity_id,description,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        a.organizationId,
        a.id,
        'UPDATE',
        entity,
        row.id,
        description,
        JSON.stringify({ revision: row.revision }),
      ],
    );
    return;
  }
  if (entity === 'payroll_periods' && row.status === 'finalized') {
    const manifest: Record<string, unknown> = {};
    const run = (await c.query('SELECT * FROM payroll_runs WHERE id=$1', [row.latest_run_id]))
      .rows[0];
    manifest.run = {
      id: run.id,
      baseRevision: Number(run.revision) - 1,
      hash: fingerprint({ ...run, finalized: false, revision: Number(run.revision) - 1 }),
    };
    for (const table of [
      'employee_payroll_results',
      'payroll_earning_lines',
      'payroll_deduction_lines',
      'payroll_contribution_lines',
    ]) {
      const components =
        table === 'employee_payroll_results'
          ? await c.query(
              'SELECT * FROM employee_payroll_results WHERE payroll_run_id=$1 ORDER BY id',
              [run.id],
            )
          : await c.query(
              `SELECT l.* FROM ${table} l JOIN employee_payroll_results r ON r.id=l.result_id WHERE r.payroll_run_id=$1 ORDER BY l.id`,
              [run.id],
            );
      manifest[table] = { count: components.rowCount, hash: fingerprint(components.rows) };
    }
    row = { ...row, finalization: manifest };
  }
  if (entity === 'payroll_runs' && Buffer.byteLength(JSON.stringify(row)) > 200000)
    row = await chunkRunSnapshot(c, a.organizationId!, row, a.id);
  const payload = JSON.stringify(row);
  if (Buffer.byteLength(payload) > 262144)
    throw new DomainError(
      413,
      'PAYROLL_SNAPSHOT_TOO_LARGE',
      'A payroll snapshot exceeds the offline event limit; reduce the period size',
    );
  await c.query(
    'INSERT INTO audit_events(organization_id,user_id,action,entity_type,entity_id,description,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      a.organizationId,
      a.id,
      operation === 'CREATE' ? 'CREATE' : 'UPDATE',
      entity,
      row.id,
      description,
      JSON.stringify({ revision: row.revision ?? 1 }),
    ],
  );
  await enqueueOutbox(c, {
    organizationId: a.organizationId!,
    entityType: entity,
    entityId: String(row.id),
    operation,
    revision: Number(row.revision ?? 1),
    payload: row,
    actorId: a.id,
  });
}
async function supersede(
  c: PoolClient,
  a: Actor,
  table: 'payroll_policies' | 'statutory_rule_sets',
  id: string,
  effectiveFrom: string,
  match?: { type: string; frequency: string },
) {
  const old = (
    await c.query(`SELECT * FROM ${table} WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [
      a.organizationId,
      id,
    ])
  ).rows[0];
  if (!old || (table === 'statutory_rule_sets' && old.status !== 'active'))
    throw new DomainError(
      409,
      'INVALID_PREDECESSOR',
      'Select an existing applicable reference version to supersede',
    );
  if (
    old.effective_from >= effectiveFrom ||
    (old.effective_to && old.effective_to <= effectiveFrom) ||
    (match && (old.type !== match.type || old.rules.frequency !== match.frequency))
  )
    throw new DomainError(
      409,
      'INVALID_PREDECESSOR',
      'The predecessor must have the same rule type/frequency and cover the new effective date',
    );
  const closed = (
    await c.query(
      `UPDATE ${table} SET effective_to=$2,revision=revision+1 WHERE id=$1 RETURNING *`,
      [id, effectiveFrom],
    )
  ).rows[0]!;
  await event(c, a, table, closed, 'Reference version superseded', 'UPDATE');
}
function dateList(start: string, end: string): string[] {
  const dates: string[] = [];
  for (
    let d = start;
    d <= end;
    d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  )
    dates.push(d);
  return dates;
}
function periodWindowError(
  start: string,
  end: string,
  frequency: Compensation['payFrequency'],
  configuration?: {
    payFrequency?: string;
    cutoffs?: { startDay: number; endDay: number | 'end_of_month' }[];
  },
): string | null {
  const last = new Date(start + 'T00:00:00Z');
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const monthEnd = last.toISOString().slice(0, 10),
    sameMonth = start.slice(0, 7) === end.slice(0, 7);
  if (frequency === 'monthly')
    return sameMonth && start.endsWith('-01') && end === monthEnd
      ? null
      : 'Monthly payroll must cover the full calendar month; hire and termination dates are prorated within that period.';
  if (frequency === 'semi_monthly') {
    if (configuration?.payFrequency !== 'semi_monthly' || configuration.cutoffs?.length !== 2)
      return 'Configure the company semi-monthly cutoffs before creating this payroll population.';
    return sameMonth &&
      configuration.cutoffs.some(
        (c) =>
          c.startDay === Number(start.slice(8)) &&
          (c.endDay === 'end_of_month' ? end === monthEnd : c.endDay === Number(end.slice(8))),
      )
      ? null
      : 'The period dates must match a configured semi-monthly cutoff.';
  }
  const expected = frequency === 'weekly' ? 7 : 14;
  return Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z') ===
    (expected - 1) * 86400000
    ? null
    : `${frequency === 'weekly' ? 'Weekly' : 'Biweekly'} payroll must cover ${expected} calendar days.`;
}
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row),
      values = grouped.get(id) ?? [];
    values.push(row);
    grouped.set(id, values);
  }
  return grouped;
}
interface EmploymentRow extends Compensation {
  employeeId: string;
  departmentName: string | null;
  positionName: string | null;
}
interface AttendanceRow {
  id: string;
  employee_id: string;
  work_date: string;
  worked_minutes: number;
  late_minutes: number;
  undertime_minutes: number;
  attendance_status: string;
  approval_status: string;
  revision: number;
  updated_at: Date;
  result: {
    schedule: {
      assignmentId: string;
      versionId: string;
      isRestDay: boolean;
      shift: { start: number; end: number; break: [number, number] | null } | null;
    } | null;
    complete: boolean;
    flags: string[];
    evidence?: { id: string; correctionRevision: number | null; operation: string | null }[];
    leaves: {
      id: string;
      revision: number;
      durationType: string;
      typeSnapshot: { paid: boolean };
    }[];
  };
}
interface ExpectedDay {
  employee_id: string;
  date: string;
  assignment_id: string | null;
  version_id: string | null;
  scheduled_minutes: number | null;
  day_start: Date;
  day_end: Date;
}
interface RuleRow {
  id: string;
  type: AppliedRule['type'];
  version: string;
  effective_from: string;
  effective_to: string | null;
  rules: AppliedRule['rules'];
  content_checksum: string;
  revision: number;
}
interface EntryRow {
  id: string;
  employee_id: string;
  amount: string;
  reason: string;
  start_date: string | null;
  end_date: string | null;
  period_id: string | null;
  kind: string;
  code: string;
  name: string;
  taxable: boolean;
  revision: number;
  type_revision: number;
  type_id: string;
}
interface SourceContext {
  snapshot: Record<string, unknown>;
  contexts: EmployeePayrollContext[];
  issues: PayrollIssue[];
  policy: PayrollPolicy | null;
}
async function loadContext(c: PoolClient, p: PeriodRow): Promise<SourceContext> {
  const org = p.organization_id,
    args = [org, p.period_start, p.period_end];
  const company = (
    await c.query(
      'SELECT id,legal_name,trade_name,timezone,currency,revision FROM organizations WHERE id=$1',
      [org],
    )
  ).rows[0];
  // Constant query count; no employee-by-employee database reads.
  const employees = (
    await c.query<{
      id: string;
      employee_number: string;
      first_name: string;
      last_name: string;
      revision: number;
    }>(
      `SELECT DISTINCT e.id,e.employee_number,e.first_name,e.last_name,e.revision FROM employees e JOIN employment_versions v ON v.employee_id=e.id AND v.organization_id=e.organization_id WHERE e.organization_id=$1 AND v.pay_frequency=$4 AND v.employment_status IN ('active','on_leave') AND v.effective_from<=$3 AND (v.effective_to IS NULL OR v.effective_to>$2) AND v.hire_date<=$3 AND (v.termination_date IS NULL OR v.termination_date>=$2) ORDER BY e.id`,
      [...args, p.pay_frequency],
    )
  ).rows;
  const ids = employees.map((e) => e.id);
  const employment = (
    await c.query<EmploymentRow>(
      `SELECT v.id,v.employee_id "employeeId",v.effective_from "effectiveFrom",v.effective_to "effectiveTo",v.hire_date "hireDate",v.termination_date "terminationDate",v.employment_status "employmentStatus",v.pay_type "payType",v.pay_frequency "payFrequency",v.basic_rate_centavos "basicRateCentavos",d.name "departmentName",pos.name "positionName" FROM employment_versions v LEFT JOIN departments d ON d.id=v.department_id LEFT JOIN positions pos ON pos.id=v.position_id WHERE v.organization_id=$1 AND v.employee_id=ANY($4::uuid[]) AND v.effective_from<=$3 AND (v.effective_to IS NULL OR v.effective_to>$2) ORDER BY v.employee_id,v.effective_from`,
      [org, p.period_start.slice(0, 7) + '-01', p.period_end, ids],
    )
  ).rows.map((row) => ({ ...row, basicRateCentavos: Number(row.basicRateCentavos) }));
  const attendance = (
    await c.query<AttendanceRow>(
      'SELECT * FROM attendance_records WHERE organization_id=$1 AND work_date BETWEEN $2 AND $3 AND employee_id=ANY($4::uuid[]) ORDER BY employee_id,work_date',
      [...args, ids],
    )
  ).rows;
  const expected = (
    await c.query<ExpectedDay>(
      `SELECT e.id employee_id,day::date date,(day::date::timestamp AT TIME ZONE o.timezone) day_start,((day::date+1)::timestamp AT TIME ZONE o.timezone) day_end,a.id assignment_id,v.id version_id,CASE WHEN d.is_work_day THEN (extract(epoch FROM (d.end_time-d.start_time+d.end_day_offset*interval '1 day'))-COALESCE(extract(epoch FROM (d.break_end-d.break_start+(d.break_end_day_offset-d.break_start_day_offset)*interval '1 day')),0))::integer/60 ELSE 0 END scheduled_minutes FROM employees e JOIN organizations o ON o.id=e.organization_id CROSS JOIN generate_series($2::date,$3::date,interval '1 day')day LEFT JOIN employee_schedule_assignments a ON a.organization_id=e.organization_id AND a.employee_id=e.id AND a.effective_from<=day::date AND (a.effective_to IS NULL OR a.effective_to>day::date) LEFT JOIN LATERAL(SELECT id FROM work_schedule_versions WHERE schedule_id=a.schedule_id AND effective_from<=day::date ORDER BY effective_from DESC LIMIT 1)v ON true LEFT JOIN work_schedule_days d ON d.version_id=v.id AND d.day_of_week=extract(dow FROM day::date) WHERE e.organization_id=$1 AND e.id=ANY($4::uuid[]) ORDER BY e.id,day`,
      [...args, ids],
    )
  ).rows;
  const policies = (
    await c.query<{
      id: string;
      version: string;
      effective_from: string;
      effective_to: string | null;
      policy: PayrollPolicy;
    }>(
      'SELECT * FROM payroll_policies WHERE organization_id=$1 AND effective_from<=$2 AND (effective_to IS NULL OR effective_to>$3) ORDER BY effective_from',
      [org, p.period_start, p.period_end],
    )
  ).rows;
  const policy = policies.length === 1 ? payrollPolicySchema.parse(policies[0]!.policy) : null;
  const activeRules = (
    await c.query<RuleRow>(
      `SELECT * FROM statutory_rule_sets WHERE organization_id=$1 AND status='active' ORDER BY type,effective_from`,
      [org],
    )
  ).rows.filter((r) => {
    const date = r.rules.effectiveDateBasis === 'pay_date' ? p.pay_date : p.period_end;
    return r.effective_from <= date && (!r.effective_to || r.effective_to > date);
  });
  const ruleIssues: PayrollIssue[] = [];
  const rules: RuleRow[] = [];
  for (const type of ['sss', 'philhealth', 'pagibig', 'bir'] as const) {
    const candidates = activeRules.filter((r) => r.type === type);
    const exact = candidates.filter((r) => r.rules.frequency === p.pay_frequency);
    const applicable = exact.length
      ? exact
      : type === 'bir'
        ? []
        : candidates.filter((r) => r.rules.frequency === 'monthly');
    if (applicable.length > 1)
      ruleIssues.push({
        code: 'AMBIGUOUS_STATUTORY_RULE',
        severity: 'error',
        message: `Multiple ${type.toUpperCase()} versions apply under their effective-date policies`,
      });
    if (applicable[0]) rules.push(applicable[0]);
  }
  const entries = (
    await c.query<EntryRow>(
      `SELECT e.*,t.kind,t.code,t.name,t.taxable,t.revision type_revision FROM payroll_entries e JOIN payroll_types t ON t.id=e.type_id AND t.organization_id=e.organization_id WHERE e.organization_id=$1 AND e.employee_id=ANY($4::uuid[]) AND e.active AND t.active AND (e.period_id=$5 OR (e.period_id IS NULL AND e.start_date<=$3 AND (e.end_date IS NULL OR e.end_date>=$2))) ORDER BY e.id`,
      [...args, ids, p.id],
    )
  ).rows;
  const jobs = (
    await c.query(
      'SELECT id,employee_id,start_date,end_date,next_date,last_error FROM attendance_processing_jobs WHERE organization_id=$1 AND employee_id=ANY($4::uuid[]) AND start_date<=$3 AND end_date>=$2 ORDER BY id',
      [...args, ids],
    )
  ).rows;
  const leaves = (
    await c.query(
      `SELECT id,employee_id,start_date,end_date,duration_type,status,revision,type_snapshot,updated_at FROM leave_requests WHERE organization_id=$1 AND employee_id=ANY($4::uuid[]) AND start_date<=$3 AND end_date>=$2 ORDER BY id`,
      [...args, ids],
    )
  ).rows;
  // Evidence is only a freshness boundary: payroll never interprets these punches.
  const evidence = (
    await c.query(
      `SELECT t.id,t.employee_id,t.recorded_at,t.record_type,t.created_at,c.id correction_id,c.recorded_at corrected_at,c.record_type corrected_type,c.operation,c.revision,c.created_at correction_created_at FROM time_records t LEFT JOIN LATERAL(SELECT * FROM time_record_corrections WHERE time_record_id=t.id ORDER BY revision DESC LIMIT 1)c ON true WHERE t.organization_id=$1 AND t.employee_id=ANY($4::uuid[]) AND (t.recorded_at BETWEEN ($2::date-interval '2 days') AND ($3::date+interval '3 days') OR c.recorded_at BETWEEN ($2::date-interval '2 days') AND ($3::date+interval '3 days')) ORDER BY t.id`,
      [...args, ids],
    )
  ).rows;
  const monthStart = p.period_end.slice(0, 7) + '-01';
  const prior = (
    await c.query(
      `SELECT e.employee_id,e.basic_pay,e.gross_pay,e.payroll_run_id,per.id period_id,per.period_start,per.period_end,COALESCE((SELECT jsonb_agg(jsonb_build_object('type',l.type,'employee',l.employee_share,'employer',l.employer_share) ORDER BY l.type) FROM payroll_contribution_lines l WHERE l.result_id=e.id),'[]') contributions FROM employee_payroll_results e JOIN payroll_runs r ON r.id=e.payroll_run_id JOIN payroll_periods per ON per.id=r.period_id WHERE e.organization_id=$1 AND e.employee_id=ANY($4::uuid[]) AND per.status='finalized' AND r.finalized AND per.id<>$5 AND per.period_end BETWEEN $2::date AND $3::date ORDER BY per.period_start,e.employee_id`,
      [org, monthStart, p.period_end, ids, p.id],
    )
  ).rows;
  const issues: PayrollIssue[] = [...ruleIssues];
  if (!employees.length)
    issues.push({
      code: 'EMPTY_POPULATION',
      severity: 'error',
      message: 'No eligible employees for this payroll period',
    });
  if (!policy)
    issues.push({
      code: 'MISSING_MONETARY_POLICY',
      severity: 'error',
      message: 'Configure one monetary policy covering the entire period',
    });
  if (jobs.length)
    issues.push({
      code: 'PENDING_ATTENDANCE_PROCESSING',
      severity: 'error',
      message: 'Complete pending attendance processing before payroll review',
    });
  if (
    p.period_start.slice(0, 7) !== p.period_end.slice(0, 7) &&
    rules.some((r) => r.type !== 'bir' && r.rules.frequency === 'monthly')
  )
    issues.push({
      code: 'UNSUPPORTED_MONTHLY_ALLOCATION',
      severity: 'error',
      message:
        'Cross-month payroll requires monthly statutory allocation not supported in this phase; split the period at month end',
    });
  const configuration = (
    await c.query(
      'SELECT configuration,revision FROM payroll_configurations WHERE organization_id=$1',
      [org],
    )
  ).rows;
  const windowError = periodWindowError(
    p.period_start,
    p.period_end,
    p.pay_frequency,
    configuration[0]?.configuration,
  );
  if (windowError)
    issues.push({ code: 'INVALID_PERIOD_WINDOW', severity: 'error', message: windowError });
  const contexts: EmployeePayrollContext[] = [];
  const employmentByEmployee = groupBy(employment, (row) => row.employeeId),
    leavesByEmployee = groupBy(leaves, (row) => String(row.employee_id)),
    evidenceByEmployee = groupBy(evidence, (row) => String(row.employee_id)),
    entriesByEmployee = groupBy(entries, (row) => row.employee_id),
    priorByEmployee = groupBy(prior, (row) => String(row.employee_id));
  const expectedByDay = new Map(expected.map((row) => [`${row.employee_id}:${row.date}`, row])),
    attendanceByDay = new Map(
      attendance.map((row) => [`${row.employee_id}:${row.work_date}`, row]),
    );
  for (const employee of employees) {
    const emp = employmentByEmployee.get(employee.id) ?? [],
      days: PayrollDay[] = [];
    for (const date of dateList(p.period_start, p.period_end)) {
      const scheduled = expectedByDay.get(`${employee.id}:${date}`),
        fact = attendanceByDay.get(`${employee.id}:${date}`);
      const eligible = emp.some(
        (v) =>
          v.effectiveFrom <= date &&
          (!v.effectiveTo || v.effectiveTo > date) &&
          v.hireDate <= date &&
          (!v.terminationDate || v.terminationDate >= date) &&
          ['active', 'on_leave'].includes(v.employmentStatus) &&
          v.payFrequency === p.pay_frequency,
      );
      if (!scheduled || scheduled.scheduled_minutes === null) {
        if (
          eligible ||
          (policy?.prorationBasis === 'scheduled_minutes' &&
            emp.some((v) => v.payType === 'monthly'))
        )
          issues.push({
            employeeId: employee.id,
            code: 'MISSING_SCHEDULE',
            severity: 'error',
            message: `${employee.employee_number} has no schedule for ${date}`,
          });
        continue;
      }
      const scheduledMinutes = scheduled.scheduled_minutes;
      if (!eligible) {
        days.push({
          date,
          scheduledMinutes,
          workedMinutes: 0,
          lateMinutes: 0,
          undertimeMinutes: 0,
          paidLeaveMinutes: 0,
          unpaidLeaveMinutes: 0,
          absent: false,
          approved: true,
          complete: true,
          revision: 0,
          attendanceId: '',
        });
        continue;
      }
      if (!fact && scheduledMinutes === 0) {
        days.push({
          date,
          scheduledMinutes: 0,
          workedMinutes: 0,
          lateMinutes: 0,
          undertimeMinutes: 0,
          paidLeaveMinutes: 0,
          unpaidLeaveMinutes: 0,
          absent: false,
          approved: true,
          complete: true,
          revision: 0,
          attendanceId: '',
        });
        continue;
      }
      if (!fact) {
        issues.push({
          employeeId: employee.id,
          code: 'MISSING_ATTENDANCE',
          severity: 'error',
          message: `${employee.employee_number} has no processed attendance for ${date}`,
        });
        continue;
      }
      let paid = 0,
        unpaid = 0;
      for (const leave of fact.result.leaves ?? []) {
        const minutes =
          leave.durationType === 'full_day'
            ? scheduledMinutes
            : leave.durationType === 'first_half'
              ? Math.floor(scheduledMinutes / 2)
              : scheduledMinutes - Math.floor(scheduledMinutes / 2);
        if (leave.typeSnapshot.paid) paid += minutes;
        else unpaid += minutes;
      }
      const sourceLeaves = (leavesByEmployee.get(employee.id) ?? [])
        .filter(
          (l) =>
            l.employee_id === employee.id &&
            l.status === 'approved' &&
            l.start_date <= date &&
            l.end_date >= date,
        )
        .map((l) => ({ id: l.id, revision: l.revision }));
      const snapLeaves = (fact.result.leaves ?? []).map((l) => ({
        id: l.id,
        revision: l.revision,
      }));
      const shift = fact.result.schedule?.shift;
      const start = shift ? shift.start - 7200000 : scheduled.day_start.getTime(),
        end = shift ? shift.end + 7200000 : scheduled.day_end.getTime();
      const liveEvidence = (evidenceByEmployee.get(employee.id) ?? [])
        .filter((e) => {
          const time = new Date(e.corrected_at ?? e.recorded_at).getTime();
          return (
            e.employee_id === employee.id && time >= start && (shift ? time <= end : time < end)
          );
        })
        .map((e) => ({
          id: String(e.id),
          correctionRevision: e.revision ?? null,
          operation: e.operation ?? null,
        }));
      const storedEvidence = (fact.result.evidence ?? []).map((e) => ({
        id: e.id,
        correctionRevision: e.correctionRevision ?? null,
        operation: e.operation ?? null,
      }));
      const byId = (a: { id: string }, b: { id: string }) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      const newerEvidence =
        fingerprint(liveEvidence.sort(byId)) !== fingerprint(storedEvidence.sort(byId));
      if (
        fact.result.schedule?.versionId !== scheduled.version_id ||
        fact.result.schedule?.assignmentId !== scheduled.assignment_id ||
        fingerprint(sourceLeaves.sort((a, b) => a.id.localeCompare(b.id))) !==
          fingerprint(snapLeaves.sort((a, b) => a.id.localeCompare(b.id))) ||
        newerEvidence
      )
        issues.push({
          employeeId: employee.id,
          code: 'OUTDATED_ATTENDANCE',
          severity: 'error',
          message: `${employee.employee_number} attendance for ${date} must be reprocessed and approved`,
        });
      days.push({
        date,
        scheduledMinutes,
        workedMinutes: fact.worked_minutes,
        lateMinutes: fact.late_minutes,
        undertimeMinutes: fact.undertime_minutes,
        paidLeaveMinutes: paid,
        unpaidLeaveMinutes: unpaid,
        absent: fact.attendance_status === 'absent',
        approved: fact.approval_status === 'approved',
        complete:
          fact.result.complete &&
          (fact.result.flags ?? []).length === 0 &&
          fact.attendance_status !== 'incomplete',
        revision: fact.revision,
        attendanceId: fact.id,
      });
    }
    if (!policy) continue;
    const relevant = (entriesByEmployee.get(employee.id) ?? []).filter(
      (e) =>
        e.employee_id === employee.id &&
        (!e.start_date ||
          emp.some((v) => {
            const start = [v.effectiveFrom, v.hireDate, p.period_start, e.start_date!]
              .sort()
              .at(-1)!;
            const end = [
              v.effectiveTo
                ? new Date(Date.parse(v.effectiveTo + 'T00:00:00Z') - 86400000)
                    .toISOString()
                    .slice(0, 10)
                : p.period_end,
              v.terminationDate ?? p.period_end,
              p.period_end,
              e.end_date ?? p.period_end,
            ].sort()[0]!;
            return (
              start <= end &&
              ['active', 'on_leave'].includes(v.employmentStatus) &&
              v.payFrequency === p.pay_frequency
            );
          })),
    );
    const lines = (kind: string): PayrollLine[] =>
      relevant
        .filter((e) => e.kind === kind)
        .map((e) => ({
          code: e.code,
          description: e.name,
          amount: Number(e.amount),
          taxable: kind === 'earning' && e.taxable,
          metadata: {
            entryId: e.id,
            typeId: e.type_id,
            reason: e.reason,
            recurring: e.period_id === null,
            typeRevision: e.type_revision,
          },
        }));
    const priorEmployee = priorByEmployee.get(employee.id) ?? [];
    const priorContributions: EmployeePayrollContext['priorContributions'] = {};
    for (const row of priorEmployee)
      for (const share of row.contributions as {
        type: AppliedRule['type'];
        employee: number;
        employer: number;
      }[]) {
        const old = priorContributions[share.type] ?? { employee: 0, employer: 0 };
        priorContributions[share.type] = {
          employee: exactSum([old.employee, Number(share.employee)]),
          employer: exactSum([old.employer, Number(share.employer)]),
        };
      }
    const context: EmployeePayrollContext = {
      employeeId: employee.id,
      period: {
        start: p.period_start,
        end: p.period_end,
        payDate: p.pay_date,
        frequency: p.pay_frequency,
        isLastPeriodOfMonth:
          p.period_end ===
          new Date(Date.UTC(Number(p.period_end.slice(0, 4)), Number(p.period_end.slice(5, 7)), 0))
            .toISOString()
            .slice(0, 10),
      },
      policy,
      employment: emp,
      days,
      earnings: lines('earning'),
      deductions: lines('deduction'),
      rules: rules.map((r) => ({
        id: r.id,
        type: r.type,
        version: r.version,
        rules: statutoryRulesSchema.parse(r.rules),
      })),
      priorContributions,
    };
    // Contribution monthly basis is actual month-to-date finalized pay plus this run.
    // Require contiguous finalized coverage when a monthly collection is due.
    const collecting =
      context.period.isLastPeriodOfMonth || policy.contributionCutoff === 'every_period';
    if (collecting && rules.some((r) => r.type !== 'bir' && r.rules.frequency === 'monthly')) {
      const eligibleDates = dateList(monthStart, p.period_end).filter((date) =>
        emp.some(
          (v) =>
            v.hireDate <= date &&
            v.effectiveFrom <= date &&
            (!v.effectiveTo || v.effectiveTo > date) &&
            (!v.terminationDate || v.terminationDate >= date) &&
            ['active', 'on_leave'].includes(v.employmentStatus),
        ),
      );
      if (
        eligibleDates.some(
          (date) =>
            date < p.period_start &&
            !priorEmployee.some((r) => r.period_start <= date && r.period_end >= date),
        )
      )
        issues.push({
          employeeId: employee.id,
          code: 'MISSING_PRIOR_MONTHLY_PAYROLL',
          severity: 'error',
          message: `${employee.employee_number} requires earlier finalized monthly payroll coverage`,
        });
    }
    // Use the pure basic/earning pipeline to establish the current contribution basis.
    try {
      const draft = computeEmployeePayroll({ ...context, rules: [] });
      context.monthlyBasis = {
        basic: exactSum([draft.basicPay, ...priorEmployee.map((r) => Number(r.basic_pay))]),
        gross: exactSum([draft.grossPay, ...priorEmployee.map((r) => Number(r.gross_pay))]),
      };
    } catch (_error) {
      issues.push({
        employeeId: employee.id,
        code: 'INVALID_EMPLOYEE_INPUT',
        severity: 'error',
        message: `${employee.employee_number} has invalid compensation or timekeeping amounts`,
      });
    }
    contexts.push(context);
  }
  const snapshot = {
    company,
    period: {
      id: p.id,
      start: p.period_start,
      end: p.period_end,
      payDate: p.pay_date,
      frequency: p.pay_frequency,
    },
    engineVersion: PAYROLL_ENGINE_VERSION,
    employees,
    employment,
    attendance: attendance.map((r) => ({ ...r, updated_at: r.updated_at.toISOString() })),
    expected,
    policies,
    rules: rules.map((r) => ({
      id: r.id,
      type: r.type,
      version: r.version,
      rules: r.rules,
      checksum: r.content_checksum,
    })),
    entries,
    jobs,
    leaves,
    evidence,
    prior,
    configuration,
  };
  return { snapshot, contexts, issues, policy };
}
const emptyResult = (id: string, message: string): PayrollResult => ({
  employeeId: id,
  basicPay: 0,
  grossPay: 0,
  ordinaryDeductions: 0,
  employeeContributions: 0,
  employerContributions: 0,
  withholdingTax: 0,
  totalDeductions: 0,
  taxableCompensation: 0,
  netPay: 0,
  earnings: [],
  deductions: [],
  contributions: [],
  taxTrace: {},
  issues: [{ code: 'EMPLOYEE_CALCULATION_FAILED', severity: 'error', message }],
});
export async function saveResult(
  c: PoolClient,
  a: Actor,
  runId: string,
  result: PayrollResult,
  snapshot: unknown,
) {
  const r = (
    await c.query(
      `INSERT INTO employee_payroll_results(organization_id,payroll_run_id,employee_id,basic_pay,gross_pay,ordinary_deductions,employee_contributions,employer_contributions,withholding_tax,taxable_compensation,total_deductions,net_pay,snapshot,tax_trace,issues,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        a.organizationId,
        runId,
        result.employeeId,
        result.basicPay,
        result.grossPay,
        result.ordinaryDeductions,
        result.employeeContributions,
        result.employerContributions,
        result.withholdingTax,
        result.taxableCompensation,
        result.totalDeductions,
        result.netPay,
        JSON.stringify(snapshot),
        JSON.stringify(result.taxTrace),
        JSON.stringify(result.issues),
        result.issues.some((i) => i.severity === 'error') ? 'failed' : 'computed',
      ],
    )
  ).rows[0]!;
  await event(c, a, 'employee_payroll_results', r, 'Employee payroll computed');
  for (const [table, lines] of [
    ['payroll_earning_lines', result.earnings],
    ['payroll_deduction_lines', result.deductions],
  ] as const)
    for (const line of lines) {
      const row = (
        await c.query(
          `INSERT INTO ${table}(organization_id,result_id,code,description,amount,taxable,metadata) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            a.organizationId,
            r.id,
            line.code,
            line.description,
            line.amount,
            line.taxable,
            JSON.stringify(line.metadata),
          ],
        )
      ).rows[0]!;
      await event(c, a, table, row, 'Payroll line computed');
    }
  for (const line of result.contributions) {
    const row = (
      await c.query(
        'INSERT INTO payroll_contribution_lines(organization_id,result_id,type,rule_set_id,employee_share,employer_share,basis_amount,tax_deductible,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [
          a.organizationId,
          r.id,
          line.type,
          line.ruleSetId,
          line.employeeShare,
          line.employerShare,
          line.basisAmount,
          line.taxDeductible,
          JSON.stringify(line.metadata),
        ],
      )
    ).rows[0]!;
    await event(c, a, 'payroll_contribution_lines', row, 'Contribution computed');
  }
}
export function createPayrollService(pool: Pool) {
  async function mutation<T>(
    a: Actor,
    permission: Permission,
    work: (c: PoolClient, org: string) => Promise<T>,
  ) {
    requirePermission(a, permission);
    const org = organization(a);
    return transaction(pool, async (c) => {
      await payrollLock(c, org);
      return work(c, org);
    });
  }
  return {
    async list(a: Actor) {
      requirePermission(a, 'payroll.view');
      return (
        await pool.query(
          'SELECT p.*,r.totals,r.status run_status FROM payroll_periods p LEFT JOIN payroll_runs r ON r.id=p.latest_run_id WHERE p.organization_id=$1 ORDER BY p.period_start DESC',
          [organization(a)],
        )
      ).rows;
    },
    async detail(a: Actor, id: string, runId?: string) {
      requirePermission(a, 'payroll.view');
      return transaction(pool, async (c) => {
        const org = organization(a);
        await payrollLock(c, org);
        const p = await period(c, org, id);
        const runs = (
          await c.query(
            'SELECT id,status,totals,issues,engine_version,prepared_by,created_at,input_hash FROM payroll_runs WHERE organization_id=$1 AND period_id=$2 ORDER BY created_at DESC,id DESC',
            [org, id],
          )
        ).rows;
        const results = (
          await c.query(
            "SELECT e.*,COALESCE(e.snapshot->'employee'->>'employee_number',s.employee_number) employee_number,COALESCE(e.snapshot->'employee'->>'first_name',s.first_name) first_name,COALESCE(e.snapshot->'employee'->>'last_name',s.last_name) last_name FROM employee_payroll_results e JOIN employees s ON s.id=e.employee_id WHERE e.organization_id=$1 AND e.payroll_run_id=$2 ORDER BY s.employee_number",
            [org, runId ?? p.latest_run_id],
          )
        ).rows;
        if (runId && !runs.some((r) => r.id === runId))
          throw new DomainError(404, 'NOT_FOUND', 'Payroll run not found');
        let stale = false;
        if (!runId && p.latest_run_id && !['finalized', 'cancelled'].includes(p.status)) {
          const r = (
            await c.query('SELECT input_hash FROM payroll_runs WHERE id=$1', [p.latest_run_id])
          ).rows[0]!;
          stale = r.input_hash !== fingerprint((await loadContext(c, p)).snapshot);
        }
        return { period: p, runs, results, stale };
      });
    },
    async result(a: Actor, periodId: string, id: string) {
      requirePermission(a, 'payroll.view');
      const r = (
        await pool.query(
          'SELECT e.*,p.id period_id,p.pay_date,p.period_start,p.period_end,r.engine_version FROM employee_payroll_results e JOIN payroll_runs r ON r.id=e.payroll_run_id JOIN payroll_periods p ON p.id=r.period_id WHERE e.organization_id=$1 AND e.id=$2 AND p.id=$3',
          [organization(a), id, periodId],
        )
      ).rows[0];
      if (!r) throw new DomainError(404, 'NOT_FOUND', 'Employee payroll result not found');
      const lines: Record<string, unknown> = {};
      for (const table of [
        'payroll_earning_lines',
        'payroll_deduction_lines',
        'payroll_contribution_lines',
      ])
        lines[table] = (
          await pool.query(
            `SELECT * FROM ${table} WHERE result_id=$1 AND organization_id=$2 ORDER BY id`,
            [id, organization(a)],
          )
        ).rows;
      return { ...r, ...lines };
    },
    createPeriod(a: Actor, input: z.infer<typeof payrollPeriodInputSchema>) {
      return mutation(a, 'payroll.create_period', async (c, org) => {
        const configuration = (
          await c.query(
            'SELECT configuration FROM payroll_configurations WHERE organization_id=$1',
            [org],
          )
        ).rows[0]?.configuration;
        const invalid = periodWindowError(
          input.periodStart,
          input.periodEnd,
          input.payFrequency,
          configuration,
        );
        if (invalid) throw new DomainError(400, 'INVALID_PERIOD_WINDOW', invalid);
        const row = (
          await c.query(
            'INSERT INTO payroll_periods(organization_id,code,name,period_start,period_end,pay_date,pay_frequency,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
            [
              org,
              input.code,
              input.name,
              input.periodStart,
              input.periodEnd,
              input.payDate,
              input.payFrequency,
              a.id,
            ],
          )
        ).rows[0]!;
        await event(c, a, 'payroll_periods', row, 'Payroll period created');
        return row;
      });
    },
    compute(
      a: Actor,
      id: string,
      input: { expectedRevision: number; idempotencyKey: string },
      recompute = false,
    ) {
      return mutation(a, recompute ? 'payroll.recompute' : 'payroll.compute', async (c, org) => {
        const p = await period(c, org, id, true);
        editable(p);
        const existing = (
          await c.query('SELECT * FROM payroll_runs WHERE period_id=$1 AND idempotency_key=$2', [
            id,
            input.idempotencyKey,
          ])
        ).rows[0];
        if (existing) return { ...existing, snapshot: undefined };
        revision(p, input.expectedRevision);
        if (p.status !== 'open' && p.status !== 'review')
          throw new DomainError(
            409,
            'INVALID_PAYROLL_STATE',
            'Open the payroll period before computing',
          );
        if (p.latest_run_id && !recompute)
          throw new DomainError(
            409,
            'RECOMPUTE_REQUIRED',
            'Use recompute to preserve previous payroll history',
          );
        const loaded = await loadContext(c, p);
        const run = (
          await c.query(
            "INSERT INTO payroll_runs(organization_id,period_id,idempotency_key,status,engine_version,input_hash,snapshot,prepared_by) VALUES($1,$2,$3,'processing',$4,$5,$6,$7) RETURNING *",
            [
              org,
              id,
              input.idempotencyKey,
              PAYROLL_ENGINE_VERSION,
              fingerprint(loaded.snapshot),
              JSON.stringify(loaded.snapshot),
              a.id,
            ],
          )
        ).rows[0]!;
        const results: PayrollResult[] = [];
        const saveResults: (() => Promise<void>)[] = [];
        for (const context of loaded.contexts) {
          let result: PayrollResult;
          try {
            result = computeEmployeePayroll(context);
          } catch (_e) {
            result = emptyResult(
              context.employeeId,
              'Invalid compensation, rate, or monetary range; inspect employee inputs',
            );
          }
          result.issues.push(
            ...loaded.issues.filter((i) => !i.employeeId || i.employeeId === context.employeeId),
          );
          results.push(result);
          const employee = (loaded.snapshot.employees as { id: string }[]).find(
            (e) => e.id === context.employeeId,
          );
          saveResults.push(() =>
            saveResult(c, a, run.id, result, {
              company: loaded.snapshot.company,
              engineVersion: PAYROLL_ENGINE_VERSION,
              employee,
              context,
              policyVersion: (loaded.snapshot.policies as unknown[])[0],
              payrollConfiguration: (loaded.snapshot.configuration as unknown[])[0] ?? null,
              attendanceFacts: (loaded.snapshot.attendance as AttendanceRow[])
                .filter((fact) => fact.employee_id === context.employeeId)
                .map((fact) => ({
                  id: fact.id,
                  date: fact.work_date,
                  revision: fact.revision,
                  approvalStatus: fact.approval_status,
                  schedule: fact.result.schedule,
                  leaves: fact.result.leaves,
                })),
            }),
          );
        }
        for (const employee of loaded.snapshot.employees as { id: string }[]) {
          if (results.some((r) => r.employeeId === employee.id)) continue;
          const failed = emptyResult(employee.id, 'No monetary policy covers the payroll period');
          failed.issues.push(...loaded.issues);
          results.push(failed);
          saveResults.push(() =>
            saveResult(c, a, run.id, failed, {
              engineVersion: PAYROLL_ENGINE_VERSION,
              employee,
              policy: null,
            }),
          );
        }
        const issues = [
          ...loaded.issues,
          ...results.flatMap((r) => r.issues.map((i) => ({ ...i, employeeId: r.employeeId }))),
        ];
        const totals: Record<string, number> = { employees: results.length };
        for (const key of [
          'basicPay',
          'grossPay',
          'ordinaryDeductions',
          'employeeContributions',
          'employerContributions',
          'withholdingTax',
          'totalDeductions',
          'netPay',
        ] as const)
          totals[key] = exactSum(results.map((r) => r[key]));
        const updated = (
          await c.query(
            'UPDATE payroll_runs SET status=$2,totals=$3,issues=$4 WHERE id=$1 RETURNING *',
            [
              run.id,
              issues.some((i) => i.severity === 'error') ? 'failed' : 'computed',
              JSON.stringify(totals),
              JSON.stringify(issues),
            ],
          )
        ).rows[0]!;
        // Run aggregate events omit the batch snapshot; per-result events carry reproducible inputs.
        await event(
          c,
          a,
          'payroll_runs',
          updated,
          recompute ? 'Payroll recomputed' : 'Payroll computed',
        );
        // Publish the parent run before employee results and their lines.
        for (const save of saveResults) await save();
        const changed = (
          await c.query(
            "UPDATE payroll_periods SET latest_run_id=$2,status='review',reviewed_run_id=NULL,reviewed_by=NULL,reviewed_at=NULL,warning_acknowledgments='[]',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",
            [id, run.id],
          )
        ).rows[0]!;
        await event(c, a, 'payroll_periods', changed, 'Payroll submitted for review', 'UPDATE');
        return { ...updated, snapshot: undefined };
      });
    },
    async transition(
      a: Actor,
      id: string,
      action: 'open' | 'cancel' | 'review' | 'finalize',
      input: { expectedRevision: number; warningAcknowledgments: string[] },
    ) {
      try {
        return await mutation(
          a,
          action === 'open' || action === 'cancel'
            ? 'payroll.create_period'
            : action === 'review'
              ? 'payroll.review'
              : 'payroll.finalize',
          async (c, org) => {
            const p = await period(c, org, id, true);
            editable(p);
            revision(p, input.expectedRevision);
            if (action === 'open' && p.status !== 'draft')
              throw new DomainError(
                409,
                'INVALID_PAYROLL_STATE',
                'Only draft payroll can be opened',
              );
            if (action === 'review' || action === 'finalize') {
              if (!p.latest_run_id || p.status !== 'review')
                throw new DomainError(409, 'PAYROLL_NOT_COMPUTED', 'Compute payroll before review');
              const run = (
                await c.query('SELECT * FROM payroll_runs WHERE id=$1 AND organization_id=$2', [
                  p.latest_run_id,
                  org,
                ])
              ).rows[0]!;
              if (
                run.status !== 'computed' ||
                (run.issues as PayrollIssue[]).some((i) => i.severity === 'error')
              )
                throw new DomainError(
                  409,
                  'PAYROLL_HAS_ERRORS',
                  'Resolve payroll calculation errors before review or finalization',
                );
              if (run.input_hash !== fingerprint((await loadContext(c, p)).snapshot))
                throw new DomainError(
                  409,
                  'STALE_PAYROLL',
                  'Payroll inputs changed; recompute before review or finalization',
                );
              const warnings = (run.issues as PayrollIssue[])
                .filter((i) => i.severity === 'warning')
                .map((i) => i.code);
              if (warnings.some((code) => !input.warningAcknowledgments.includes(code)))
                throw new DomainError(
                  409,
                  'WARNINGS_NOT_ACKNOWLEDGED',
                  'Acknowledge every payroll warning',
                );
              if (action === 'finalize') {
                if (p.reviewed_run_id !== p.latest_run_id)
                  throw new DomainError(
                    409,
                    'REVIEW_REQUIRED',
                    'Review the latest payroll run before finalization',
                  );
                await reconcile(c, p.latest_run_id, run.totals);
                // Result statuses remain computed/failed; the authoritative freeze is the run and period.
                const frozen = (
                  await c.query(
                    'UPDATE payroll_runs SET finalized=true,revision=revision+1 WHERE id=$1 RETURNING *',
                    [p.latest_run_id],
                  )
                ).rows[0]!;
                await event(
                  c,
                  a,
                  'payroll_runs',
                  { ...frozen, snapshot: undefined },
                  'Payroll run finalized',
                  'UPDATE',
                );
              }
            }
            const sql =
              action === 'review'
                ? 'UPDATE payroll_periods SET reviewed_run_id=latest_run_id,reviewed_by=$2,reviewed_at=now(),warning_acknowledgments=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *'
                : action === 'finalize'
                  ? "UPDATE payroll_periods SET status='finalized',finalized_by=$2,finalized_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *"
                  : 'UPDATE payroll_periods SET status=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *';
            const args =
              action === 'review'
                ? [id, a.id, JSON.stringify(input.warningAcknowledgments)]
                : action === 'finalize'
                  ? [id, a.id]
                  : [id, action === 'open' ? 'open' : 'cancelled'];
            const row = (await c.query(sql, args)).rows[0]!;
            await event(
              c,
              a,
              'payroll_periods',
              row,
              `Payroll ${action === 'review' ? 'reviewed' : action === 'finalize' ? 'finalized' : action === 'cancel' ? 'cancelled' : 'opened'}`,
              'UPDATE',
            );
            return row;
          },
        );
      } catch (error) {
        if (action === 'finalize' && a.organizationId && a.permissions.includes('payroll.finalize'))
          await transaction(pool, async (c) => {
            await c.query(
              "INSERT INTO audit_events(organization_id,user_id,action,entity_type,entity_id,description,metadata) VALUES($1,$2,'UPDATE','payroll_periods',$3,'Payroll finalization failed',$4)",
              [
                a.organizationId,
                a.id,
                id,
                JSON.stringify({
                  code: error instanceof DomainError ? error.code : 'TRANSACTION_FAILED',
                }),
              ],
            );
          });
        throw error;
      }
    },
    async configuration(
      a: Actor,
      section: 'types' | 'entries' | 'policies' | 'rules',
      kind?: 'earning' | 'deduction',
    ) {
      const permissions: Record<typeof section, Permission> = {
        types: kind === 'deduction' ? 'deductions.view' : 'earnings.view',
        entries: kind === 'deduction' ? 'deductions.view' : 'earnings.view',
        policies: 'payroll_config.view',
        rules: kind === 'deduction' ? 'tax.view' : 'contributions.view',
      };
      requirePermission(a, permissions[section]);
      const org = organization(a);
      if (section === 'types')
        return (
          await pool.query(
            'SELECT * FROM payroll_types WHERE organization_id=$1 AND kind=$2 ORDER BY code',
            [org, kind ?? 'earning'],
          )
        ).rows;
      if (section === 'entries')
        return (
          await pool.query(
            'SELECT e.*,t.name,t.code,t.kind,s.employee_number FROM payroll_entries e JOIN payroll_types t ON t.id=e.type_id JOIN employees s ON s.id=e.employee_id WHERE e.organization_id=$1 AND t.kind=$2 ORDER BY e.created_at DESC',
            [org, kind ?? 'earning'],
          )
        ).rows;
      if (section === 'rules')
        return (
          await pool.query(
            "SELECT * FROM statutory_rule_sets WHERE organization_id=$1 AND ($2='bir' AND type='bir' OR $2<>'bir' AND type<>'bir') ORDER BY type,effective_from DESC",
            [org, kind === 'deduction' ? 'bir' : 'contributions'],
          )
        ).rows;
      return (
        await pool.query(
          'SELECT * FROM payroll_policies WHERE organization_id=$1 ORDER BY effective_from DESC',
          [org],
        )
      ).rows;
    },
    createType(a: Actor, input: z.infer<typeof payrollTypeInputSchema>) {
      return mutation(
        a,
        input.kind === 'earning' ? 'earnings.manage' : 'deductions.manage',
        async (c, org) => {
          const row = (
            await c.query(
              'INSERT INTO payroll_types(organization_id,kind,code,name,taxable,category,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
              [
                org,
                input.kind,
                input.code,
                input.name,
                input.taxable,
                input.category,
                input.active,
              ],
            )
          ).rows[0]!;
          await event(c, a, 'payroll_types', row, 'Payroll type created');
          return row;
        },
      );
    },
    typeStatus(a: Actor, id: string, input: { active: boolean; expectedRevision: number }) {
      return transaction(pool, async (c) => {
        const org = organization(a);
        await payrollLock(c, org);
        const old = (
          await c.query(
            'SELECT * FROM payroll_types WHERE organization_id=$1 AND id=$2 FOR UPDATE',
            [org, id],
          )
        ).rows[0];
        if (!old) throw new DomainError(404, 'NOT_FOUND', 'Payroll type not found');
        requirePermission(a, old.kind === 'earning' ? 'earnings.manage' : 'deductions.manage');
        if (old.revision !== input.expectedRevision)
          throw new DomainError(
            409,
            'REVISION_CONFLICT',
            'Payroll type changed; refresh before continuing',
          );
        const row = (
          await c.query(
            'UPDATE payroll_types SET active=$2,revision=revision+1 WHERE id=$1 RETURNING *',
            [id, input.active],
          )
        ).rows[0]!;
        await event(c, a, 'payroll_types', row, 'Payroll type status changed', 'UPDATE');
        return row;
      });
    },
    createEntry(a: Actor, input: z.infer<typeof payrollEntryInputSchema>) {
      return transaction(pool, async (c) => {
        const org = organization(a);
        await payrollLock(c, org);
        const type = (
          await c.query(
            'SELECT kind FROM payroll_types WHERE organization_id=$1 AND id=$2 AND active',
            [org, input.typeId],
          )
        ).rows[0];
        if (!type) throw new DomainError(400, 'INVALID_TYPE', 'Select an active payroll type');
        requirePermission(a, type.kind === 'earning' ? 'earnings.manage' : 'deductions.manage');
        if (input.periodId) editable(await period(c, org, input.periodId, true));
        const row = (
          await c.query(
            'INSERT INTO payroll_entries(organization_id,employee_id,type_id,amount,reason,period_id,start_date,end_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
            [
              org,
              input.employeeId,
              input.typeId,
              input.amount,
              input.reason,
              input.periodId,
              input.startDate,
              input.endDate,
              a.id,
            ],
          )
        ).rows[0]!;
        await event(c, a, 'payroll_entries', row, `Manual ${type.kind} added`);
        return row;
      });
    },
    deactivateEntry(a: Actor, id: string, expected: number) {
      return transaction(pool, async (c) => {
        const org = organization(a);
        await payrollLock(c, org);
        const entry = (
          await c.query(
            'SELECT e.*,t.kind FROM payroll_entries e JOIN payroll_types t ON t.id=e.type_id WHERE e.organization_id=$1 AND e.id=$2 FOR UPDATE OF e',
            [org, id],
          )
        ).rows[0];
        if (!entry) throw new DomainError(404, 'NOT_FOUND', 'Payroll entry not found');
        requirePermission(a, entry.kind === 'earning' ? 'earnings.manage' : 'deductions.manage');
        if (entry.revision !== expected)
          throw new DomainError(409, 'REVISION_CONFLICT', 'Payroll entry changed');
        if (entry.period_id) editable(await period(c, org, entry.period_id, true));
        const row = (
          await c.query(
            'UPDATE payroll_entries SET active=false,revision=revision+1 WHERE id=$1 RETURNING *',
            [id],
          )
        ).rows[0]!;
        await event(c, a, 'payroll_entries', row, 'Payroll entry deactivated', 'UPDATE');
        return row;
      });
    },
    createPolicy(a: Actor, input: z.infer<typeof payrollPolicyInputSchema>) {
      return mutation(a, 'payroll_config.update', async (c, org) => {
        if (input.supersedesId)
          await supersede(c, a, 'payroll_policies', input.supersedesId, input.effectiveFrom);
        const row = (
          await c.query(
            'INSERT INTO payroll_policies(organization_id,version,effective_from,effective_to,policy,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            [
              org,
              input.version,
              input.effectiveFrom,
              input.effectiveTo,
              JSON.stringify(input.policy),
              a.id,
            ],
          )
        ).rows[0]!;
        await event(c, a, 'payroll_policies', row, 'Payroll monetary policy version created');
        return row;
      });
    },
    importRules(a: Actor, input: z.infer<typeof statutoryImportSchema>) {
      return mutation(
        a,
        input.type === 'bir' ? 'tax.configure' : 'contributions.configure',
        async (c, org) => {
          const row = (
            await c.query(
              'INSERT INTO statutory_rule_sets(organization_id,type,version,effective_from,effective_to,agency,source_title,source_reference,verification_note,content_checksum,rules,imported_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
              [
                org,
                input.type,
                input.version,
                input.effectiveFrom,
                input.effectiveTo,
                input.agency,
                input.sourceTitle,
                input.sourceReference,
                input.verificationNote,
                fingerprint(input),
                JSON.stringify(input.rules),
                a.id,
              ],
            )
          ).rows[0]!;
          await event(c, a, 'statutory_rule_sets', row, 'Statutory reference version imported');
          return row;
        },
      );
    },
    activateRules(a: Actor, id: string, expected: number, supersedesId: string | null = null) {
      return transaction(pool, async (c) => {
        const org = organization(a);
        await payrollLock(c, org);
        const rule = (
          await c.query(
            'SELECT * FROM statutory_rule_sets WHERE organization_id=$1 AND id=$2 FOR UPDATE',
            [org, id],
          )
        ).rows[0];
        if (!rule) throw new DomainError(404, 'NOT_FOUND', 'Statutory version not found');
        requirePermission(a, rule.type === 'bir' ? 'tax.configure' : 'contributions.configure');
        if (rule.revision !== expected || rule.status !== 'draft')
          throw new DomainError(
            409,
            'REVISION_CONFLICT',
            'Only the current draft version can be activated',
          );
        statutoryRulesSchema.parse(rule.rules);
        if (supersedesId)
          await supersede(c, a, 'statutory_rule_sets', supersedesId, rule.effective_from, {
            type: rule.type,
            frequency: rule.rules.frequency,
          });
        const row = (
          await c.query(
            "UPDATE statutory_rule_sets SET status='active',verified_by=$2,verified_at=now(),revision=revision+1 WHERE id=$1 RETURNING *",
            [id, a.id],
          )
        ).rows[0]!;
        await event(
          c,
          a,
          'statutory_rule_sets',
          row,
          'Verified statutory reference version activated',
          'UPDATE',
        );
        return row;
      });
    },
  };
}
export async function reconcile(c: PoolClient, runId: string, totals: Record<string, number>) {
  const results = (
    await c.query('SELECT * FROM employee_payroll_results WHERE payroll_run_id=$1', [runId])
  ).rows;
  if (!results.length)
    throw new DomainError(409, 'EMPTY_PAYROLL', 'Cannot finalize an empty payroll');
  const earnings = (
    await c.query(
      'SELECT l.result_id,sum(l.amount)::text amount FROM payroll_earning_lines l JOIN employee_payroll_results e ON e.id=l.result_id WHERE e.payroll_run_id=$1 GROUP BY l.result_id',
      [runId],
    )
  ).rows;
  const deductions = (
    await c.query(
      'SELECT l.result_id,sum(l.amount)::text amount FROM payroll_deduction_lines l JOIN employee_payroll_results e ON e.id=l.result_id WHERE e.payroll_run_id=$1 GROUP BY l.result_id',
      [runId],
    )
  ).rows;
  const contributions = (
    await c.query(
      'SELECT l.result_id,sum(l.employee_share)::text employee,sum(l.employer_share)::text employer FROM payroll_contribution_lines l JOIN employee_payroll_results e ON e.id=l.result_id WHERE e.payroll_run_id=$1 GROUP BY l.result_id',
      [runId],
    )
  ).rows;
  for (const r of results) {
    const share = contributions.find((l) => l.result_id === r.id);
    if (
      r.status === 'failed' ||
      Number(r.net_pay) < 0 ||
      Number(r.gross_pay) !== Number(earnings.find((l) => l.result_id === r.id)?.amount ?? 0) ||
      Number(r.ordinary_deductions) !==
        Number(deductions.find((l) => l.result_id === r.id)?.amount ?? 0) ||
      Number(r.employee_contributions) !== Number(share?.employee ?? 0) ||
      Number(r.employer_contributions) !== Number(share?.employer ?? 0)
    )
      throw new DomainError(409, 'RECONCILIATION_FAILED', 'Payroll result lines do not reconcile');
  }
  for (const [key, column] of Object.entries({
    basicPay: 'basic_pay',
    grossPay: 'gross_pay',
    ordinaryDeductions: 'ordinary_deductions',
    employeeContributions: 'employee_contributions',
    employerContributions: 'employer_contributions',
    withholdingTax: 'withholding_tax',
    totalDeductions: 'total_deductions',
    netPay: 'net_pay',
  }))
    if (totals[key] !== exactSum(results.map((r) => Number(r[column]))))
      throw new DomainError(409, 'RECONCILIATION_FAILED', 'Payroll period totals do not reconcile');
  if (totals.employees !== results.length)
    throw new DomainError(
      409,
      'RECONCILIATION_FAILED',
      'Payroll employee count does not reconcile',
    );
}
