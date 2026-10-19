import { publishReference } from './references.js';
import { syncRateLimit } from './rate-limit.js';
import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { syncRegistrationSchema, syncSequenceSchema } from '@hexpayroll/shared';
import { authenticate, domainErrors } from '../timekeeping/middleware.js';
import {
  DomainError,
  audit,
  transaction,
  requirePermission,
  type Actor,
} from '../foundation/repository.js';
import { pullChanges, pushEvents, registerNode, rotateNode } from './service.js';
import { syncWorkerStatus } from './status.js';
import { writableDomains } from './receiver.js';
import { listConflicts, conflictDetails, resolveConflict } from './conflicts.js';

export function createSyncRouter(
  pool: Pool,
  central: boolean,
  options: { mode?: string; interval?: number } = {},
) {
  const router = Router();
  router.use(syncRateLimit());
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // The local server never accidentally accepts central delivery requests.
  router.use((req, _res, next) => {
    if (!central && /^\/sync\/(nodes|push|pull)(\/|$)/.test(req.path))
      next(new DomainError(404, 'NOT_FOUND', 'Central synchronization is disabled'));
    else next();
  });
  // Device-authenticated wire routes require explicit version negotiation.
  router.use((req, res, next) => {
    if (['/sync/push', '/sync/pull'].includes(req.path)) {
      res.setHeader('X-Hex-Sync-Protocol', '2');
      if (req.headers['x-hex-sync-protocol'] !== '2')
        return next(
          new DomainError(426, 'SYNC_PROTOCOL_INCOMPATIBLE', 'Synchronization protocol 2 required'),
        );
    }
    next();
  });
  const credential = (header: string | undefined) =>
    /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1] ?? '';
  router.post('/sync/push', async (req, res) =>
    res.json(await pushEvents(pool, credential(req.headers.authorization), req.body)),
  );
  router.get('/sync/pull', async (req, res) => {
    const q = z
      .object({ after: syncSequenceSchema.default('0') })
      .strict()
      .parse(req.query);
    res.json(await pullChanges(pool, credential(req.headers.authorization), q.after));
  });
  const admin = (res: { locals: Record<string, unknown> }) => {
    const a = res.locals.actor as Actor;
    if (!a.roles.includes('administrator') || !a.organizationId)
      throw new DomainError(403, 'FORBIDDEN', 'Organization administrator required');
    return a;
  };
  router.post('/sync/reference', authenticate(pool), async (req, res) => {
    const a = admin(res);
    if (!central) throw new DomainError(404, 'NOT_FOUND', 'Central administration only');
    res.json(await publishReference(pool, a, req.body));
  });
  router.post('/sync/nodes', authenticate(pool), async (req, res) => {
    const a = admin(res),
      input = syncRegistrationSchema.parse(req.body);
    if (input.organizationId !== a.organizationId)
      throw new DomainError(
        409,
        'SYNC_ORGANIZATION_MISMATCH',
        'Central and local organization IDs must match',
      );
    const node = await transaction(pool, async (c) => {
      const registered = await registerNode(c, a.organizationId!, input.deviceName);
      await audit(c, a, 'DEVICE_REGISTERED', 'sync_nodes', registered.nodeId);
      return registered;
    });
    res.status(201).json(node);
  });
  router.get('/sync/nodes', authenticate(pool), async (_req, res) => {
    const a = admin(res);
    res.json({
      items: (
        await pool.query(
          'SELECT id,device_name,enabled,revoked_at,last_seen_at,last_pull_sequence::text FROM sync_nodes WHERE organization_id=$1 ORDER BY created_at LIMIT 100',
          [a.organizationId],
        )
      ).rows,
    });
  });
  router.post('/sync/nodes/:id/revoke', authenticate(pool), async (req, res) => {
    const a = admin(res),
      id = z.uuid().parse(req.params.id);
    await transaction(pool, async (c) => {
      const result = await c.query(
        'UPDATE sync_nodes SET enabled=false,revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND organization_id=$2 RETURNING id',
        [id, a.organizationId],
      );
      if (!result.rowCount) throw new DomainError(404, 'NOT_FOUND', 'Installation not found');
      await audit(c, a, 'DEVICE_REVOKED', 'sync_nodes', id);
    });
    res.json({ id, revoked: true });
  });
  router.post('/sync/nodes/:id/rotate', authenticate(pool), async (req, res) => {
    const a = admin(res);
    res.json(await rotateNode(pool, a.organizationId!, z.uuid().parse(req.params.id), a.id));
  });
  router.put('/sync/nodes/:id/domains', authenticate(pool), async (req, res) => {
    const a = admin(res);
    const id = z.uuid().parse(req.params.id);
    const { domains } = z
      .object({ domains: z.array(z.string().refine((v) => writableDomains.includes(v))).max(100) })
      .strict()
      .parse(req.body);
    await transaction(pool, async (c) => {
      const r = await c.query(
        'UPDATE sync_nodes SET allowed_domains=$3 WHERE id=$1 AND organization_id=$2 RETURNING id',
        [id, a.organizationId, domains],
      );
      if (!r.rowCount) throw new DomainError(404, 'NOT_FOUND', 'Installation not found');
      await audit(c, a, 'DEVICE_AUTHORIZED', 'sync_nodes', id, [], { domains });
    });
    res.json({ id, domains });
  });
  router.get('/sync/state', authenticate(pool), async (_req, res) => {
    const a = res.locals.actor as Actor;
    requirePermission(a, 'sync.view');
    const counts = await pool.query(
      `SELECT
     (SELECT count(*)::int FROM sync_outbox WHERE organization_id=$1 AND status IN ('pending','processing')) pending,
     (SELECT count(*)::int FROM sync_outbox WHERE organization_id=$1 AND status IN ('failed','rejected')) failed,
     (SELECT count(*)::int FROM sync_conflicts WHERE organization_id=$1 AND status IN ('open','under_review')) conflicts,
     (SELECT max(synced_at) FROM sync_outbox WHERE organization_id=$1 AND delivery_protocol_version=2) "lastPush",
     (SELECT count(*)::int FROM sync_outbox WHERE organization_id=$1 AND status='synced' AND delivery_protocol_version=1) "legacyDelivered",
     (SELECT max(updated_at) FROM sync_checkpoints WHERE organization_id=$1) "lastPull"`,
      [a.organizationId],
    );
    const identity = await pool.query(
      'SELECT n.id,n.device_name,n.enabled,n.revoked_at,(n.token_hash IS NOT NULL) AS registered FROM sync_local_identity i JOIN sync_nodes n ON n.id=i.node_id AND n.organization_id=i.organization_id WHERE i.organization_id=$1',
      [a.organizationId],
    );
    res.json({
      ...counts.rows[0],
      device: identity.rows[0] ?? null,
      worker: syncWorkerStatus.state,
      authorization: syncWorkerStatus.authorization,
      authorizationProblem: syncWorkerStatus.authorizationProblem,
      ...syncWorkerStatus.snapshot(
        options.mode ?? (central ? 'central' : 'disabled'),
        a.organizationId,
        options.interval ?? 15000,
      ),
    });
  });
  router.get('/sync/history', authenticate(pool), async (req, res) => {
    const a = res.locals.actor as Actor;
    requirePermission(a, 'sync.view');
    const q = z
      .object({ page: z.coerce.number().int().min(1).max(100000).default(1) })
      .strict()
      .parse(req.query);
    const r = await pool.query(
      'SELECT h.*,n.device_name,EXTRACT(EPOCH FROM(h.finished_at-h.started_at))*1000 AS duration_ms FROM sync_history h JOIN sync_nodes n ON n.id=h.node_id AND n.organization_id=h.organization_id WHERE h.organization_id=$1 ORDER BY h.started_at DESC,h.id LIMIT 25 OFFSET $2',
      [a.organizationId, (q.page - 1) * 25],
    );
    res.json({ items: r.rows, page: q.page });
  });
  router.post('/sync/now', authenticate(pool), async (_req, res) => {
    const a = admin(res);
    if (
      central ||
      !syncWorkerStatus.requestCycle ||
      syncWorkerStatus.organizationId !== a.organizationId
    )
      throw new DomainError(
        409,
        'SYNC_UNAVAILABLE',
        'Configure the local synchronization worker first',
      );
    if (syncWorkerStatus.authorization === 'denied')
      throw new DomainError(
        403,
        'SYNC_AUTHORIZATION',
        'Device authorization failed; review registration or rotate credentials',
      );
    await syncWorkerStatus.requestCycle();
    res.json({
      state: syncWorkerStatus.state,
      result:
        (
          await pool.query(
            'SELECT result FROM sync_history WHERE organization_id=$1 ORDER BY started_at DESC LIMIT 1',
            [a.organizationId],
          )
        ).rows[0]?.result ?? 'failed',
    });
  });
  router.get('/sync/proposals', authenticate(pool), async (_req, res) => {
    const a = admin(res);
    if (!central) throw new DomainError(404, 'NOT_FOUND', 'Central administration only');
    res.json({
      items: (
        await pool.query(
          'SELECT request_id,conflict_id,node_id,request,created_at FROM sync_resolution_proposals WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100',
          [a.organizationId],
        )
      ).rows,
    });
  });
  router.get('/sync/conflicts', authenticate(pool), async (req, res) => {
    res.json(await listConflicts(pool, res.locals.actor as Actor, req.query));
  });
  router.get('/sync/conflicts/:id', authenticate(pool), async (req, res) => {
    res.json(await conflictDetails(pool, res.locals.actor as Actor, z.uuid().parse(req.params.id)));
  });
  router.post('/sync/conflicts/:id/resolve', authenticate(pool), async (req, res) => {
    res.json(
      await resolveConflict(
        pool,
        res.locals.actor as Actor,
        z.uuid().parse(req.params.id),
        req.body,
        central,
      ),
    );
  });
  router.post('/sync/outbox/retry', authenticate(pool), async (_req, res) => {
    const a = admin(res);
    if (central)
      throw new DomainError(
        400,
        'INVALID_REQUEST',
        'Retry outgoing events on the local installation',
      );
    const r = await pool.query(
      "UPDATE sync_outbox SET status='pending',retry_cycle_attempts=0,next_attempt_at=NULL,error=NULL WHERE organization_id=$1 AND status='failed' RETURNING id",
      [a.organizationId],
    );
    res.json({ retried: r.rowCount });
  });
  router.use(domainErrors);
  return router;
}
