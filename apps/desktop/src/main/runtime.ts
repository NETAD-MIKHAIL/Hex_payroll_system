import { app, protocol, net, safeStorage, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, appendFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import type {
  DesktopConfiguration,
  DesktopMessage,
  DesktopSyncConfiguration,
  ServiceMessage,
} from '../../../api/src/desktop/protocol';

export const APPLICATION_ORIGIN = 'hexpayroll://app';
export const dataRoot = join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'Hex Payroll');
export interface Runtime {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export async function desktopLog(event: string, code?: string) {
  try {
    const path = join(dataRoot, 'logs', 'desktop.jsonl');
    await mkdir(join(dataRoot, 'logs'), { recursive: true });
    if (
      await stat(path).then(
        (s) => s.size > 5 * 1024 * 1024,
        () => false,
      )
    ) {
      await rename(path, path + '.previous').catch(() => {});
    }
    await appendFile(
      path,
      JSON.stringify({ time: new Date().toISOString(), event, ...(code ? { code } : {}) }) + '\n',
    );
  } catch {
    /* A disk or ACL error must not suppress the startup recovery dialog. */
  }
}
async function privateDirectories() {
  await mkdir(dataRoot, { recursive: true });
  // Grant only this Windows user and SYSTEM; mode bits alone do not protect Windows files.
  const sid = await new Promise<string>((resolveSid, reject) => {
    const child = spawn('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      const match = output.match(/S-1-[0-9-]+/);
      if (code || !match) reject(new Error('DATA_PERMISSIONS_FAILED'));
      else resolveSid(match[0]);
    });
  });
  await new Promise<void>((resolveAcl, reject) => {
    const child = spawn(
      'icacls.exe',
      [dataRoot, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
      { windowsHide: true, stdio: 'ignore' },
    );
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolveAcl() : reject(new Error('DATA_PERMISSIONS_FAILED')),
    );
  });
  for (const directory of ['configuration', 'logs', 'sync', 'backups'])
    await mkdir(join(dataRoot, directory), { recursive: true });
}
async function loadSecrets(): Promise<DesktopConfiguration['secrets']> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
  const path = join(dataRoot, 'configuration', 'credentials.bin');
  try {
    const secrets = JSON.parse(
      safeStorage.decryptString(await readFile(path)),
    ) as DesktopConfiguration['secrets'];
    if (
      !['bootstrap', 'migrator', 'application'].every((key) =>
        /^[a-f0-9]{64}$/.test(secrets[key as keyof typeof secrets]),
      )
    )
      throw new Error('Invalid credentials');
    return secrets;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('CREDENTIALS_UNAVAILABLE', { cause: error });
    // Missing credentials for an existing cluster is a recovery event, never a reason to replace them.
    if (
      await stat(join(dataRoot, 'database')).then(
        () => true,
        () => false,
      )
    )
      throw new Error('CREDENTIALS_UNAVAILABLE', { cause: error });
    const secrets = {
      bootstrap: randomBytes(32).toString('hex'),
      migrator: randomBytes(32).toString('hex'),
      application: randomBytes(32).toString('hex'),
    };
    await writeFile(path, safeStorage.encryptString(JSON.stringify(secrets)), {
      flag: 'wx',
      mode: 0o600,
    });
    return secrets;
  }
}
export async function readSyncConfiguration(): Promise<DesktopSyncConfiguration> {
  try {
    const config = JSON.parse(
      await readFile(join(dataRoot, 'configuration', 'sync.json'), 'utf8'),
    ) as DesktopSyncConfiguration;
    if (!['local', 'disabled'].includes(config.mode)) throw new Error('Invalid sync mode');
    if (config.url) {
      const url = new URL(config.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw new Error('Invalid central URL');
    }
    if (
      config.nodeId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.nodeId)
    )
      throw new Error('Invalid node');
    if (config.mode === 'local' && (!config.url || !config.nodeId))
      throw new Error('Incomplete sync');
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'disabled' };
    throw new Error('SYNC_CONFIGURATION_INVALID', { cause: error });
  }
}
export class DesktopRuntime implements Runtime {
  get isStopping(): boolean {
    return this.stopping;
  }
  private database?: UtilityProcess;
  private api?: UtilityProcess;
  private address?: string;
  private stopping = false;
  private healthTimer?: ReturnType<typeof setInterval>;
  private shutdownPromise?: Promise<void>;
  private readonly token = randomBytes(32).toString('base64url');
  constructor(
    private readonly progress: (state: string) => void,
    private readonly failed: (code: string) => void,
  ) {}
  private launch(entry: string): UtilityProcess {
    const child = utilityProcess.fork(
      join(process.resourcesPath, 'api', 'dist', 'desktop', entry + '.js'),
      [],
      {
        cwd: join(dataRoot, 'configuration'),
        serviceName: `Hex Payroll ${entry}`,
        env: {
          SystemRoot: process.env.SystemRoot,
          PATH: process.env.SystemRoot + '\\System32',
          TEMP: process.env.TEMP,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
          APPDATA: process.env.APPDATA,
          USERPROFILE: process.env.USERPROFILE,
        },
        stdio: 'pipe',
      },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      // Store only known event labels, never raw process output or request URLs.
      for (const line of chunk.toString().split('\n')) {
        try {
          const value = JSON.parse(line) as { msg?: string };
          if (value.msg === 'request handled') continue;
          if (value.msg) void desktopLog(entry + '-event');
        } catch {
          /* Non-JSON diagnostics are deliberately suppressed. */
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const code = /\bERR_[A-Z_]+\b/.exec(chunk.toString())?.[0];
      void desktopLog(entry + '-diagnostic', code);
    });
    child.on('exit', (code) => {
      void desktopLog(entry + '-exit', String(code));
      if (!this.stopping) this.failed(entry.toUpperCase() + '_PROCESS_EXITED');
    });
    child.on('message', (message: ServiceMessage) => {
      if (message.type === 'progress') {
        this.progress(message.state);
        void desktopLog(message.state);
      }
      if (message.type === 'error' && !this.stopping) this.failed(message.code);
    });
    return child;
  }
  private request(
    child: UtilityProcess,
    message: DesktopMessage,
    expected: ServiceMessage['type'],
    timeout: number,
  ): Promise<ServiceMessage> {
    return new Promise((resolveMessage, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', listener);
        child.off('exit', exited);
      };
      const listener = (response: ServiceMessage) => {
        if (response.type === expected) {
          cleanup();
          resolveMessage(response);
        } else if (response.type === 'error') {
          cleanup();
          reject(new Error(response.code));
        }
      };
      const exited = () => {
        cleanup();
        reject(new Error('SERVICE_EXITED'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('SERVICE_TIMEOUT'));
      }, timeout);
      child.on('message', listener);
      child.once('exit', exited);
      child.postMessage(message);
    });
  }
  async start() {
    this.progress('INITIALIZING');
    await privateDirectories();
    await desktopLog('INITIALIZING');
    const secrets = await loadSecrets();
    const maintenance = process.argv.includes('--admin');
    const sync = maintenance ? { mode: 'disabled' as const } : await readSyncConfiguration();
    if (this.stopping) throw new Error('STARTUP_CANCELLED');
    this.progress('STARTING_DATABASE');
    this.database = this.launch('database');
    const result = await this.request(
      this.database,
      {
        type: 'initialize',
        configuration: {
          root: dataRoot,
          postgres: join(process.resourcesPath, 'postgres'),
          migrations: join(process.resourcesPath, 'migrations'),
          secrets,
        },
      },
      'database-ready',
      480000,
    );
    if (result.type !== 'database-ready' || this.stopping) throw new Error('STARTUP_CANCELLED');
    this.progress('STARTING_API');
    this.api = this.launch('api');
    const ready = await this.request(
      this.api,
      { type: 'api', databaseUrl: result.databaseUrl, token: this.token, sync, maintenance },
      'api-ready',
      75000,
    );
    if (ready.type !== 'api-ready' || this.stopping) throw new Error('STARTUP_CANCELLED');
    this.address = `http://127.0.0.1:${ready.port}`;
    this.progress('CHECKING_SERVICES');
    const health = await net.fetch(this.address + '/api/health', {
      headers: { 'x-hex-desktop': this.token },
      signal: AbortSignal.timeout(5000),
    });
    if (!health.ok || ((await health.json()) as { status?: string }).status !== 'ok')
      throw new Error('API_HEALTH_FAILED');
    protocol.handle('hexpayroll', (request) => this.handle(request));
    this.healthTimer = setInterval(() => {
      if (!this.address || this.stopping) return;
      void net
        .fetch(this.address + '/api/health', {
          headers: { 'x-hex-desktop': this.token },
          signal: AbortSignal.timeout(5000),
        })
        .then((response) => {
          if (!response.ok) throw new Error();
        })
        .catch(() => {
          if (!this.stopping) this.failed('API_HEALTH_FAILED');
        });
    }, 15000);
    this.progress('READY');
    await desktopLog('READY');
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== 'app' || url.username || url.password || url.port)
      return new Response('Forbidden', { status: 403 });
    if (url.pathname.startsWith('/api/')) {
      if (!this.address || this.stopping)
        return new Response('Service unavailable', { status: 503 });
      const headers = new Headers();
      for (const key of ['authorization', 'content-type', 'accept']) {
        const value = request.headers.get(key);
        if (value) headers.set(key, value);
      }
      headers.set('x-hex-desktop', this.token);
      headers.set('origin', APPLICATION_ORIGIN);
      const response = await net.fetch(this.address + url.pathname + url.search, {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD'
          ? {}
          : { body: await request.arrayBuffer() }),
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      return new Response([204, 304].includes(response.status) ? null : response.body, {
        status: response.status,
        headers: {
          'content-type': response.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
        },
      });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const root = join(process.resourcesPath, 'web');
    const file = resolve(
      root,
      '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
    );
    if (
      !file.startsWith(root + '\\') ||
      !['.html', '.js', '.css', '.svg', '.png', '.ico', '.woff', '.woff2'].includes(extname(file))
    )
      return new Response('Not found', { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(response.headers);
      headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response(
        'Application resource missing. Reinstall Hex Payroll; your data will be preserved.',
        { status: 404 },
      );
    }
  }
  stop(): Promise<void> {
    this.shutdownPromise ??= this.shutdown();
    return this.shutdownPromise;
  }
  private async shutdown() {
    this.stopping = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.address = undefined;
    await desktopLog('SHUTTING_DOWN');
    for (const child of [this.api, this.database]) {
      if (!child?.pid) continue;
      try {
        await this.request(
          child,
          { type: 'shutdown' },
          'stopped',
          child === this.api ? 25000 : 360000,
        );
      } catch {
        child.kill();
        await desktopLog('SHUTDOWN_INCOMPLETE');
      }
    }
  }
}
