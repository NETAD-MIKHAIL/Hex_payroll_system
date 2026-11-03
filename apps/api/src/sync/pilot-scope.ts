import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../foundation/repository.js';
import type { RequestHandler } from 'express';

/** Database-owned policy, empty by default. Runtime cannot widen it. */
export async function pilotActive(db: Pool | PoolClient): Promise<boolean> {
  return (await db.query('SELECT hex_pilot_active() active')).rows[0]?.active === true;
}
export async function requireBroadStreamsDisabled(db: Pool | PoolClient) {
  if (await pilotActive(db))
    throw new DomainError(
      403,
      'PILOT_SCOPE_HOLD',
      'Broad synchronization is held during the pilot',
    );
}

/** A pilot is an attendance-only workspace. Existing holds are not reconciled. */
export function pilotBoundary(db: Pool): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!(await pilotActive(db)) || req.method === 'GET' || req.method === 'OPTIONS') {
        next();
        return;
      }
      const allowed =
        /^\/api\/(?:auth\/(?:login|logout)|attendance-management(?:\/.*)?|sync\/(?:biometric\/(?:receive|closure)|attendance\/(?:workspace|evidence|certify|proposals|finalize|reopen|exceptions|evidence-review))|time-records\/(?:manual|ingest|[^/]+\/corrections)|biometric-source-closures|attendance\/reprocess)$/.test(
          req.path,
        );
      if (!allowed) {
        res.status(403).json({
          error: {
            code: 'PILOT_SCOPE_HOLD',
            message: 'This operation is held during the attendance pilot',
          },
        });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
