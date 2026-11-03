import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { DomainError } from '../foundation/repository.js';
import { authenticateNode } from './service.js';

/**
 * Authenticate central sync PUSH before Express parses its JSON body.
 * The sync service independently authenticates inside its transaction.
 */
export function syncPushPreparseAuth(db: Pool): RequestHandler {
  return async (req, res, next) => {
    try {
      const token =
        /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      await authenticateNode(db, token);
      next();
    } catch (error) {
      if (error instanceof DomainError && error.status === 401) {
        res.status(401).json({
          error: { code: 'NODE_INVALID', message: 'Installation credential invalid' },
        });
        return;
      }
      next(error);
    }
  };
}
