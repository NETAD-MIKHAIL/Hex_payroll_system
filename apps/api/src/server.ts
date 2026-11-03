import { PAYROLL_ENGINE_VERSION } from '@hexpayroll/payroll-engine';
import { createApp, logger } from './app.js';
import { env } from './config/env.js';
import { pool, probeDatabase } from './db/pool.js';
import { startAttendanceWorker } from './timekeeping/worker.js';
import { startSyncWorker } from './sync/client.js';
import { startTrustedEvidenceWorker } from './sync/trusted-worker.js';
import { startLocalAttendanceWorker } from './sync/worker-mode.js';
import pg from 'pg';
import type { DesktopEnrollment } from './desktop/enrollment.js';
import type { DesktopDeviceConfiguration } from './desktop/device-config.js';

export async function startServer(
  options: {
    enroll?: (input: DesktopEnrollment) => Promise<void>;
    devices?: DesktopDeviceConfiguration;
  } = {},
) {
  // Probe before binding a port. If the database is unreachable we want a clear
  // startup failure, not an API that accepts requests it cannot serve.
  const probe = await probeDatabase();
  logger.info({ database: probe.database, connectedAs: probe.user }, 'postgres reachable');

  const attendanceWriter =
    env.SYNC_MODE === 'central' &&
    env.ATTENDANCE_FINALIZATION_ENABLED &&
    env.CENTRAL_ATTENDANCE_WRITER_DATABASE_URL
      ? new pg.Pool({ connectionString: env.CENTRAL_ATTENDANCE_WRITER_DATABASE_URL })
      : undefined;
  const app = createApp({ ...options, ...(attendanceWriter ? { attendanceWriter } : {}) });
  const trustedWorker = startTrustedEvidenceWorker(
    pool,
    {
      url: env.SYNC_CENTRAL_URL ?? '',
      nodeId: env.SYNC_NODE_ID ?? '',
      token: env.SYNC_NODE_TOKEN ?? '',
    },
    {
      mode: env.SYNC_MODE,
      enabled: env.SYNC_TRUSTED_EVIDENCE_ENABLED,
      biometricEnabled: env.SYNC_BIOMETRIC_EVIDENCE_ENABLED,
      attendanceEnabled: env.ATTENDANCE_FINALIZATION_ENABLED,
      interval: env.SYNC_INTERVAL_MS,
    },
    () => logger.warn('Trusted evidence pending or conflicted; receipt and retry state retained'),
  );
  const stopSync =
    env.SYNC_MODE === 'local'
      ? startSyncWorker(
          pool,
          { url: env.SYNC_CENTRAL_URL!, nodeId: env.SYNC_NODE_ID!, token: env.SYNC_NODE_TOKEN! },
          env.SYNC_INTERVAL_MS,
          () => logger.warn('Synchronization unavailable; local operations continue'),
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

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stopWorker();
      await stopSync();
      await trustedWorker.stop();
      await pool.end();
      await attendanceWriter?.end();
    })());
  if (!env.HEX_PRIVATE_API_TOKEN) {
    const shutdown = () => {
      void stop().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
  return { server, stop };
}

if (!process.env.HEX_PRIVATE_API_TOKEN)
  void startServer().catch((error: unknown) => {
    logger.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'fatal error during startup',
    );
    process.exit(1);
  });
