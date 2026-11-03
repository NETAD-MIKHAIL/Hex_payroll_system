import type { Pool } from 'pg';
import { canonicalSyncJson } from '@hexpayroll/shared';
import { tokenHash } from '../auth/service.js';
import { DomainError, transaction } from '../foundation/repository.js';
import { authenticateNode } from '../sync/service.js';
import { digest, signedClosureSchema, verifySourceClosure } from './source-period-protocol.js';

export function createSourceClosureReceiver(
  pool: Pool,
  mode: 'local' | 'central',
  enabled = false,
) {
  return async (nodeToken: string, input: unknown) => {
    if (mode !== 'central' || !enabled)
      throw new DomainError(403, 'DISABLED', 'Source certification is disabled');
    const closure = signedClosureSchema.parse(input),
      m = closure.manifest;
    return transaction(pool, async (c) => {
      const node = await authenticateNode(c, nodeToken);
      if (node.organization_id !== m.organizationId)
        throw new DomainError(403, 'ORGANIZATION_MISMATCH', 'Source organization mismatch');
      if (
        !(
          await c.query(
            'SELECT id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL FOR SHARE',
            [node.id, tokenHash(nodeToken)],
          )
        ).rowCount
      )
        throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
      await c.query('SELECT pg_advisory_xact_lock(736614)');
      const source = (
        await c.query(
          'SELECT node_id FROM central_biometric_sources WHERE organization_id=$1 AND device_id=$2',
          [m.organizationId, m.deviceId],
        )
      ).rows[0];
      if (source?.node_id !== node.id)
        throw new DomainError(403, 'SOURCE_MISMATCH', 'Source collector mismatch');
      const capability = (
        await c.query(
          'SELECT * FROM central_source_capabilities WHERE organization_id=$1 AND device_id=$2 ORDER BY revision DESC LIMIT 1',
          [m.organizationId, m.deviceId],
        )
      ).rows[0];
      if (
        !capability ||
        capability.contract !== 'signed-inventory-v1' ||
        capability.revision !== m.capabilityRevision ||
        capability.epoch !== m.epoch
      )
        throw new DomainError(
          409,
          'UNSUPPORTED_SOURCE',
          'Source capability does not verify this closure',
        );
      try {
        verifySourceClosure(closure, capability.public_key);
      } catch {
        throw new DomainError(409, 'INVALID_SOURCE_SIGNATURE', 'Source closure signature invalid');
      }
      const timing = (
        await c.query('SELECT $1::timestamptz<=clock_timestamp() valid', [m.issuedAt])
      ).rows[0];
      if (!timing.valid)
        throw new DomainError(409, 'SOURCE_NOT_CLOSED', 'Source period is not closed');
      const prior = (
        await c.query(
          'SELECT manifest=$2::jsonb AND signature=$3 AS matches FROM central_source_closures WHERE closure_id=$1',
          [m.closureId, canonicalSyncJson(m), closure.signature],
        )
      ).rows[0];
      if (prior && !prior.matches)
        throw new DomainError(409, 'CONFLICT', 'Closure identity reused');
      if (!prior)
        await c.query(
          `INSERT INTO central_source_closures(closure_id,organization_id,device_id,capability_revision,node_id,manifest,signature,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            m.closureId,
            m.organizationId,
            m.deviceId,
            m.capabilityRevision,
            node.id,
            canonicalSyncJson(m),
            closure.signature,
            digest(closure),
          ],
        );
      return { closureId: m.closureId, received: true as const, certified: false as const };
    });
  };
}
