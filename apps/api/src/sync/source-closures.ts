import type { Pool } from 'pg';
import { canonicalSyncJson } from '@hexpayroll/shared';
import { z } from 'zod';
import { transaction, DomainError, type Actor } from '../foundation/repository.js';
import { signedClosureSchema } from '../timekeeping/source-period-protocol.js';
import { tokenHash } from '../auth/service.js';
import { syncRequest, TransportError, type SyncClientConfig } from './client.js';

export async function captureSourceClosure(
  pool: Pool,
  actor: Actor,
  input: unknown,
  enabled = false,
) {
  if (!enabled) throw new DomainError(403, 'DISABLED', 'Source closure capture is disabled');
  const closure = signedClosureSchema.parse(input),
    m = closure.manifest;
  if (m.organizationId !== actor.organizationId)
    throw new DomainError(403, 'ORGANIZATION_MISMATCH', 'Source organization mismatch');
  return transaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'time_records:device:' + m.deviceId,
    ]);
    if (
      !(
        await c.query(
          "SELECT 1 FROM biometric_devices WHERE organization_id=$1 AND id=$2 AND status='active'",
          [m.organizationId, m.deviceId],
        )
      ).rowCount
    )
      throw new DomainError(409, 'SOURCE_MISSING', 'Source device unavailable');
    const old = (
      await c.query('SELECT payload=$2::jsonb matches FROM biometric_source_closures WHERE id=$1', [
        m.closureId,
        JSON.stringify(closure),
      ])
    ).rows[0];
    if (old && !old.matches)
      throw new DomainError(409, 'CONFLICT', 'Source closure identity reused');
    if (!old)
      await c.query(
        'INSERT INTO biometric_source_closures(id,organization_id,device_id,payload) VALUES($1,$2,$3,$4)',
        [m.closureId, m.organizationId, m.deviceId, canonicalSyncJson(closure)],
      );
    return { closureId: m.closureId, captured: true, certified: false };
  });
}
export async function pushNextSourceClosure(pool: Pool, config: SyncClientConfig) {
  const node = (
    await pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL',
      [config.nodeId, tokenHash(config.token)],
    )
  ).rows[0];
  if (!node) throw new Error('Local installation not enrolled');
  const row = (
    await pool.query(
      `SELECT * FROM biometric_source_closures c WHERE organization_id=$1 AND NOT EXISTS(SELECT 1 FROM biometric_closure_deliveries d WHERE d.closure_id=c.id)
       ORDER BY COALESCE((SELECT max(a.attempted_at) FROM biometric_closure_attempts a WHERE a.closure_id=c.id),'epoch'::timestamptz),captured_at,id LIMIT 1`,
      [node.organization_id],
    )
  ).rows[0];
  if (!row) return false;
  try {
    const ack = z
      .object({
        closureId: z.literal(row.id),
        received: z.literal(true),
        certified: z.literal(false),
      })
      .strict()
      .parse(await syncRequest(config, 'biometric/closure', row.payload));
    await transaction(pool, async (c) => {
      if (
        !(
          await c.query(
            'SELECT 1 FROM sync_nodes WHERE id=$1 AND organization_id=$2 AND token_hash=$3 AND enabled AND revoked_at IS NULL FOR SHARE',
            [config.nodeId, node.organization_id, tokenHash(config.token)],
          )
        ).rowCount
      )
        throw new Error('Local enrollment changed');
      await c.query(
        'INSERT INTO biometric_closure_deliveries(closure_id,node_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [ack.closureId, config.nodeId],
      );
    });
    return true;
  } catch (error) {
    // Retain unconfirmed work and its failure audit; try independent closures
    // before this head again. A failed/unknown outcome is never a delivery receipt.
    await pool.query(
      'INSERT INTO biometric_closure_attempts(closure_id,node_id,code) VALUES($1,$2,$3)',
      [
        row.id,
        config.nodeId,
        error instanceof TransportError ? 'HTTP_' + error.status : 'UNCONFIRMED',
      ],
    );
    throw error;
  }
}
