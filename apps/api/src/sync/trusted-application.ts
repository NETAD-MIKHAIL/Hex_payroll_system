import type { Pool, PoolClient } from 'pg';
import { requireBroadStreamsDisabled } from './pilot-scope.js';
import { canonicalSyncJson, type TrustedEvidenceEnvelope } from '@hexpayroll/shared';
import { normalize, transaction, databaseErrorCode } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import { scheduleWeekdayId } from '../timekeeping/schedule-identity.js';
import { verifyTrustedEvidence } from './trusted-evidence.js';
import { validateTrustedSnapshot } from './trusted-snapshots.js';
import type { SyncClientConfig } from './client.js';
import { identityFingerprint } from './trusted-identity-protocol.js';

type Row = Record<string, unknown>;
export class ApplicationIssue extends Error {
  constructor(
    public code: string,
    public status: 'pending' | 'conflict',
  ) {
    super(code);
  }
}
const pending = (code: string): never => {
  throw new ApplicationIssue(code, 'pending');
};
const conflict = (code: string): never => {
  throw new ApplicationIssue(code, 'conflict');
};
const equal = (a: unknown, b: unknown) => canonicalSyncJson(a) === canonicalSyncJson(b);
const snake = (key: string) => key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const tables = new Set([
  'work_schedules',
  'work_schedule_versions',
  'work_schedule_days',
  'employee_schedule_assignments',
  'schedule_assignment_history',
  'leave_types',
  'leave_requests',
]);

// All identifiers originate in fixed schemas and the table allowlist, never SQL input.
async function insert(c: PoolClient, table: string, row: Row) {
  if (!tables.has(table)) throw new Error('Invalid projection table');
  const entries = Object.entries(row);
  await c.query(
    `INSERT INTO ${table}(${entries.map(([k]) => snake(k)).join(',')}) VALUES(${entries.map((_, i) => '$' + (i + 1)).join(',')})`,
    entries.map(([, v]) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)),
  );
}
async function reference(
  c: PoolClient,
  table: 'auth_users' | 'employees' | 'work_schedules' | 'leave_types',
  id: unknown,
  org: string,
) {
  if (id === null) return;
  const row = (await c.query(`SELECT id,organization_id FROM ${table} WHERE id=$1 FOR SHARE`, [id]))
    .rows[0];
  if (!row)
    pending(table === 'auth_users' ? 'MISSING_TRUSTED_ACTOR' : 'MISSING_' + table.toUpperCase());
  if (row.organization_id !== org) conflict('DEPENDENCY_ORGANIZATION_MISMATCH');
}
async function actors(c: PoolClient, row: Row, org: string) {
  for (const key of [
    'updatedBy',
    'createdBy',
    'requestedBy',
    'approvedBy',
    'rejectedBy',
    'cancelledBy',
  ])
    if (row[key] !== undefined) await reference(c, 'auth_users', row[key], org);
}
export async function readTrustedAggregate(
  c: PoolClient,
  type: string,
  id: string,
): Promise<Row | null> {
  if (
    !['work_schedules', 'employee_schedule_assignments', 'leave_types', 'leave_requests'].includes(
      type,
    )
  )
    throw new Error('Invalid aggregate type');
  const root = (await c.query(`SELECT * FROM ${type} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!root) return null;
  const result: Row = normalize(root);
  if (type === 'work_schedules') {
    const versions = (
      await c.query(
        'SELECT * FROM work_schedule_versions WHERE schedule_id=$1 ORDER BY effective_from,id',
        [id],
      )
    ).rows;
    result.versions = [];
    for (const v of versions)
      (result.versions as Row[]).push({
        ...normalize(v),
        days: (
          await c.query(
            'SELECT * FROM work_schedule_days WHERE version_id=$1 ORDER BY day_of_week',
            [v.id],
          )
        ).rows.map(normalize),
      });
  }
  if (type === 'employee_schedule_assignments')
    result.history = (
      await c.query(
        'SELECT * FROM schedule_assignment_history WHERE assignment_id=$1 ORDER BY revision',
        [id],
      )
    ).rows.map(normalize);
  return result;
}
const without = (row: Row, keys: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
function transition(event: TrustedEvidenceEnvelope, before: Row | null, after: Row) {
  if (!before) {
    if (event.entityType === 'work_schedules' && (after.versions as Row[]).length !== 1)
      conflict('INVALID_INITIAL_HISTORY');
    if (
      event.entityType === 'employee_schedule_assignments' &&
      (after.history as Row[]).length !== 0
    )
      conflict('INVALID_INITIAL_HISTORY');
    return;
  }
  if (before.createdAt !== after.createdAt) conflict('IMMUTABLE_CREATION_CHANGED');
  if (event.entityType === 'work_schedules') {
    const old = before.versions as Row[],
      next = after.versions as Row[];
    const added = event.action === 'schedule.update' ? 1 : 0;
    if (next.length !== old.length + added || !equal(next.slice(0, old.length), old))
      conflict('IMMUTABLE_SCHEDULE_HISTORY_CHANGED');
    if (
      event.action === 'schedule.status' &&
      !equal(
        without(before, ['versions', 'status', 'revision', 'updatedAt', 'updatedBy']),
        without(after, ['versions', 'status', 'revision', 'updatedAt', 'updatedBy']),
      )
    )
      conflict('STATUS_CHANGED_UNBOUND_CONTENT');
  }
  if (event.entityType === 'employee_schedule_assignments') {
    const old = before.history as Row[],
      next = after.history as Row[];
    if (
      before.employeeId !== after.employeeId ||
      next.length !== old.length + 1 ||
      !equal(next.slice(0, old.length), old) ||
      !equal(next.at(-1)?.snapshot, without(before, ['history']))
    )
      conflict('IMMUTABLE_ASSIGNMENT_HISTORY_CHANGED');
  }
  if (event.entityType === 'leave_requests') {
    if (!(
      before.status === 'pending' ||
      (before.status === 'approved' && event.action === 'leave.cancel')
    ))
      conflict('INVALID_LEAVE_TRANSITION');
    const changed =
      event.action === 'leave.approve'
        ? ['approvedBy', 'approvedAt']
        : event.action === 'leave.reject'
          ? ['rejectedBy', 'rejectedAt']
          : ['cancelledBy', 'cancelledAt'];
    const allowed = ['status', 'remarks', 'revision', 'updatedBy', 'updatedAt', ...changed];
    if (!equal(without(before, allowed), without(after, allowed)))
      conflict('IMMUTABLE_LEAVE_CONTENT_CHANGED');
  }
}
export async function pendingEvidenceOutbox(
  c: PoolClient,
  event: TrustedEvidenceEnvelope,
  before: Row | null,
) {
  const ids = [event.entityId];
  for (const aggregate of [event.snapshot, before])
    if (aggregate && Array.isArray(aggregate.versions))
      for (const v of aggregate.versions as Row[]) {
        ids.push(v.id as string);
        for (const d of v.days as Row[]) ids.push(d.id as string);
      }
  return (
    await c.query(
      `SELECT o.id,o.status,o.lease_expires_at,jsonb_build_object('id',o.id,'organizationId',o.organization_id,'entityType',o.entity_type,'entityId',o.entity_id,'operation',o.operation,'revision',o.revision,'payloadVersion',o.payload_version,'payload',o.payload) content FROM sync_outbox o
    WHERE o.organization_id=$1 AND o.entity_id=ANY($2::uuid[]) AND o.entity_type IN ('work_schedules','work_schedule_versions','work_schedule_days','employee_schedule_assignments','schedule_assignment_history','leave_types','leave_requests') AND o.status<>'synced'
    AND NOT EXISTS(SELECT 1 FROM trusted_evidence_reconciled_outbox r WHERE r.outbox_id=o.id AND r.content=jsonb_build_object('id',o.id,'organizationId',o.organization_id,'entityType',o.entity_type,'entityId',o.entity_id,'operation',o.operation,'revision',o.revision,'payloadVersion',o.payload_version,'payload',o.payload)) ORDER BY o.id FOR UPDATE OF o`,
      [event.organizationId, ids],
    )
  ).rows;
}
export async function projectTrustedEvidence(
  c: PoolClient,
  event: TrustedEvidenceEnvelope,
  reconciliationId?: string,
) {
  let row: Row;
  try {
    row = validateTrustedSnapshot(event);
  } catch {
    throw new ApplicationIssue('INVALID_ACCEPTED_SNAPSHOT', 'conflict');
  }
  const org = event.organizationId;
  const before = await readTrustedAggregate(c, event.entityType, event.entityId);
  const prior = (
    await c.query(
      `SELECT canonical_snapshot FROM trusted_evidence_applications WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY revision DESC LIMIT 1`,
      [org, event.entityType, event.entityId],
    )
  ).rows[0];
  const predecessor: Row | null = prior ? JSON.parse(prior.canonical_snapshot) : null;
  const outbox = await pendingEvidenceOutbox(c, event, before);
  if (reconciliationId) {
    const decision = (
      await c.query('SELECT * FROM trusted_evidence_reconciliations WHERE id=$1', [
        reconciliationId,
      ])
    ).rows[0];
    if (
      !decision ||
      decision.organization_id !== org ||
      String(decision.sequence) !== event.sequence ||
      decision.decision !== 'useCentral' ||
      decision.local_fingerprint !== identityFingerprint(before) ||
      decision.central_fingerprint !== event.snapshotFingerprint ||
      !equal(
        decision.outbox_snapshot,
        outbox.map((r) => r.content),
      )
    )
      conflict('RECONCILIATION_BINDING_CHANGED');
    if (!before || before.organizationId !== org)
      throw new ApplicationIssue('RECONCILIATION_TARGET_MISSING', 'conflict');
    if ((predecessor?.revision ?? 0) !== event.expectedRevision)
      conflict('RECONCILIATION_REVISION_GAP');
    if (event.entityType === 'work_schedules') {
      const allowed = (predecessor ?? row).versions as Row[];
      if (
        !(before.versions as Row[]).every((v) => allowed.some((a) => equal(v, a))) ||
        (predecessor && !equal(before.versions, predecessor.versions))
      )
        conflict('RECONCILIATION_IMMUTABLE_CHILD_BLOCKER');
    }
    if (
      event.entityType === 'employee_schedule_assignments' &&
      !equal(before.history, (predecessor ?? row).history)
    )
      conflict('RECONCILIATION_IMMUTABLE_HISTORY_BLOCKER');
  }
  if (before && before.organizationId !== org) conflict('TARGET_ORGANIZATION_MISMATCH');
  if (!reconciliationId && !prior && before) conflict('EXISTING_LOCAL_EVIDENCE');
  if (!before && event.expectedRevision !== 0) pending('REVISION_GAP');
  if (before && !reconciliationId) {
    if (!prior || !equal(before, JSON.parse(prior.canonical_snapshot)))
      conflict('LOCAL_EVIDENCE_CHANGED');
    if (Number(before.revision) < event.expectedRevision) pending('REVISION_GAP');
    if (before.revision !== event.expectedRevision) conflict('REVISION_CONFLICT');
  } else if (!before && prior) conflict('LOCAL_EVIDENCE_REMOVED');
  if (outbox.length && !reconciliationId) conflict('PENDING_LOCAL_WORK');
  await actors(c, row, org);
  if (event.entityType === 'work_schedules')
    for (const v of row.versions as Row[]) {
      await actors(c, v, org);
      try {
        new Intl.DateTimeFormat('en', { timeZone: v.timezone as string });
      } catch {
        conflict('INVALID_TIMEZONE');
      }
      for (const d of v.days as Row[])
        if (d.id !== scheduleWeekdayId(v.id as string, d.dayOfWeek as number))
          conflict('INVALID_WEEKDAY_IDENTITY');
    }
  if (event.entityType === 'employee_schedule_assignments' || event.entityType === 'leave_requests')
    await reference(c, 'employees', row.employeeId, org);
  if (event.entityType === 'employee_schedule_assignments') {
    await reference(c, 'work_schedules', row.scheduleId, org);
    for (const h of row.history as Row[]) await actors(c, h.snapshot as Row, org);
    if (
      !(
        await c.query(
          'SELECT 1 FROM work_schedule_versions WHERE schedule_id=$1 AND organization_id=$2 AND effective_from<=$3 LIMIT 1',
          [row.scheduleId, org, row.effectiveFrom],
        )
      ).rowCount
    )
      pending('MISSING_EFFECTIVE_SCHEDULE_VERSION');
    const overlaps = (
      await c.query(
        `SELECT a.id,EXISTS(SELECT 1 FROM trusted_evidence_applications r WHERE r.organization_id=$1 AND r.entity_type='employee_schedule_assignments' AND r.entity_id=a.id) trusted FROM employee_schedule_assignments a WHERE a.organization_id=$1 AND a.employee_id=$2 AND a.id<>$3 AND daterange(a.effective_from,a.effective_to,'[)') && daterange($4::date,$5::date,'[)')`,
        [org, row.employeeId, row.id, row.effectiveFrom, row.effectiveTo],
      )
    ).rows;
    if (overlaps.some((r) => !r.trusted)) conflict('LOCAL_ASSIGNMENT_OVERLAP');
    if (overlaps.length) pending('TRUSTED_ASSIGNMENT_OVERLAP');
  }
  if (event.entityType === 'leave_requests') {
    await reference(c, 'leave_types', row.leaveTypeId, org);
    if (row.status === 'pending' || row.status === 'approved') {
      const overlaps = (
        await c.query(
          `SELECT l.id,EXISTS(SELECT 1 FROM trusted_evidence_applications r WHERE r.organization_id=$1 AND r.entity_type='leave_requests' AND r.entity_id=l.id) trusted FROM leave_requests l WHERE l.organization_id=$1 AND l.employee_id=$2 AND l.id<>$3 AND l.status IN ('pending','approved') AND l.start_date<=$5 AND l.end_date>=$4 AND (l.duration_type='full_day' OR $6='full_day' OR l.duration_type=$6)`,
          [org, row.employeeId, row.id, row.startDate, row.endDate, row.durationType],
        )
      ).rows;
      if (overlaps.some((r) => !r.trusted)) conflict('LOCAL_LEAVE_OVERLAP');
      if (overlaps.length) pending('TRUSTED_LEAVE_OVERLAP');
    }
  }
  transition(event, reconciliationId ? predecessor : before, row);
  const root = without(row, ['versions', 'history']);
  if (!before) await insert(c, event.entityType, root);
  else {
    const entries = Object.entries(
      without(
        root,
        reconciliationId ? ['id', 'organizationId'] : ['id', 'organizationId', 'createdAt'],
      ),
    );
    const changed = await c.query(
      `UPDATE ${event.entityType} SET ${entries.map(([k], i) => snake(k) + '=$' + (i + 4)).join(',')} WHERE id=$1 AND organization_id=$2 AND revision=$3`,
      [
        event.entityId,
        org,
        reconciliationId ? before.revision : event.expectedRevision,
        ...entries.map(([, v]) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)),
      ],
    );
    if (changed.rowCount !== 1) conflict('REVISION_CONFLICT');
  }
  if (event.entityType === 'work_schedules')
    for (const v of row.versions as Row[]) {
      const exists = (await c.query('SELECT 1 FROM work_schedule_versions WHERE id=$1', [v.id]))
        .rowCount;
      if (!exists) {
        await insert(c, 'work_schedule_versions', without(v, ['days']));
        for (const d of v.days as Row[]) await insert(c, 'work_schedule_days', d);
      }
    }
  if (event.entityType === 'employee_schedule_assignments')
    for (const h of row.history as Row[]) {
      if (
        !(await c.query('SELECT 1 FROM schedule_assignment_history WHERE id=$1', [h.id])).rowCount
      )
        await insert(c, 'schedule_assignment_history', h);
    }
  if (!equal(await readTrustedAggregate(c, event.entityType, event.entityId), row))
    conflict('PROJECTION_SNAPSHOT_MISMATCH');
  await c.query(
    `INSERT INTO trusted_evidence_applications(organization_id,sequence,event_id,acceptance_id,entity_type,entity_id,revision,snapshot_fingerprint,canonical_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      org,
      event.sequence,
      event.eventId,
      event.acceptanceId,
      event.entityType,
      event.entityId,
      event.resultingRevision,
      event.snapshotFingerprint,
      canonicalSyncJson(row),
    ],
  );
  if (reconciliationId) {
    for (const item of outbox) {
      await c.query(
        'INSERT INTO trusted_evidence_reconciled_outbox(outbox_id,reconciliation_id,content) VALUES($1,$2,$3)',
        [item.id, reconciliationId, JSON.stringify(item.content)],
      );
      await c.query(
        "UPDATE sync_outbox SET status='failed',error='Preserved by explicit evidence reconciliation; do not resend',lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
        [item.id],
      );
    }
    await c.query(
      'INSERT INTO trusted_evidence_reconciliation_applications(reconciliation_id,organization_id,sequence) VALUES($1,$2,$3)',
      [reconciliationId, org, event.sequence],
    );
  }
}

/** Local-only projection of already durable, immutable trusted inbox rows. */
export async function applyTrustedEvidenceBatch(
  pool: Pool,
  config: SyncClientConfig,
  mode: 'local' | 'central' | 'disabled',
) {
  if (mode !== 'local') throw new Error('Trusted application is local-only');
  await requireBroadStreamsDisabled(pool);
  return transaction(pool, async (c) => {
    if (
      (await c.query("SELECT to_regclass('central_evidence_acceptances') present")).rows[0].present
    )
      throw new Error('Central storage cannot run local projection');
    const node = (
      await c.query(
        'SELECT organization_id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL FOR SHARE',
        [config.nodeId, tokenHash(config.token)],
      )
    ).rows[0];
    if (!node) throw new Error('Local installation not enrolled');
    const org: string = node.organization_id;
    const setup = (await c.query('SELECT organization_id FROM application_setup FOR SHARE'))
      .rows[0];
    if (setup?.organization_id !== org) throw new Error('Local organization mismatch');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,731))', [org]);
    const rows = (
      await c.query(
        `SELECT i.sequence::text,i.envelope FROM trusted_evidence_inbox i
      LEFT JOIN trusted_evidence_applications a USING(organization_id,sequence)
      LEFT JOIN trusted_evidence_application_state s USING(organization_id,sequence)
      WHERE i.organization_id=$1 AND a.sequence IS NULL AND (s.sequence IS NULL OR (s.status='pending' AND s.next_attempt_at<=clock_timestamp()))
      AND NOT EXISTS(SELECT 1 FROM trusted_evidence_inbox earlier LEFT JOIN trusted_evidence_applications done USING(organization_id,sequence)
        WHERE earlier.organization_id=i.organization_id AND earlier.sequence<i.sequence AND done.sequence IS NULL AND earlier.envelope->>'entityType'=i.envelope->>'entityType' AND earlier.envelope->>'entityId'=i.envelope->>'entityId')
      ORDER BY i.sequence LIMIT 20`,
        [org],
      )
    ).rows;
    const result = { applied: 0, pending: 0, conflicts: 0 };
    for (const entry of rows) {
      await c.query('SAVEPOINT trusted_projection');
      try {
        const event = verifyTrustedEvidence(entry.envelope);
        if (event.organizationId !== org || event.sequence !== entry.sequence)
          conflict('INBOX_BINDING_MISMATCH');
        await projectTrustedEvidence(c, event);
        await c.query('RELEASE SAVEPOINT trusted_projection');
        result.applied++;
      } catch (error) {
        await c.query('ROLLBACK TO SAVEPOINT trusted_projection');
        await c.query('RELEASE SAVEPOINT trusted_projection');
        // Database/validation failures never include raw error details in durable state.
        const code = databaseErrorCode(error);
        const issue =
          error instanceof ApplicationIssue
            ? error
            : ['23505', '23514'].includes(code)
              ? new ApplicationIssue('LOCAL_CONSTRAINT_CONFLICT', 'conflict')
              : new ApplicationIssue('PROJECTION_FAILED', 'pending');
        await c.query(
          `INSERT INTO trusted_evidence_application_state(organization_id,sequence,status,code,next_attempt_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '2 seconds')
          ON CONFLICT(organization_id,sequence) DO UPDATE SET status=excluded.status,code=excluded.code,attempts=trusted_evidence_application_state.attempts+1,last_attempt_at=clock_timestamp(),next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(300,power(2,LEAST(trusted_evidence_application_state.attempts+1,8))::integer))`,
          [org, entry.sequence, issue.status, issue.code],
        );
        if (issue.status === 'conflict') result.conflicts++;
        else result.pending++;
      }
    }
    return result;
  });
}
