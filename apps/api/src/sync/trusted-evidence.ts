import { createHash } from 'node:crypto';
import { requireBroadStreamsDisabled } from './pilot-scope.js';
import type { Pool, PoolClient } from 'pg';
import {
  canonicalSyncJson,
  trustedEvidenceEnvelopeSchema,
  trustedEvidencePullSchema,
  syncSequenceSchema,
} from '@hexpayroll/shared';
import { transaction } from '../foundation/repository.js';
import { DomainError } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import { authenticateNode } from './service.js';

export function verifyTrustedEvidence(input: unknown) {
  const event = trustedEvidenceEnvelopeSchema.parse(input);
  const hash = createHash('sha256').update(canonicalSyncJson(event.snapshot)).digest('hex');
  if (hash !== event.snapshotFingerprint)
    throw new Error('Trusted evidence snapshot fingerprint mismatch');
  return event;
}

/** Requires a privileged server writer client. No credential bypass or SECURITY DEFINER.
 * Caller owns transaction: future acceptance + audit + publication must commit together.
 * This publishes only an existing acceptance, never creates one. */
export async function publishTrustedEvidence(client: PoolClient, acceptanceId: string) {
  const acceptance = (
    await client.query(
      'SELECT canonical_snapshot FROM central_evidence_acceptances WHERE acceptance_id=$1 FOR SHARE',
      [acceptanceId],
    )
  ).rows[0];
  if (!acceptance)
    throw new DomainError(409, 'ACCEPTANCE_REQUIRED', 'An immutable acceptance is required');
  if (
    canonicalSyncJson(JSON.parse(acceptance.canonical_snapshot)) !== acceptance.canonical_snapshot
  )
    throw new Error('Accepted snapshot is not canonical');
  const result = await client.query(
    `INSERT INTO central_evidence_events(acceptance_id)
    VALUES($1) ON CONFLICT(acceptance_id) DO NOTHING RETURNING event_id,sequence::text`,
    [acceptanceId],
  );
  if (result.rows[0]) return result.rows[0];
  return (
    await client.query(
      'SELECT event_id,sequence::text FROM central_evidence_events WHERE acceptance_id=$1',
      [acceptanceId],
    )
  ).rows[0];
}

export async function pullTrustedEvidence(pool: Pool, token: string, after: string) {
  await requireBroadStreamsDisabled(pool);
  syncSequenceSchema.parse(after);
  return transaction(pool, async (client) => {
    const initial = await authenticateNode(client, token);
    const node = (
      await client.query(
        `SELECT organization_id FROM sync_nodes
      WHERE id=$1 AND enabled AND revoked_at IS NULL AND token_hash=$2 FOR SHARE`,
        [initial.id, tokenHash(token)],
      )
    ).rows[0];
    if (!node) throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
    const rows = (
      await client.query(
        `SELECT e.sequence::text,e.event_id,a.*,u.request_id,u.payload_fingerprint,
      u.acting_user_id,u.source_node_id FROM central_evidence_events e
      JOIN central_evidence_acceptances a ON a.acceptance_id=e.acceptance_id
      JOIN central_evidence_authorizations u ON u.decision_id=a.authorization_decision_id
      WHERE a.organization_id=$1 AND e.sequence>$2 ORDER BY e.sequence LIMIT 3`,
        [node.organization_id, after],
      )
    ).rows;
    const changes = rows.map((row) =>
      verifyTrustedEvidence({
        protocolVersion: 2,
        origin: 'central.accepted',
        sequence: row.sequence,
        eventId: row.event_id,
        acceptanceId: row.acceptance_id,
        authorizationDecisionId: row.authorization_decision_id,
        authorizationRequestId: row.request_id,
        authorizationFingerprint: row.payload_fingerprint,
        organizationId: row.organization_id,
        entityId: row.entity_id,
        entityType: row.entity_type,
        action: row.action,
        expectedRevision: row.expected_revision,
        resultingRevision: row.resulting_revision,
        acceptedBy: row.acting_user_id,
        sourceNodeId: row.source_node_id,
        acceptedAt: new Date(row.accepted_at).toISOString(),
        snapshot: JSON.parse(row.canonical_snapshot),
        snapshotFingerprint: row.snapshot_fingerprint,
      }),
    );
    return trustedEvidencePullSchema.parse({
      protocolVersion: 2,
      origin: 'central.accepted',
      changes,
      nextSequence: changes.at(-1)?.sequence ?? after,
    });
  });
}
