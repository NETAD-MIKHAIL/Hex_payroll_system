import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { canonicalSyncJson, isoDateSchema } from '@hexpayroll/shared';
import { DomainError, transaction } from '../foundation/repository.js';
import {
  authorizeCentralUser,
  centralCredentialsSchema,
  type AttendanceAuthorizationCredentials,
} from './central-attendance-authorization.js';

const commandSchema = z
  .object({
    requestId: z.uuid(),
    organizationId: z.uuid(),
    employeeId: z.uuid(),
    workDate: isoDateSchema,
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

/** Audited, revision-bound preparation for central attendance proposals. A review
 * does not certify capture completeness or write canonical attendance state.
 */
export function createAttendanceEvidenceReviewService(
  pool: Pool,
  mode: 'local' | 'central',
  enabled = false,
) {
  return async (credentials: AttendanceAuthorizationCredentials, input: unknown) => {
    if (mode !== 'central' || !enabled)
      throw new DomainError(403, 'DISABLED', 'Attendance evidence review is disabled');
    const cmd = commandSchema.parse(input);
    const auth = centralCredentialsSchema.parse(credentials);
    return transaction(pool, async (c) => {
      const actor = await authorizeCentralUser(c, auth, cmd.organizationId, 'attendance.manage');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `attendance-review:${cmd.organizationId}:${cmd.employeeId}:${cmd.workDate}`,
      ]);
      const prior = (
        await c.query(
          'SELECT *,work_date::text work_date_text FROM central_attendance_evidence_reviews WHERE request_id=$1',
          [cmd.requestId],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.organization_id !== cmd.organizationId ||
          prior.employee_id !== cmd.employeeId ||
          prior.work_date_text !== cmd.workDate ||
          prior.revision !== cmd.expectedRevision + 1 ||
          prior.reason !== cmd.reason ||
          prior.operator_id !== actor.submitterUserId ||
          prior.node_id !== actor.nodeId
        )
          throw new DomainError(409, 'CONFLICT', 'Review identity reused with different content');
        return prior;
      }
      const latest = (
        await c.query(
          'SELECT COALESCE(max(revision),0)::int revision FROM central_attendance_evidence_reviews WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3',
          [cmd.organizationId, cmd.employeeId, cmd.workDate],
        )
      ).rows[0].revision;
      if (latest !== cmd.expectedRevision)
        throw new DomainError(409, 'CONFLICT', 'Evidence review revision changed');
      const devices = (
        await c.query(
          'SELECT device_id,node_id FROM central_biometric_sources WHERE organization_id=$1 ORDER BY device_id',
          [cmd.organizationId],
        )
      ).rows;
      for (const device of devices)
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'central-biometric:' + device.device_id,
        ]);
      // Serialize accepted evidence publication while reading immutable source revisions.
      await c.query('SELECT pg_advisory_xact_lock(684297106)');
      const gaps = (
        await c.query(
          `WITH sequences AS (
        SELECT device_id,sequence,lag(sequence,1,0::bigint) OVER(PARTITION BY device_id ORDER BY sequence) previous
        FROM central_biometric_receipts WHERE organization_id=$1)
        SELECT device_id,(previous+1)::text first_missing,(sequence-1)::text last_missing
        FROM sequences WHERE sequence>previous+1 ORDER BY device_id,sequence`,
          [cmd.organizationId],
        )
      ).rows;
      const receipts = (
        await c.query(
          'SELECT batch_id,device_id,sequence::text,payload FROM central_biometric_receipts WHERE organization_id=$1 ORDER BY device_id,sequence',
          [cmd.organizationId],
        )
      ).rows;
      const accepted = (
        await c.query(
          `SELECT DISTINCT ON(entity_type,entity_id) entity_type,entity_id,resulting_revision,canonical_snapshot,snapshot_fingerprint
        FROM central_evidence_acceptances WHERE organization_id=$1 ORDER BY entity_type,entity_id,resulting_revision DESC`,
          [cmd.organizationId],
        )
      ).rows;
      const mappings = (
        await c.query(
          'SELECT to_jsonb(m) snapshot FROM biometric_mappings m WHERE organization_id=$1 ORDER BY device_id,device_employee_id',
          [cmd.organizationId],
        )
      ).rows;
      // Capture-batch ordinals can expose missing delivery, but cannot prove a
      // device exported its entire log or that a later punch will never arrive.
      const blockers = ['SOURCE_PERIOD_CLOSURE_UNVERIFIED'];
      if (!devices.length) blockers.push('EXPECTED_DEVICE_COVERAGE_UNVERIFIED');
      if (gaps.length) blockers.push('MISSING_CAPTURE_BATCHES');
      if (!accepted.length) blockers.push('ACCEPTED_SCHEDULE_EVIDENCE_MISSING');
      const snapshot = {
        version: 1,
        organizationId: cmd.organizationId,
        employeeId: cmd.employeeId,
        workDate: cmd.workDate,
        devices,
        gaps,
        receipts,
        accepted,
        mappings,
        blockers,
        status: 'pending_review',
        finalized: false,
      };
      const canonical = canonicalSyncJson(snapshot);
      const fingerprint = createHash('sha256').update(canonical).digest('hex');
      return (
        await c.query(
          `INSERT INTO central_attendance_evidence_reviews(request_id,organization_id,employee_id,work_date,revision,operator_id,node_id,reason,snapshot,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            cmd.requestId,
            cmd.organizationId,
            cmd.employeeId,
            cmd.workDate,
            cmd.expectedRevision + 1,
            actor.submitterUserId,
            actor.nodeId,
            cmd.reason,
            canonical,
            fingerprint,
          ],
        )
      ).rows[0];
    });
  };
}
