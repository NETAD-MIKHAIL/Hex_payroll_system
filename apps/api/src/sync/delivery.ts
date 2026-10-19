import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  syncEventSchema,
  centralPushResponseSchema,
  syncPushResponseSchema,
  structuredPushResponseSchema,
  syncSequenceSchema,
} from '@hexpayroll/shared';
import { persistConflict } from './conflicts.js';
import { dependencyKeys } from './conflict-policy.js';
import { transaction, DomainError } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import {
  TransportError,
  httpPushTransport,
  requestSignal,
  abortable,
  type PushTransport,
  type RequestOptions,
  type SyncClientConfig,
} from './transport.js';
import type { SyncWorkerStatus } from './status.js';

export async function ensureNode(pool: Pool, config: SyncClientConfig) {
  const result = await pool.query<{ organization_id: string }>(
    'SELECT organization_id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL',
    [config.nodeId, tokenHash(config.token)],
  );
  if (!result.rows[0])
    throw new DomainError(
      403,
      'LOCAL_NODE_INVALID',
      'Local installation credential does not match its registered device',
    );
  return result.rows[0].organization_id;
}
export interface PushOptions extends RequestOptions {
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  random?: () => number;
  transport?: PushTransport;
  status?: SyncWorkerStatus;
}
export function retryDelayMs(attempt: number, random: () => number = Math.random) {
  const ceiling = Math.min(300000, 2000 * 2 ** Math.min(Math.max(0, attempt - 1), 20));
  return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
}
export class StaleLeaseError extends Error {}

export async function pushNextBatch(
  pool: Pool,
  config: SyncClientConfig,
  options: PushOptions = {},
) {
  const org = await ensureNode(pool, config),
    lease = randomUUID();
  const batchSize = options.batchSize ?? 3,
    maxAttempts = options.maxAttempts ?? 10;
  const timeoutMs = options.timeoutMs ?? 10000,
    leaseMs = options.leaseMs ?? 30000;
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 3 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    timeoutMs <= 0 ||
    leaseMs <= timeoutMs
  )
    throw new Error('Invalid synchronization delivery configuration');
  options.signal?.throwIfAborted();
  const rows = await transaction(pool, async (c) => {
    // Claims are serialized, and never skip a failed/deferred/leased predecessor.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7342))', [org]);
    const result = await c.query(
      `SELECT *, (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()) AS due,
         (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) AS expired
       FROM sync_outbox WHERE organization_id=$1 AND status NOT IN ('synced','rejected','superseded')
       ORDER BY publication_sequence LIMIT 1000 FOR UPDATE`,
      [org],
    );
    const claimed = [];
    const blocked = new Set<string>();
    for (const row of result.rows) {
      const keys: string[] | null =
        row.dependency_keys ?? dependencyKeys(row.entity_type, row.entity_id, row.payload);
      if (
        row.status === 'conflicted' ||
        (blocked.size && (!keys || keys.some((key) => blocked.has(key))))
      ) {
        if (!keys) break;
        for (const key of keys) blocked.add(key);
        continue;
      }
      if (row.status === 'failed' || (row.status === 'processing' ? !row.expired : !row.due)) break;
      if (row.retry_cycle_attempts >= maxAttempts) {
        await c.query(
          "UPDATE sync_outbox SET status='failed',error='Automatic retry limit reached; review and retry required',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL WHERE id=$1",
          [row.id],
        );
        break;
      }
      const updated = await c.query(
        `UPDATE sync_outbox SET status='processing',lease_token=$2,
          lease_expires_at=clock_timestamp()+($3::double precision * interval '1 millisecond'),
          attempt_count=attempt_count+1,retry_cycle_attempts=retry_cycle_attempts+1,last_attempt_at=clock_timestamp(),error=NULL
         WHERE id=$1 RETURNING *`,
        [row.id, lease, leaseMs],
      );
      claimed.push(updated.rows[0]!);
      if (claimed.length === batchSize) break;
    }
    return claimed;
  });
  if (!rows.length) {
    if (options.status) {
      const head = await pool.query(
        "SELECT status FROM sync_outbox WHERE organization_id=$1 AND status NOT IN ('synced','rejected','superseded') ORDER BY publication_sequence LIMIT 1",
        [org],
      );
      if (['failed', 'conflicted'].includes(head.rows[0]?.status)) options.status.state = 'blocked';
    }
    return false;
  }
  let transportAttempted = false;
  let transportVerified = false;
  try {
    const events = rows.map((r) => ({
      ...syncEventSchema.parse({
        eventId: r.id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        operation: r.operation,
        revision: r.revision,
        payloadVersion: r.payload_version,
        payload: r.payload,
      }),
      organizationId: r.organization_id,
      originNodeId: r.origin_node_id,
      baseRevision: r.base_revision,
      createdAt: new Date(r.created_at).toISOString(),
      actorId: r.actor_id ?? null,
    }));
    const signal = requestSignal({ ...options, timeoutMs });
    const transport = options.transport ?? httpPushTransport(config, timeoutMs);
    transportAttempted = true;
    const raw = await abortable(() => transport.push(events, signal), signal);
    const v2 = centralPushResponseSchema.safeParse(raw);
    if (!options.transport && !v2.success)
      throw new TransportError(426, 'SYNC_PROTOCOL_INCOMPATIBLE');
    if (v2.success) {
      const outcomes = v2.data.results;
      if (
        outcomes.length !== rows.length ||
        new Set(outcomes.map((o) => o.eventId)).size !== rows.length ||
        outcomes.some((o) => !rows.some((r) => r.id === o.eventId))
      )
        throw new Error('Invalid delivery results');
      const accepted = outcomes.filter((o) => 'sequence' in o);
      if (new Set(accepted.map((o) => o.sequence)).size !== accepted.length)
        throw new Error('Duplicate receipt sequence');
      await transaction(pool, async (c) => {
        for (const row of rows) {
          const owned = await c.query(
            "SELECT id FROM sync_outbox WHERE id=$1 AND organization_id=$2 AND lease_token=$3 AND status='processing' AND lease_expires_at>clock_timestamp() FOR UPDATE",
            [row.id, org, lease],
          );
          if (owned.rowCount !== 1) throw new StaleLeaseError('Delivery lease no longer owned');
        }
        for (const outcome of outcomes) {
          const row = rows.find((r) => r.id === outcome.eventId)!;
          if ('sequence' in outcome) {
            await c.query(
              "UPDATE sync_outbox SET status='synced',delivery_protocol_version=2,central_sequence=$2,synced_at=now(),lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,error=NULL WHERE id=$1",
              [row.id, outcome.sequence],
            );
          } else if (outcome.status === 'conflict') {
            const parsed = structuredPushResponseSchema.parse({
              outcomes: [
                {
                  eventId: outcome.eventId,
                  outcome: 'conflict',
                  conflictType: outcome.conflictType,
                  currentRevision: outcome.currentRevision,
                  snapshot: outcome.snapshot,
                  reason: outcome.reason,
                },
              ],
            }).outcomes[0]!;
            if (parsed.outcome !== 'conflict') throw new Error('Invalid conflict');
            if (
              parsed.snapshot &&
              (parsed.snapshot.organizationId ?? parsed.snapshot.organization_id) !== org
            )
              throw new Error('Conflict scope mismatch');
            await persistConflict(c, {
              organizationId: org,
              nodeId: row.origin_node_id,
              eventId: row.id,
              localEventId: row.id,
              entityType: row.entity_type,
              entityId: row.entity_id,
              incomingRevision: row.revision,
              baseRevision: row.base_revision,
              currentRevision: parsed.currentRevision,
              incoming: row.payload,
              current: parsed.snapshot,
              conflictType: parsed.conflictType,
              reason: parsed.reason,
            });
            await c.query(
              "UPDATE sync_outbox SET status='conflicted',lease_token=NULL,lease_expires_at=NULL,error='Data conflict requires review' WHERE id=$1",
              [row.id],
            );
          } else {
            const retry =
              outcome.status === 'retryable_failure' && row.retry_cycle_attempts < maxAttempts;
            await c.query(
              "UPDATE sync_outbox SET status=$2,error=$3,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=CASE WHEN $2='pending' THEN now()+($4::double precision*interval '1 millisecond') ELSE NULL END WHERE id=$1",
              [
                row.id,
                retry ? 'pending' : outcome.status === 'rejected' ? 'rejected' : 'failed',
                outcome.code + ': ' + outcome.reason,
                retryDelayMs(row.retry_cycle_attempts, options.random),
              ],
            );
          }
        }
      });
      transportVerified = true;
      options.status?.recordTransport(true);
      return true;
    }
    const structured = structuredPushResponseSchema.safeParse(raw);
    if (structured.success) {
      const outcomes = structured.data.outcomes;
      if (
        outcomes.some(
          (outcome) =>
            outcome.outcome === 'conflict' &&
            outcome.snapshot &&
            (('organizationId' in outcome.snapshot && outcome.snapshot.organizationId !== org) ||
              ('organization_id' in outcome.snapshot && outcome.snapshot.organization_id !== org)),
        )
      )
        throw new Error('Invalid conflict organization');
      if (
        outcomes.length !== rows.length ||
        new Set(outcomes.map((o) => o.eventId)).size !== rows.length ||
        outcomes.some((o) => !rows.some((r) => r.id === o.eventId))
      )
        throw new Error('Invalid delivery outcomes');
      const accepted = outcomes.filter((o) => o.outcome === 'accepted');
      if (
        new Set(accepted.map((o) => o.sequence)).size !== accepted.length ||
        accepted.some((o) => !syncSequenceSchema.safeParse(o.sequence).success)
      )
        throw new Error('Invalid delivery sequences');
      // An adapter cannot acknowledge a consumer of a conflicted predecessor.
      const blocked = new Set<string>();
      let barrier = false;
      for (const row of rows) {
        const outcome = outcomes.find((o) => o.eventId === row.id)!;
        const keys = dependencyKeys(row.entity_type, row.entity_id, row.payload);
        if (
          outcome.outcome === 'accepted' &&
          (barrier || (blocked.size > 0 && (!keys || keys.some((k) => blocked.has(k)))))
        )
          throw new Error('Invalid dependent delivery outcome');
        if (outcome.outcome === 'conflict') {
          if (!keys) barrier = true;
          else keys.forEach((k) => blocked.add(k));
        }
      }
      transportVerified = true;
      options.status?.recordTransport(true);
      await transaction(pool, async (c) => {
        for (const row of rows) {
          const owned = await c.query(
            "SELECT id FROM sync_outbox WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='processing' AND lease_expires_at>clock_timestamp() FOR UPDATE",
            [org, row.id, lease],
          );
          if (owned.rowCount !== 1) throw new StaleLeaseError('Delivery lease no longer owned');
        }
        for (const outcome of outcomes) {
          const row = rows.find((r) => r.id === outcome.eventId)!;
          if (outcome.outcome === 'accepted')
            await c.query(
              "UPDATE sync_outbox SET status='synced',central_sequence=$2,synced_at=now(),lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,error=NULL WHERE id=$1",
              [row.id, outcome.sequence],
            );
          else {
            await persistConflict(c, {
              organizationId: org,
              nodeId: row.origin_node_id,
              eventId: row.id,
              localEventId: row.id,
              entityType: row.entity_type,
              entityId: row.entity_id,
              incomingRevision: row.revision,
              baseRevision: row.base_revision,
              currentRevision: outcome.currentRevision,
              incoming: row.payload,
              current: outcome.snapshot,
              conflictType: outcome.conflictType,
              reason: 'Authoritative validation reported ' + outcome.conflictType,
            });
            await c.query(
              "UPDATE sync_outbox SET status='conflicted',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,error='Data conflict requires review' WHERE id=$1",
              [row.id],
            );
          }
        }
      });
      return true;
    }
    const response = syncPushResponseSchema.parse(raw);
    if (
      response.receipts.length !== rows.length ||
      new Set(response.receipts.map((r) => r.eventId)).size !== rows.length ||
      response.receipts.some(
        (r) => !rows.some((row) => row.id === r.eventId) || r.sequence === '0',
      ) ||
      new Set(response.receipts.map((r) => r.sequence)).size !== rows.length
    )
      throw new Error('Invalid delivery acknowledgment');
    transportVerified = true;
    options.status?.recordTransport(true);
    await transaction(pool, async (c) => {
      for (const receipt of response.receipts) {
        const result = await c.query(
          "UPDATE sync_outbox SET status='synced',central_sequence=$3,synced_at=now(),lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,error=NULL WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_expires_at>clock_timestamp()",
          [receipt.eventId, lease, receipt.sequence],
        );
        if (result.rowCount !== 1) throw new StaleLeaseError('Delivery lease no longer owned');
      }
    });
  } catch (error) {
    if (transportAttempted && !transportVerified && !options.signal?.aborted)
      options.status?.recordTransport(false);
    if (
      error instanceof TransportError &&
      [401, 403, 426].includes(error.status) &&
      options.status
    ) {
      options.status.failAuthorization(error.code);
    }
    const permanent =
      error instanceof TransportError && [400, 401, 403, 409, 413, 422, 426].includes(error.status);
    await transaction(pool, async (c) => {
      for (const row of rows) {
        const failed = permanent || row.retry_cycle_attempts >= maxAttempts;
        const message = permanent
          ? `Transport rejected batch (${error.status}); review and retry required`
          : failed
            ? 'Automatic retry limit reached; review and retry required'
            : 'Transport unavailable or acknowledgment invalid; retry scheduled';
        await c.query(
          `UPDATE sync_outbox SET status=$3,error=$4,lease_token=NULL,lease_expires_at=NULL,
           next_attempt_at=CASE WHEN $3='failed' THEN NULL ELSE now()+($5::double precision * interval '1 millisecond') END
           WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_expires_at>clock_timestamp()`,
          [
            row.id,
            lease,
            failed ? 'failed' : 'pending',
            message,
            retryDelayMs(row.retry_cycle_attempts, options.random),
          ],
        );
        if (failed && options.status) options.status.state = 'blocked';
      }
    });
    throw error;
  }
  return true;
}
