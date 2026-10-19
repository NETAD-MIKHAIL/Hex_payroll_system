import pg from 'pg';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, unlink, stat, readdir, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { parentPort } from './protocol.js';
import type { DesktopConfiguration } from './protocol.js';
import { migrate, readMigrations } from '../db/migrate.js';

export function connectionUrl(
  port: number,
  role: string,
  password: string,
  database = 'hexpayroll',
): string {
  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = role;
  url.password = password;
  return url.toString();
}
export async function command(
  executable: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  timeout = 60000,
): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.SystemRoot + '\\System32',
        TEMP: process.env.TEMP,
        ...extraEnv,
      },
      // pg_ctl's server descendants must not inherit pipes that keep Node waiting for EOF.
      stdio:
        /pg_ctl\.exe$/i.test(executable) && args[0] !== '--version'
          ? 'ignore'
          : ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('COMMAND_TIMEOUT'));
    }, timeout);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < 65536) output += chunk.toString();
    });
    child.stderr?.resume(); // Raw PostgreSQL errors can contain connection details.
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('BINARY_UNAVAILABLE'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveCommand(output);
      else reject(Object.assign(new Error('DATABASE_COMMAND_FAILED'), { exitCode: code }));
    });
  });
}
async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
async function atomic(path: string, value: unknown) {
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('PORT_UNAVAILABLE'));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}
export class PrivateDatabase {
  private port = 0;
  private identity?: string;
  private owned = false;
  private monitor?: ReturnType<typeof setInterval>;
  constructor(private readonly configuration: DesktopConfiguration) {}
  private get data() {
    return join(this.configuration.root, 'database');
  }
  private binary(name: string) {
    return join(this.configuration.postgres, 'bin', name + '.exe');
  }
  private pool(role = 'hexpayroll_bootstrap', database = 'postgres') {
    const key =
      role === 'hexpayroll_app'
        ? 'application'
        : role === 'hexpayroll_migrator'
          ? 'migrator'
          : 'bootstrap';
    const pool = new pg.Pool({
      connectionString: connectionUrl(this.port, role, this.configuration.secrets[key], database),
      connectionTimeoutMillis: 3000,
      query_timeout: 10000,
      max: 1,
    });
    pool.on('error', () => {
      /* Query/readiness checks report sanitized failures. */
    });
    return pool;
  }
  private async verify(): Promise<string> {
    const pool = this.pool();
    try {
      const result = await pool.query(
        "SELECT current_setting('data_directory') AS directory,system_identifier::text AS identity FROM pg_control_system()",
      );
      const row = result.rows[0];
      if (
        resolve(row.directory).toLowerCase() !== resolve(this.data).toLowerCase() ||
        (this.identity && row.identity !== this.identity)
      )
        throw new Error('CLUSTER_IDENTITY_MISMATCH');
      return row.identity as string;
    } finally {
      await pool.end();
    }
  }
  private async waitForIdentity(): Promise<string> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        return await this.verify();
      } catch (error) {
        if (error instanceof Error && error.message === 'CLUSTER_IDENTITY_MISMATCH') throw error;
        await new Promise((resolveRetry) => setTimeout(resolveRetry, 100));
      }
    }
    throw new Error('DATABASE_READINESS_FAILED');
  }
  async start(): Promise<string> {
    const c = this.configuration;
    for (const name of ['postgres', 'pg_ctl', 'initdb', 'pg_dump', 'pg_restore']) {
      const version = await command(this.binary(name), ['--version']);
      if (!/\b18\./.test(version)) throw new Error('POSTGRES_VERSION_INCOMPATIBLE');
    }
    const marker = join(this.data, 'PG_VERSION');
    const fresh = !(await exists(marker));
    if (fresh) {
      if ((await exists(this.data)) && (await readdir(this.data)).length)
        throw new Error('UNRECOGNIZED_CLUSTER');
      const disk = await statfs(c.root);
      if (disk.bavail * disk.bsize < 512 * 1024 * 1024) throw new Error('INSUFFICIENT_DISK_SPACE');
      const staging = join(c.root, 'database-initializing');
      if (await exists(staging)) throw new Error('INITIALIZATION_INTERRUPTED');
      const passwordFile = join(c.root, 'configuration', 'initdb-password');
      await writeFile(passwordFile, c.secrets.bootstrap, { mode: 0o600, flag: 'wx' });
      try {
        await command(
          this.binary('initdb'),
          [
            '-D',
            staging,
            '-U',
            'hexpayroll_bootstrap',
            '--pwfile',
            passwordFile,
            '--auth-host=scram-sha-256',
            '--auth-local=scram-sha-256',
            '--encoding=UTF8',
            '--locale=C',
          ],
          {},
          120000,
        );
      } finally {
        await unlink(passwordFile).catch(() => {});
      }
      // An empty existing directory is harmless, but rename must not replace it.
      if (await exists(this.data)) throw new Error('EMPTY_CLUSTER_DIRECTORY_REQUIRES_REVIEW');
      await rename(staging, this.data);
    } else if ((await readFile(marker, 'utf8')).trim() !== '18')
      throw new Error('CLUSTER_VERSION_INCOMPATIBLE');
    const identityPath = join(c.root, 'configuration', 'cluster.json');
    if (await exists(identityPath)) {
      const saved = JSON.parse(await readFile(identityPath, 'utf8')) as {
        port: number;
        identity: string;
      };
      if (
        !Number.isInteger(saved.port) ||
        saved.port < 1 ||
        saved.port > 65535 ||
        !/^\d+$/.test(saved.identity)
      )
        throw new Error('CLUSTER_CONFIGURATION_INVALID');
      this.port = saved.port;
      this.identity = saved.identity;
    }
    const pidPath = join(this.data, 'postmaster.pid');
    if (await exists(pidPath)) {
      const lines = (await readFile(pidPath, 'utf8')).split(/\r?\n/);
      const pidPort = Number(lines[3]);
      if (!Number.isInteger(pidPort) || pidPort < 1 || pidPort > 65535)
        throw new Error('CLUSTER_LOCK_REQUIRES_REVIEW');
      this.port = pidPort;
      // Never remove a lock file or stop a process that we cannot authenticate.
      try {
        this.identity = await this.verify();
        this.owned = true;
      } catch {
        // pg_ctl performs the supported stale-lock checks; never unlink postmaster.pid ourselves.
        let stopped = false;
        try {
          await command(this.binary('pg_ctl'), ['status', '-D', this.data]);
        } catch (error) {
          stopped = (error as { exitCode?: number }).exitCode === 3;
        }
        if (!stopped) throw new Error('CLUSTER_LOCK_REQUIRES_REVIEW');
      }
    }
    if (!this.owned) {
      await writeFile(
        join(this.data, 'postgresql.auto.conf'),
        "listen_addresses='127.0.0.1'\npassword_encryption='scram-sha-256'\nlog_statement='none'\nlog_min_messages='panic'\nlog_error_verbosity='terse'\nlog_min_error_statement='panic'\nlog_parameter_max_length_on_error=0\nlogging_collector=on\nlog_directory='../logs'\nlog_filename='postgres-%a.log'\nlog_rotation_age='1d'\nlog_rotation_size='5MB'\nlog_truncate_on_rotation=on\n",
      );
      let started = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        this.port = await freePort();
        await writeFile(
          join(this.data, 'pg_hba.conf'),
          'host all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 reject\n',
        );
        try {
          await command(
            this.binary('pg_ctl'),
            [
              'start',
              '-D',
              this.data,
              '-l',
              join(c.root, 'logs', 'postgres.log'),
              '-w',
              '-t',
              '30',
              '-o',
              `-h 127.0.0.1 -p ${this.port}`,
            ],
            {},
            40000,
          );
          this.identity = await this.waitForIdentity();
          this.owned = true;
          started = true;
          break;
        } catch {
          if (await exists(pidPath)) {
            // On Windows pg_ctl may report failure while recovering a stale lock even
            // though the owned server has started. Adopt only after authenticated identity checks.
            try {
              this.identity = await this.waitForIdentity();
              this.owned = true;
              started = true;
              break;
            } catch {
              throw new Error('DATABASE_START_REQUIRES_REVIEW');
            }
          }
        }
      }
      if (!started) throw new Error('DATABASE_START_FAILED');
    }
    await atomic(identityPath, { port: this.port, identity: this.identity });
    parentPort?.postMessage({ type: 'progress', state: 'RUNNING_MIGRATIONS' });
    try {
      await this.provisionAndMigrate();
    } catch (error) {
      throw new Error(
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'MIGRATION_FAILED',
        { cause: error },
      );
    }
    this.monitor = setInterval(() => {
      void this.verify().catch(() => {
        if (this.monitor) clearInterval(this.monitor);
        parentPort?.postMessage({ type: 'error', code: 'DATABASE_HEALTH_FAILED' });
      });
    }, 15000);
    return connectionUrl(this.port, 'hexpayroll_app', c.secrets.application);
  }
  private async provisionAndMigrate() {
    const c = this.configuration;
    const admin = this.pool();
    try {
      for (const [role, key] of [
        ['hexpayroll_migrator', 'migrator'],
        ['hexpayroll_app', 'application'],
      ] as const) {
        if (!/^[a-f0-9]{64}$/.test(c.secrets[key])) throw new Error('INVALID_CREDENTIAL');
        if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount)
          await admin.query(
            `CREATE ROLE ${role} LOGIN PASSWORD '${c.secrets[key]}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
          );
      }
      if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='hexpayroll'")).rowCount)
        await admin.query('CREATE DATABASE hexpayroll OWNER hexpayroll_migrator');
    } finally {
      await admin.end();
    }
    const migrator = this.pool('hexpayroll_migrator', 'hexpayroll');
    try {
      await migrator.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await migrator.query('GRANT USAGE ON SCHEMA public TO hexpayroll_app');
      await migrator.query(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO hexpayroll_app',
      );
      await migrator.query(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO hexpayroll_app',
      );
      const migrations = await readMigrations(c.migrations);
      if (!migrations.length) throw new Error('MIGRATIONS_MISSING');
      const table = await migrator.query("SELECT to_regclass('public.schema_migrations') AS name");
      const history = table.rows[0].name
        ? (await migrator.query('SELECT name,checksum FROM schema_migrations')).rows
        : [];
      if (
        history.some(
          (row) => !migrations.some((m) => m.name === row.name && m.checksum === row.checksum),
        )
      )
        throw new Error('MIGRATION_HISTORY_INCOMPATIBLE');
      if (history.length && migrations.some((m) => !history.some((row) => row.name === m.name))) {
        const backup = join(c.root, 'backups', `before-migration-${Date.now()}.dump`);
        await command(
          this.binary('pg_dump'),
          [
            '-h',
            '127.0.0.1',
            '-p',
            String(this.port),
            '-U',
            'hexpayroll_migrator',
            '-d',
            'hexpayroll',
            '-Fc',
            '-f',
            backup,
          ],
          { PGPASSWORD: c.secrets.migrator },
          300000,
        );
        await command(this.binary('pg_restore'), ['--list', backup]);
        if ((await stat(backup)).size < 100) throw new Error('BACKUP_INVALID');
      }
      await migrate(migrator, migrations);
      const runtime = this.pool('hexpayroll_app', 'hexpayroll');
      try {
        const check = await runtime.query(
          "SELECT has_schema_privilege(current_user,'public','CREATE') AS ddl,(SELECT count(*)::int FROM schema_migrations) AS count",
        );
        if (check.rows[0].ddl || check.rows[0].count !== migrations.length)
          throw new Error('SCHEMA_VERIFICATION_FAILED');
      } finally {
        await runtime.end();
      }
    } finally {
      await migrator.end();
    }
  }
  async stop() {
    if (this.monitor) clearInterval(this.monitor);
    if (!this.owned) return;
    await this.verify();
    await command(
      this.binary('pg_ctl'),
      ['stop', '-D', this.data, '-m', 'fast', '-w', '-t', '20'],
      {},
      25000,
    );
    this.owned = false;
  }
}

if (parentPort) {
  let database: PrivateDatabase | undefined;
  let startup: Promise<unknown> = Promise.resolve();
  let stopping = false;
  parentPort.on('message', ({ data }) => {
    if (data.type === 'initialize' && !database) {
      database = new PrivateDatabase(data.configuration);
      startup = database
        .start()
        .then((databaseUrl) => {
          if (!stopping) parentPort!.postMessage({ type: 'database-ready', databaseUrl });
        })
        .catch((error: unknown) =>
          parentPort!.postMessage({
            type: 'error',
            code:
              error instanceof Error && /^[A-Z_]+$/.test(error.message)
                ? error.message
                : 'DATABASE_INITIALIZATION_FAILED',
          }),
        );
    }
    if (data.type === 'shutdown' && database && !stopping) {
      stopping = true;
      void startup
        .then(() => database!.stop())
        .then(() => {
          parentPort!.postMessage({ type: 'stopped' });
          process.exit(0);
        })
        .catch(() => {
          parentPort!.postMessage({ type: 'error', code: 'DATABASE_SHUTDOWN_FAILED' });
          process.exit(1);
        });
    }
  });
}
