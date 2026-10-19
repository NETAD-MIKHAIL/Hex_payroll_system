import { assembleRunSnapshot } from './snapshots.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as tables from '../db/generated/schema.js';
import {
  departmentInputSchema,
  positionInputSchema,
  employeeInputSchema,
  employmentInputSchema,
  statutoryRulesSchema,
  payrollPolicySchema,
  payrollConfigurationSchema,
  leaveTypeInputSchema,
  type CentralEvent,
  type ConflictType,
} from '@hexpayroll/shared';
import { audit, DomainError, normalize, payloadFields } from '../foundation/repository.js';
import { fingerprint, reconcile } from '../payroll/services.js';
import { detectConflict } from './conflict-policy.js';

// A closed registry: neither SQL identifiers nor accepted columns come from clients.
const registry: Record<string, PgTable> = {
  departments: tables.departments,
  positions: tables.positions,
  employees: tables.employees,
  employment_versions: tables.employmentVersions,
  work_schedules: tables.workSchedules,
  work_schedule_versions: tables.workScheduleVersions,
  work_schedule_days: tables.workScheduleDays,
  employee_schedule_assignments: tables.employeeScheduleAssignments,
  time_records: tables.timeRecords,
  time_record_corrections: tables.timeRecordCorrections,
  leave_types: tables.leaveTypes,
  leave_requests: tables.leaveRequests,
  attendance_records: tables.attendanceRecords,
  attendance_adjustments: tables.attendanceAdjustments,
  biometric_devices: tables.biometricDevices,
  biometric_mappings: tables.biometricMappings,
  payroll_periods: tables.payrollPeriods,
  payroll_runs: tables.payrollRuns,
  employee_payroll_results: tables.employeePayrollResults,
  payroll_earning_lines: tables.payrollEarningLines,
  payroll_deduction_lines: tables.payrollDeductionLines,
  payroll_contribution_lines: tables.payrollContributionLines,
  payroll_types: tables.payrollTypes,
  payroll_entries: tables.payrollEntries,
  organizations: tables.organizations,
  statutory_rule_sets: tables.statutoryRuleSets,
  payroll_policies: tables.payrollPolicies,
  payroll_configurations: tables.payrollConfigurations,
};
export const writableDomains = [
  'sync_snapshot_chunk',
  'sync_resolution_proposals',
  ...Object.keys(registry).filter(
    (k) =>
      ![
        'organizations',
        'statutory_rule_sets',
        'payroll_policies',
        'employment_versions',
        'work_schedule_days',
      ].includes(k),
  ),
];
export class ReceiverConflict extends Error {
  constructor(
    public conflictType: ConflictType,
    public current: Record<string, unknown> | null,
    message: string,
  ) {
    super(message);
  }
}
export class MissingDependency extends Error {}
/** Only an explicitly confirmed rejection may remove an unaccepted local branch.
 * Its complete prior aggregate remains in immutable conflict evidence. */
export async function restoreEmploymentAggregate(
  c: PoolClient,
  org: string,
  employeeId: string,
  input: unknown,
) {
  const versions = z.array(z.record(z.string(), z.unknown())).max(1000).parse(input);
  const ids = versions.map((v) => z.uuid().parse(v.id));
  await c.query(
    'DELETE FROM employment_versions WHERE organization_id=$1 AND employee_id=$2 AND NOT(id=ANY($3::uuid[]))',
    [org, employeeId, ids],
  );
  versions.sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)));
  for (const version of versions) {
    if (version.organizationId !== org || version.employeeId !== employeeId)
      throw new DomainError(403, 'EMPLOYMENT_SCOPE', 'Employment identity mismatch');
    employmentInputSchema.parse(
      Object.fromEntries(
        Object.entries(version).filter(([key]) => key in employmentInputSchema.shape),
      ),
    );
    const row = await c.query(
      'SELECT id FROM employment_versions WHERE id=$1 AND organization_id=$2 AND employee_id=$3',
      [version.id, org, employeeId],
    );
    await writeRow(c, 'employment_versions', version, org, !!row.rowCount);
  }
}
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export async function ensureRemoteActor(c: PoolClient, org: string, id: string | null) {
  if (!id) return;
  z.uuid().parse(id);
  const found = await c.query('SELECT organization_id FROM auth_users WHERE id=$1 FOR SHARE', [id]);
  if (found.rows[0]) {
    if (found.rows[0].organization_id !== org)
      throw new DomainError(403, 'ACTOR_SCOPE', 'Actor belongs to another organization');
    return;
  }
  await c.query(
    "INSERT INTO auth_users(id,organization_id,username,display_name,password_hash,active) VALUES($1,$2,$3,'Remote payroll actor','!remote-no-login',false) ON CONFLICT(id) DO NOTHING",
    [id, org, 'remote.' + id],
  );
  const actor = await c.query('SELECT organization_id FROM auth_users WHERE id=$1', [id]);
  if (actor.rows[0]?.organization_id !== org)
    throw new DomainError(403, 'ACTOR_SCOPE', 'Actor identity unavailable');
  await c.query(
    'INSERT INTO sync_remote_actors(organization_id,actor_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [org, id],
  );
}
async function writeRow(
  c: PoolClient,
  table: string,
  input: Record<string, unknown>,
  org: string,
  existing: boolean,
) {
  const definition = registry[table];
  if (!definition)
    throw new DomainError(422, 'ENTITY_UNSUPPORTED', 'Unsupported synchronization entity');
  const cols = getTableColumns(definition);
  const columnMap = new Map(Object.entries(cols).map(([key, col]) => [key, col.name]));
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (table === 'organizations' && key === 'organizationId') continue;
    const column =
      columnMap.get(key) ?? (Object.values(cols).some((col) => col.name === key) ? key : undefined);
    if (!column) throw new DomainError(422, 'PAYLOAD_FIELD', 'Unexpected snapshot field');
    const definition = Object.values(cols).find((col) => col.name === column)!;
    if (definition.columnType.startsWith('PgBigInt') && value !== null) {
      if (
        typeof value === 'number'
          ? !Number.isSafeInteger(value)
          : typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)
      )
        throw new DomainError(422, 'CENTAVO_INTEGER', 'Money must be exact integer centavos');
      if (
        BigInt(value as string | number) > 9007199254740991n ||
        BigInt(value as string | number) < -9007199254740991n
      )
        throw new DomainError(422, 'CENTAVO_RANGE', 'Money exceeds safe integer bounds');
    }
    row[column] = value;
  }
  if (table === 'organizations') {
    if (row.id !== org) throw new DomainError(403, 'SCOPE', 'Organization mismatch');
  } else if (row.organization_id !== org)
    throw new DomainError(403, 'SCOPE', 'Organization mismatch');
  for (const [key, value] of Object.entries(row)) {
    if ((key.endsWith('_by') || key === 'prepared_by') && typeof value === 'string')
      await ensureRemoteActor(c, org, value);
  }
  // PostgreSQL performs typed decoding and its existing domain integrity triggers.
  const names = Object.keys(row);
  const nonId = names.filter((k) => k !== 'id' && k !== 'organization_id');
  if (existing) {
    await c.query(
      `UPDATE ${quote(table)} t SET ${nonId.map((k) => quote(k) + '=r.' + quote(k)).join(',')} FROM jsonb_populate_record(NULL::${quote(table)},$1::jsonb) r WHERE t.id=r.id`,
      [JSON.stringify(row)],
    );
  } else {
    await c.query(
      `INSERT INTO ${quote(table)} (${names.map(quote).join(',')}) SELECT ${names.map(quote).join(',')} FROM jsonb_populate_record(NULL::${quote(table)},$1::jsonb)`,
      [JSON.stringify(row)],
    );
  }
}
export async function currentSnapshot(c: PoolClient, table: string, id: string, org: string) {
  if (!registry[table])
    throw new DomainError(422, 'ENTITY_UNSUPPORTED', 'Unsupported synchronization entity');
  const scope = table === 'organizations' ? 'id' : 'organization_id';
  const immutable = [
    'employee_payroll_results',
    'payroll_earning_lines',
    'payroll_deduction_lines',
    'payroll_contribution_lines',
    'work_schedule_versions',
    'work_schedule_days',
    'time_records',
    'time_record_corrections',
    'attendance_adjustments',
  ];
  const r = await c.query(
    `SELECT * FROM ${quote(table)} WHERE id=$1 AND ${scope}=$2${immutable.includes(table) ? '' : ' FOR UPDATE'}`,
    [id, org],
  );
  if (!r.rows[0]) return null;
  const row = normalize(r.rows[0]);
  if (table === 'employees')
    row.employmentVersions = (
      await c.query(
        'SELECT * FROM employment_versions WHERE employee_id=$1 AND organization_id=$2 ORDER BY effective_from',
        [id, org],
      )
    ).rows.map(normalize);
  return row;
}
export async function applyBusinessEvent(
  c: PoolClient,
  org: string,
  e: CentralEvent,
  remote = false,
) {
  if (
    !registry[e.entityType] ||
    ['employment_versions', 'work_schedule_days'].includes(e.entityType)
  )
    throw new DomainError(422, 'ENTITY_UNSUPPORTED', 'Unsupported synchronization entity');
  if (
    !remote &&
    ['organizations', 'statutory_rule_sets', 'payroll_policies'].includes(e.entityType)
  )
    throw new DomainError(403, 'CENTRAL_OWNED', 'Entity is centrally owned');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7343))', [org]);
  await c.query("SELECT set_config('hex.sync_remote','on',true)");
  let payload = e.payload;
  if (
    e.entityType === 'payroll_runs' &&
    payload.snapshot &&
    typeof payload.snapshot === 'object' &&
    '$sync' in payload.snapshot
  )
    payload = {
      ...payload,
      snapshot: await assembleRunSnapshot(c, org, e.entityId, payload.snapshot),
    };
  if (
    payload.id !== e.entityId ||
    (payload.organizationId ?? payload.organization_id) !== org ||
    Number(payload.revision) !== e.revision
  )
    throw new DomainError(422, 'SNAPSHOT_IDENTITY', 'Snapshot identity mismatch');
  if (e.entityType === 'statutory_rule_sets') statutoryRulesSchema.parse(payload.rules);
  if (e.entityType === 'payroll_policies') payrollPolicySchema.parse(payload.policy);
  if (e.entityType === 'payroll_configurations')
    payrollConfigurationSchema.parse(payload.configuration);
  if (e.entityType === 'leave_types')
    leaveTypeInputSchema.parse(
      Object.fromEntries(
        Object.entries(payload).filter(
          ([key]) => !['id', 'organizationId', 'revision'].includes(key),
        ),
      ),
    );
  const current = await currentSnapshot(c, e.entityType, e.entityId, org);
  const identities: Record<string, string[]> = {
    employee_schedule_assignments: ['employeeId'],
    attendance_records: ['employeeId', 'workDate'],
    leave_requests: [
      'employeeId',
      'leaveTypeId',
      'startDate',
      'endDate',
      'durationType',
      'requestedBy',
    ],
    payroll_periods: ['code', 'periodStart', 'periodEnd', 'payFrequency', 'payDate'],
  };
  if (
    current &&
    identities[e.entityType]?.some((key) => {
      const incoming = payload[key] ?? payload[key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())];
      return incoming !== current[key];
    })
  )
    throw new ReceiverConflict(
      'INVALID_REFERENCE',
      current,
      'Stable domain identity or scope changed',
    );
  const bootstrapping =
    remote &&
    e.entityType === 'organizations' &&
    (
      await c.query(
        'SELECT reference_bootstrap_pending FROM sync_local_identity WHERE organization_id=$1',
        [org],
      )
    ).rows[0]?.reference_bootstrap_pending === true;
  if (remote && !bootstrapping && current && Number(current.revision) >= e.revision) {
    // Acknowledge our own echoed snapshot only after the caller checks pending edits.
    if (Number(current.revision) === e.revision) {
      const comparable = Object.fromEntries(
        Object.keys(payload).map((k) => [
          k,
          k === 'organizationId'
            ? org
            : current[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())],
        ]),
      );
      if (fingerprint(comparable) === fingerprint(payload)) return;
      throw new ReceiverConflict('UPDATE_UPDATE', current, 'Same revision has different contents');
    }
    throw new ReceiverConflict('STALE_REVISION', current, 'Local revision is newer');
  }
  if (
    current &&
    [
      'employee_payroll_results',
      'payroll_earning_lines',
      'payroll_deduction_lines',
      'payroll_contribution_lines',
      'work_schedule_versions',
      'time_record_corrections',
      'attendance_adjustments',
    ].includes(e.entityType)
  )
    throw new ReceiverConflict('UPDATE_UPDATE', current, 'Historical evidence is append-only');
  const finalizing =
    e.entityType === 'payroll_periods' &&
    payload.status === 'finalized' &&
    payload.finalization !== undefined;
  const detection = detectConflict({
    entityType: e.entityType,
    operation: e.operation,
    baseRevision: e.baseRevision,
    incoming: finalizing ? { ...payload, status: 'review' } : payload,
    authoritative: current,
    authorized: true,
  });
  if (!bootstrapping && detection.outcome === 'conflict')
    throw new ReceiverConflict(detection.conflictType, current, detection.reason);
  if (detection.outcome === 'deferred') throw new MissingDependency(detection.reason);
  if (e.operation !== 'CREATE' && e.revision !== e.baseRevision + 1)
    throw new DomainError(422, 'REVISION', 'Revision must follow base revision');
  const employeeVersions = payload.employmentVersions;
  const days = payload.days;
  const fields = payloadFields[e.entityType];
  let data: Record<string, unknown>;
  if (fields) {
    const allowed = new Set(['id', 'organizationId', 'revision', ...fields]);
    if (Object.keys(payload).some((k) => !allowed.has(k)))
      throw new DomainError(422, 'PAYLOAD_FIELD', 'Unexpected snapshot field');
    data = Object.fromEntries(
      Object.entries(payload).filter(([k]) => !['employmentVersions', 'days'].includes(k)),
    );
  } else data = Object.fromEntries(Object.entries(payload).filter(([k]) => k !== 'finalization'));
  const schema =
    e.entityType === 'departments'
      ? departmentInputSchema
      : e.entityType === 'positions'
        ? positionInputSchema
        : e.entityType === 'employees'
          ? employeeInputSchema
          : null;
  if (schema) {
    const parsed = schema.parse(
      Object.fromEntries(
        Object.entries(data).filter(([k]) => !['id', 'organizationId', 'revision'].includes(k)),
      ),
    );
    data = { ...parsed, id: e.entityId, organizationId: org, revision: e.revision };
  }
  await ensureRemoteActor(c, org, e.actorId);
  if (finalizing) {
    const manifest = z
      .object({
        run: z.object({
          id: z.uuid(),
          baseRevision: z.number().int().positive(),
          hash: z.string().length(64),
        }),
        employee_payroll_results: z.object({
          count: z.number().int().nonnegative(),
          hash: z.string().length(64),
        }),
        payroll_earning_lines: z.object({
          count: z.number().int().nonnegative(),
          hash: z.string().length(64),
        }),
        payroll_deduction_lines: z.object({
          count: z.number().int().nonnegative(),
          hash: z.string().length(64),
        }),
        payroll_contribution_lines: z.object({
          count: z.number().int().nonnegative(),
          hash: z.string().length(64),
        }),
      })
      .strict()
      .parse(payload.finalization);
    if (
      !current ||
      current.latestRunId !== manifest.run.id ||
      current.reviewedRunId !== manifest.run.id
    )
      throw new ReceiverConflict(
        'PAYROLL_CONFLICT',
        current,
        'Payroll must be reviewed against the same run',
      );
    const run = (
      await c.query(
        'SELECT * FROM payroll_runs WHERE id=$1 AND organization_id=$2 AND period_id=$3 FOR UPDATE',
        [manifest.run.id, org, e.entityId],
      )
    ).rows[0];
    if (!run) throw new MissingDependency('Payroll run unavailable');
    if (
      run.finalized ||
      run.revision !== manifest.run.baseRevision ||
      fingerprint(run) !== manifest.run.hash
    )
      throw new ReceiverConflict('PAYROLL_CONFLICT', current, 'Finalization run snapshot differs');
    for (const table of [
      'employee_payroll_results',
      'payroll_earning_lines',
      'payroll_deduction_lines',
      'payroll_contribution_lines',
    ] as const) {
      const rows =
        table === 'employee_payroll_results'
          ? await c.query(
              'SELECT * FROM employee_payroll_results WHERE payroll_run_id=$1 ORDER BY id',
              [run.id],
            )
          : await c.query(
              `SELECT l.* FROM ${table} l JOIN employee_payroll_results r ON r.id=l.result_id WHERE r.payroll_run_id=$1 ORDER BY l.id`,
              [run.id],
            );
      if (rows.rowCount !== manifest[table].count)
        throw new MissingDependency('Payroll components incomplete');
      if (fingerprint(rows.rows) !== manifest[table].hash)
        throw new ReceiverConflict(
          'PAYROLL_CONFLICT',
          current,
          'Payroll component snapshot differs',
        );
    }
    await reconcile(c, run.id, run.totals);
    await c.query('UPDATE payroll_runs SET finalized=true,revision=revision+1 WHERE id=$1', [
      run.id,
    ]);
  }
  if (current && e.entityType === 'employee_schedule_assignments')
    await c.query(
      'INSERT INTO schedule_assignment_history(organization_id,assignment_id,revision,snapshot) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [org, e.entityId, current.revision, JSON.stringify(current)],
    );
  if (current && e.entityType === 'attendance_records')
    await c.query(
      'INSERT INTO attendance_history(organization_id,attendance_id,revision,snapshot) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [org, e.entityId, current.revision, JSON.stringify(current)],
    );
  await writeRow(c, e.entityType, data, org, !!current);
  if (bootstrapping)
    await c.query(
      'UPDATE sync_local_identity SET reference_bootstrap_pending=false WHERE organization_id=$1',
      [org],
    );
  if (e.entityType === 'employees' && employeeVersions !== undefined) {
    const versions = z.array(z.record(z.string(), z.unknown())).max(1000).parse(employeeVersions);
    // Close existing intervals before inserting their successors.
    versions.sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)));
    for (const v of versions) {
      if (v.employeeId !== e.entityId || v.organizationId !== org)
        throw new DomainError(422, 'EMPLOYMENT_SCOPE', 'Employment identity mismatch');
      employmentInputSchema.parse(
        Object.fromEntries(Object.entries(v).filter(([k]) => k in employmentInputSchema.shape)),
      );
      const found = await c.query(
        'SELECT organization_id,employee_id FROM employment_versions WHERE id=$1 FOR UPDATE',
        [z.uuid().parse(v.id)],
      );
      if (
        found.rows[0] &&
        (found.rows[0].organization_id !== org || found.rows[0].employee_id !== e.entityId)
      )
        throw new DomainError(403, 'EMPLOYMENT_SCOPE', 'Employment identity unavailable');
      await writeRow(c, 'employment_versions', v, org, !!found.rows[0]);
    }
  }
  if (e.entityType === 'work_schedule_versions') {
    for (const day of z.array(z.record(z.string(), z.unknown())).length(7).parse(days)) {
      await writeRow(
        c,
        'work_schedule_days',
        { ...day, organizationId: org, versionId: e.entityId },
        org,
        false,
      );
    }
  }
  await audit(c, { id: null, organizationId: org }, 'SYNC_APPLIED', e.entityType, e.entityId, [], {
    eventId: e.eventId,
    actorId: e.actorId,
    revision: e.revision,
    remote,
  });
}
