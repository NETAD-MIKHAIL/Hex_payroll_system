import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { syncRegistrationSchema, syncSequenceSchema } from '@hexpayroll/shared';
import { authenticate, domainErrors } from '../timekeeping/middleware.js';
import { DomainError, type Actor } from '../foundation/repository.js';
import { pullChanges, pushEvents, registerNode } from './service.js';
import { pullTrustedEvidence } from './trusted-evidence.js';
import { pullTrustedIdentities } from './central-identities.js';
import { createEvidenceReconciliationService } from './evidence-reconciliation.js';
import type { SyncClientConfig } from './client.js';
import { createCentralBiometricEvidenceService } from '../timekeeping/central-biometric-evidence.js';
import { createAttendanceEvidenceReviewService } from '../timekeeping/attendance-evidence-review.js';

export function createSyncRouter(
  pool: Pool,
  central: boolean,
  localConfig?: SyncClientConfig,
  biometricEnabled = false,
) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // The local server never accidentally accepts central delivery requests.
  router.use((req, _res, next) => {
    if (!central && /^\/sync\/(nodes|push|pull|evidence|identities)(\/|$)/.test(req.path))
      next(new DomainError(404, 'NOT_FOUND', 'Central synchronization is disabled'));
    else next();
  });
  const credential = (header: string | undefined) =>
    /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1] ?? '';
  const biometric = createCentralBiometricEvidenceService(
    pool,
    central ? 'central' : 'local',
    biometricEnabled,
  );
  const reviewAttendance = createAttendanceEvidenceReviewService(
    pool,
    central ? 'central' : 'local',
    biometricEnabled,
  );
  router.post('/sync/attendance/evidence-review', async (req, res) =>
    res.json(
      await reviewAttendance(
        {
          nodeToken: credential(req.headers.authorization),
          sessionToken: req.get('X-Central-Session') ?? '',
        },
        req.body,
      ),
    ),
  );
  router.post('/sync/biometric/receive', async (req, res) =>
    res.json(await biometric.receive(credential(req.headers.authorization), req.body)),
  );
  if (!central && localConfig) {
    const reconciliation = createEvidenceReconciliationService(pool, localConfig, 'local');
    router.get('/sync/local-evidence/:sequence', async (req, res) =>
      res.json(
        await reconciliation.inspect(credential(req.headers.authorization), req.params.sequence),
      ),
    );
    router.post('/sync/local-evidence/reconcile', async (req, res) =>
      res.json(await reconciliation.reconcile(credential(req.headers.authorization), req.body)),
    );
  }
  router.get('/sync/identities/pull', async (req, res) => {
    const q = z
      .object({ after: syncSequenceSchema.default('0') })
      .strict()
      .parse(req.query);
    res.json(await pullTrustedIdentities(pool, credential(req.headers.authorization), q.after));
  });
  router.get('/sync/evidence/pull', async (req, res) => {
    const q = z
      .object({ after: syncSequenceSchema.default('0') })
      .strict()
      .parse(req.query);
    res.json(await pullTrustedEvidence(pool, credential(req.headers.authorization), q.after));
  });
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
  router.post('/sync/nodes', authenticate(pool), async (req, res) => {
    const a = admin(res),
      input = syncRegistrationSchema.parse(req.body);
    if (input.organizationId !== a.organizationId)
      throw new DomainError(
        409,
        'SYNC_ORGANIZATION_MISMATCH',
        'Central and local organization IDs must match',
      );
    res.status(201).json(await registerNode(pool, a.organizationId!, input.deviceName));
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
    const result = await pool.query(
      'UPDATE sync_nodes SET enabled=false,revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND organization_id=$2 RETURNING id',
      [id, a.organizationId],
    );
    if (!result.rowCount) throw new DomainError(404, 'NOT_FOUND', 'Installation not found');
    res.json({ id, revoked: true });
  });
  router.get('/sync/conflicts', authenticate(pool), async (_req, res) => {
    const a = admin(res);
    res.json({
      items: (
        await pool.query(
          'SELECT id,node_id,source_event_id,entity_type,entity_id,incoming_revision,current_revision,reason,status,created_at,resolved_at FROM sync_conflicts WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100',
          [a.organizationId],
        )
      ).rows,
    });
  });
  router.post('/sync/conflicts/:id/resolve', authenticate(pool), async (req, res) => {
    const a = admin(res),
      id = z.uuid().parse(req.params.id);
    const { status } = z
      .object({ status: z.enum(['resolved', 'ignored']) })
      .strict()
      .parse(req.body);
    const r = await pool.query(
      "UPDATE sync_conflicts SET status=$3,resolved_at=now(),resolved_by=$4 WHERE id=$1 AND organization_id=$2 AND status='open' RETURNING id",
      [id, a.organizationId, status, a.id],
    );
    if (!r.rowCount)
      throw new DomainError(409, 'CONFLICT', 'Conflict is unavailable or already closed');
    res.json({ id, status });
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
      "UPDATE sync_outbox o SET status='pending',next_attempt_at=NULL,error=NULL WHERE organization_id=$1 AND status='failed' AND NOT EXISTS(SELECT 1 FROM trusted_evidence_reconciled_outbox r WHERE r.outbox_id=o.id) RETURNING id",
      [a.organizationId],
    );
    res.json({ retried: r.rowCount });
  });
  router.use(domainErrors);
  return router;
}
