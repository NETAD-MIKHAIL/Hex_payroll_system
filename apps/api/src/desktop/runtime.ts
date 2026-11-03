// Bundled as a CommonJS Node utility-process entry; no external Node installation.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';
import { migrate, readMigrations } from '../db/migrate.js';
import { recordDesktopEnrollment } from './enrollment.js';
import type { ManualDeviceConnection } from './device-config.js';
interface PrivateSettings {
  installationId: string;
  administratorPassword: string;
  migratorPassword: string;
  applicationPassword: string;
  sync?: { url: string; nodeId: string; token: string; organizationId: string; deviceName: string };
  deviceConnections?: ManualDeviceConnection[];
}

interface Start {
  root: string;
  resources: string;
  settings: PrivateSettings;
  token: string;
  origin: string;
}
const parent = (
  process as unknown as {
    parentPort: {
      on(event: 'message', cb: (event: { data: unknown }) => void): void;
      postMessage(value: unknown): void;
    };
  }
).parentPort;
let lastHeartbeat = Date.now();
let stopApi: (() => Promise<void>) | undefined;
let stopDatabase: (() => Promise<void>) | undefined;
let stopping = false;
let phase = 'waiting';
let diagnosticRoot: string | undefined;
function progress(value: string) {
  phase = value;
  parent.postMessage({ type: 'progress', phase });
  if (diagnosticRoot)
    void writeFile(
      join(diagnosticRoot, 'startup-status.json'),
      JSON.stringify({ phase, at: new Date().toISOString() }) + '\n',
    ).catch(() => undefined);
}
let credentialsSaved: (() => void) | undefined;
let enrolling = false;
let deviceSettingsSaved: (() => void) | undefined;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 65_000);
  let apiDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stopApi?.(),
      new Promise<void>((resolve) => {
        apiDeadline = setTimeout(resolve, 20_000);
      }),
    ]);
  } finally {
    if (apiDeadline) clearTimeout(apiDeadline);
    try {
      await stopDatabase?.();
    } finally {
      clearTimeout(deadline);
      process.exit(code);
    }
  }
}
setInterval(() => {
  if (Date.now() - lastHeartbeat > 15_000) void shutdown(1);
}, 3000).unref();
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot reserve loopback port');
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return address.port;
}
const literal = (value: string) => "'" + value.replace(/'/g, "''") + "'";
async function start(input: Start) {
  const { root, resources, settings } = input;
  diagnosticRoot = root;
  progress('verify-cluster');
  const bin = join(resources, 'postgres', 'bin');
  const data = join(root, 'pgdata');
  const marker = join(root, 'cluster-owner.json');
  await mkdir(root, { recursive: true });
  const command = (name: string, args: string[], env?: NodeJS.ProcessEnv) =>
    new Promise<void>((resolve, reject) => {
      // pg_ctl starts a grandchild on Windows. Pipes inherited by postgres prevent
      // execFile's close event from completing even after pg_ctl has exited.
      const child = spawn(join(bin, name + '.exe'), args, {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, ...env },
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Database command timed out'));
      }, 120_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error('Database command failed'));
      });
    });
  if (!(await exists(marker))) {
    if (await exists(data)) throw new Error('Unowned cluster; refusing adoption');
    await writeFile(
      marker,
      JSON.stringify({ installationId: settings.installationId, port: await freePort() }),
      { flag: 'wx' },
    );
  }
  const owner = JSON.parse(await readFile(marker, 'utf8')) as {
    installationId: string;
    port: number;
  };
  if (
    owner.installationId !== settings.installationId ||
    !Number.isInteger(owner.port) ||
    owner.port < 1024 ||
    owner.port > 65535
  )
    throw new Error('Private cluster ownership mismatch');
  if (!(await exists(data))) {
    progress('initialize-cluster');
    const staging = join(root, 'pgdata.initializing');
    // Never delete a partial cluster automatically. An interrupted init is reported for explicit recovery.
    if (await exists(staging))
      throw new Error('Interrupted database initialization; preserve files and request recovery');
    // initdb requires a filename. A private, unpredictable Windows named pipe
    // supplies it without leaving a plaintext password file after a power loss.
    const passwordPipe = '\\\\.\\pipe\\hexpayroll-init-' + randomUUID();
    const passwordServer = createServer((socket) => {
      socket.on('error', () => undefined);
      socket.end(settings.administratorPassword + '\n');
    });
    await new Promise<void>((resolve, reject) => {
      passwordServer.once('error', reject);
      passwordServer.listen(passwordPipe, resolve);
    });
    try {
      await command('initdb', [
        '-D',
        staging,
        '-U',
        'hexpayroll_owner',
        '--pwfile=' + passwordPipe,
        '--auth-host=scram-sha-256',
        '--auth-local=scram-sha-256',
        '--encoding=UTF8',
        '--locale=C',
      ]);
    } finally {
      passwordServer.close();
    }
    await writeFile(
      join(staging, 'postgresql.conf'),
      [
        "listen_addresses = '127.0.0.1'",
        `port = ${owner.port}`,
        "password_encryption = 'scram-sha-256'",
        "unix_socket_directories = ''",
        'logging_collector = on',
        "log_filename = 'postgres-%a.log'",
        "log_rotation_age = '1d'",
        "log_rotation_size = '10MB'",
        'log_truncate_on_rotation = on',
        'log_statement = none',
        'log_min_error_statement = panic',
        'fsync = on',
        'full_page_writes = on',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(staging, 'pg_hba.conf'),
      'host all all 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n',
    );
    await rename(staging, data);
  }
  if ((await readFile(join(data, 'PG_VERSION'), 'utf8')).trim() !== '18')
    throw new Error('Unsupported cluster major version');
  // pg_ctl only ever receives our owned absolute data directory. No service registration or global tools.
  stopDatabase = async () => {
    await command('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']);
  };
  const status = await command('pg_ctl', ['-D', data, 'status']).then(
    () => true,
    () => false,
  );
  progress('start-postgres');
  if (!status)
    await command('pg_ctl', [
      '-D',
      data,
      '-l',
      join(root, 'postgres.log'),
      '-w',
      '-t',
      '60',
      'start',
    ]);
  const connection = (user: string, password: string, database = 'hexpayroll') => ({
    host: '127.0.0.1',
    port: owner.port,
    user,
    password,
    database,
    connectionTimeoutMillis: 5000,
    max: 2,
  });
  const administrator = new pg.Pool(
    connection('hexpayroll_owner', settings.administratorPassword, 'postgres'),
  );
  progress('provision-roles');
  try {
    const identity = await administrator.query('SHOW data_directory');
    if (
      String(identity.rows[0].data_directory).replaceAll('\\', '/').toLowerCase() !==
      data.replaceAll('\\', '/').toLowerCase()
    )
      throw new Error('Database directory identity mismatch');
    for (const [role, password] of [
      ['hexpayroll_migrator', settings.migratorPassword],
      ['hexpayroll_app', settings.applicationPassword],
    ]) {
      if (!(await administrator.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount)
        await administrator.query(
          `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(password!)}`,
        );
    }
    if (
      !(await administrator.query("SELECT 1 FROM pg_database WHERE datname='hexpayroll'")).rowCount
    )
      await administrator.query('CREATE DATABASE hexpayroll OWNER hexpayroll_migrator');
    await administrator.query('REVOKE ALL ON DATABASE hexpayroll FROM PUBLIC');
    await administrator.query('GRANT CONNECT ON DATABASE hexpayroll TO hexpayroll_app');
    await administrator.query('REVOKE CONNECT ON DATABASE postgres,template1 FROM PUBLIC');
  } finally {
    await administrator.end();
  }
  const migrator = new pg.Pool(connection('hexpayroll_migrator', settings.migratorPassword));
  progress('migrate');
  try {
    await migrator.query(
      'REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO hexpayroll_app',
    );
    // Set defaults before migrations; never blanket regrant existing tables and undo history guards.
    await migrator.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO hexpayroll_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO hexpayroll_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO hexpayroll_app`);
    const migrations = await readMigrations(join(resources, 'migrations'));
    const ledger = await migrator.query("SELECT to_regclass('public.schema_migrations') AS ledger");
    const applied = ledger.rows[0].ledger
      ? (await migrator.query('SELECT name,checksum FROM schema_migrations')).rows
      : [];
    // Fail before backup/DDL if this is a downgrade or modified history.
    if (
      applied.some(
        (row) => !migrations.some((m) => m.name === row.name && m.checksum === row.checksum),
      )
    )
      throw new Error('Installed version is incompatible with existing migration history');
    if (applied.length && applied.length < migrations.length) {
      const backup = join(root, 'backups');
      await mkdir(backup, { recursive: true });
      const temporary = join(backup, `pre-upgrade-${Date.now()}.dump.partial`);
      await command(
        'pg_dump',
        [
          '-h',
          '127.0.0.1',
          '-p',
          String(owner.port),
          '-U',
          'hexpayroll_owner',
          '-d',
          'hexpayroll',
          '-Fc',
          '-f',
          temporary,
        ],
        { PGPASSWORD: settings.administratorPassword },
      );
      await rename(temporary, temporary.replace(/\.partial$/, ''));
    }
    await migrate(migrator, migrations);
    await migrator.query('REVOKE ALL ON schema_migrations FROM hexpayroll_app');
  } finally {
    await migrator.end();
  }
  const url = new URL('postgresql://127.0.0.1:' + owner.port + '/hexpayroll');
  url.username = 'hexpayroll_app';
  url.password = settings.applicationPassword;
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DATABASE_URL: url.href,
    API_HOST: '127.0.0.1',
    API_PORT: '0',
    HEX_PRIVATE_API_TOKEN: input.token,
    HEX_RENDERER_ORIGIN: input.origin,
    SYNC_MODE: settings.sync ? 'local' : 'disabled',
    SYNC_BIOMETRIC_EVIDENCE_ENABLED: 'false',
    ATTENDANCE_FINALIZATION_ENABLED: 'false',
    SYNC_TRUSTED_EVIDENCE_ENABLED: 'false',
  });
  if (settings.sync)
    Object.assign(process.env, {
      SYNC_CENTRAL_URL: settings.sync.url,
      SYNC_NODE_ID: settings.sync.nodeId,
      SYNC_NODE_TOKEN: settings.sync.token,
    });
  const { startServer } = await import('../server.js');
  progress('start-api');
  const api = await startServer({
    devices: {
      list: () => settings.deviceConnections ?? [],
      save: async (connection) => {
        if (deviceSettingsSaved) throw new Error('Another configuration write is pending');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            deviceSettingsSaved = undefined;
            reject(new Error('Device storage timed out'));
          }, 10_000);
          deviceSettingsSaved = () => {
            clearTimeout(timer);
            deviceSettingsSaved = undefined;
            resolve();
          };
          parent.postMessage({ type: 'save-device-connection', connection });
        });
        settings.deviceConnections = [
          ...(settings.deviceConnections ?? []).filter(
            (item) => item.deviceId !== connection.deviceId,
          ),
          connection,
        ];
      },
    },
    enroll: async (enrollment) => {
      if (enrolling) throw new Error('Another credential write is pending');
      enrolling = true;
      try {
        if (
          settings.sync &&
          (settings.sync.nodeId !== enrollment.nodeId || settings.sync.token !== enrollment.token)
        )
          throw new Error('Already enrolled');
        const database = new pg.Pool(connection('hexpayroll_app', settings.applicationPassword));
        try {
          await recordDesktopEnrollment(database, enrollment);
        } finally {
          await database.end();
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            credentialsSaved = undefined;
            reject(new Error('Credential storage timed out'));
          }, 10_000);
          credentialsSaved = () => {
            clearTimeout(timer);
            credentialsSaved = undefined;
            resolve();
          };
          parent.postMessage({ type: 'save-enrollment', enrollment });
        });
        settings.sync = enrollment;
      } finally {
        enrolling = false;
      }
    },
  });
  stopApi = api.stop;
  const address = api.server.address();
  if (!address || typeof address === 'string') throw new Error('API failed to bind');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`, {
    headers: { 'X-Hex-Private-Token': input.token },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('API health check failed');
  parent.postMessage({ type: 'ready', url: `http://127.0.0.1:${address.port}` });
  progress('ready');
}
let started = false;
parent.on('message', ({ data }) => {
  const message = data as { type: string; input: Start };
  if (message.type === 'heartbeat') {
    lastHeartbeat = Date.now();
    return;
  }
  if (message.type === 'credentials-saved') {
    credentialsSaved?.();
    return;
  }
  if (message.type === 'device-settings-saved') {
    deviceSettingsSaved?.();
    return;
  }
  if (message.type === 'stop') {
    void shutdown(0);
    return;
  }
  if (message.type !== 'start' || started) return;
  started = true;
  void start(message.input).catch((error: unknown) => {
    // PostgreSQL/driver exceptions may contain credentials, SQL or payroll data.
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'STARTUP';
    const safeCode = /^[A-Z0-9_]{1,24}$/.test(code) ? code : 'STARTUP';
    parent.postMessage({
      type: 'failed',
      message: `Local startup failed at ${phase} (${safeCode}). Preserve the data folder and consult startup diagnostics.`,
    });
    void shutdown(1);
  });
});
