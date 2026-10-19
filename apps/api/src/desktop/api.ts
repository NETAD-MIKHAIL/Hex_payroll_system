import { parentPort } from './protocol.js';
import { desktopGuard } from './security.js';

if (!parentPort) throw new Error('Desktop utility process required');
let started = false;
let shutdownRequested = false;
let shutdown: (() => void) | undefined;
parentPort.on('message', ({ data }) => {
  if (data.type === 'shutdown') {
    shutdownRequested = true;
    shutdown?.();
    return;
  }
  if (data.type !== 'api' || started) return;
  started = true;
  // The packaged entrypoint never reads development .env files or inherits central mode.
  process.env.DOTENV_CONFIG_PATH = '__desktop_no_dotenv__';
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = data.databaseUrl;
  process.env.SYNC_MODE = data.sync.mode;
  if (data.sync.url) process.env.SYNC_CENTRAL_URL = data.sync.url;
  if (data.sync.nodeId) process.env.SYNC_NODE_ID = data.sync.nodeId;
  void start(data.token, data.maintenance ?? false).catch(() => {
    parentPort!.postMessage({ type: 'error', code: 'API_START_FAILED' });
    process.exit(1);
  });
});

async function start(token: string, maintenance: boolean) {
  const [
    { createApp, logger },
    { pool, probeDatabase },
    { startSyncWorker },
    { windowsCredentials },
    { startLocalAttendanceWorker },
    { startAttendanceWorker },
    { env },
    { syncWorkerStatus },
  ] = await Promise.all([
    import('../app.js'),
    import('../db/pool.js'),
    import('../sync/client.js'),
    import('../sync/credentials.js'),
    import('../sync/worker-mode.js'),
    import('../timekeeping/worker.js'),
    import('../config/env.js'),
    import('../sync/status.js'),
  ]);
  const { desktopBootstrapRouter } = await import('./bootstrap.js');
  pool.on('error', () =>
    parentPort!.postMessage({ type: 'error', code: 'DATABASE_CONNECTION_LOST' }),
  );
  const { desktopAdministrationRouter } = await import('./administration.js');
  const bootstrap = desktopBootstrapRouter(pool);
  if (maintenance) bootstrap.use(desktopAdministrationRouter(pool));
  await probeDatabase();
  const application = createApp({ desktop: { guard: desktopGuard(token), bootstrap } });
  const server = application.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  let stopSync = async () => {};
  if (!maintenance && env.SYNC_MODE === 'local') {
    try {
      const credential = await windowsCredentials.read(env.SYNC_NODE_ID!);
      stopSync = startSyncWorker(
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
      );
    } catch {
      syncWorkerStatus.failAuthorization('CREDENTIAL_UNAVAILABLE');
    }
  }
  const stopAttendance = maintenance
    ? async () => {}
    : startLocalAttendanceWorker(env.SYNC_MODE, () =>
        startAttendanceWorker(pool, () => logger.error('Attendance worker failed')),
      );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing API address');
  parentPort!.postMessage({ type: 'api-ready', port: address.port });
  let stopping = false;
  shutdown = () => {
    if (stopping) return;
    stopping = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    void Promise.all([closed, stopSync(), stopAttendance()])
      .then(() => pool.end())
      .then(() => {
        parentPort!.postMessage({ type: 'stopped' });
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };
  if (shutdownRequested) shutdown();
}
