import { z } from 'zod';
import { requireBroadStreamsDisabled } from './pilot-scope.js';
import type { Pool } from 'pg';
import { canonicalSyncJson, syncSequenceSchema } from '@hexpayroll/shared';
import { DomainError, transaction } from '../foundation/repository.js';
import {
  centralCredentialsSchema,
  authorizeCentralUser,
} from '../timekeeping/central-attendance-authorization.js';
import { verifyEvidenceWriter } from '../timekeeping/central-evidence-writer.js';
import { authenticateNode } from './service.js';
import { tokenHash } from '../auth/service.js';
import {
  identityFingerprint,
  identitySnapshotSchema,
  identityPullSchema,
  verifyIdentity,
} from './trusted-identity-protocol.js';

const requestSchema = z
  .object({
    version: z.literal(1),
    requestId: z.uuid(),
    organizationId: z.uuid(),
    userId: z.uuid(),
    expectedRevision: z.number().int().min(0).max(2147483646),
    expectedAccountRevision: z.number().int().positive(),
  })
  .strict();
const mismatch = (): never => {
  throw new DomainError(
    409,
    'IDENTITY_CONFLICT',
    'Identity publication content or revision changed',
  );
};
/** Internal command only. Publishes current central identity, never creates/edits an account. */
export function createCentralIdentityPublisher(pool: Pool, mode: 'central' | 'local') {
  return async (credentials: unknown, input: unknown) => {
    if (mode !== 'central')
      throw new DomainError(403, 'CENTRAL_ONLY', 'Identity publication is central-only');
    const auth = centralCredentialsSchema.parse(credentials),
      request = requestSchema.parse(input);
    return transaction(pool, async (c) => {
      await verifyEvidenceWriter(c);
      const actor = await authorizeCentralUser(c, auth, request.organizationId, 'users.update');
      // Application setup is locked by the resolver, matching account administration order.
      const user = (
        await c.query(
          'SELECT id,organization_id,display_name,active,revision,created_at,updated_at FROM auth_users WHERE id=$1 FOR SHARE',
          [request.userId],
        )
      ).rows[0];
      if (!user || user.organization_id !== request.organizationId)
        throw new DomainError(403, 'ORGANIZATION_MISMATCH', 'Identity organization mismatch');
      if (!user.active)
        await authorizeCentralUser(c, auth, request.organizationId, 'users.disable');
      const canonical = canonicalSyncJson(request);
      await c.query('SELECT pg_advisory_xact_lock(684297106)');
      const existing = (
        await c.query('SELECT * FROM central_identity_events WHERE request_id=$1', [
          request.requestId,
        ])
      ).rows[0];
      if (existing) {
        if (
          existing.canonical_request !== canonical ||
          existing.published_by !== actor.authorUserId ||
          existing.source_node_id !== actor.nodeId
        )
          mismatch();
        return { eventId: existing.event_id as string, sequence: String(existing.sequence) };
      }
      if (user.revision !== request.expectedAccountRevision) mismatch();
      const last = (
        await c.query(
          'SELECT resulting_revision,account_revision,canonical_snapshot FROM central_identity_events WHERE organization_id=$1 AND user_id=$2 ORDER BY resulting_revision DESC LIMIT 1',
          [request.organizationId, user.id],
        )
      ).rows[0];
      if (
        (last?.resulting_revision ?? 0) !== request.expectedRevision ||
        (last && last.account_revision > user.revision)
      )
        mismatch();
      const snapshot = identitySnapshotSchema.parse({
        id: user.id,
        organizationId: user.organization_id,
        displayName: user.display_name,
        active: user.active,
        revision: request.expectedRevision + 1,
        accountRevision: user.revision,
        createdAt: new Date(user.created_at).toISOString(),
        updatedAt: new Date(user.updated_at).toISOString(),
      });
      // A repeated account revision cannot conceal edits to published identity fields.
      if (last && last.account_revision === user.revision) {
        const old = JSON.parse(last.canonical_snapshot);
        if (
          old.active !== snapshot.active ||
          old.displayName !== snapshot.displayName ||
          old.createdAt !== snapshot.createdAt ||
          old.updatedAt !== snapshot.updatedAt
        )
          mismatch();
      }
      const timing = await c.query(
        'SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()',
        [tokenHash(auth.sessionToken), actor.authorUserId],
      );
      if (!timing.rowCount) throw new DomainError(401, 'SESSION_INVALID', 'User session expired');
      const result = await c.query(
        `INSERT INTO central_identity_events(request_id,canonical_request,organization_id,user_id,expected_revision,resulting_revision,account_revision,published_by,source_node_id,canonical_snapshot,snapshot_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING event_id,sequence::text`,
        [
          request.requestId,
          canonical,
          request.organizationId,
          user.id,
          request.expectedRevision,
          snapshot.revision,
          user.revision,
          actor.authorUserId,
          actor.nodeId,
          canonicalSyncJson(snapshot),
          identityFingerprint(snapshot),
        ],
      );
      return {
        eventId: result.rows[0].event_id as string,
        sequence: result.rows[0].sequence as string,
      };
    });
  };
}
export async function pullTrustedIdentities(pool: Pool, token: string, after: string) {
  await requireBroadStreamsDisabled(pool);
  syncSequenceSchema.parse(after);
  return transaction(pool, async (c) => {
    const initial = await authenticateNode(c, token);
    const node = (
      await c.query(
        'SELECT organization_id FROM sync_nodes WHERE id=$1 AND token_hash=$2 AND enabled AND revoked_at IS NULL FOR SHARE',
        [initial.id, tokenHash(token)],
      )
    ).rows[0];
    if (!node) throw new DomainError(401, 'NODE_INVALID', 'Installation invalid');
    const rows = (
      await c.query(
        'SELECT *,sequence::text position FROM central_identity_events WHERE organization_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 3',
        [node.organization_id, after],
      )
    ).rows;
    const changes = rows.map((r) =>
      verifyIdentity({
        protocolVersion: 2,
        origin: 'central.identity',
        sequence: r.position,
        eventId: r.event_id,
        requestId: r.request_id,
        organizationId: r.organization_id,
        userId: r.user_id,
        expectedRevision: r.expected_revision,
        resultingRevision: r.resulting_revision,
        publishedBy: r.published_by,
        sourceNodeId: r.source_node_id,
        publishedAt: new Date(r.published_at).toISOString(),
        snapshot: JSON.parse(r.canonical_snapshot),
        snapshotFingerprint: r.snapshot_fingerprint,
      }),
    );
    return identityPullSchema.parse({
      protocolVersion: 2,
      origin: 'central.identity',
      changes,
      nextSequence: changes.at(-1)?.sequence ?? after,
    });
  });
}
