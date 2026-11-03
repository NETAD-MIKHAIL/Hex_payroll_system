import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { syncSequenceSchema } from '@hexpayroll/shared';
import { DomainError } from '../foundation/repository.js';
import { createCentralAttendanceFinalizationService } from './central-attendance-finalization.js';
import { createSourceClosureReceiver } from './source-period-receipt.js';
import { pullTrustedAttendance } from '../sync/trusted-attendance.js';
import { domainErrors } from './middleware.js';
import {
  readCentralAttendanceWorkspace,
  readCentralAttendanceEvidence,
} from './attendance-management-read.js';

export function createAttendanceFinalizationRouter(
  runtime: Pool,
  mode: 'local' | 'central' | 'disabled',
  enabled = false,
  writer?: Pool,
) {
  const router = Router();
  const token = (header: string | undefined) =>
    /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1] ?? '';
  const closure = createSourceClosureReceiver(
    runtime,
    mode === 'central' ? 'central' : 'local',
    enabled,
  );
  router.use('/sync/attendance', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (mode !== 'central' || !enabled)
      next(new DomainError(403, 'DISABLED', 'Attendance finalization is disabled'));
    else next();
  });
  router.post('/sync/biometric/closure', async (req, res) =>
    res.json(await closure(token(req.headers.authorization), req.body)),
  );
  const credentials = (req: Request) => ({
    nodeToken: token(req.headers.authorization),
    sessionToken: req.get('X-Central-Session') ?? '',
  });
  router.post('/sync/attendance/workspace', async (req, res) =>
    res.json(await readCentralAttendanceWorkspace(runtime, credentials(req), req.body)),
  );
  router.post('/sync/attendance/evidence', async (req, res) =>
    res.json(await readCentralAttendanceEvidence(runtime, credentials(req), req.body)),
  );
  router.get('/sync/attendance/pull', async (req, res) => {
    const q = z
      .object({ after: syncSequenceSchema.default('0') })
      .strict()
      .parse(req.query);
    res.json(await pullTrustedAttendance(runtime, token(req.headers.authorization), q.after));
  });
  const service = writer
    ? createCentralAttendanceFinalizationService(
        writer,
        mode === 'central' ? 'central' : 'local',
        enabled,
      )
    : null;
  for (const [path, operation] of [
    ['certify', 'certify'],
    ['exceptions', 'resolveException'],
    ['proposals', 'propose'],
    ['finalize', 'finalize'],
    ['reopen', 'reopen'],
  ] as const)
    router.post('/sync/attendance/' + path, async (req, res) => {
      if (!service)
        throw new DomainError(
          503,
          'WRITER_UNAVAILABLE',
          'A separately provisioned central attendance writer is required',
        );
      res.json(
        await service[operation](
          {
            nodeToken: token(req.headers.authorization),
            sessionToken: req.get('X-Central-Session') ?? '',
          },
          req.body,
        ),
      );
    });
  router.use(domainErrors);
  return router;
}
