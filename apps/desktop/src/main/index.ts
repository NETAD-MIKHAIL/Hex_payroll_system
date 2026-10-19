import { app, BrowserWindow, shell, protocol, dialog } from 'electron';
import { APPLICATION_ORIGIN, dataRoot, DesktopRuntime, desktopLog } from './runtime';
import { get } from 'node:http';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Desktop shell; packaged service orchestration lives in runtime.ts. */

/** Where apps/web's dev server listens (see apps/web/vite.config.ts). */
const DEV_WEB_URL = process.env.HEX_WEB_DEV_URL ?? 'http://127.0.0.1:5273';

/** Reads a non-negative integer from the environment, falling back when unset or junk. */
function readNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * How long the shell waits for apps/web's dev server before giving up.
 *
 * Deliberately generous: this happens once per `pnpm dev`, and a cold Vite start on a
 * slow disk is seconds, not minutes. `HEX_WEB_WAIT_TIMEOUT_MS` overrides it, and `0`
 * means "do not gate the window at all" — the pre-wait behaviour of loading first and
 * letting the late-load retry below sort it out.
 */
const DEV_WAIT_TIMEOUT_MS = readNonNegativeInt(process.env.HEX_WEB_WAIT_TIMEOUT_MS, 60_000);
const DEV_WAIT_INTERVAL_MS = 250;
const DEV_WAIT_REQUEST_TIMEOUT_MS = 1_000;

/** How often the wait says it is still waiting, so a slow start does not look like a hang. */
const DEV_WAIT_HEARTBEAT_MS = 5_000;

/** The late-load retry: now a fallback for a dev server that died and came back. */
const DEV_SERVER_MAX_ATTEMPTS = 20;
const DEV_SERVER_RETRY_MS = 500;

let mainWindow: BrowserWindow | null = null;
let runtime: DesktopRuntime | undefined;
let quitting = false;
let startupError = false;
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hexpayroll',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
let dataDirectoryError = false;
if (app.isPackaged) {
  try {
    mkdirSync(dataRoot, { recursive: true });
    app.setPath('userData', dataRoot);
  } catch {
    dataDirectoryError = true;
  }
}
const stages: Record<string, string> = {
  INITIALIZING: 'Preparing your payroll workspace...',
  STARTING_DATABASE: 'Starting local database...',
  RUNNING_MIGRATIONS: 'Preparing database schema...',
  STARTING_API: 'Preparing payroll services...',
  CHECKING_SERVICES: 'Checking local services...',
  READY: 'Ready. Synchronization runs when available.',
};
function progress(state: string) {
  const message = stages[state] ?? 'Preparing payroll services...';
  if (mainWindow && !mainWindow.isDestroyed())
    void mainWindow.webContents
      .executeJavaScript(
        `document.getElementById('progress')?.replaceChildren(${JSON.stringify(message)})`,
      )
      .catch(() => {});
}
async function failure(code: string) {
  if (startupError || quitting || runtime?.isStopping) return;
  startupError = true;
  const reference = /^[A-Z_]+$/.test(code) ? code : 'STARTUP_FAILED';
  await desktopLog('STARTUP_ERROR', reference);
  mainWindow?.hide();
  await runtime?.stop();
  const result = await dialog.showMessageBox({
    type: 'error',
    title: 'Hex Payroll could not start',
    message: 'A required local service is unavailable.',
    detail:
      'Reference: ' +
      reference +
      '. Your payroll database has been preserved. Check disk space and folder permissions. For missing application files, reinstall the same version. For database or migration failures, preserve the data folder and contact your administrator. Logs: ' +
      join(dataRoot, 'logs'),
    buttons: ['Close', 'Open logs', 'Retry'],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response === 1) await shell.openPath(join(dataRoot, 'logs'));
  if (result.response === 2) app.relaunch();
  app.quit();
}

/**
 * One readiness probe.
 *
 * Resolves with `null` once something answers, or a short reason — the socket error
 * code — when nothing does. Carrying the reason matters: `ECONNREFUSED` means nothing
 * is listening on that port, while `ETIMEDOUT` means something is listening and stuck,
 * and those two point at completely different fixes.
 *
 * Any answer counts, 404 included: the question is whether something is serving HTTP
 * on that address, not whether the route exists. A refused connection fails
 * immediately, so polling is cheap; `timeout` only bounds a hung socket.
 */
function probeDevServer(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const request = get(url, { timeout: DEV_WAIT_REQUEST_TIMEOUT_MS }, (response) => {
      response.resume(); // Drain the body; only "the server answered" matters.
      resolve(null);
    });

    request.on('timeout', () => request.destroy());
    request.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}

/**
 * Blocks until apps/web's dev server answers.
 *
 * `pnpm dev` starts Vite, the API and this shell at the same time, so the shell
 * routinely wins the race. Waiting here means no window exists until there is
 * something to render. Loading a refused URL instead paints Chromium's error page
 * behind `show: false` and then flashes it on `ready-to-show`.
 *
 * Development only: a packaged shell loads the built UI from disk.
 */
async function waitForDevServer(url: string): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + DEV_WAIT_TIMEOUT_MS;
  let announced = false;
  let lastHeartbeat = startedAt;
  let lastReason = 'no answer yet';

  while (Date.now() < deadline) {
    const reason = await probeDevServer(url);

    if (reason === null) {
      if (announced) {
        console.log(`[desktop] web dev server ready after ${Date.now() - startedAt} ms`);
      }
      return;
    }

    lastReason = reason;

    if (!announced) {
      console.log(`[desktop] waiting for the web dev server at ${url} ...`);
      announced = true;
    }

    if (Date.now() - lastHeartbeat >= DEV_WAIT_HEARTBEAT_MS) {
      const waitedSeconds = Math.round((Date.now() - startedAt) / 1_000);
      console.log(
        `[desktop] still waiting for ${url} (${waitedSeconds}s, last error: ${lastReason})`,
      );
      lastHeartbeat = Date.now();
    }

    await new Promise((resolve) => setTimeout(resolve, DEV_WAIT_INTERVAL_MS));
  }

  // The overwhelmingly likely cause is `pnpm dev` run from apps/desktop, where that
  // script starts this shell and nothing else. Saying so beats making a developer
  // guess at a port number.
  console.error(
    `[desktop] no web dev server answered at ${url} within ${DEV_WAIT_TIMEOUT_MS} ms ` +
      `(last error: ${lastReason}).\n` +
      '[desktop] Run `pnpm dev` from the repository root: it starts the API, the web dev\n' +
      '[desktop] server and this shell together. Inside apps/desktop, `pnpm dev` (and\n' +
      '[desktop] `pnpm dev:desktop` from the root) starts this shell alone.\n' +
      '[desktop] See docs/troubleshooting.md.',
  );

  throw new Error(`no web dev server answered at ${url} (${lastReason})`);
}

/**
 * Loads the UI, tolerating the fact that in development the Vite dev server may
 * not have finished starting. Without this, launching the desktop a moment too
 * early shows a blank window instead of waiting for the UI.
 *
 * `waitForDevServer()` above makes this the fallback rather than the mechanism:
 * it matters when the dev server dies and comes back while the window is open.
 */
async function loadDevServer(window: BrowserWindow, attempt = 1): Promise<void> {
  try {
    await window.loadURL(DEV_WEB_URL);
  } catch (error) {
    if (attempt >= DEV_SERVER_MAX_ATTEMPTS) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_RETRY_MS));
    await loadDevServer(window, attempt + 1);
  }
}

async function loadUi(window: BrowserWindow): Promise<void> {
  if (app.isPackaged) {
    // The fixed application origin serves static resources and proxies authenticated API requests.
    await window.loadURL(
      APPLICATION_ORIGIN +
        '/index.html' +
        (process.argv.includes('--admin') ? '?maintenance=1#/desktop-admin' : ''),
    );
    return;
  }

  await loadDevServer(window);
  console.log(`[desktop] UI loaded from ${DEV_WEB_URL}`);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'Hex Payroll',
    backgroundColor: '#020617',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Show only once the first paint is ready — avoids a white flash on launch.
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.on('query-session-end', () => {
    void runtime?.stop();
  });

  // Never let the renderer spawn arbitrary Electron windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === 'https:') void shell.openExternal(url);
    } catch {
      /* Reject malformed links. */
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = app.isPackaged
      ? url.startsWith(APPLICATION_ORIGIN + '/')
      : new URL(url).origin === new URL(DEV_WEB_URL).origin;
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  if (app.isPackaged && !runtime) {
    const html =
      '<!doctype html><html><meta charset="utf-8"><title>Hex Payroll</title><body style="background:#020617;color:#e2e8f0;font:18px system-ui;display:grid;place-content:center;height:90vh"><h1>HEX PAYROLL</h1><p id="progress">Preparing your payroll workspace...</p><p style="font-size:13px;color:#94a3b8">Local payroll remains available offline.</p></body></html>';
    await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    mainWindow.show();
    runtime = new DesktopRuntime(progress, (code) => {
      void failure(code);
    });
    try {
      await runtime.start();
      await loadUi(mainWindow);
    } catch (error) {
      await failure(error instanceof Error ? error.message : 'STARTUP_FAILED');
    }
  } else {
    await loadUi(mainWindow);
  }
}

/*
 * Single-instance guard.
 *
 * Mandatory, and not merely for tidiness: once the shell owns a private
 * PostgreSQL data directory, two concurrent instances against one pgdata will
 * corrupt it. Establishing the guard now means that safety property exists
 * before the thing it protects.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId('ph.hexpayroll.desktop');
      if (dataDirectoryError) {
        dialog.showErrorBox(
          'Hex Payroll storage unavailable',
          'The application data folder cannot be created or opened: ' +
            dataRoot +
            '. Check folder permissions and available disk space, then reopen Hex Payroll. Existing payroll data has not been reset.',
        );
        app.quit();
        return;
      }

      // Development only: a packaged shell loads the built UI from disk, so there is
      // nothing to wait for. `HEX_WEB_WAIT_TIMEOUT_MS=0` opts out of the gate. A timeout
      // rejects into the catch below and quits, which is far more legible than an open
      // window with nothing in it.
      if (!app.isPackaged && DEV_WAIT_TIMEOUT_MS > 0) {
        await waitForDevServer(DEV_WEB_URL);
      }

      await createWindow();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          void createWindow();
        }
      });
    })
    .catch((error: unknown) => {
      console.error('[desktop] failed to start:', error);
      // Non-zero on purpose: `pnpm dev` runs concurrently with `--success first`, so the
      // first process to exit decides the result. A shell that could not start must not
      // look like a clean shutdown just because it quit deliberately.
      app.exit(1);
    });

  app.on('before-quit', (event) => {
    if (!runtime || quitting) return;
    event.preventDefault();
    void runtime.stop().finally(() => {
      quitting = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
