import type { Pool } from 'pg';
import { centralEventSchema } from '@hexpayroll/shared';
import { transaction, DomainError, type Actor } from '../foundation/repository.js';
import { applyBusinessEvent } from './receiver.js';

/** Restricted central administration; ordinary business routes stay private. */
export async function publishReference(pool: Pool, actor: Actor, input: unknown) {
  const event = centralEventSchema.parse(input);
  if (!['organizations', 'statutory_rule_sets', 'payroll_policies'].includes(event.entityType))
    throw new DomainError(
      403,
      'CENTRAL_REFERENCE',
      'Only central-owned reference entities are allowed',
    );
  return transaction(pool, async (c) => {
    const org = actor.organizationId!;
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7343))', [org]);
    const duplicate = await c.query(
      'SELECT sequence::text,payload=$3::jsonb identical,entity_type,entity_id,revision FROM sync_changes WHERE organization_id=$1 AND source_event_id=$2',
      [org, event.eventId, JSON.stringify(event.payload)],
    );
    if (duplicate.rows[0]) {
      const old = duplicate.rows[0];
      if (
        !old.identical ||
        old.entity_type !== event.entityType ||
        old.entity_id !== event.entityId ||
        old.revision !== event.revision
      )
        throw new DomainError(409, 'EVENT_IDENTITY', 'Reference event identity reused');
      return { sequence: old.sequence };
    }
    let node = (
      await c.query('SELECT node_id FROM sync_local_identity WHERE organization_id=$1', [org])
    ).rows[0]?.node_id;
    if (!node) {
      node = (
        await c.query(
          "INSERT INTO sync_nodes(organization_id,device_name) VALUES($1,'Central reference publisher') RETURNING id",
          [org],
        )
      ).rows[0].id;
      await c.query('INSERT INTO sync_local_identity(organization_id,node_id) VALUES($1,$2)', [
        org,
        node,
      ]);
    }
    await applyBusinessEvent(c, org, { ...event, originNodeId: node, actorId: actor.id }, true);
    const result = await c.query(
      'INSERT INTO sync_changes(organization_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload_version,payload,base_revision,actor_id,protocol_version) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,2) RETURNING sequence::text',
      [
        org,
        node,
        event.eventId,
        event.entityType,
        event.entityId,
        event.operation,
        event.revision,
        JSON.stringify(event.payload),
        event.baseRevision,
        actor.id,
      ],
    );
    return result.rows[0];
  });
}
