import express from 'express';
import type { ErrorRequestHandler, Express, RequestHandler } from 'express';
import pino from 'pino';
import { env } from './config/env.js';
import { corsMiddleware } from './middleware/cors.js';
import { healthRouter } from './routes/health.js';
import { createAuthRouter } from './routes/auth.js';
import { createAuthService } from './auth/service.js';
import type { Pool } from 'pg';
import { pool as defaultPool } from './db/pool.js';
import { createFoundationRouter } from './foundation/router.js';
import { createTimekeepingRouter } from './timekeeping/router.js';
import { createPayrollRouter } from './payroll/router.js';
import { createSyncRouter } from './sync/router.js';

export const logger = pino({ level: env.LOG_LEVEL });

const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    logger.info(
      {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      },
      'request handled',
    );
  });

  next();
};

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
};

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'unhandled error');
  const invalid =
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.parse.failed';
  const large =
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.too.large';
  res.status(invalid ? 400 : large ? 413 : 500).json({
    error: {
      code: invalid || large ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
      message: invalid
        ? 'Malformed JSON'
        : large
          ? 'Request is too large'
          : 'Internal server error',
    },
  });
};

/**
 * Builds the Express application.
 *
 * This factory is the whole point of the deployment shape: the SAME app is
 * mounted by `local.ts` (spawned as a child process by the Electron desktop
 * shell, bound to loopback) and by `server.ts` (the central server). There is no
 * "desktop API" and "cloud API" to keep in sync — only one application with two
 * entrypoints.
 */
export function createApp(
  options: { database?: Pool; mode?: 'disabled' | 'local' | 'central' } = {},
): Express {
  const app = express();
  const pool = options.database ?? defaultPool;
  const mode = options.mode ?? env.SYNC_MODE;

  app.disable('x-powered-by');
  // Before the body parser: a preflight carries no body, and a rejected origin
  // must not be able to make the server parse anything.
  app.use(corsMiddleware);
  app.use('/api/auth', createAuthRouter(createAuthService(pool)));
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);

  // Mounted under `/api`, which is where every consumer expects health
  // (`HEALTH_PATH` in @hexpayroll/shared) and where resource routes will live.
  app.use('/api', healthRouter);
  app.use(
    '/api',
    createSyncRouter(pool, mode === 'central', { mode, interval: env.SYNC_INTERVAL_MS }),
  );
  if (mode !== 'central') {
    app.use('/api', createPayrollRouter(pool));
    app.use('/api', createTimekeepingRouter(pool));
    app.use(
      '/api',
      createFoundationRouter(pool, {
        mode,
        interval: env.SYNC_INTERVAL_MS,
        ...(env.SYNC_NODE_ID ? { nodeId: env.SYNC_NODE_ID } : {}),
      }),
    );
  }
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
