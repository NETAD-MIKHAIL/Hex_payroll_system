import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  scheduleInputSchema,
  assignmentInputSchema,
  leaveTypeInputSchema,
  leaveInputSchema,
  canonicalSyncJson,
  type FoundationRecord,
} from '@hexpayroll/shared';
import { DomainError, transaction, normalize } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import {
  authorizeCentralUser,
  centralCredentialsSchema,
} from './central-attendance-authorization.js';
import {
  evidenceActions,
  parseEvidenceDecision,
  canonicalEvidenceJson,
} from './central-evidence-decisions.js';
import { verifyEvidenceWriter } from './central-evidence-writer.js';
import { publishTrustedEvidence } from '../sync/trusted-evidence.js';

const acceptanceInput = z
  .object({ authorizationDecisionId: z.uuid(), request: z.unknown() })
  .strict();
function fail(code: string, message: string): never {
  throw new DomainError(409, code, message);
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export { scheduleWeekdayId } from './schedule-identity.js';
import { scheduleWeekdayId } from './schedule-identity.js';

// Private helper: names come only from the fixed action map and parsed schema fields.
async function writeRow(
  c: PoolClient,
  table: string,
  id: string,
  org: string,
  expected: number,
  data: Record<string, unknown>,
  actor: string,
): Promise<FoundationRecord> {
  const entries = Object.entries({ ...data, updatedBy: actor });
  const columns = entries.map(([name]) =>
    name.replace(/[A-Z]/g, (char) => '_' + char.toLowerCase()),
  );
  const values = entries.map(([, value]) =>
    value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
  );
  const result =
    expected === 0
      ? await c.query(
          `INSERT INTO ${table}(id,organization_id,${columns.join(',')})
        VALUES($1,$2,${values.map((_, index) => '$' + (index + 3)).join(',')}) RETURNING *`,
          [id, org, ...values],
        )
      : await c.query(
          `UPDATE ${table} SET ${columns.map((name, index) => name + '=$' + (index + 4)).join(',')},
        revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND organization_id=$2 AND revision=$3 RETURNING *`,
          [id, org, expected, ...values],
        );
  if (!result.rows[0]) fail('EVIDENCE_REVISION_MISMATCH', 'Evidence revision changed');
  return normalize(result.rows[0]);
}
async function dependency(c: PoolClient, table: string, id: string, org: string) {
  const row = (
    await c.query(
      `SELECT ${table === 'employees' ? 'id,organization_id' : '*'} FROM ${table} WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
      [id, org],
    )
  ).rows[0];
  if (!row)
    fail('EVIDENCE_DEPENDENCY_MISSING', 'Evidence dependency is unavailable in this organization');
  return normalize(row);
}
async function scheduleSnapshot(c: PoolClient, row: FoundationRecord) {
  const versions = (
    await c.query(
      'SELECT * FROM work_schedule_versions WHERE schedule_id=$1 ORDER BY effective_from,id',
      [row.id],
    )
  ).rows;
  return {
    ...row,
    versions: await Promise.all(
      versions.map(async (version) => ({
        ...normalize(version),
        days: (
          await c.query(
            'SELECT * FROM work_schedule_days WHERE version_id=$1 ORDER BY day_of_week',
            [version.id],
          )
        ).rows.map(normalize),
      })),
    ),
  };
}

/** Internal only. The supplied pool must connect as the separately provisioned writer.
 * No existing local mutation service is called: no jobs, outbox echo or attendance writes. */
export function createCentralEvidenceAcceptanceService(
  writerPool: Pool,
  mode: 'local' | 'central',
) {
  return async (credentials: unknown, input: unknown) => {
    if (mode !== 'central')
      throw new DomainError(403, 'CENTRAL_ONLY', 'Central evidence acceptance is unavailable');
    const auth = centralCredentialsSchema.safeParse(credentials),
      parsed = acceptanceInput.safeParse(input);
    if (!auth.success)
      throw new DomainError(401, 'AUTH_INVALID', 'Valid node and user credentials are required');
    if (!parsed.success)
      throw new DomainError(400, 'INVALID_REQUEST', 'Invalid evidence acceptance request');
    const request = parseEvidenceDecision(parsed.data.request),
      spec = evidenceActions[request.action];
    const canonical = canonicalEvidenceJson(request),
      fingerprint = hash(canonical);
    return transaction(writerPool, async (c) => {
      await verifyEvidenceWriter(c);
      const identity = await authorizeCentralUser(
        c,
        auth.data,
        request.organizationId,
        spec.permission,
      );
      const checkExpiry = async () => {
        const current = await c.query(
          'SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()',
          [tokenHash(auth.data.sessionToken), identity.authorUserId],
        );
        if (!current.rowCount)
          throw new DomainError(401, 'SESSION_INVALID', 'User session invalid');
      };
      // Same organization serialization lock used by existing evidence integrity triggers.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,731))', [
        request.organizationId,
      ]);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'evidence-request:' + request.requestId,
      ]);
      const authorization = (
        await c.query(
          'SELECT * FROM central_evidence_authorizations WHERE decision_id=$1 FOR SHARE',
          [parsed.data.authorizationDecisionId],
        )
      ).rows[0];
      if (
        !authorization ||
        authorization.canonical_request !== canonical ||
        authorization.payload_fingerprint !== fingerprint ||
        authorization.request_id !== request.requestId ||
        authorization.organization_id !== request.organizationId ||
        authorization.entity_id !== request.entityId ||
        authorization.entity_type !== spec.table ||
        authorization.action !== request.action ||
        authorization.expected_revision !== request.expectedRevision ||
        authorization.permission_code !== spec.permission ||
        authorization.acting_user_id !== identity.authorUserId ||
        authorization.source_node_id !== identity.nodeId
      )
        fail('EVIDENCE_AUTHORIZATION_MISMATCH', 'Exact authorization binding required');
      const existing = (
        await c.query(
          `SELECT * FROM central_evidence_acceptances WHERE authorization_decision_id=$1`,
          [authorization.decision_id],
        )
      ).rows[0];
      if (existing) {
        if (hash(existing.canonical_snapshot) !== existing.snapshot_fingerprint)
          fail('EVIDENCE_ACCEPTANCE_CONFLICT', 'Stored snapshot fingerprint mismatch');
        const event = (
          await c.query(
            'SELECT event_id,sequence::text FROM central_evidence_events WHERE acceptance_id=$1',
            [existing.acceptance_id],
          )
        ).rows[0];
        if (!event) fail('EVIDENCE_ACCEPTANCE_CONFLICT', 'Stored acceptance has no publication');
        await checkExpiry();
        return { acceptance: existing, event };
      }
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        spec.table + ':' + request.entityId,
      ]);
      const raw = (
        await c.query(`SELECT * FROM ${spec.table} WHERE id=$1 FOR UPDATE`, [request.entityId])
      ).rows[0];
      if (raw && raw.organization_id !== request.organizationId)
        throw new DomainError(403, 'ORGANIZATION_MISMATCH', 'Evidence organization mismatch');
      if ((raw ? Number(raw.revision) : 0) !== request.expectedRevision || (spec.create && raw))
        fail(
          'EVIDENCE_REVISION_MISMATCH',
          'Current evidence revision does not match authorization',
        );
      const old = raw ? normalize(raw) : null;
      const beforeSnapshot =
        old && spec.table === 'work_schedules' ? await scheduleSnapshot(c, old) : old;
      const org = (
        await c.query(
          `SELECT timezone,(clock_timestamp() AT TIME ZONE timezone)::date::text AS today
        FROM organizations WHERE id=$1 FOR SHARE`,
          [request.organizationId],
        )
      ).rows[0];
      if (!org) fail('EVIDENCE_DEPENDENCY_MISSING', 'Organization is unavailable');
      const p = request.payload;
      const backdate = (date: string, reason: string | null) => {
        if (date < org.today && !reason?.trim())
          fail('EVIDENCE_REASON_REQUIRED', 'Backdated changes require a reason');
      };
      let row: FoundationRecord;
      if (request.action === 'schedule.create' || request.action === 'schedule.update') {
        const { versionId, timezone, ...body } = p;
        const data = scheduleInputSchema.parse(body);
        backdate(data.effectiveFrom, data.reason);
        if (
          timezone !== org.timezone ||
          !(await c.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [timezone])).rowCount
        )
          fail(
            'EVIDENCE_TIMEZONE_MISMATCH',
            'Schedule timezone must match the current organization timezone',
          );
        const latest = (
          await c.query(
            'SELECT effective_from FROM work_schedule_versions WHERE schedule_id=$1 ORDER BY effective_from DESC LIMIT 1',
            [request.entityId],
          )
        ).rows[0];
        if (latest && data.effectiveFrom <= latest.effective_from)
          fail(
            'EVIDENCE_EFFECTIVE_DATE_CONFLICT',
            'Schedule version must follow the latest effective date',
          );
        row = await writeRow(
          c,
          spec.table,
          request.entityId,
          request.organizationId,
          request.expectedRevision,
          { code: data.code, name: data.name, description: data.description, status: data.status },
          identity.authorUserId,
        );
        await c.query(
          `INSERT INTO work_schedule_versions(id,organization_id,schedule_id,effective_from,reason,timezone,name,code,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            versionId,
            request.organizationId,
            request.entityId,
            data.effectiveFrom,
            data.reason,
            timezone,
            data.name,
            data.code,
            identity.authorUserId,
          ],
        );
        for (const day of data.days) {
          await c.query(
            `INSERT INTO work_schedule_days(id,organization_id,version_id,day_of_week,is_work_day,start_time,end_time,end_day_offset,
            break_start,break_end,break_start_day_offset,break_end_day_offset,grace_minutes)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              scheduleWeekdayId(String(versionId), day.dayOfWeek),
              request.organizationId,
              versionId,
              day.dayOfWeek,
              day.isWorkDay,
              day.startTime,
              day.endTime,
              day.endDayOffset,
              day.breakStart,
              day.breakEnd,
              day.breakStartDayOffset,
              day.breakEndDayOffset,
              day.graceMinutes,
            ],
          );
        }
      } else if (request.action === 'schedule.status') {
        row = await writeRow(
          c,
          spec.table,
          request.entityId,
          request.organizationId,
          request.expectedRevision,
          { status: p.status },
          identity.authorUserId,
        );
      } else if (request.action.startsWith('assignment.')) {
        const { employeeId, ...body } = p;
        const data = assignmentInputSchema.parse({ ...body, expectedRevision: 1 });
        if (old && old.employeeId !== employeeId)
          fail('EVIDENCE_IDENTITY_CONFLICT', 'Assignment employee cannot change');
        await dependency(c, 'employees', String(employeeId), request.organizationId);
        const schedule = await dependency(
          c,
          'work_schedules',
          data.scheduleId,
          request.organizationId,
        );
        if (schedule.status !== 'active')
          fail('EVIDENCE_INACTIVE_SCHEDULE', 'Assignment requires an active schedule');
        if (
          !(
            await c.query(
              'SELECT 1 FROM work_schedule_versions WHERE organization_id=$1 AND schedule_id=$2 AND effective_from<=$3',
              [request.organizationId, data.scheduleId, data.effectiveFrom],
            )
          ).rowCount
        )
          fail('EVIDENCE_DEPENDENCY_MISSING', 'Schedule has no applicable version');
        backdate(data.effectiveFrom, data.reason);
        if (old && !data.reason?.trim())
          fail('EVIDENCE_REASON_REQUIRED', 'Assignment corrections require a reason');
        const overlaps = await c.query(
          `SELECT id FROM employee_schedule_assignments WHERE organization_id=$1 AND employee_id=$2 AND id<>$3
          AND daterange(effective_from,effective_to,'[)') && daterange($4::date,$5::date,'[)') FOR UPDATE`,
          [
            request.organizationId,
            employeeId,
            request.entityId,
            data.effectiveFrom,
            data.effectiveTo,
          ],
        );
        if (overlaps.rowCount)
          fail(
            'EVIDENCE_ASSIGNMENT_OVERLAP',
            'Overlapping assignments require separately authorized changes',
          );
        if (old)
          await c.query(
            `INSERT INTO schedule_assignment_history(organization_id,assignment_id,revision,snapshot)
          VALUES($1,$2,$3,$4)`,
            [request.organizationId, old.id, old.revision, JSON.stringify(old)],
          );
        row = await writeRow(
          c,
          spec.table,
          request.entityId,
          request.organizationId,
          request.expectedRevision,
          {
            employeeId,
            scheduleId: data.scheduleId,
            effectiveFrom: data.effectiveFrom,
            effectiveTo: data.effectiveTo,
            reason: data.reason,
          },
          identity.authorUserId,
        );
      } else if (request.action.startsWith('leaveType.')) {
        const data = leaveTypeInputSchema.parse(p);
        row = await writeRow(
          c,
          spec.table,
          request.entityId,
          request.organizationId,
          request.expectedRevision,
          data,
          identity.authorUserId,
        );
      } else if (request.action === 'leave.request') {
        const data = leaveInputSchema.parse(p);
        await dependency(c, 'employees', data.employeeId, request.organizationId);
        const type = await dependency(c, 'leave_types', data.leaveTypeId, request.organizationId);
        if (type.status !== 'active')
          fail('EVIDENCE_INACTIVE_LEAVE_TYPE', 'Leave type must be active');
        const automatic = type.requiresApproval === false;
        row = await writeRow(
          c,
          spec.table,
          request.entityId,
          request.organizationId,
          0,
          {
            ...data,
            status: automatic ? 'approved' : 'pending',
            requestedBy: identity.authorUserId,
            typeSnapshot: {
              code: type.code,
              name: type.name,
              paid: type.paid,
              requiresApproval: type.requiresApproval,
            },
            ...(automatic
              ? { approvedBy: identity.authorUserId, approvedAt: identity.authorizedAt }
              : {}),
          },
          identity.authorUserId,
        );
      } else {
        if (!old) fail('EVIDENCE_REVISION_MISMATCH', 'Leave request is unavailable');
        await dependency(c, 'employees', String(old.employeeId), request.organizationId);
        await dependency(c, 'leave_types', String(old.leaveTypeId), request.organizationId);
        const action = request.action.slice('leave.'.length);
        if (old.status !== 'pending' && !(old.status === 'approved' && action === 'cancel'))
          fail('EVIDENCE_LEAVE_TRANSITION', 'Leave transition is not permitted');
        if (action === 'reject' && !(typeof p.remarks === 'string' && p.remarks.trim()))
          fail('EVIDENCE_REASON_REQUIRED', 'Leave rejection requires remarks');
        const prefix =
          action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';
        row = await writeRow(
          c,
          spec.table,
          request.entityId,
          request.organizationId,
          request.expectedRevision,
          {
            status: prefix,
            [prefix + 'By']: identity.authorUserId,
            [prefix + 'At']: identity.authorizedAt,
            remarks: p.remarks,
          },
          identity.authorUserId,
        );
      }
      // Serialize the actual persisted aggregate, including all immutable children/history.
      const snapshot =
        spec.table === 'work_schedules'
          ? await scheduleSnapshot(c, row)
          : spec.table === 'employee_schedule_assignments'
            ? {
                ...row,
                history: (
                  await c.query(
                    'SELECT * FROM schedule_assignment_history WHERE assignment_id=$1 ORDER BY revision',
                    [row.id],
                  )
                ).rows.map(normalize),
              }
            : row;
      const encoded = canonicalSyncJson(snapshot);
      if (Buffer.byteLength(encoded) > 262144)
        fail('EVIDENCE_SNAPSHOT_TOO_LARGE', 'Accepted aggregate exceeds the v2 protocol limit');
      const acceptance = (
        await c.query(
          `INSERT INTO central_evidence_acceptances(authorization_decision_id,organization_id,entity_id,entity_type,
        action,expected_revision,resulting_revision,canonical_snapshot,snapshot_fingerprint,audit_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            authorization.decision_id,
            request.organizationId,
            request.entityId,
            spec.table,
            request.action,
            request.expectedRevision,
            row.revision,
            encoded,
            hash(encoded),
            JSON.stringify({
              version: 1,
              requestId: request.requestId,
              authorizationFingerprint: fingerprint,
              actingUserId: identity.authorUserId,
              sourceNodeId: identity.nodeId,
              permission: spec.permission,
              before: beforeSnapshot,
              after: snapshot,
            }),
          ],
        )
      ).rows[0];
      const event = await publishTrustedEvidence(c, acceptance.acceptance_id);
      await checkExpiry();
      return { acceptance, event };
    });
  };
}
