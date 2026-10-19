import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { CentralEvent } from '@hexpayroll/shared';
import { DomainError } from '../foundation/repository.js';
import { enqueueOutbox } from './outbox.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const chunkSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    revision: z.literal(1),
    aggregateId: z.uuid(),
    index: z.number().int().min(0).max(127),
    total: z.number().int().min(1).max(128),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    data: z
      .string()
      .max(174764)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
export async function chunkRunSnapshot(
  c: PoolClient,
  org: string,
  run: Record<string, unknown>,
  actorId: string,
) {
  const bytes = Buffer.from(JSON.stringify(run.snapshot));
  if (bytes.length > 16777216)
    throw new DomainError(
      413,
      'SNAPSHOT_LIMIT',
      'Payroll snapshot exceeds the 16 MiB synchronization limit',
    );
  const count = Math.ceil(bytes.length / 131072),
    hash = digest(bytes);
  const ids = (
    await c.query<{ id: string }>('SELECT uuidv7() AS id FROM generate_series(1,$1)', [count])
  ).rows.map((r) => r.id);
  for (let i = 0; i < count; i++)
    await enqueueOutbox(c, {
      organizationId: org,
      entityType: 'sync_snapshot_chunk',
      entityId: ids[i]!,
      operation: 'CREATE',
      revision: 1,
      actorId,
      payload: {
        id: ids[i],
        organizationId: org,
        revision: 1,
        aggregateId: run.id,
        index: i,
        total: count,
        hash,
        data: bytes.subarray(i * 131072, (i + 1) * 131072).toString('base64'),
      },
    });
  return { ...run, snapshot: { $sync: 'payroll-snapshot-v1', hash, chunkIds: ids } };
}
export async function receiveSnapshotChunk(c: PoolClient, org: string, e: CentralEvent) {
  const p = chunkSchema.parse(e.payload);
  if (p.organizationId !== org || p.id !== e.entityId || p.index >= p.total)
    throw new DomainError(422, 'SNAPSHOT_IDENTITY', 'Snapshot chunk identity mismatch');
  const bytes = Buffer.from(p.data, 'base64');
  if (bytes.length > 131072 || bytes.toString('base64') !== p.data)
    throw new DomainError(422, 'SNAPSHOT_ENCODING', 'Invalid snapshot encoding');
  const result = await c.query(
    'INSERT INTO sync_snapshot_chunks(organization_id,id,aggregate_id,chunk_index,total,hash,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id',
    [org, p.id, p.aggregateId, p.index, p.total, p.hash, p.data],
  );
  if (!result.rowCount) {
    const same = await c.query(
      'SELECT id FROM sync_snapshot_chunks WHERE organization_id=$1 AND id=$2 AND aggregate_id=$3 AND chunk_index=$4 AND total=$5 AND hash=$6 AND data=$7',
      [org, p.id, p.aggregateId, p.index, p.total, p.hash, p.data],
    );
    if (!same.rowCount)
      throw new DomainError(409, 'SNAPSHOT_IDENTITY', 'Snapshot chunk identity reused');
  }
}
export async function assembleRunSnapshot(
  c: PoolClient,
  org: string,
  id: string,
  manifest: unknown,
) {
  const p = z
    .object({
      $sync: z.literal('payroll-snapshot-v1'),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      chunkIds: z.array(z.uuid()).min(1).max(128),
    })
    .strict()
    .parse(manifest);
  const result = await c.query<{ id: string; chunk_index: number; data: string; total: number }>(
    'SELECT id,chunk_index,data,total FROM sync_snapshot_chunks WHERE organization_id=$1 AND aggregate_id=$2 AND hash=$3 AND id=ANY($4::uuid[]) ORDER BY chunk_index',
    [org, id, p.hash, p.chunkIds],
  );
  if (
    result.rows.length !== p.chunkIds.length ||
    result.rows.some(
      (row, i) =>
        row.id !== p.chunkIds[i] || row.chunk_index !== i || row.total !== p.chunkIds.length,
    )
  )
    throw new DomainError(
      503,
      'SNAPSHOT_INCOMPLETE',
      'Snapshot dependencies are not yet available',
    );
  const bytes = Buffer.concat(result.rows.map((row) => Buffer.from(row.data, 'base64')));
  if (digest(bytes) !== p.hash)
    throw new DomainError(422, 'SNAPSHOT_HASH', 'Snapshot checksum mismatch');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
