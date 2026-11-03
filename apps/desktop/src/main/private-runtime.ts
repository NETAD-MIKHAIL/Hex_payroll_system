import { utilityProcess, type UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  loadSettings,
  protectDirectory,
  saveSettings,
  type PrivateSettings,
} from './private-storage';

export async function startPrivateRuntime(
  root: string,
  resources: string,
  origin: string,
  token: string,
) {
  await protectDirectory(root);
  const settings = await loadSettings(root);
  // Explicit allowlist: no inherited .env, central passwords, PG settings or Node options.
  const env: NodeJS.ProcessEnv = { HEX_PRIVATE_API_TOKEN: token };
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PATH',
  ])
    if (process.env[key]) env[key] = process.env[key];
  const child: UtilityProcess = utilityProcess.fork(join(resources, 'api', 'runtime.cjs'), [], {
    cwd: root,
    env,
    stdio: 'pipe',
    serviceName: 'Hex Payroll local services',
  });
  let writes = Promise.resolve();
  child.on(
    'message',
    (message: {
      type: string;
      enrollment?: PrivateSettings['sync'];
      connection?: NonNullable<PrivateSettings['deviceConnections']>[number];
    }) => {
      if (!['save-enrollment', 'save-device-connection'].includes(message.type)) return;
      writes = writes
        .catch(() => undefined)
        .then(async () => {
          const next = { ...settings };
          if (message.type === 'save-enrollment' && message.enrollment)
            next.sync = message.enrollment;
          else if (message.type === 'save-device-connection' && message.connection)
            next.deviceConnections = [
              ...(settings.deviceConnections ?? []).filter(
                (item) => item.deviceId !== message.connection!.deviceId,
              ),
              message.connection,
            ];
          else return;
          await saveSettings(root, next);
          Object.assign(settings, next);
          child.postMessage({
            type:
              message.type === 'save-enrollment' ? 'credentials-saved' : 'device-settings-saved',
          });
        });
      void writes.catch(() => undefined); // No acknowledgment means API reports storage failure.
    },
  );
  // Never forward arbitrary SQL/driver output into renderer or a world-readable log.
  child.stdout?.resume();
  child.stderr?.resume();
  const heartbeat = setInterval(() => child.postMessage({ type: 'heartbeat' }), 3000);
  let expectedExit = false;
  let exited = false;
  let databaseCleanup: Promise<void> | undefined;
  const cleanupOwnedDatabase = () =>
    (databaseCleanup ??= (async () => {
      try {
        const marker = JSON.parse(await readFile(join(root, 'cluster-owner.json'), 'utf8')) as {
          installationId: string;
        };
        if (marker.installationId !== settings.installationId) return;
        if ((await readFile(join(root, 'pgdata', 'PG_VERSION'), 'utf8')).trim() !== '18') return;
        const runControl = (args: string[]) =>
          new Promise<number | null>((resolve) => {
            const control = spawn(
              join(resources, 'postgres', 'bin', 'pg_ctl.exe'),
              ['-D', join(root, 'pgdata'), ...args],
              { windowsHide: true, stdio: 'ignore', env },
            );
            const timer = setTimeout(() => {
              control.kill();
              resolve(null);
            }, 35_000);
            control.once('error', () => {
              clearTimeout(timer);
              resolve(null);
            });
            control.once('exit', (code) => {
              clearTimeout(timer);
              resolve(code);
            });
          });
        if ((await runControl(['status'])) === 0)
          await runControl(['-m', 'fast', '-w', '-t', '30', 'stop']);
      } catch {
        /* No adoption, service operations, or data deletion during recovery. */
      }
    })());
  child.once('exit', () => {
    exited = true;
    void cleanupOwnedDatabase();
  });
  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local startup timed out')), 240_000);
    child.once('exit', () => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      reject(new Error('Local services exited during startup'));
    });
    child.on('message', (message: { type: string; url?: string; message?: string }) => {
      if (message.type === 'ready' && message.url) {
        clearTimeout(timeout);
        resolve(message.url);
      }
      if (message.type === 'failed') {
        clearTimeout(timeout);
        reject(new Error(message.message ?? 'Local startup failed'));
      }
    });
  });
  child.once('spawn', () =>
    child.postMessage({ type: 'start', input: { root, resources, settings, token, origin } }),
  );
  const stop = async () => {
    if (expectedExit) return;
    expectedExit = true;
    clearInterval(heartbeat);
    if (exited) {
      await cleanupOwnedDatabase();
      return;
    }
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.postMessage({ type: 'stop' });
      // Child has its own bounded database cleanup. Do not terminate it before pg_ctl finishes.
      setTimeout(() => {
        child.kill();
        resolve();
      }, 70_000).unref();
    });
    await cleanupOwnedDatabase();
  };
  try {
    return { url: await ready, stop, child, expectedExit: () => expectedExit };
  } catch (error) {
    await stop();
    throw error;
  }
}

export const createPrivateToken = () => randomBytes(32).toString('base64url');
