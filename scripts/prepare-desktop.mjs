import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  readFile,
  writeFile,
  mkdir,
  cp,
  rm,
  readdir,
  realpath,
  stat,
  lstat,
  unlink,
  rename,
} from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stageMsvc } from './stage-msvc.mjs';
import { verifyPeDependencies } from './verify-pe-dependencies.mjs';
import { materializeRuntime } from './materialize-runtime.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(workspace, 'apps/desktop/build');
const stage = join(build, 'runtime');
const cache = join(build, 'cache');
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Stage on Windows x64.');
const manifest = JSON.parse(
  await readFile(join(workspace, 'apps/desktop/postgres-runtime.json'), 'utf8'),
);
await mkdir(cache, { recursive: true });
const archive = join(cache, 'postgresql-18.6-windows-x64.zip');
try {
  await stat(archive);
} catch {
  const response = await globalThis.fetch(manifest.source);
  if (!response.ok) throw new Error('PostgreSQL archive download failed');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const { createWriteStream } = await import('node:fs');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
}
const { createReadStream } = await import('node:fs');
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest('hex') !== manifest.sha256) throw new Error('PostgreSQL archive checksum mismatch');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (result.error || result.status !== 0) throw new Error('Desktop staging command failed');
}
// All deletion targets are fixed children of apps/desktop/build.
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const unpack = join(build, 'postgres-unpack');
await rm(unpack, { recursive: true, force: true });
run('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-File',
  join(workspace, 'scripts/extract-desktop-postgres.ps1'),
]);
const postgres = join(stage, 'postgres');
await mkdir(postgres);
for (const directory of ['bin', 'lib', 'share'])
  await cp(join(unpack, 'pgsql', directory), join(postgres, directory), {
    recursive: true,
    // Optional language packs are not used by Hex Payroll and require separate interpreters.
    filter: (source) => !/plperl|plpython|pltcl/i.test(basename(source)),
  });
for (const name of await readdir(join(unpack, 'pgsql')))
  if (/license|notice|copying/i.test(name))
    await cp(join(unpack, 'pgsql', name), join(postgres, name), { recursive: true });
await cp(
  join(workspace, 'apps/desktop/postgres-runtime.json'),
  join(postgres, 'runtime-manifest.json'),
);
await stageMsvc(workspace, stage, run);
await writeFile(
  join(postgres, 'dependency-manifest.json'),
  JSON.stringify(await verifyPeDependencies(postgres), null, 2),
);
for (const executable of ['postgres', 'initdb', 'pg_ctl', 'pg_dump', 'pg_restore', 'psql']) {
  const binary = join(postgres, 'bin', executable + '.exe');
  const pe = await readFile(binary);
  if (pe.readUInt32LE(0) !== 0x00905a4d && pe.subarray(0, 2).toString() !== 'MZ')
    throw new Error('Not a PE binary');
  const offset = pe.readUInt32LE(0x3c);
  if (pe.readUInt16LE(offset + 4) !== 0x8664) throw new Error('PostgreSQL binary is not x64');
  const result = spawnSync(binary, ['--version'], {
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.SystemRoot + '\\System32' },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout.includes(manifest.version))
    throw new Error('Staged PostgreSQL binary cannot execute');
}
if (!process.env.npm_execpath) throw new Error('Run with pnpm desktop:stage');
// pnpm 11 legacy deploy rewrites the workspace verification cache with deployment settings.
// Restore that cache so packaging does not invalidate subsequent workspace commands.
const workspaceState = join(workspace, 'node_modules/.pnpm-workspace-state-v1.json');
const previousState = await readFile(workspaceState);
try {
  run(process.execPath, [
    process.env.npm_execpath,
    '--ignore-scripts',
    '--filter',
    '@hexpayroll/api',
    'deploy',
    '--legacy',
    '--prod',
    join(stage, 'api'),
  ]);
} finally {
  await writeFile(workspaceState, previousState);
}
await rm(join(stage, 'api/dist/cli'), { recursive: true, force: true });
// Legacy deployment leaves an unused API self-link to the source workspace.
// Remove the link itself before any traversal/copy so sources and .env cannot escape into resources.
const selfLink = join(stage, 'api/node_modules/.pnpm/node_modules/@hexpayroll/api');
if (
  await lstat(selfLink).then(
    (entry) => entry.isSymbolicLink(),
    () => false,
  )
)
  await unlink(selfLink);
await materializeRuntime(join(stage, 'api'), join(stage, 'api-portable'));
await rm(join(stage, 'api'), { recursive: true, force: true });
await rename(join(stage, 'api-portable'), join(stage, 'api'));
await cp(join(workspace, 'database/migrations'), join(stage, 'migrations'), { recursive: true });
// Collect redistributed dependency notices without including unrelated source/configuration.
const notices = join(stage, 'notices');
await mkdir(notices);
const visited = new Set();
const noticeIndex = [];
async function collect(directory) {
  const canonical = await realpath(directory);
  if (!canonical.toLowerCase().startsWith((join(stage, 'api') + '\\').toLowerCase()))
    throw new Error('Deployed dependency points outside the runtime');
  if (visited.has(canonical)) return;
  visited.add(canonical);
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory() || item.isSymbolicLink()) {
      await collect(path);
      continue;
    }
    if (/^(license|licence|notice|copying|copyright)([.-]|$)/i.test(item.name)) {
      const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
      await cp(path, join(notices, key + '-' + item.name));
      noticeIndex.push({
        packageDirectory: canonical.slice(join(stage, 'api').length + 1),
        notice: key + '-' + item.name,
      });
    }
  }
}
await collect(join(stage, 'api/node_modules'));
await writeFile(join(notices, 'index.json'), JSON.stringify(noticeIndex, null, 2));
await writeFile(
  join(notices, 'README.txt'),
  'Electron and its embedded Node.js notices are shipped by electron-builder. PostgreSQL and EDB component notices accompany the private runtime. Other dependency notices are collected here.\n',
);
// Original geometric monogram, represented as a 32-bit DIB icon.
const size = 256,
  pixels = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const dx = x / 4,
      dy = y / 4;
    const h =
      (((dx >= 18 && dx < 25) || (dx >= 39 && dx < 46)) && dy >= 16 && dy < 48) ||
      (dy >= 28 && dy < 35 && dx >= 18 && dx < 46);
    const i = ((size - 1 - y) * size + x) * 4;
    pixels.set(h ? [245, 245, 245, 255] : [97, 62, 33, 255], i);
  }
const dib = Buffer.alloc(40);
dib.writeUInt32LE(40);
dib.writeInt32LE(size, 4);
dib.writeInt32LE(size * 2, 8);
dib.writeUInt16LE(1, 12);
dib.writeUInt16LE(32, 14);
const mask = Buffer.alloc((size * size) / 8),
  header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = size;
header[7] = size;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(dib.length + pixels.length + mask.length, 14);
header.writeUInt32LE(22, 18);
await writeFile(join(build, 'icon.ico'), Buffer.concat([header, dib, pixels, mask]));
await writeFile(
  join(stage, 'package-manifest.json'),
  JSON.stringify(
    {
      application: 'Hex Payroll',
      version: '0.1.0',
      platform: 'win32',
      architecture: 'x64',
      postgres: manifest,
    },
    null,
    2,
  ),
);
console.log('Desktop runtime staged and validated.');
