import { receiveSnapshotChunk } from './snapshots.js';
import { applyResolution } from './resolutions.js';
import type { Pool } from 'pg';
import { centralPullResponseSchema } from '@hexpayroll/shared';
import { transaction, DomainError } from '../foundation/repository.js';
import { applyBusinessEvent, ReceiverConflict, currentSnapshot } from './receiver.js';
import { persistConflict } from './conflicts.js';

/** Business application and cursor advancement are one crash-atomic operation. */
export async function applyRemotePage(
  pool: Pool,
  nodeId: string,
  org: string,
  after: string,
  input: unknown,
) {
  const page = centralPullResponseSchema.parse(input);
  let previous = BigInt(after);
  for (const e of page.changes) {
    if (e.organizationId !== org || BigInt(e.sequence) <= previous)
      throw new Error('Invalid change stream');
    previous = BigInt(e.sequence);
  }
  if (BigInt(page.nextSequence) !== previous) throw new Error('Invalid continuation cursor');
  return transaction(pool, async (c) => {
    await c.query("SELECT set_config('hex.sync_remote','on',true)");
    // Match central application lock ordering, even with multiple local callers.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7343))', [org]);
    const node = await c.query(
      'SELECT organization_id FROM sync_nodes WHERE id=$1 AND enabled FOR UPDATE',
      [nodeId],
    );
    if (node.rows[0]?.organization_id !== org)
      throw new DomainError(403, 'SCOPE', 'Device scope mismatch');
    await c.query(
      'INSERT INTO sync_checkpoints(organization_id,node_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [org, nodeId],
    );
    const checkpoint = await c.query(
      'SELECT applied_sequence::text AS sequence FROM sync_checkpoints WHERE organization_id=$1 AND node_id=$2 FOR UPDATE',
      [org, nodeId],
    );
    if (checkpoint.rows[0].sequence !== after) return false;
    for (const e of page.changes) {
      const pending = await c.query(
        "SELECT id FROM sync_outbox WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3 AND status NOT IN ('synced','rejected','superseded') LIMIT 1",
        [org, e.entityType, e.entityId],
      );
      const own = await c.query(
        "SELECT id FROM sync_outbox WHERE organization_id=$1 AND id=$2 AND status='synced' AND central_sequence=$3",
        [org, e.eventId, e.sequence],
      );
      if (e.entityType === 'sync_snapshot_chunk') {
        if (!own.rowCount)
          await receiveSnapshotChunk(c, org, { ...e, originNodeId: e.sourceNodeId });
      } else if (e.entityType === 'sync_resolution')
        await applyResolution(c, org, { ...e, originNodeId: e.sourceNodeId }, nodeId);
      else if (e.entityType !== 'sync_resolution_proposals' && !own.rowCount) {
        await c.query('SAVEPOINT remote_event');
        try {
          if (pending.rowCount)
            throw new ReceiverConflict(
              'UPDATE_UPDATE',
              await currentSnapshot(c, e.entityType, e.entityId, org),
              'Local pending mutation requires resolution',
            );
          await applyBusinessEvent(c, org, { ...e, originNodeId: e.sourceNodeId }, true);
        } catch (error) {
          await c.query('ROLLBACK TO SAVEPOINT remote_event');
          if (!(error instanceof ReceiverConflict)) throw error;
          // The feed origin need not be enrolled on this desktop; use its local
          // device identity for evidence and retain the original in the durable inbox.
          const known = pending.rows[0]
            ? await c.query(
                "SELECT id FROM sync_conflicts WHERE organization_id=$1 AND local_event_id=$2 AND status IN ('open','under_review')",
                [org, pending.rows[0].id],
              )
            : { rowCount: 0 };
          if (!known.rowCount)
            await persistConflict(c, {
              organizationId: org,
              nodeId,
              eventId: pending.rows[0]?.id ?? e.eventId,
              entityType: e.entityType,
              entityId: e.entityId,
              incomingRevision:
                pending.rows[0]?.revision ?? Number(error.current?.revision ?? e.revision),
              currentRevision: e.revision,
              baseRevision: pending.rows[0]?.base_revision ?? e.baseRevision,
              incoming: pending.rows[0]?.payload ?? error.current ?? e.payload,
              current: e.payload,
              conflictType: error.conflictType,
              reason: error.message,
              ...(pending.rows[0] ? { localEventId: String(pending.rows[0].id) } : {}),
            });
          if (pending.rows[0])
            await c.query(
              "UPDATE sync_outbox SET status='conflicted',lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
              [pending.rows[0].id],
            );
        }
        await c.query('RELEASE SAVEPOINT remote_event');
      }
      await c.query(
        'INSERT INTO sync_inbox(organization_id,sequence,change_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload_version,payload,applied_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) ON CONFLICT DO NOTHING',
        [
          org,
          e.sequence,
          e.changeId,
          e.sourceNodeId,
          e.eventId,
          e.entityType,
          e.entityId,
          e.operation,
          e.revision,
          e.payloadVersion,
          JSON.stringify(e.payload),
        ],
      );
    }
    await c.query(
      'UPDATE sync_checkpoints SET applied_sequence=$3,updated_at=now() WHERE organization_id=$1 AND node_id=$2',
      [org, nodeId, page.nextSequence],
    );
    await c.query('UPDATE sync_nodes SET last_pull_sequence=$2,last_seen_at=now() WHERE id=$1', [
      nodeId,
      page.nextSequence,
    ]);
    return true;
  });
}
