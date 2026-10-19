import { receiveSnapshotChunk } from './snapshots.js';
import { fingerprint } from '../payroll/services.js';
import { receiveResolutionProposal } from './resolutions.js';
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { centralPushSchema, type CentralResult } from '@hexpayroll/shared';
import {
  applyBusinessEvent,
  currentSnapshot,
  ReceiverConflict,
  MissingDependency,
  writableDomains,
} from './receiver.js';
import { databaseErrorCode, audit, normalize, payloadFields } from '../foundation/repository.js';
import { tokenHash } from '../auth/service.js';
import { DomainError, transaction } from '../foundation/repository.js';
import { persistConflict } from './conflicts.js';

export interface SyncNode {
  id: string;
  organization_id: string;
  allowed_domains: string[];
}
export async function authenticateNode(c: Pool | PoolClient, token: string): Promise<SyncNode> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
  const result = await c.query<SyncNode & { enabled: boolean; revoked_at: Date | null }>(
    'SELECT id,organization_id,allowed_domains,enabled,revoked_at FROM sync_nodes WHERE token_hash=$1',
    [tokenHash(token)],
  );
  if (!result.rows[0])
    throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
  if (result.rows[0].revoked_at)
    throw new DomainError(
      403,
      'NODE_REVOKED',
      'Device revoked; contact an organization administrator',
    );
  if (!result.rows[0].enabled)
    throw new DomainError(
      403,
      'NODE_DISABLED',
      'Device disabled; contact an organization administrator',
    );
  return result.rows[0];
}
async function lockedNode(c: PoolClient, token: string) {
  const node = await authenticateNode(c, token);
  const r = await c.query(
    'SELECT id,organization_id,allowed_domains FROM sync_nodes WHERE id=$1 AND enabled AND revoked_at IS NULL AND token_hash=$2 FOR UPDATE',
    [node.id, tokenHash(token)],
  );
  if (!r.rowCount) throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
  await c.query('UPDATE sync_nodes SET last_seen_at=now() WHERE id=$1', [node.id]);
  return r.rows[0] as SyncNode;
}
export async function registerNode(
  pool: Pool | PoolClient,
  organizationId: string,
  deviceName: string,
) {
  const token = randomBytes(32).toString('base64url');
  const result = await pool.query<{ id: string }>(
    'INSERT INTO sync_nodes(organization_id,device_name,token_hash,allowed_domains) VALUES($1,$2,$3,$4) RETURNING id',
    [organizationId, deviceName, tokenHash(token), writableDomains],
  );
  const nodeId = result.rows[0]!.id;
  const organization = (
    await pool.query('SELECT * FROM organizations WHERE id=$1', [organizationId])
  ).rows[0];
  const row = normalize(organization);
  const snapshot = Object.fromEntries(
    Object.entries({ ...row, organizationId }).filter(([k]) =>
      ['id', 'organizationId', 'revision', ...payloadFields.organizations!].includes(k),
    ),
  );
  await pool.query(
    `INSERT INTO sync_changes(organization_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload_version,payload,base_revision,protocol_version)
   SELECT $1,$2,uuidv7(),'organizations',$1,'CREATE',$3,1,$4,0,2
   WHERE NOT EXISTS(SELECT 1 FROM sync_changes WHERE organization_id=$1 AND entity_type='organizations' AND revision=$3 AND protocol_version=2)`,
    [organizationId, nodeId, row.revision, JSON.stringify(snapshot)],
  );
  return { nodeId, organizationId, token };
}

export async function pushEvents(pool: Pool, token: string, input: unknown) {
  const { events } = centralPushSchema.parse(input);
  await authenticateNode(pool, token);
  const results: CentralResult[] = [];
  for (const e of events) {
    const result = await transaction(pool, async (c) => {
      const node = await lockedNode(c, token);
      // A single lock order for application, idempotency and feed publication.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7343))', [
        node.organization_id,
      ]);
      const prior = await c.query(
        'SELECT node_id,organization_id,request=$2::jsonb identical,result FROM sync_received_events WHERE event_id=$1',
        [e.eventId, JSON.stringify({ hash: fingerprint(e) })],
      );
      if (prior.rows[0]) {
        const old = prior.rows[0];
        if (
          old.organization_id !== node.organization_id ||
          old.node_id !== node.id ||
          !old.identical
        )
          return {
            eventId: e.eventId,
            status: 'rejected' as const,
            code: 'EVENT_IDENTITY',
            reason: 'Event identity was reused',
          };
        const r = old.result as CentralResult;
        return r.status === 'accepted' ? { ...r, status: 'already_applied' as const } : r;
      }
      let outcome: CentralResult;
      await c.query('SAVEPOINT business_event');
      try {
        const secret = (v: unknown): boolean =>
          Array.isArray(v)
            ? v.some(secret)
            : v !== null && typeof v === 'object'
              ? Object.entries(v).some(
                  ([k, value]) =>
                    /password|token|secret|credential|session/i.test(k) || secret(value),
                )
              : false;
        if (secret(e.payload))
          throw new DomainError(
            422,
            'SECRET_PAYLOAD',
            'Secrets are prohibited in business synchronization',
          );
        if (!node.allowed_domains.includes(e.entityType))
          throw new DomainError(403, 'DOMAIN_DENIED', 'Device is not authorized for this domain');
        if (e.entityType === 'sync_snapshot_chunk')
          await receiveSnapshotChunk(c, node.organization_id, e);
        else if (e.entityType === 'sync_resolution_proposals')
          await receiveResolutionProposal(
            c,
            node.organization_id,
            node.id,
            e,
            node.allowed_domains,
          );
        else await applyBusinessEvent(c, node.organization_id, e);
        const row = await c.query(
          'INSERT INTO sync_changes(organization_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload_version,payload,base_revision,actor_id,protocol_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,2) RETURNING sequence::text',
          [
            node.organization_id,
            node.id,
            e.eventId,
            e.entityType,
            e.entityId,
            e.operation,
            e.revision,
            e.payloadVersion,
            JSON.stringify(e.payload),
            e.baseRevision,
            e.actorId,
          ],
        );
        outcome = {
          eventId: e.eventId,
          status: 'accepted',
          revision: e.revision,
          sequence: row.rows[0].sequence,
        };
      } catch (error) {
        await c.query('ROLLBACK TO SAVEPOINT business_event');
        const code = databaseErrorCode(error);
        if (error instanceof ReceiverConflict || ['23505', '23514', '23P01'].includes(code)) {
          const current =
            error instanceof ReceiverConflict
              ? error.current
              : await currentSnapshot(c, e.entityType, e.entityId, node.organization_id);
          const conflictType =
            error instanceof ReceiverConflict ? error.conflictType : 'INVALID_REFERENCE';
          const reason =
            error instanceof ReceiverConflict
              ? error.message
              : 'Business identity or domain constraint conflicts';
          const id = await persistConflict(c, {
            organizationId: node.organization_id,
            nodeId: node.id,
            eventId: e.eventId,
            entityType: e.entityType,
            entityId: e.entityId,
            incomingRevision: e.revision,
            currentRevision: current ? Number(current.revision) : null,
            baseRevision: e.baseRevision,
            incoming: e.payload,
            current,
            conflictType,
            reason,
            authority: 'local',
          });
          outcome = {
            eventId: e.eventId,
            status: 'conflict',
            conflictId: id,
            conflictType,
            currentRevision: current ? Number(current.revision) : null,
            snapshot: current,
            reason,
          };
        } else if (
          error instanceof MissingDependency ||
          (error instanceof DomainError && error.status === 503) ||
          code === '23503' ||
          ['40001', '40P01', '55P03'].includes(code)
        )
          outcome = {
            eventId: e.eventId,
            status: 'retryable_failure',
            code: 'DEPENDENCY_OR_BUSY',
            reason: 'Dependency unavailable or transaction busy; retry later',
          };
        else if (
          error instanceof DomainError ||
          (error instanceof Error && error.name === 'ZodError') ||
          ['22P02', '23502', '22007', '22008'].includes(code)
        )
          outcome = {
            eventId: e.eventId,
            status: 'rejected',
            code: error instanceof DomainError ? error.code : 'INVALID_PAYLOAD',
            reason: error instanceof DomainError ? error.message : 'Invalid business snapshot',
          };
        else throw error;
      }
      await c.query('RELEASE SAVEPOINT business_event');
      if (outcome.status !== 'retryable_failure')
        await c.query(
          'INSERT INTO sync_received_events(organization_id,event_id,node_id,request,result) VALUES($1,$2,$3,$4,$5)',
          [
            node.organization_id,
            e.eventId,
            node.id,
            JSON.stringify({ hash: fingerprint(e) }),
            JSON.stringify(outcome),
          ],
        );
      return outcome;
    });
    results.push(result);
  }
  return { protocolVersion: 2 as const, results };
}
export async function pullChanges(pool: Pool, token: string, after: string) {
  return transaction(pool, async (c) => {
    const node = await lockedNode(c, token);
    const rows = await c.query(
      'SELECT sequence::text,id AS "changeId",organization_id AS "organizationId",source_node_id AS "sourceNodeId",source_event_id AS "eventId",entity_type AS "entityType",entity_id AS "entityId",operation,revision,payload_version AS "payloadVersion",payload,base_revision AS "baseRevision",actor_id AS "actorId" FROM sync_changes WHERE organization_id=$1 AND protocol_version=2 AND sequence>$2 ORDER BY sync_changes.sequence LIMIT 4',
      [node.organization_id, after],
    );
    const changes = rows.rows.slice(0, 3);
    // Reject rather than advancing past unauthorized data. Provision devices for
    // the required domains before enabling a shared organization feed.
    if (
      changes.some(
        (e) =>
          !node.allowed_domains.includes(e.entityType) &&
          ![
            'organizations',
            'statutory_rule_sets',
            'payroll_policies',
            'sync_resolution',
            'sync_resolution_proposals',
          ].includes(e.entityType),
      )
    )
      throw new DomainError(403, 'DOMAIN_DENIED', 'Device cannot read this domain');
    return {
      protocolVersion: 2 as const,
      changes,
      nextSequence: changes.at(-1)?.sequence ?? after,
      hasMore: rows.rows.length > 3,
    };
  });
}
export async function rotateNode(pool: Pool, org: string, id: string, actorId: string) {
  return transaction(pool, async (c) => {
    const token = randomBytes(32).toString('base64url');
    const r = await c.query(
      'UPDATE sync_nodes SET token_hash=$3,credential_rotated_at=now() WHERE organization_id=$1 AND id=$2 AND enabled AND revoked_at IS NULL RETURNING id',
      [org, id, tokenHash(token)],
    );
    if (!r.rowCount) throw new DomainError(404, 'NOT_FOUND', 'Active installation not found');
    await audit(c, { id: actorId, organizationId: org }, 'DEVICE_ROTATED', 'sync_nodes', id);
    return { nodeId: id, token };
  });
}
