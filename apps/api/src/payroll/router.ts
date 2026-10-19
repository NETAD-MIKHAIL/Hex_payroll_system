import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  payrollPeriodInputSchema,
  payrollTransitionSchema,
  payrollComputeSchema,
  payrollPolicyInputSchema,
  payrollTypeInputSchema,
  payrollTypeStatusSchema,
  payrollEntryInputSchema,
  statutoryImportSchema,
  statutoryActivationSchema,
} from '@hexpayroll/shared';
import type { Actor } from '../foundation/repository.js';
import { authenticate } from '../timekeeping/middleware.js';
import { payrollErrors } from './errors.js';
import { captureLocalConflict } from '../sync/local-conflicts.js';
import { createPayrollService } from './services.js';
export function createPayrollRouter(pool: Pool) {
  const router = Router(),
    service = createPayrollService(pool);
  router.use('/payroll', authenticate(pool));
  const actor = (res: { locals: Record<string, unknown> }) => res.locals.actor as Actor;
  const id = (value: unknown) => z.uuid().parse(value);
  router.get('/payroll/periods', async (_req, res) => res.json(await service.list(actor(res))));
  router.post('/payroll/periods', async (req, res) =>
    res
      .status(201)
      .json(await service.createPeriod(actor(res), payrollPeriodInputSchema.parse(req.body))),
  );
  router.get('/payroll/periods/:id', async (req, res) =>
    res.json(await service.detail(actor(res), id(req.params.id))),
  );
  router.get('/payroll/periods/:id/runs/:runId', async (req, res) =>
    res.json(await service.detail(actor(res), id(req.params.id), id(req.params.runId))),
  );
  router.get('/payroll/periods/:id/results/:resultId', async (req, res) =>
    res.json(await service.result(actor(res), id(req.params.id), id(req.params.resultId))),
  );
  for (const action of ['open', 'cancel', 'review', 'finalize'] as const)
    router.post('/payroll/periods/:id/' + action, async (req, res) =>
      res.json(
        await service.transition(
          actor(res),
          id(req.params.id),
          action,
          payrollTransitionSchema.parse(req.body),
        ),
      ),
    );
  for (const action of ['compute', 'recompute'] as const)
    router.post('/payroll/periods/:id/' + action, async (req, res) =>
      res.json(
        await service.compute(
          actor(res),
          id(req.params.id),
          payrollComputeSchema.parse(req.body),
          action === 'recompute',
        ),
      ),
    );
  for (const section of ['types', 'entries', 'policies', 'rules'] as const)
    router.get('/payroll/' + section, async (req, res) =>
      res.json(
        await service.configuration(
          actor(res),
          section,
          z.enum(['earning', 'deduction']).optional().parse(req.query.kind),
        ),
      ),
    );
  router.post('/payroll/types', async (req, res) =>
    res
      .status(201)
      .json(await service.createType(actor(res), payrollTypeInputSchema.parse(req.body))),
  );
  router.post('/payroll/entries', async (req, res) =>
    res
      .status(201)
      .json(await service.createEntry(actor(res), payrollEntryInputSchema.parse(req.body))),
  );
  router.post('/payroll/types/:id/status', async (req, res) =>
    res.json(
      await service.typeStatus(
        actor(res),
        id(req.params.id),
        payrollTypeStatusSchema.parse(req.body),
      ),
    ),
  );
  router.post('/payroll/entries/:id/deactivate', async (req, res) =>
    res.json(
      await service.deactivateEntry(
        actor(res),
        id(req.params.id),
        payrollTransitionSchema.parse(req.body).expectedRevision,
      ),
    ),
  );
  router.post('/payroll/policies', async (req, res) =>
    res
      .status(201)
      .json(await service.createPolicy(actor(res), payrollPolicyInputSchema.parse(req.body))),
  );
  router.post('/payroll/rules/import', async (req, res) =>
    res
      .status(201)
      .json(await service.importRules(actor(res), statutoryImportSchema.parse(req.body))),
  );
  router.post('/payroll/rules/:id/activate', async (req, res) =>
    res.json(
      await service.activateRules(
        actor(res),
        id(req.params.id),
        statutoryActivationSchema.parse(req.body).expectedRevision,
        statutoryActivationSchema.parse(req.body).supersedesId,
      ),
    ),
  );
  router.use('/payroll', captureLocalConflict(pool));
  router.use('/payroll', payrollErrors);
  return router;
}
