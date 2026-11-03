import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { syncSequenceSchema } from '@hexpayroll/shared';
import { DomainError, transaction, getActor, requirePermission } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import { localTrustGate } from './trusted-identities.js';
import { verifyTrustedEvidence } from './trusted-evidence.js';
import {
  readTrustedAggregate,
  pendingEvidenceOutbox,
  projectTrustedEvidence,
  ApplicationIssue,
} from './trusted-application.js';
import { identityFingerprint } from './trusted-identity-protocol.js';
import { evidenceActions } from '../timekeeping/central-evidence-decisions.js';
import type { SyncClientConfig } from './client.js';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const inputSchema = z
  .object({
    requestId: z.uuid(),
    sequence: syncSequenceSchema.refine((s) => s !== '0'),
    decision: z.enum(['preserveLocal', 'useCentral']),
    reason: z.string().trim().min(1).max(2000),
    localFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    centralFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    outboxFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    competingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
async function inspect(c: PoolClient, config: SyncClientConfig, token: string, sequence: string) {
  const org = await localTrustGate(c, config);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,731))', [org]);
  const entry = (
    await c.query(
      'SELECT envelope FROM trusted_evidence_inbox WHERE organization_id=$1 AND sequence=$2',
      [org, sequence],
    )
  ).rows[0];
  if (!entry) throw new DomainError(404, 'NOT_FOUND', 'Trusted evidence is unavailable');
  const event = verifyTrustedEvidence(entry.envelope);
  const initial = (
    await c.query(
      'SELECT user_id FROM auth_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()',
      [tokenHash(token)],
    )
  ).rows[0];
  if (!initial)
    throw new DomainError(401, 'SESSION_INVALID', 'Active local operator session required');
  await c.query('SELECT id FROM auth_users WHERE id=$1 FOR SHARE', [initial.user_id]);
  const session = (
    await c.query(
      'SELECT user_id FROM auth_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp() FOR SHARE',
      [tokenHash(token)],
    )
  ).rows[0];
  if (!session)
    throw new DomainError(401, 'SESSION_INVALID', 'Active local operator session required');
  await c.query(
    'SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN role_permissions rp ON rp.role_id=r.id WHERE ur.user_id=$1 FOR SHARE OF ur,r,rp',
    [session.user_id],
  );
  const actor = await getActor(c, session.user_id);
  if (actor.organizationId !== org || !actor.roles.includes('administrator'))
    throw new DomainError(
      403,
      'FORBIDDEN',
      'Organization administrator required for reconciliation',
    );
  requirePermission(actor, evidenceActions[event.action].permission);
  const local = await readTrustedAggregate(c, event.entityType, event.entityId);
  if (local && local.organizationId !== org)
    throw new DomainError(
      409,
      'ORGANIZATION_MISMATCH',
      'Local aggregate belongs to another organization',
    );
  const outbox = await pendingEvidenceOutbox(c, event, local);
  let competingIds: string[] = [];
  const s = event.snapshot;
  if (event.entityType === 'work_schedules' || event.entityType === 'leave_types')
    competingIds = (
      await c.query(
        `SELECT id FROM ${event.entityType} WHERE organization_id=$1 AND id<>$2 AND lower(code)=lower($3)`,
        [org, event.entityId, s.code],
      )
    ).rows.map((r) => r.id);
  if (event.entityType === 'employee_schedule_assignments')
    competingIds = (
      await c.query(
        "SELECT id FROM employee_schedule_assignments WHERE organization_id=$1 AND id<>$2 AND employee_id=$3 AND daterange(effective_from,effective_to,'[)') && daterange($4::date,$5::date,'[)')",
        [org, event.entityId, s.employeeId, s.effectiveFrom, s.effectiveTo],
      )
    ).rows.map((r) => r.id);
  if (event.entityType === 'leave_requests' && (s.status === 'pending' || s.status === 'approved'))
    competingIds = (
      await c.query(
        "SELECT id FROM leave_requests WHERE organization_id=$1 AND id<>$2 AND employee_id=$3 AND status IN ('pending','approved') AND start_date<=$5 AND end_date>=$4 AND (duration_type='full_day' OR $6='full_day' OR duration_type=$6)",
        [org, event.entityId, s.employeeId, s.startDate, s.endDate, s.durationType],
      )
    ).rows.map((r) => r.id);
  const competingLocal = [];
  for (const id of competingIds.sort())
    competingLocal.push(await readTrustedAggregate(c, event.entityType, id));
  const predecessor = (
    await c.query(
      'SELECT canonical_snapshot FROM trusted_evidence_applications WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY revision DESC LIMIT 1',
      [org, event.entityType, event.entityId],
    )
  ).rows[0];
  return {
    org,
    event,
    actor,
    local,
    outbox,
    view: {
      sequence,
      eventId: event.eventId,
      acceptanceId: event.acceptanceId,
      entityType: event.entityType,
      entityId: event.entityId,
      local,
      central: event.snapshot,
      trustedPredecessor: predecessor ? JSON.parse(predecessor.canonical_snapshot) : null,
      pendingOutbox: outbox.map((r) => r.content),
      competingLocal,
      competingFingerprint: identityFingerprint(competingLocal),
      localFingerprint: identityFingerprint(local),
      centralFingerprint: event.snapshotFingerprint,
      outboxFingerprint: identityFingerprint(outbox.map((r) => r.content)),
    },
  };
}
/** Local authenticated operator service: no client-supplied actor, grants or snapshots. */
export function createEvidenceReconciliationService(
  pool: Pool,
  config: SyncClientConfig,
  mode: 'local' | 'central' | 'disabled',
) {
  const localOnly = () => {
    if (mode !== 'local') throw new DomainError(403, 'LOCAL_ONLY', 'Reconciliation is local-only');
  };
  return {
    inspect: async (sessionToken: unknown, sequence: unknown) => {
      localOnly();
      const token = tokenSchema.parse(sessionToken),
        position = syncSequenceSchema.parse(sequence);
      return transaction(pool, async (c) => (await inspect(c, config, token, position)).view);
    },
    reconcile: async (sessionToken: unknown, input: unknown) => {
      localOnly();
      const token = tokenSchema.parse(sessionToken),
        request = inputSchema.parse(input);
      return transaction(pool, async (c) => {
        const context = await inspect(c, config, token, request.sequence);
        const { org, event, actor, local, outbox, view } = context;
        const existing = (
          await c.query('SELECT * FROM trusted_evidence_reconciliations WHERE id=$1', [
            request.requestId,
          ])
        ).rows[0];
        if (existing) {
          if (
            existing.organization_id !== org ||
            String(existing.sequence) !== request.sequence ||
            existing.operator_id !== actor.id ||
            existing.decision !== request.decision ||
            existing.reason !== request.reason ||
            existing.local_fingerprint !== request.localFingerprint ||
            existing.central_fingerprint !== request.centralFingerprint ||
            identityFingerprint(existing.outbox_snapshot) !== request.outboxFingerprint ||
            identityFingerprint(existing.competing_snapshot) !== request.competingFingerprint
          )
            throw new DomainError(
              409,
              'RECONCILIATION_REPLAY_CONFLICT',
              'Reconciliation request content changed',
            );
          return { id: request.requestId, decision: request.decision, replayed: true };
        }
        if (
          (
            await c.query(
              'SELECT 1 FROM trusted_evidence_applications WHERE organization_id=$1 AND sequence=$2',
              [org, event.sequence],
            )
          ).rowCount
        )
          throw new DomainError(409, 'ALREADY_APPLIED', 'Evidence is already applied');
        if (
          (
            await c.query(
              `SELECT 1 FROM trusted_evidence_inbox i LEFT JOIN trusted_evidence_applications a USING(organization_id,sequence) WHERE i.organization_id=$1 AND i.sequence<$2 AND a.sequence IS NULL AND i.envelope->>'entityType'=$3 AND i.envelope->>'entityId'=$4`,
              [org, event.sequence, event.entityType, event.entityId],
            )
          ).rowCount
        )
          throw new DomainError(
            409,
            'PREDECESSOR_PENDING',
            'Earlier accepted evidence must be resolved first',
          );
        if (
          view.localFingerprint !== request.localFingerprint ||
          view.centralFingerprint !== request.centralFingerprint ||
          view.outboxFingerprint !== request.outboxFingerprint ||
          view.competingFingerprint !== request.competingFingerprint
        )
          throw new DomainError(
            409,
            'RECONCILIATION_STALE',
            'Inspected evidence changed; inspect again',
          );
        if (request.decision === 'useCentral' && view.competingLocal.length)
          throw new DomainError(
            409,
            'RECONCILIATION_UNBOUND_AGGREGATE',
            'A different local identity conflicts; preserve it and resolve that aggregate explicitly',
          );
        if (
          outbox.some(
            (r) =>
              r.status === 'processing' &&
              (!r.lease_expires_at || new Date(r.lease_expires_at).getTime() > Date.now()),
          )
        )
          throw new DomainError(
            409,
            'OUTBOX_IN_FLIGHT',
            'Wait for outgoing delivery lease to finish',
          );
        await c.query(
          `INSERT INTO trusted_evidence_reconciliations(id,organization_id,sequence,operator_id,decision,reason,local_snapshot,local_fingerprint,central_snapshot,central_fingerprint,outbox_snapshot,competing_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            request.requestId,
            org,
            event.sequence,
            actor.id,
            request.decision,
            request.reason,
            JSON.stringify(local),
            request.localFingerprint,
            JSON.stringify(event.snapshot),
            request.centralFingerprint,
            JSON.stringify(outbox.map((r) => r.content)),
            JSON.stringify(view.competingLocal),
          ],
        );
        if (request.decision === 'useCentral')
          try {
            await projectTrustedEvidence(c, event, request.requestId);
          } catch (error) {
            if (error instanceof ApplicationIssue)
              throw new DomainError(
                409,
                error.code,
                'Evidence reconciliation blocked: ' + error.code,
              );
            throw error;
          }
        // preserveLocal records an explicit hold, not a dismissal or a central acceptance.
        await c.query(
          `INSERT INTO trusted_evidence_application_state(organization_id,sequence,status,code,next_attempt_at) VALUES($1,$2,'conflict',$3,clock_timestamp()) ON CONFLICT(organization_id,sequence) DO UPDATE SET status='conflict',code=excluded.code`,
          [
            org,
            event.sequence,
            request.decision === 'preserveLocal'
              ? 'OPERATOR_PRESERVED_LOCAL'
              : 'OPERATOR_RECONCILED',
          ],
        );
        if (
          !(
            await c.query(
              'SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()',
              [tokenHash(token), actor.id],
            )
          ).rowCount
        )
          throw new DomainError(401, 'SESSION_INVALID', 'Operator session expired');
        return { id: request.requestId, decision: request.decision, replayed: false };
      });
    },
  };
}
