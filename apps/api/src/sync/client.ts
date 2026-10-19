import type { Pool } from 'pg';
import { centralPullResponseSchema } from '@hexpayroll/shared';
import { transaction, DomainError } from '../foundation/repository.js';
import { applyRemotePage } from './remote.js';
import { ensureNode, pushNextBatch, type PushOptions } from './delivery.js';
import {
  TransportError,
  syncRequest,
  type SyncClientConfig,
  type RequestOptions,
} from './transport.js';
import { syncWorkerStatus, type SyncWorkerStatus } from './status.js';
import { startWorker } from './worker.js';
import { selectLocalOrigin } from './outbox.js';
export { pushNextBatch } from './delivery.js';
export { TransportError, syncRequest, type SyncClientConfig } from './transport.js';

export async function pullNextBatch(
  pool: Pool,
  config: SyncClientConfig,
  options: RequestOptions & { status?: SyncWorkerStatus } = {},
) {
  const org = await ensureNode(pool, config);
  const r = await pool.query(
    'SELECT COALESCE((SELECT applied_sequence FROM sync_checkpoints WHERE node_id=$1),0)::text AS last_pull_sequence',
    [config.nodeId],
  );
  const after: string = r.rows[0]!.last_pull_sequence;
  const response = await (async () => {
    try {
      const raw = await syncRequest(config, 'pull?after=' + after, undefined, options);
      if (
        typeof raw !== 'object' ||
        raw === null ||
        !('protocolVersion' in raw) ||
        raw.protocolVersion !== 2
      )
        throw new TransportError(426, 'SYNC_PROTOCOL_INCOMPATIBLE');
      const response = centralPullResponseSchema.parse(raw);
      let previous = BigInt(after);
      for (const change of response.changes) {
        if (change.organizationId !== org || BigInt(change.sequence) <= previous)
          throw new Error('Invalid change stream');
        previous = BigInt(change.sequence);
      }
      if (BigInt(response.nextSequence) !== previous) throw new Error('Invalid pull cursor');
      options.status?.recordTransport(true);
      return response;
    } catch (error) {
      if (
        error instanceof TransportError &&
        [401, 403, 426].includes(error.status) &&
        options.status
      ) {
        options.status.failAuthorization(error.code);
      }
      if (!options.signal?.aborted) options.status?.recordTransport(false);
      throw error;
    }
  })();
  await applyRemotePage(pool, config.nodeId, org, after, response);
  return response.changes.length > 0;
}

export function startSyncWorker(
  pool: Pool,
  config: SyncClientConfig,
  interval: number,
  onError: () => void,
  options: PushOptions = {},
) {
  const status = options.status ?? syncWorkerStatus;
  let identityEstablished = false;
  let cycleId: string | null = null;
  return startWorker(
    {
      prepare: async () => {
        try {
          status.organizationId = await ensureNode(pool, config);
        } catch (error) {
          if (error instanceof DomainError) status.failAuthorization(error.code);
          throw error;
        }
        if (cycleId)
          await pool.query(
            "UPDATE sync_history SET result='interrupted',finished_at=now() WHERE id=$1",
            [cycleId],
          );
        const history = await pool.query(
          'INSERT INTO sync_history(organization_id,node_id) VALUES($1,$2) RETURNING id',
          [status.organizationId, config.nodeId],
        );
        cycleId = history.rows[0].id;
        await pool.query(
          "UPDATE sync_history SET result='interrupted',finished_at=now() WHERE node_id=$1 AND result='running' AND id<>$2",
          [config.nodeId, cycleId],
        );
        await pool.query(
          "DELETE FROM sync_history WHERE organization_id=$1 AND started_at<now()-interval '90 days'",
          [status.organizationId],
        );
        if (!identityEstablished) {
          await transaction(pool, (client) =>
            selectLocalOrigin(client, status.organizationId!, config.nodeId),
          );
          identityEstablished = true;
        }
      },
      push: async (signal) => {
        for (let page = 0; page < 10; page++) {
          if (!(await pushNextBatch(pool, config, { ...options, signal, status }))) break;
        }
      },
      pull: async (signal) => {
        for (let page = 0; page < 10; page++) {
          if (!(await pullNextBatch(pool, config, { ...options, signal, status }))) break;
        }
      },
      apply: async () => {},
      finish: async (failed) => {
        if (!cycleId) return;
        await pool.query(
          `UPDATE sync_history h SET finished_at=now(),
          accepted=(SELECT count(*) FROM sync_outbox o WHERE o.organization_id=h.organization_id AND o.synced_at>=h.started_at),
          pushed=(SELECT count(*) FROM sync_outbox o WHERE o.organization_id=h.organization_id AND o.last_attempt_at>=h.started_at),
          pulled=(SELECT count(*) FROM sync_inbox i WHERE i.organization_id=h.organization_id AND i.received_at>=h.started_at),
          conflicts=(SELECT count(*) FROM sync_conflicts c WHERE c.organization_id=h.organization_id AND c.created_at>=h.started_at),
          failed=(SELECT count(*) FROM sync_outbox o WHERE o.organization_id=h.organization_id AND o.last_attempt_at>=h.started_at AND o.status IN ('failed','rejected')),
          result=CASE WHEN $2 THEN 'failed' WHEN EXISTS(SELECT 1 FROM sync_outbox o WHERE o.organization_id=h.organization_id AND o.status IN ('failed','conflicted','rejected','pending','processing')) THEN 'partial' ELSE 'success' END WHERE h.id=$1`,
          [cycleId, failed],
        );
        cycleId = null;
      },
    },
    { interval, status, onError },
  );
}
