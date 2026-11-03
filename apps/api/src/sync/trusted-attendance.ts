import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalSyncJson, syncSequenceSchema, isoDateSchema } from '@hexpayroll/shared';
import { transaction, DomainError } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import { authenticateNode } from './service.js';
import { syncRequest, type SyncClientConfig } from './client.js';
import { digest } from '../timekeeping/source-period-protocol.js';
const snapshotSchema = z
  .object({
    canonical_attendance_id: z.uuid(),
    organization_id: z.uuid(),
    employee_id: z.uuid(),
    work_date: isoDateSchema,
    canonical_revision: z.number().int().positive(),
    first_in: z.string().nullable(),
    last_out: z.string().nullable(),
    worked_minutes: z.number().int().min(0).max(1440),
    late_minutes: z.number().int().min(0).max(1440),
    undertime_minutes: z.number().int().min(0).max(1440),
    attendance_status: z.enum(['present', 'late', 'absent', 'on_leave', 'rest_day', 'incomplete']),
    approval_status: z.enum(['unreviewed', 'approved', 'needs_review']),
    result: z.record(z.string(), z.unknown()),
    accepted_evidence_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    processor_version: z.number().int().positive(),
    approved_by: z.uuid().nullable(),
    approved_at: z.string().nullable(),
    last_proposal_id: z.uuid(),
    last_decision_id: z.uuid(),
    last_decision_category: z.literal('accepted'),
    updated_by: z.uuid(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict()
  .refine(
    (s) =>
      s.approval_status === 'approved'
        ? s.approved_by !== null && s.approved_at !== null
        : s.approved_by === null && s.approved_at === null,
    'Invalid approval attribution',
  );
export const trustedAttendanceEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(2),
    origin: z.literal('central.attendance'),
    sequence: syncSequenceSchema,
    eventId: z.uuid(),
    organizationId: z.uuid(),
    canonicalId: z.uuid(),
    canonicalRevision: z.number().int().positive(),
    snapshot: snapshotSchema,
    snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((e, c) => {
    const s = e.snapshot;
    if (
      e.organizationId !== s.organization_id ||
      e.canonicalId !== s.canonical_attendance_id ||
      e.canonicalRevision !== s.canonical_revision ||
      e.snapshotFingerprint !== digest(s)
    )
      c.addIssue({ code: 'custom', message: 'Trusted attendance binding mismatch' });
  });
export const trustedAttendancePageSchema = z
  .object({
    changes: z.array(trustedAttendanceEnvelopeSchema).max(3),
    nextSequence: syncSequenceSchema,
  })
  .strict();
async function localIdentity(c: Pool | PoolClient, config: SyncClientConfig, locking = false) {
  const r = (
    await c.query<{ organization_id: string }>(
      `SELECT organization_id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL ${locking ? 'FOR SHARE' : ''}`,
      [config.nodeId, tokenHash(config.token)],
    )
  ).rows[0];
  if (!r) throw new Error('Local installation not enrolled');
  return r.organization_id;
}
export async function pullTrustedAttendance(pool: Pool, nodeToken: string, after: string) {
  syncSequenceSchema.parse(after);
  return transaction(pool, async (c) => {
    const node = await authenticateNode(c, nodeToken);
    const locked = (
      await c.query(
        'SELECT id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL FOR SHARE',
        [node.id, tokenHash(nodeToken)],
      )
    ).rowCount;
    if (!locked) throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
    const rows = (
      await c.query(
        'SELECT *,sequence::text ordinal FROM central_attendance_events WHERE organization_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 3',
        [node.organization_id, after],
      )
    ).rows;
    return trustedAttendancePageSchema.parse({
      changes: rows.map((r) => ({
        protocolVersion: 2,
        origin: 'central.attendance',
        sequence: r.ordinal,
        eventId: r.event_id,
        organizationId: r.organization_id,
        canonicalId: r.canonical_id,
        canonicalRevision: r.canonical_revision,
        snapshot: JSON.parse(r.snapshot),
        snapshotFingerprint: r.fingerprint,
      })),
      nextSequence: rows.at(-1)?.ordinal ?? after,
    });
  });
}
export async function pullNextTrustedAttendanceBatch(pool: Pool, config: SyncClientConfig) {
  const org = await localIdentity(pool, config);
  const after =
    (
      await pool.query<{ n: string }>(
        'SELECT last_sequence::text n FROM trusted_attendance_checkpoints WHERE organization_id=$1 AND node_id=$2',
        [org, config.nodeId],
      )
    ).rows[0]?.n ?? '0';
  const page = trustedAttendancePageSchema.parse(
    await syncRequest(config, 'attendance/pull?after=' + after),
  );
  let cursor = BigInt(after);
  for (const e of page.changes) {
    if (e.organizationId !== org || BigInt(e.sequence) <= cursor)
      throw new Error('Invalid trusted attendance page');
    cursor = BigInt(e.sequence);
  }
  if (page.nextSequence !== cursor.toString()) throw new Error('Invalid trusted attendance cursor');
  await transaction(pool, async (c) => {
    const lockedOrg = await localIdentity(c, config, true);
    if (lockedOrg !== org) throw new Error('Local enrollment changed');
    await c.query(
      'INSERT INTO trusted_attendance_checkpoints(organization_id,node_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [org, config.nodeId],
    );
    const checkpoint = (
      await c.query<{ n: string }>(
        'SELECT last_sequence::text n FROM trusted_attendance_checkpoints WHERE organization_id=$1 AND node_id=$2 FOR UPDATE',
        [org, config.nodeId],
      )
    ).rows[0]!;
    if (checkpoint.n !== after) return;
    for (const e of page.changes) {
      const prior = (
        await c.query(
          'SELECT envelope FROM trusted_attendance_inbox WHERE sequence=$1 OR event_id=$2',
          [e.sequence, e.eventId],
        )
      ).rows;
      if (prior.length) {
        if (prior.length !== 1 || canonicalSyncJson(prior[0].envelope) !== canonicalSyncJson(e))
          throw new Error('Trusted attendance replay mismatch');
      } else
        await c.query(
          'INSERT INTO trusted_attendance_inbox(sequence,event_id,organization_id,canonical_id,canonical_revision,envelope) VALUES($1,$2,$3,$4,$5,$6)',
          [e.sequence, e.eventId, org, e.canonicalId, e.canonicalRevision, JSON.stringify(e)],
        );
    }
    await c.query(
      'UPDATE trusted_attendance_checkpoints SET last_sequence=$3 WHERE organization_id=$1 AND node_id=$2',
      [org, config.nodeId, page.nextSequence],
    );
  });
  return page.changes.length;
}
export async function applyTrustedAttendanceBatch(
  pool: Pool,
  config: SyncClientConfig,
  mode: 'local' | 'central' = 'local',
) {
  if (mode !== 'local') throw new Error('Trusted attendance application is local only');
  return transaction(pool, async (c) => {
    const org = await localIdentity(c, config, true);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'trusted-attendance:' + org,
    ]);
    const rows = (
      await c.query(
        `SELECT i.* FROM trusted_attendance_inbox i LEFT JOIN trusted_attendance_application_state a USING(sequence)
      WHERE organization_id=$1 AND NOT EXISTS(SELECT 1 FROM trusted_attendance_applications r WHERE r.sequence=i.sequence)
      AND (a.next_attempt_at IS NULL OR a.next_attempt_at<=clock_timestamp()) ORDER BY COALESCE(a.attempts,0),i.sequence LIMIT 30`,
        [org],
      )
    ).rows;
    let applied = 0,
      pending = 0,
      conflicts = 0;
    for (const row of rows) {
      const e = trustedAttendanceEnvelopeSchema.parse(row.envelope),
        s = e.snapshot;
      const current = (
        await c.query(
          'SELECT * FROM trusted_attendance_state WHERE canonical_id=$1 OR (organization_id=$2 AND employee_id=$3 AND work_date=$4)',
          [e.canonicalId, org, s.employee_id, s.work_date],
        )
      ).rows[0];
      let code: string | null = null,
        status: 'pending' | 'conflict' = 'pending';
      if (current && (current.canonical_id !== e.canonicalId || current.organization_id !== org)) {
        code = 'LOCAL_IDENTITY_CONFLICT';
        status = 'conflict';
      } else if (Number(current?.canonical_revision ?? 0) !== e.canonicalRevision - 1)
        code = 'CANONICAL_REVISION_GAP';
      else if (
        !(
          await c.query('SELECT 1 FROM employees WHERE organization_id=$1 AND id=$2', [
            org,
            s.employee_id,
          ])
        ).rowCount
      )
        code = 'MISSING_EMPLOYEE';
      else {
        for (const actor of new Set(
          [s.updated_by, s.approved_by].filter((a): a is string => a !== null),
        ))
          if (
            !(
              await c.query('SELECT 1 FROM auth_users WHERE organization_id=$1 AND id=$2', [
                org,
                actor,
              ])
            ).rowCount
          )
            code = 'MISSING_TRUSTED_ACTOR';
      }
      if (code) {
        await c.query(
          `INSERT INTO trusted_attendance_application_state(sequence,status,code,next_attempt_at) VALUES($1,$2,$3,clock_timestamp()+interval '15 seconds') ON CONFLICT(sequence) DO UPDATE SET status=$2,code=$3,attempts=trusted_attendance_application_state.attempts+1,next_attempt_at=clock_timestamp()+interval '15 seconds'`,
          [e.sequence, status, code],
        );
        if (status === 'conflict') conflicts++;
        else pending++;
        continue;
      }
      const args = [
        e.canonicalId,
        org,
        s.employee_id,
        s.work_date,
        e.canonicalRevision,
        e.sequence,
        JSON.stringify(s),
      ];
      if (!current)
        await c.query(
          'INSERT INTO trusted_attendance_state(canonical_id,organization_id,employee_id,work_date,canonical_revision,sequence,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',
          args,
        );
      else
        await c.query(
          'UPDATE trusted_attendance_state SET canonical_revision=$5,sequence=$6,snapshot=$7 WHERE canonical_id=$1 AND organization_id=$2 AND employee_id=$3 AND work_date=$4',
          args,
        );
      await c.query('INSERT INTO trusted_attendance_applications(sequence) VALUES($1)', [
        e.sequence,
      ]);
      await c.query('DELETE FROM trusted_attendance_application_state WHERE sequence=$1', [
        e.sequence,
      ]);
      applied++;
    }
    return { applied, pending, conflicts };
  });
}
