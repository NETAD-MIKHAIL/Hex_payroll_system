import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  isoDateSchema,
  attendanceDaysSchema,
  attendanceDetailSchema,
  centralAttendanceWorkspaceSchema,
} from '@hexpayroll/shared';
import {
  DomainError,
  transaction,
  requirePermission,
  type Actor,
} from '../foundation/repository.js';
import { resolveShift } from './services.js';
import {
  authorizeCentralUser,
  centralCredentialsSchema,
  type AttendanceAuthorizationCredentials,
} from './central-attendance-authorization.js';

export const attendancePeriodSchema = z
  .object({ employeeId: z.uuid(), workDate: isoDateSchema })
  .strict();
export const attendanceListQuerySchema = z
  .object({
    date: isoDateSchema,
    search: z.string().max(100).default(''),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
const list = async (c: PoolClient, sql: string, values: unknown[]) =>
  (await c.query(sql, values)).rows.map((r) => r.data);
const employeeSql =
  "jsonb_build_object('id',e.id,'employeeNumber',e.employee_number,'name',e.first_name||' '||e.last_name)";
function summary(value: Record<string, unknown> | null) {
  if (!value) return null;
  const result = value.result as Record<string, unknown> | undefined;
  if (!result) return value;
  const { sourceSnapshot: unused, exception: unusedException, ...small } = result;
  void unused;
  void unusedException;
  const accepted = (
    result.sourceSnapshot as { accepted?: { version?: { name?: string } } } | undefined
  )?.accepted;
  return {
    ...value,
    schedule_name: value.schedule_name ?? accepted?.version?.name ?? null,
    result: small,
  };
}
export function createAttendanceManagementReader(
  pool: Pool,
  features: { capture: boolean; finalization: boolean; centralConfigured: boolean },
) {
  return {
    async days(actor: Actor, input: unknown) {
      const q = attendanceListQuerySchema.parse(input);
      return transaction(pool, async (c) => {
        const timezone = (
          await c.query<{ timezone: string }>('SELECT timezone FROM organizations WHERE id=$1', [
            actor.organizationId,
          ])
        ).rows[0]?.timezone;
        if (!timezone)
          throw new DomainError(409, 'SETUP_REQUIRED', 'Organization setup is required');
        const values = [actor.organizationId, q.date, '%' + q.search + '%'];
        const total = Number(
          (
            await c.query(
              "SELECT count(*) n FROM employees e WHERE e.organization_id=$1 AND (e.first_name||' '||e.last_name||' '||e.employee_number) ILIKE $2",
              [actor.organizationId, values[2]],
            )
          ).rows[0].n,
        );
        const rows = (
          await c.query(
            `SELECT ${employeeSql} employee,CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a)||jsonb_build_object('schedule_name',v.name) END provisional,t.snapshot canonical FROM employees e
          LEFT JOIN attendance_records a ON a.organization_id=e.organization_id AND a.employee_id=e.id AND a.work_date=$2
          LEFT JOIN work_schedule_versions v ON v.id=a.schedule_version_id
          LEFT JOIN trusted_attendance_state t ON t.organization_id=e.organization_id AND t.employee_id=e.id AND t.work_date=$2
          WHERE e.organization_id=$1 AND (e.first_name||' '||e.last_name||' '||e.employee_number) ILIKE $3
          ORDER BY e.employee_number,e.id LIMIT $4 OFFSET $5`,
            [...values, q.pageSize, (q.page - 1) * q.pageSize],
          )
        ).rows;
        return attendanceDaysSchema.parse({
          date: q.date,
          timezone,
          items: rows.map((r) => ({
            ...r,
            provisional: summary(r.provisional),
            canonical: summary(r.canonical),
          })),
          total,
          page: q.page,
          pageSize: q.pageSize,
          features,
        });
      });
    },
    async detail(actor: Actor, input: unknown) {
      const p = attendancePeriodSchema.parse(input),
        org = actor.organizationId;
      return transaction(pool, async (c) => {
        const employee = (
          await c.query(
            `SELECT ${employeeSql} data FROM employees e WHERE organization_id=$1 AND id=$2`,
            [org, p.employeeId],
          )
        ).rows[0]?.data;
        if (!employee) throw new DomainError(404, 'NOT_FOUND', 'Employee not found');
        const timezone = (
          await c.query<{ timezone: string }>('SELECT timezone FROM organizations WHERE id=$1', [
            org,
          ])
        ).rows[0]!.timezone;
        const base = [org, p.employeeId, p.workDate];
        const provisional =
          (
            await c.query(
              'SELECT to_jsonb(a) data FROM attendance_records a WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3',
              base,
            )
          ).rows[0]?.data ?? null;
        const canonical =
          (
            await c.query(
              'SELECT snapshot FROM trusted_attendance_state WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3',
              base,
            )
          ).rows[0]?.snapshot ?? null;
        const mappings = await list(
          c,
          'SELECT to_jsonb(m) data FROM biometric_mappings m WHERE organization_id=$1 AND employee_id=$2 ORDER BY device_id,device_employee_id',
          [org, p.employeeId],
        );
        const rawPunches = await list(
          c,
          `SELECT to_jsonb(r) data FROM biometric_raw_captures r WHERE organization_id=$1
          AND EXISTS(SELECT 1 FROM biometric_mappings m WHERE m.organization_id=$1 AND m.employee_id=$2 AND m.device_id=r.device_id AND m.device_employee_id=r.device_employee_id)
          AND recorded_at>=($3::date-1)::timestamp AT TIME ZONE $4 AND recorded_at<($3::date+2)::timestamp AT TIME ZONE $4 ORDER BY recorded_at,id LIMIT 500`,
          [...base, timezone],
        );
        const timeRecords = await list(
          c,
          `SELECT to_jsonb(t)||jsonb_build_object('corrections',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY revision) FROM time_record_corrections x WHERE x.time_record_id=t.id),'[]'::jsonb)) data
          FROM time_records t WHERE organization_id=$1 AND employee_id=$2 AND recorded_at>=($3::date-1)::timestamp AT TIME ZONE $4 AND recorded_at<($3::date+2)::timestamp AT TIME ZONE $4 ORDER BY recorded_at,id LIMIT 500`,
          [...base, timezone],
        );
        const devices = await list(
          c,
          `SELECT to_jsonb(d)||jsonb_build_object('capture',to_jsonb(s),'pendingBatches',(SELECT count(*) FROM biometric_capture_batches b WHERE b.device_id=d.id AND NOT EXISTS(SELECT 1 FROM biometric_batch_deliveries r WHERE r.batch_id=b.id))) data
          FROM biometric_devices d LEFT JOIN biometric_ingestion_state s ON s.device_id=d.id WHERE d.organization_id=$1 AND d.id IN (SELECT device_id FROM biometric_mappings WHERE organization_id=$1 AND employee_id=$2) ORDER BY d.code`,
          [org, p.employeeId],
        );
        const batches = await list(
          c,
          `SELECT to_jsonb(b)||jsonb_build_object('delivery',to_jsonb(d)) data FROM biometric_capture_batches b LEFT JOIN biometric_batch_deliveries d ON d.batch_id=b.id
          WHERE b.organization_id=$1 AND b.device_id IN (SELECT device_id FROM biometric_mappings WHERE organization_id=$1 AND employee_id=$2) ORDER BY b.captured_at DESC,b.id LIMIT 50`,
          [org, p.employeeId],
        );
        const closures = await list(
          c,
          `SELECT jsonb_build_object('id',s.id,'device_id',s.device_id,'captured_at',s.captured_at,'manifest',s.payload->'manifest','delivery',to_jsonb(d),'attempts',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY attempted_at DESC) FROM biometric_closure_attempts a WHERE a.closure_id=s.id),'[]'::jsonb)) data FROM biometric_source_closures s LEFT JOIN biometric_closure_deliveries d ON d.closure_id=s.id
          WHERE s.organization_id=$1 AND s.device_id IN (SELECT device_id FROM biometric_mappings WHERE organization_id=$1 AND employee_id=$2) ORDER BY s.captured_at DESC LIMIT 20`,
          [org, p.employeeId],
        );
        const history = await list(
          c,
          `SELECT data FROM (
          SELECT h.created_at at,jsonb_build_object('kind','local','id',h.id,'revision',h.revision,'snapshot',h.snapshot,'at',h.created_at) data FROM attendance_history h JOIN attendance_records a ON a.id=h.attendance_id WHERE a.organization_id=$1 AND a.employee_id=$2 AND a.work_date=$3
          UNION ALL SELECT (i.envelope->'snapshot'->>'updated_at')::timestamptz at,jsonb_build_object('kind','trusted','id',i.event_id,'revision',i.canonical_revision,'snapshot',i.envelope->'snapshot','appliedAt',r.applied_at,'at',i.envelope->'snapshot'->>'updated_at') data FROM trusted_attendance_inbox i LEFT JOIN trusted_attendance_applications r USING(sequence) WHERE i.organization_id=$1 AND i.envelope->'snapshot'->>'employee_id'=$2::text AND i.envelope->'snapshot'->>'work_date'=$3::text
          ) x ORDER BY at DESC LIMIT 100`,
          base,
        );
        const dependencies = await list(
          c,
          `SELECT to_jsonb(s)||jsonb_build_object('canonicalId',i.canonical_id,'revision',i.canonical_revision) data FROM trusted_attendance_application_state s JOIN trusted_attendance_inbox i USING(sequence) WHERE i.organization_id=$1 AND i.envelope->'snapshot'->>'employee_id'=$2::text AND i.envelope->'snapshot'->>'work_date'=$3::text ORDER BY s.sequence`,
          base,
        );
        const commands = await list(
          c,
          `SELECT to_jsonb(r)||jsonb_build_object('outcomes',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY observed_at DESC) FROM attendance_desktop_outcomes o WHERE o.request_id=r.id),'[]'::jsonb)) data FROM attendance_desktop_requests r WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3 AND operator_id=$4 ORDER BY created_at DESC LIMIT 50`,
          [...base, actor.id],
        );
        const leave = await list(
          c,
          'SELECT to_jsonb(l) data FROM leave_requests l WHERE organization_id=$1 AND employee_id=$2 AND start_date<=$3 AND end_date>=$3 ORDER BY requested_at DESC',
          base,
        );
        const reconciliation = await list(
          c,
          `SELECT jsonb_build_object('id',r.id,'decision',r.decision,'reason',r.reason,'created_at',r.created_at,'entityType',i.envelope->>'entityType') data FROM trusted_evidence_reconciliations r JOIN trusted_evidence_inbox i ON i.sequence=r.sequence AND i.organization_id=r.organization_id WHERE r.organization_id=$1 ORDER BY r.created_at DESC LIMIT 20`,
          [org],
        );
        const schedule = await resolveShift(c, org!, p.employeeId, p.workDate);
        return attendanceDetailSchema.parse({
          employee,
          date: p.workDate,
          timezone,
          provisional,
          canonical,
          schedule,
          leave,
          timeRecords,
          rawPunches,
          batches,
          closures: closures.map((r) => ({
            ...r,
            manifest: r.manifest
              ? {
                  ...r.manifest,
                  inventory: undefined,
                  inventoryCount: r.manifest.inventory?.length,
                }
              : null,
          })),
          devices,
          dependencies,
          history: history.map((r) => ({ ...r, snapshot: summary(r.snapshot) })),
          mappings,
          commands: commands.map((r) => ({
            ...r,
            outcomes: r.outcomes.map((o: Record<string, unknown>) => ({
              ...o,
              result: o.result
                ? {
                    category: (o.result as Record<string, unknown>).category,
                    id: (o.result as Record<string, unknown>).id,
                  }
                : null,
            })),
          })),
          reconciliation,
        });
      });
    },
    async monitor(actor: Actor) {
      return transaction(pool, async (c) => {
        const org = actor.organizationId;
        const devices = await list(
          c,
          `SELECT to_jsonb(d)||jsonb_build_object('lastCaptureAt',s.last_ingestion_at,'lastPunchAt',s.last_record_at,'pendingBatches',(SELECT count(*) FROM biometric_capture_batches b WHERE b.device_id=d.id AND NOT EXISTS(SELECT 1 FROM biometric_batch_deliveries r WHERE r.batch_id=b.id))) data FROM biometric_devices d LEFT JOIN biometric_ingestion_state s ON s.device_id=d.id WHERE d.organization_id=$1 ORDER BY d.code`,
          [org],
        );
        const unmatched = actor.permissions.includes('time_records.view')
          ? await list(
              c,
              `SELECT to_jsonb(r) data FROM biometric_raw_captures r WHERE organization_id=$1 AND NOT EXISTS(SELECT 1 FROM biometric_mappings m WHERE m.device_id=r.device_id AND m.device_employee_id=r.device_employee_id AND m.status='active') ORDER BY captured_at DESC LIMIT 50`,
              [org],
            )
          : [];
        const dependencies = await list(
          c,
          'SELECT to_jsonb(s) data FROM trusted_attendance_application_state s JOIN trusted_attendance_inbox i USING(sequence) WHERE i.organization_id=$1 ORDER BY s.sequence LIMIT 50',
          [org],
        );
        const receipts = await list(
          c,
          `SELECT to_jsonb(d) data FROM biometric_batch_deliveries d JOIN biometric_capture_batches b ON b.id=d.batch_id WHERE b.organization_id=$1 ORDER BY delivered_at DESC LIMIT 20`,
          [org],
        );
        const checkpoints = await list(
          c,
          'SELECT to_jsonb(t) data FROM trusted_attendance_checkpoints t WHERE organization_id=$1',
          [org],
        );
        const attempts = await list(
          c,
          'SELECT to_jsonb(a) data FROM biometric_closure_attempts a JOIN biometric_source_closures c ON c.id=a.closure_id WHERE c.organization_id=$1 ORDER BY attempted_at DESC LIMIT 30',
          [org],
        );
        return {
          devices,
          unmatched,
          dependencies,
          receipts,
          checkpoints,
          attempts,
          generatedAt: new Date().toISOString(),
        };
      });
    },
  };
}
export async function readCentralAttendanceWorkspace(
  pool: Pool,
  credentials: AttendanceAuthorizationCredentials,
  input: unknown,
) {
  const p = attendancePeriodSchema.extend({ organizationId: z.uuid() }).parse(input);
  return transaction(pool, async (c) => {
    await authorizeCentralUser(
      c,
      centralCredentialsSchema.parse(credentials),
      p.organizationId,
      'attendance.view',
    );
    if (
      !(
        await c.query('SELECT id FROM employees WHERE organization_id=$1 AND id=$2', [
          p.organizationId,
          p.employeeId,
        ])
      ).rowCount
    )
      throw new DomainError(
        404,
        'NOT_FOUND',
        'Central employee not found; resolve identity dependencies',
      );
    const base = [p.organizationId, p.employeeId, p.workDate];
    const canonical =
      (
        await c.query(
          'SELECT to_jsonb(s) data FROM central_attendance_state s WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3',
          base,
        )
      ).rows[0]?.data ?? null;
    const certifications = await list(
      c,
      'SELECT to_jsonb(t) data FROM central_attendance_certifications t WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3 ORDER BY revision DESC LIMIT 30',
      base,
    );
    const exceptions = await list(
      c,
      `SELECT to_jsonb(r) data FROM central_attendance_exception_resolutions r JOIN central_attendance_certifications c ON c.id=r.certification_id WHERE c.organization_id=$1 AND c.employee_id=$2 AND c.work_date=$3 ORDER BY r.created_at DESC LIMIT 30`,
      base,
    );
    const proposals = await list(
      c,
      'SELECT to_jsonb(t) data FROM central_attendance_requests t WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3 ORDER BY received_at DESC LIMIT 50',
      base,
    );
    const decisions = await list(
      c,
      'SELECT to_jsonb(t) data FROM central_attendance_decisions t WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3 ORDER BY decided_at DESC LIMIT 50',
      base,
    );
    const history = await list(
      c,
      'SELECT to_jsonb(t) data FROM central_attendance_acceptance_history t WHERE organization_id=$1 AND canonical_attendance_id=(SELECT canonical_attendance_id FROM central_attendance_state WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3) ORDER BY new_revision DESC LIMIT 50',
      base,
    );
    const coverage = await list(
      c,
      'SELECT to_jsonb(t) data FROM central_attendance_coverage t WHERE organization_id=$1 AND employee_id=$2 ORDER BY revision DESC LIMIT 10',
      [p.organizationId, p.employeeId],
    );
    const capabilities = await list(
      c,
      'SELECT to_jsonb(t) data FROM central_source_capabilities t WHERE organization_id=$1 AND device_id IN (SELECT device_id FROM biometric_mappings WHERE organization_id=$1 AND employee_id=$2) ORDER BY device_id,revision DESC LIMIT 40',
      [p.organizationId, p.employeeId],
    );
    const receipts = await list(
      c,
      `SELECT jsonb_build_object('batch_id',r.batch_id,'device_id',r.device_id,'node_id',r.node_id,'sequence',r.sequence::text,'received_at',r.received_at) data FROM central_biometric_receipts r WHERE organization_id=$1 AND device_id IN (SELECT device_id FROM biometric_mappings WHERE organization_id=$1 AND employee_id=$2) ORDER BY received_at DESC LIMIT 50`,
      [p.organizationId, p.employeeId],
    );
    return centralAttendanceWorkspaceSchema.parse({
      ...p,
      canonical,
      certifications: certifications.map((r, i) =>
        i === 0 ? r : { ...r, snapshot: { blockers: r.snapshot.blockers } },
      ),
      exceptions,
      proposals: proposals.map((r) => ({
        ...r,
        proposed_payload: {
          ...r.proposed_payload,
          result: summary({ result: r.proposed_payload.result })?.result,
        },
      })),
      decisions,
      history: history.map((r) => ({
        ...r,
        old_state: summary(r.old_state),
        new_state: summary(r.new_state),
      })),
      coverage,
      capabilities,
      receipts,
      generatedAt: new Date().toISOString(),
    });
  });
}
export async function readLocalAttendanceEvidence(pool: Pool, actor: Actor, input: unknown) {
  const p = attendancePeriodSchema
    .extend({ kind: z.enum(['trusted', 'local', 'closure']), id: z.uuid() })
    .strict()
    .parse(input);
  return transaction(pool, async (c) => {
    const values = [actor.organizationId, p.employeeId, p.workDate, p.id];
    let sql: string;
    if (p.kind === 'trusted')
      sql = `SELECT jsonb_build_object('envelope',i.envelope,'application',to_jsonb(a)) data FROM trusted_attendance_inbox i LEFT JOIN trusted_attendance_applications a USING(sequence) WHERE i.organization_id=$1 AND i.envelope->'snapshot'->>'employee_id'=$2::text AND i.envelope->'snapshot'->>'work_date'=$3::text AND i.event_id=$4`;
    else if (p.kind === 'local')
      sql = `SELECT to_jsonb(h) data FROM attendance_history h JOIN attendance_records r ON r.id=h.attendance_id WHERE r.organization_id=$1 AND r.employee_id=$2 AND r.work_date=$3 AND h.id=$4`;
    else {
      requirePermission(actor, 'time_records.view');
      sql = `SELECT to_jsonb(s) data FROM biometric_source_closures s WHERE s.organization_id=$1 AND s.id=$4 AND s.device_id IN(SELECT device_id FROM biometric_mappings WHERE organization_id=$1 AND employee_id=$2) AND (s.payload->'manifest'->>'start')::timestamptz<($3::date+2)::timestamptz AND (s.payload->'manifest'->>'end')::timestamptz>($3::date-1)::timestamptz`;
    }
    const row = (await c.query(sql, values)).rows[0]?.data;
    if (!row)
      throw new DomainError(
        404,
        'NOT_FOUND',
        'No local evidence for this employee and attendance period',
      );
    return row;
  });
}
export async function readCentralAttendanceEvidence(
  pool: Pool,
  credentials: AttendanceAuthorizationCredentials,
  input: unknown,
) {
  const q = attendancePeriodSchema
    .extend({
      organizationId: z.uuid(),
      kind: z.enum(['certification', 'proposal', 'history', 'exception']),
      id: z.uuid(),
    })
    .parse(input);
  return transaction(pool, async (c) => {
    await authorizeCentralUser(
      c,
      centralCredentialsSchema.parse(credentials),
      q.organizationId,
      'attendance.view',
    );
    const tables = {
      certification: ['central_attendance_certifications', 'id'],
      proposal: ['central_attendance_requests', 'proposal_id'],
      history: ['central_attendance_acceptance_history', 'history_id'],
      exception: ['central_attendance_exception_resolutions', 'id'],
    } as const;
    const [table, key] = tables[q.kind];
    const where =
      q.kind === 'history'
        ? 't.canonical_attendance_id IN(SELECT canonical_attendance_id FROM central_attendance_state WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3)'
        : q.kind === 'exception'
          ? 't.certification_id IN(SELECT id FROM central_attendance_certifications WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3)'
          : 't.employee_id=$2 AND t.work_date=$3';
    const row = (
      await c.query(
        `SELECT to_jsonb(t) data FROM ${table} t WHERE t.organization_id=$1 AND ${where} AND t.${key}=$4`,
        [q.organizationId, q.employeeId, q.workDate, q.id],
      )
    ).rows[0]?.data;
    if (!row)
      throw new DomainError(404, 'NOT_FOUND', 'Evidence not found for this attendance period');
    return row;
  });
}
