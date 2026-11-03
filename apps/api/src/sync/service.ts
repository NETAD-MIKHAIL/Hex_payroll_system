import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { syncPushSchema, type SyncEvent } from '@hexpayroll/shared';
import { tokenHash } from '../auth/service.js';
import { DomainError, transaction } from '../foundation/repository.js';
import { requireBroadStreamsDisabled } from './pilot-scope.js';

// Node enrollment grants transport access, never identity or evidence approval.
// Also quarantine historical snapshots on pull; they are not trusted grants.
const centralOnlyEntities = [
  'attendance_pilot_scope',
  'attendance_desktop_requests',
  'attendance_desktop_outcomes',
  'central_source_capabilities',
  'central_attendance_coverage',
  'central_attendance_exception_policies',
  'central_source_closures',
  'central_attendance_certifications',
  'central_attendance_exception_resolutions',
  'central_attendance_events',
  'biometric_source_closures',
  'biometric_closure_deliveries',
  'biometric_closure_attempts',
  'trusted_attendance_inbox',
  'trusted_attendance_checkpoints',
  'trusted_attendance_applications',
  'trusted_attendance_state',
  'trusted_attendance_application_state',
  'central_attendance_evidence_reviews',
  'central_attendance_requests',
  'central_attendance_state',
  'central_attendance_decisions',
  'central_attendance_acceptance_history',
  'central_biometric_sources',
  'central_biometric_receipts',
  'central_biometric_raw_evidence',
  'biometric_raw_captures',
  'biometric_capture_batches',
  'biometric_batch_deliveries',
  'central_identity_events',
  'trusted_identity_inbox',
  'trusted_identity_checkpoints',
  'trusted_identity_applications',
  'trusted_identity_application_state',
  'trusted_actor_identities',
  'trusted_evidence_reconciliations',
  'trusted_evidence_reconciliation_applications',
  'trusted_evidence_reconciled_outbox',
  'auth_users',
  'auth_sessions',
  'roles',
  'permissions',
  'user_roles',
  'role_permissions',
  'sync_nodes',
  'application_setup',
  'central_evidence_authorizations',
  'central_evidence_acceptances',
  'central_evidence_events',
  'trusted_evidence_inbox',
  'trusted_evidence_applications',
  'trusted_evidence_application_state',
  'trusted_evidence_checkpoints',
  'work_schedules',
  'work_schedule_versions',
  'work_schedule_days',
  'employee_schedule_assignments',
  'schedule_assignment_history',
  'leave_types',
  'leave_requests',
];

export interface SyncNode {
  id: string;
  organization_id: string;
}
export async function authenticateNode(c: Pool | PoolClient, token: string): Promise<SyncNode> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
  const result = await c.query<SyncNode>(
    'SELECT id,organization_id FROM sync_nodes WHERE token_hash=$1 AND enabled AND revoked_at IS NULL',
    [tokenHash(token)],
  );
  if (!result.rows[0])
    throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
  return result.rows[0];
}
async function lockedNode(c: PoolClient, token: string) {
  const node = await authenticateNode(c, token);
  const r = await c.query(
    'SELECT id FROM sync_nodes WHERE id=$1 AND enabled AND revoked_at IS NULL FOR UPDATE',
    [node.id],
  );
  if (!r.rowCount) throw new DomainError(401, 'NODE_INVALID', 'Installation credential invalid');
  await c.query('UPDATE sync_nodes SET last_seen_at=now() WHERE id=$1', [node.id]);
  return node;
}
export async function registerNode(
  pool: Pool | PoolClient,
  organizationId: string,
  deviceName: string,
) {
  const token = randomBytes(32).toString('base64url');
  const result = await pool.query<{ id: string }>(
    'INSERT INTO sync_nodes(organization_id,device_name,token_hash) VALUES($1,$2,$3) RETURNING id',
    [organizationId, deviceName, tokenHash(token)],
  );
  return { nodeId: result.rows[0]!.id, organizationId, token };
}
class IdentityConflict extends Error {
  constructor(
    public node: SyncNode,
    public event: SyncEvent,
    public current: Record<string, unknown>,
  ) {
    super('Event identity reused');
  }
}
export async function pushEvents(pool: Pool, token: string, input: unknown) {
  try {
    return await transaction(pool, async (c) => {
      const node = await lockedNode(c, token);
      await requireBroadStreamsDisabled(c);
      const { events } = syncPushSchema.parse(input);
      if (events.some((event) => centralOnlyEntities.includes(event.entityType)))
        throw new DomainError(
          403,
          'SYNC_CENTRAL_AUTHORITY_REQUIRED',
          'Protected evidence and authorization changes require central administration',
        );
      const receipts: { eventId: string; sequence: string }[] = [];
      for (const e of events) {
        const existing = await c.query(
          `SELECT *,payload=$3::jsonb AS payload_equal FROM sync_changes WHERE source_node_id=$1 AND source_event_id=$2`,
          [node.id, e.eventId, JSON.stringify(e.payload)],
        );
        const old = existing.rows[0];
        if (old) {
          if (
            !old.payload_equal ||
            old.entity_type !== e.entityType ||
            old.entity_id !== e.entityId ||
            old.operation !== e.operation ||
            old.revision !== e.revision ||
            old.payload_version !== e.payloadVersion
          )
            throw new IdentityConflict(node, e, old);
          receipts.push({ eventId: e.eventId, sequence: String(old.sequence) });
          continue;
        }
        const r = await c.query(
          `INSERT INTO sync_changes(organization_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload_version,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING sequence::text`,
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
          ],
        );
        receipts.push({ eventId: e.eventId, sequence: r.rows[0]!.sequence });
      }
      return { receipts };
    });
  } catch (error) {
    if (!(error instanceof IdentityConflict)) throw error;
    await transaction(pool, async (c) => {
      const node = await lockedNode(c, token);
      const e = error.event;
      await c.query(
        `INSERT INTO sync_conflicts(organization_id,node_id,source_event_id,entity_type,entity_id,incoming_revision,current_revision,incoming_payload,current_payload,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'Event ID reused with different contents') ON CONFLICT(node_id,source_event_id) DO NOTHING`,
        [
          node.organization_id,
          node.id,
          e.eventId,
          e.entityType,
          e.entityId,
          e.revision,
          error.current.revision,
          JSON.stringify(e.payload),
          JSON.stringify(error.current.payload),
        ],
      );
    });
    throw new DomainError(
      409,
      'SYNC_EVENT_CONFLICT',
      'Event ID already accepted with different contents',
    );
  }
}
export async function pullChanges(pool: Pool, token: string, after: string) {
  await requireBroadStreamsDisabled(pool);
  return transaction(pool, async (c) => {
    const node = await lockedNode(c, token);
    const result = await c.query(
      `SELECT sequence::text,"id" AS "changeId",organization_id AS "organizationId",source_node_id AS "sourceNodeId",source_event_id AS "eventId",entity_type AS "entityType",entity_id AS "entityId",operation,revision,payload_version AS "payloadVersion",payload FROM sync_changes WHERE organization_id=$1 AND sequence>$2 AND NOT (entity_type=ANY($3::text[])) ORDER BY sync_changes.sequence LIMIT 3`,
      [node.organization_id, after, centralOnlyEntities],
    );
    // Include the originating node's events so one cursor traverses the whole stream.
    return { changes: result.rows, nextSequence: result.rows.at(-1)?.sequence ?? after };
  });
}
