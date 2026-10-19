import type { PoolClient } from 'pg';
import { z } from 'zod';
import { conflictResolutionRequestSchema, type CentralEvent } from '@hexpayroll/shared';
import { audit, DomainError, payloadFields } from '../foundation/repository.js';
import { currentSnapshot, applyBusinessEvent } from './receiver.js';
import { ensureRemoteActor, restoreEmploymentAggregate } from './receiver.js';
import { persistConflict } from './conflicts.js';

export async function receiveResolutionProposal(
  c: PoolClient,
  org: string,
  nodeId: string,
  e: CentralEvent,
  allowedDomains: readonly string[],
) {
  const p = z
    .object({
      id: z.uuid(),
      organizationId: z.uuid(),
      revision: z.literal(1),
      sourceEventId: z.uuid(),
      entityType: z.string(),
      entityId: z.uuid(),
      incomingRevision: z.number().int().positive(),
      baseRevision: z.number().int().nonnegative().nullable(),
      incoming: z.record(z.string(), z.unknown()),
      request: conflictResolutionRequestSchema,
    })
    .strict()
    .parse(e.payload);
  if (p.id !== e.entityId || p.id !== p.request.requestId || p.organizationId !== org)
    throw new DomainError(422, 'RESOLUTION_IDENTITY', 'Resolution identity mismatch');
  const conflict = await c.query(
    'SELECT id FROM sync_conflicts WHERE organization_id=$1 AND node_id=$2 AND source_event_id=$3 FOR UPDATE',
    [org, nodeId, p.sourceEventId],
  );
  if (!allowedDomains.includes(p.entityType))
    throw new DomainError(403, 'DOMAIN_DENIED', 'Device cannot propose resolution for this domain');
  if (!conflict.rows[0]) {
    const current = await currentSnapshot(c, p.entityType, p.entityId, org);
    const id = await persistConflict(c, {
      organizationId: org,
      nodeId,
      eventId: p.sourceEventId,
      entityType: p.entityType,
      entityId: p.entityId,
      incomingRevision: p.incomingRevision,
      baseRevision: p.baseRevision,
      currentRevision: current ? Number(current.revision) : null,
      incoming: p.incoming,
      current,
      conflictType: 'UPDATE_UPDATE',
      reason: 'Local branch requires explicit central review',
      authority: 'local',
    });
    conflict.rows.push({ id });
  }
  await c.query(
    'INSERT INTO sync_resolution_proposals(organization_id,request_id,conflict_id,node_id,request) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [org, p.id, conflict.rows[0].id, nodeId, JSON.stringify(p.request)],
  );
  await audit(
    c,
    { organizationId: org, id: null },
    'CONFLICT_REVIEWED',
    'sync_conflicts',
    conflict.rows[0].id,
    [],
    { requestId: p.id, nodeId },
  );
}
export async function publishResolution(
  c: PoolClient,
  org: string,
  row: Record<string, unknown>,
  actorId: string,
  requestId: string,
  resolution: string,
  reason: string,
) {
  const type = String(row.entity_type),
    id = String(row.entity_id);
  const current = await currentSnapshot(c, type, id, org);
  const fields = payloadFields[type];
  const snapshot =
    current && fields
      ? Object.fromEntries(
          Object.entries({ ...current, organizationId: org }).filter(([k]) =>
            ['id', 'organizationId', 'revision', ...fields].includes(k),
          ),
        )
      : null;
  const eventId = (await c.query('SELECT uuidv7() AS id')).rows[0].id;
  const payload = {
    id: String(row.id),
    organizationId: org,
    revision: Number(row.version) + 1,
    sourceEventId: String(row.source_event_id),
    requestId,
    resolution,
    reason,
    actorId,
    entityType: type,
    entityId: id,
    snapshot,
  };
  const seq = await c.query(
    "INSERT INTO sync_changes(organization_id,source_node_id,source_event_id,entity_type,entity_id,operation,revision,payload_version,payload,base_revision,actor_id,protocol_version) VALUES($1,$2,$3,'sync_resolution',$4,'UPDATE',$5,1,$6,$7,$8,2) RETURNING sequence::text",
    [
      org,
      row.node_id,
      eventId,
      row.id,
      payload.revision,
      JSON.stringify(payload),
      Number(row.version),
      actorId,
    ],
  );
  return seq.rows[0].sequence;
}
export async function applyResolution(
  c: PoolClient,
  org: string,
  e: CentralEvent,
  localNodeId: string,
) {
  const p = z
    .object({
      id: z.uuid(),
      organizationId: z.uuid(),
      revision: z.number().int().positive(),
      sourceEventId: z.uuid(),
      requestId: z.uuid(),
      resolution: z.string(),
      reason: z.string().max(1000),
      actorId: z.uuid(),
      entityType: z.string(),
      entityId: z.uuid(),
      snapshot: z.record(z.string(), z.unknown()).nullable(),
    })
    .strict()
    .parse(e.payload);
  if (p.organizationId !== org) throw new DomainError(403, 'SCOPE', 'Resolution scope mismatch');
  let conflict = (
    await c.query(
      'SELECT * FROM sync_conflicts WHERE organization_id=$1 AND source_event_id=$2 FOR UPDATE',
      [org, p.sourceEventId],
    )
  ).rows[0];
  if (p.snapshot) {
    const pending = await c.query(
      "SELECT * FROM sync_outbox WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3 AND status NOT IN ('synced','superseded','rejected') ORDER BY publication_sequence",
      [org, p.entityType, p.entityId],
    );
    const unacknowledged = pending.rows.find((row) => row.id === p.sourceEventId);
    if (!conflict && unacknowledged) {
      const id = await persistConflict(c, {
        organizationId: org,
        nodeId: localNodeId,
        eventId: unacknowledged.id,
        localEventId: unacknowledged.id,
        entityType: p.entityType,
        entityId: p.entityId,
        incomingRevision: unacknowledged.revision,
        baseRevision: unacknowledged.base_revision,
        currentRevision: Number(p.snapshot.revision),
        incoming: unacknowledged.payload,
        current: p.snapshot,
        conflictType: 'UPDATE_UPDATE',
        reason: 'Central resolution arrived before the push acknowledgment',
      });
      conflict = (
        await c.query(
          'SELECT * FROM sync_conflicts WHERE organization_id=$1 AND id=$2 FOR UPDATE',
          [org, id],
        )
      ).rows[0];
    }
    const newer = pending.rows.filter((r) => r.id !== conflict?.local_event_id);
    for (const row of newer) {
      await persistConflict(c, {
        organizationId: org,
        nodeId: localNodeId,
        eventId: row.id,
        localEventId: row.id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        incomingRevision: row.revision,
        baseRevision: row.base_revision,
        currentRevision: Number(p.snapshot.revision),
        incoming: row.payload,
        current: p.snapshot,
        conflictType: 'UPDATE_UPDATE',
        reason: 'New local edits must be reviewed against the confirmed central resolution',
      });
      await c.query(
        "UPDATE sync_outbox SET status='conflicted',lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
        [row.id],
      );
    }
    const current = await currentSnapshot(c, p.entityType, p.entityId, org);
    const revision = Number(p.snapshot.revision);
    // Replace a known rejected local revision through the same guarded receiver.
    if (
      !newer.length &&
      conflict?.local_event_id &&
      current &&
      Number(current.revision) === Number(conflict.incoming_revision)
    ) {
      const fields = payloadFields[p.entityType];
      if (!fields || !['employees', 'departments', 'positions'].includes(p.entityType))
        throw new DomainError(409, 'RESOLUTION_DOMAIN', 'Resolve using the domain workflow');
      const cols = Object.keys(p.snapshot).filter(
        (k) => fields.includes(k) && k !== 'employmentVersions',
      );
      const values = cols.map((k) => p.snapshot![k]);
      const sets = cols.map(
        (k, i) => '"' + k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()) + '"=$' + (i + 3),
      );
      await c.query(
        `UPDATE ${p.entityType} SET ${sets.join(',')},revision=$${values.length + 3} WHERE id=$1 AND organization_id=$2`,
        [p.entityId, org, ...values, revision],
      );
      if (p.entityType === 'employees' && p.snapshot.employmentVersions !== undefined)
        await restoreEmploymentAggregate(c, org, p.entityId, p.snapshot.employmentVersions);
    } else if (!newer.length && (!current || Number(current.revision) < revision)) {
      await applyBusinessEvent(
        c,
        org,
        {
          ...e,
          entityType: p.entityType,
          entityId: p.entityId,
          revision,
          baseRevision: current ? Number(current.revision) : 0,
          operation: current ? 'UPDATE' : 'CREATE',
          payload: p.snapshot,
        },
        true,
      );
    }
  }
  if (conflict) {
    await ensureRemoteActor(c, org, p.actorId);
    await c.query(
      "UPDATE sync_conflicts SET status=$3,resolution_state='confirmed',resolved_at=now(),resolved_by=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
      [org, conflict.id, p.resolution === 'reject_mutation' ? 'dismissed' : 'resolved', p.actorId],
    );
    await c.query(
      "UPDATE sync_conflict_resolutions SET state='confirmed' WHERE organization_id=$1 AND conflict_id=$2 AND state='pending'",
      [org, conflict.id],
    );
    if (conflict.local_event_id)
      await c.query(
        "UPDATE sync_outbox SET status='superseded',lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND organization_id=$2 AND status IN ('conflicted','pending','processing','failed')",
        [conflict.local_event_id, org],
      );
  }
  await audit(
    c,
    { id: null, organizationId: org },
    'CONFLICT_RESOLVED',
    'sync_conflicts',
    conflict?.id ?? null,
    [],
    {
      sourceEventId: p.sourceEventId,
      requestId: p.requestId,
      actorId: p.actorId,
      reason: p.reason,
    },
  );
}
