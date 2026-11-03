import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  syncEventSchema,
  syncPullResponseSchema,
  syncPushResponseSchema,
  trustedEvidencePullSchema,
  canonicalSyncJson,
} from '@hexpayroll/shared';
import { transaction } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import { applyInboxBatch } from './inbox.js';
import { verifyTrustedEvidence } from './trusted-evidence.js';
import { validateTrustedSnapshot } from './trusted-snapshots.js';
import { requireBroadStreamsDisabled } from './pilot-scope.js';

export interface SyncClientConfig {
  url: string;
  nodeId: string;
  token: string;
}
export class TransportError extends Error {
  constructor(public status: number) {
    super(`Synchronization HTTP ${status}`);
  }
}
export async function syncRequest(config: SyncClientConfig, path: string, body?: unknown) {
  const response = await fetch(config.url.replace(/\/$/, '') + '/api/sync/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new TransportError(response.status);
  }
  // Enforce the bound while reading, even when Content-Length is absent.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty synchronization response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1048576) throw new Error('Synchronization response exceeds limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function ensureNode(pool: Pool, config: SyncClientConfig) {
  const r = await pool.query<{ organization_id: string }>(
    'SELECT organization_id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL',
    [config.nodeId, tokenHash(config.token)],
  );
  if (!r.rows[0]) throw new Error('Local installation not enrolled');
  return r.rows[0].organization_id;
}
export async function pushNextBatch(pool: Pool, config: SyncClientConfig) {
  await requireBroadStreamsDisabled(pool);
  const org = await ensureNode(pool, config),
    lease = randomUUID();
  const rows = await transaction(pool, async (c) => {
    const result = await c.query(
      `WITH batch AS (SELECT id FROM sync_outbox WHERE organization_id=$1 AND
       ((status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=now())) OR (status='processing' AND (lease_expires_at IS NULL OR lease_expires_at<=now())))
       ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 3)
       UPDATE sync_outbox o SET status='processing',lease_token=$2,lease_expires_at=now()+interval '30 seconds',attempt_count=attempt_count+1,last_attempt_at=now(),error=NULL
       FROM batch WHERE o.id=batch.id RETURNING o.*`,
      [org, lease],
    );
    return result.rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  });
  if (!rows.length) return false;
  try {
    const events = rows.map((r) =>
      syncEventSchema.parse({
        eventId: r.id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        operation: r.operation,
        revision: r.revision,
        payloadVersion: r.payload_version,
        payload: r.payload,
      }),
    );
    const response = syncPushResponseSchema.parse(await syncRequest(config, 'push', { events }));
    if (
      response.receipts.length !== rows.length ||
      new Set(response.receipts.map((r) => r.eventId)).size !== rows.length ||
      response.receipts.some((r) => !rows.some((row) => row.id === r.eventId)) ||
      response.receipts.some((r) => r.sequence === '0')
    )
      throw new Error('Invalid delivery acknowledgment');
    await transaction(pool, async (c) => {
      for (const receipt of response.receipts)
        await c.query(
          "UPDATE sync_outbox SET status='synced',central_sequence=$3,synced_at=now(),lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,error=NULL WHERE id=$1 AND lease_token=$2 AND status='processing'",
          [receipt.eventId, lease, receipt.sequence],
        );
    });
  } catch (error) {
    const permanent =
      error instanceof TransportError && [400, 401, 403, 409, 413, 422].includes(error.status);
    await pool.query(
      `UPDATE sync_outbox SET status=$2,error=$3,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=now()+make_interval(secs=>LEAST(300,power(2,LEAST(attempt_count,8))::integer)) WHERE lease_token=$1 AND status='processing'`,
      [
        lease,
        permanent ? 'failed' : 'pending',
        permanent
          ? `Transport rejected batch (${error.status}); review and retry required`
          : 'Transport unavailable or acknowledgment invalid; retry scheduled',
      ],
    );
    throw error;
  }
  return true;
}
export async function pullNextBatch(pool: Pool, config: SyncClientConfig) {
  await requireBroadStreamsDisabled(pool);
  const org = await ensureNode(pool, config);
  const r = await pool.query('SELECT last_pull_sequence::text FROM sync_nodes WHERE id=$1', [
    config.nodeId,
  ]);
  const after: string = r.rows[0]!.last_pull_sequence;
  const response = syncPullResponseSchema.parse(await syncRequest(config, 'pull?after=' + after));
  let previous = BigInt(after);
  for (const change of response.changes) {
    if (change.organizationId !== org || BigInt(change.sequence) <= previous)
      throw new Error('Invalid change stream');
    previous = BigInt(change.sequence);
  }
  if (BigInt(response.nextSequence) !== previous) throw new Error('Invalid pull cursor');
  await transaction(pool, async (c) => {
    const node = await c.query(
      'SELECT last_pull_sequence::text FROM sync_nodes WHERE id=$1 AND enabled FOR UPDATE',
      [config.nodeId],
    );
    if (node.rows[0]?.last_pull_sequence !== after) return; // Another worker already progressed.
    for (const e of response.changes)
      await c.query(
        `INSERT INTO sync_inbox(organization_id,sequence,change_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload_version,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
    await c.query('UPDATE sync_nodes SET last_pull_sequence=$2,last_seen_at=now() WHERE id=$1', [
      config.nodeId,
      response.nextSequence,
    ]);
  });
  return response.changes.length > 0;
}

// Independent trusted transport cursor; business application has its own receipts.
export async function pullNextTrustedEvidenceBatch(pool: Pool, config: SyncClientConfig) {
  await requireBroadStreamsDisabled(pool);
  const url = new URL(config.url);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Trusted evidence requires HTTPS or loopback transport');
  const org = await ensureNode(pool, config);
  const checkpoint = (
    await pool.query(
      `SELECT last_sequence::text FROM trusted_evidence_checkpoints
    WHERE organization_id=$1 AND node_id=$2`,
      [org, config.nodeId],
    )
  ).rows[0];
  const after: string = checkpoint?.last_sequence ?? '0';
  const response = trustedEvidencePullSchema.parse(
    await syncRequest(config, 'evidence/pull?after=' + after),
  );
  let previous = BigInt(after);
  const events = response.changes.map((change) => {
    const event = verifyTrustedEvidence(change);
    validateTrustedSnapshot(event);
    if (event.organizationId !== org || BigInt(event.sequence) <= previous)
      throw new Error('Invalid trusted evidence stream');
    previous = BigInt(event.sequence);
    return event;
  });
  if (BigInt(response.nextSequence) !== previous)
    throw new Error('Invalid trusted evidence cursor');
  await transaction(pool, async (client) => {
    // Enrollment and independent checkpoint are checked again under the write lock.
    const node = (
      await client.query(
        `SELECT organization_id FROM sync_nodes WHERE id=$1
      AND token_hash=$2 AND enabled AND revoked_at IS NULL FOR SHARE`,
        [config.nodeId, tokenHash(config.token)],
      )
    ).rows[0];
    if (node?.organization_id !== org) throw new Error('Local installation not enrolled');
    await client.query(
      `INSERT INTO trusted_evidence_checkpoints(organization_id,node_id)
      VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [org, config.nodeId],
    );
    const current = (
      await client.query(
        `SELECT last_sequence::text FROM trusted_evidence_checkpoints
      WHERE organization_id=$1 AND node_id=$2 FOR UPDATE`,
        [org, config.nodeId],
      )
    ).rows[0];
    if (current.last_sequence !== after) return;
    for (const event of events) {
      const existing = (
        await client.query(
          `SELECT envelope FROM trusted_evidence_inbox
        WHERE organization_id=$1 AND (sequence=$2 OR event_id=$3 OR acceptance_id=$4)`,
          [org, event.sequence, event.eventId, event.acceptanceId],
        )
      ).rows;
      if (existing.length) {
        if (
          existing.length !== 1 ||
          canonicalSyncJson(existing[0].envelope) !== canonicalSyncJson(event)
        )
          throw new Error('Trusted evidence replay conflict');
        continue;
      }
      await client.query(
        `INSERT INTO trusted_evidence_inbox(organization_id,sequence,event_id,acceptance_id,envelope)
        VALUES($1,$2,$3,$4,$5)`,
        [org, event.sequence, event.eventId, event.acceptanceId, JSON.stringify(event)],
      );
    }
    await client.query(
      `UPDATE trusted_evidence_checkpoints SET last_sequence=$3
      WHERE organization_id=$1 AND node_id=$2`,
      [org, config.nodeId, response.nextSequence],
    );
  });
  return events.length > 0;
}
export function startSyncWorker(
  pool: Pool,
  config: SyncClientConfig,
  interval: number,
  onError: () => void,
) {
  let stopped = false,
    running: Promise<void> | null = null;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      // Pull continues even if one outgoing event needs operator review.
      try {
        await pushNextBatch(pool, config);
      } catch {
        onError();
      }
      try {
        await pullNextBatch(pool, config);
      } catch {
        onError();
      }
      try {
        const result = await applyInboxBatch(pool, await ensureNode(pool, config));
        if (result.pending) onError();
      } catch {
        onError();
      }
    })().finally(() => {
      running = null;
    });
  };
  const timer = setInterval(tick, interval);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
