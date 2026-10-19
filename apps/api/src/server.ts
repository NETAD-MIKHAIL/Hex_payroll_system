import { PAYROLL_ENGINE_VERSION } from '@hexpayroll/payroll-engine';
import { createApp, logger } from './app.js';
import { env } from './config/env.js';
import { pool, probeDatabase } from './db/pool.js';
import { startAttendanceWorker } from './timekeeping/worker.js';
import { windowsCredentials } from './sync/credentials.js';
import { syncWorkerStatus } from './sync/status.js';
import { startSyncWorker } from './sync/client.js';
import { startLocalAttendanceWorker } from './sync/worker-mode.js';

async function main(): Promise<void> {
  // Probe before binding a port. If the database is unreachable we want a clear
  // startup failure, not an API that accepts requests it cannot serve.
  const probe = await probeDatabase();
  logger.info({ database: probe.database, connectedAs: probe.user }, 'postgres reachable');

  const app = createApp();
  let credential: string | undefined;
  if (env.SYNC_MODE === 'local') {
    try {
      credential = await windowsCredentials.read(env.SYNC_NODE_ID!);
    } catch {
      syncWorkerStatus.failAuthorization('CREDENTIAL_UNAVAILABLE');
      syncWorkerStatus.organizationId =
        (await pool.query('SELECT organization_id FROM sync_nodes WHERE id=$1', [env.SYNC_NODE_ID]))
          .rows[0]?.organization_id ?? null;
      logger.warn('Secure device credential unavailable; local operations remain available');
    }
  }
  const stopSync =
    env.SYNC_MODE === 'local' && credential
      ? startSyncWorker(
          pool,
          { url: env.SYNC_CENTRAL_URL!, nodeId: env.SYNC_NODE_ID!, token: credential },
          env.SYNC_INTERVAL_MS,
          () => logger.warn('Synchronization unavailable; local operations continue'),
          {
            batchSize: env.SYNC_BATCH_SIZE,
            timeoutMs: env.SYNC_REQUEST_TIMEOUT_MS,
            leaseMs: env.SYNC_LEASE_MS,
            maxAttempts: env.SYNC_MAX_ATTEMPTS,
          },
        )
      : async () => {};
  const stopWorker = startLocalAttendanceWorker(env.SYNC_MODE, () =>
    startAttendanceWorker(pool, () => logger.error('Attendance worker failed; retrying')),
  );

  const server = app.listen(env.API_PORT, env.API_HOST, () => {
    logger.info(
      {
        host: env.API_HOST,
        port: env.API_PORT,
        nodeEnv: env.NODE_ENV,
        payrollEngine: PAYROLL_ENGINE_VERSION,
      },
      'Hex Payroll API listening',
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // Stop scheduling and abort sync immediately, before waiting for HTTP clients.
    void Promise.all([closed, stopWorker(), stopSync()])
      .then(() => pool.end())
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        logger.error('Shutdown failed');
        process.exit(1);
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  logger.error(
    { errorType: error instanceof Error ? error.name : 'unknown' },
    'fatal error during startup',
  );
  process.exit(1);
});
