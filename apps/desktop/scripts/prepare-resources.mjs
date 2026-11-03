import { createRequire, builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  copyFile,
  stat,
  lstat,
  rename,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(desktop, '../..');
const destination = join(desktop, 'build', 'standalone');
// A fresh staging location prevents stale files/secrets from entering a later release.
try {
  await stat(destination);
  await rename(destination, destination + '-previous-' + Date.now());
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const postgres = resolve(process.env.HEX_POSTGRES_SOURCE ?? 'C:/Program Files/PostgreSQL/18');
const visualStudio = resolve(
  process.env.HEX_VC_REDIST_SOURCE ??
    'C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT',
);
const redistNotice = resolve(
  process.env.HEX_VC_REDIST_NOTICE ??
    'C:/Program Files/Microsoft Visual Studio/2022/Community/Licenses/1033/Redist.txt',
);
const postgresVersion = execFileSync(join(postgres, 'bin', 'postgres.exe'), ['--version'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim();
if (!/^postgres \(PostgreSQL\) 18\./.test(postgresVersion))
  throw new Error('PostgreSQL 18 Windows x64 distribution required');
for (const notice of ['server_license.txt', 'commandlinetools_3rd_party_licenses.txt']) {
  if (!(await readFile(join(postgres, notice), 'utf8')).trim())
    throw new Error('Missing PostgreSQL redistribution notice');
}
await mkdir(destination, { recursive: true });
async function copyTree(source, target, include = () => true) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const path = join(source, entry.name);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Symlink in runtime input');
    if (entry.isDirectory()) await copyTree(path, join(target, entry.name), include);
    else if (include(entry.name)) await copyFile(path, join(target, entry.name));
  }
}
const executableAllowlist = new Set([
  'postgres.exe',
  'initdb.exe',
  'pg_ctl.exe',
  'pg_dump.exe',
  'pg_restore.exe',
]);
await copyTree(
  join(postgres, 'bin'),
  join(destination, 'postgres', 'bin'),
  (name) => executableAllowlist.has(name) || name.endsWith('.dll'),
);
// Use Visual Studio's designated redistributable folder, never copies from System32.
// App-local CRT keeps this per-user installer offline and avoids installing a system prerequisite.
await copyTree(visualStudio, join(destination, 'postgres', 'bin'), (name) => name.endsWith('.dll'));
await copyFile(redistNotice, join(destination, 'postgres', 'Microsoft-VC-REDIST.txt'));
await copyTree(join(postgres, 'lib'), join(destination, 'postgres', 'lib'), (name) =>
  name.endsWith('.dll'),
);
await copyTree(join(postgres, 'share'), join(destination, 'postgres', 'share'));
for (const notice of ['server_license.txt', 'commandlinetools_3rd_party_licenses.txt'])
  await copyFile(join(postgres, notice), join(destination, 'postgres', notice));
await mkdir(join(destination, 'migrations'));
for (const name of (await readdir(join(repository, 'database', 'migrations'))).sort()) {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) {
    if (name.endsWith('.sql')) throw new Error('Unexpected local migration input');
    continue;
  }
  await copyFile(
    join(repository, 'database', 'migrations', name),
    join(destination, 'migrations', name),
  );
}
// esbuild is Vite's locked build dependency; never download tooling during packaging.
const webRequire = createRequire(join(repository, 'apps', 'web', 'package.json'));
const viteRequire = createRequire(webRequire.resolve('vite'));
const { build } = viteRequire('esbuild');
const result = await build({
  entryPoints: [join(repository, 'apps', 'api', 'src', 'desktop', 'runtime.ts')],
  outfile: join(destination, 'api', 'runtime.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  metafile: true,
  legalComments: 'eof',
  define: { 'import.meta.url': '__runtimeImportMetaUrl' },
  banner: {
    js: 'const __runtimeImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
});
const unbundled = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter(
    (item) =>
      item.external &&
      !item.path.startsWith('node:') &&
      !builtinModules.includes(item.path) &&
      item.path !== 'pg-native',
  ); // pg's optional native getter is never enabled in this pure-JS runtime.
if (unbundled.length)
  throw new Error('Unbundled runtime dependency: ' + unbundled.map((item) => item.path).join(', '));
const notices = new Map();
const noticeInputs = new Set(Object.keys(result.metafile.inputs).map((input) => resolve(input)));
const visitedDependencies = new Set();
async function visitDependency(name, requireFrom) {
  let entry;
  try {
    entry = requireFrom.resolve(name);
  } catch {
    return;
  }
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (metadata.name !== name) {
        directory = dirname(directory);
        continue;
      }
      if (visitedDependencies.has(directory)) return;
      visitedDependencies.add(directory);
      noticeInputs.add(entry);
      const dependencyRequire = createRequire(join(directory, 'package.json'));
      for (const dependency of Object.keys(metadata.dependencies ?? {}))
        await visitDependency(dependency, dependencyRequire);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    directory = dirname(directory);
  }
}
const webMetadata = JSON.parse(await readFile(join(repository, 'apps/web/package.json'), 'utf8'));
for (const name of Object.keys(webMetadata.dependencies)) await visitDependency(name, webRequire);
for (const input of noticeInputs) {
  let directory = dirname(resolve(input));
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (metadata.name && !metadata.name.startsWith('@hexpayroll/')) {
        const key = metadata.name + '@' + metadata.version;
        if (!notices.has(key)) {
          const licenseFiles = (await readdir(directory)).filter((name) =>
            /^(licen[sc]e|copying|notice)(\.|$)/i.test(name),
          );
          if (licenseFiles.length)
            notices.set(
              key,
              (
                await Promise.all(
                  licenseFiles.map((name) => readFile(join(directory, name), 'utf8')),
                )
              ).join('\n'),
            );
          else {
            if (metadata.name === 'drizzle-orm' && metadata.license === 'Apache-2.0') {
              notices.set(
                key,
                'Source: https://github.com/drizzle-team/drizzle-orm/blob/main/LICENSE\n' +
                  (await readFile(join(desktop, 'notices', 'drizzle-orm-LICENSE.txt'), 'utf8')),
              );
            } else {
              const readme = await readFile(join(directory, 'README.md'), 'utf8');
              const section = readme.match(/^#+ licen[sc]e\s*\r?\n[\s\S]+/im)?.[0];
              if (!section || !section.includes('Permission is hereby granted'))
                throw new Error('Missing dependency license: ' + key);
              notices.set(key, section);
            }
          }
        }
      }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    directory = dirname(directory);
  }
}
await writeFile(
  join(destination, 'THIRD-PARTY-NOTICES.txt'),
  [...notices].map(([name, text]) => `${name}\n${text}`).join('\n\n'),
);
const manifest = {
  format: 1,
  postgresVersion,
  postgresSource:
    'PostgreSQL Windows distribution; build operator must retain original distributor provenance',
  visualCppRuntime:
    'Visual Studio 2022 x64 app-local redistributable; redistribution subject to Visual Studio license terms',
  createdAt: new Date().toISOString(),
  files: {},
};
async function hashTree(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await hashTree(path);
    else
      manifest.files[relative(destination, path).replaceAll('\\', '/')] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
  }
}
await hashTree(destination);
await writeFile(
  join(destination, 'runtime-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
  `Staged ${Object.keys(manifest.files).length} runtime files; ${postgresVersion}. No database or .env files copied.`,
);
