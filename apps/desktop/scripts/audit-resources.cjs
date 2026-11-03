const { readFile, readdir, lstat } = require('node:fs/promises');
const { resolve, join, relative, basename } = require('node:path');
const { createHash } = require('node:crypto');

module.exports = async function () {
  const desktop = resolve(__dirname, '..');
  const root = join(desktop, 'build', 'standalone');
  const manifest = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !manifest.postgresVersion.startsWith('postgres (PostgreSQL) 18.'))
    throw new Error('Invalid standalone runtime manifest');
  const found = new Set();
  async function audit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      const name = relative(root, path).replaceAll('\\', '/');
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Runtime symlink rejected');
      if (item.isDirectory()) {
        await audit(path);
        continue;
      }
      if (name === 'runtime-manifest.json') continue;
      if (/^\.env(?:\.|$)/i.test(basename(name)) || name.endsWith('.map'))
        throw new Error('Forbidden runtime input');
      const digest = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      if (manifest.files[name] !== digest)
        throw new Error('Runtime resource missing from manifest or changed: ' + name);
      found.add(name);
    }
  }
  await audit(root);
  if (found.size !== Object.keys(manifest.files).length)
    throw new Error('Missing runtime resources');
  for (const required of [
    'api/runtime.cjs',
    'postgres/bin/postgres.exe',
    'postgres/bin/initdb.exe',
    'postgres/bin/pg_ctl.exe',
    'postgres/bin/pg_dump.exe',
    'postgres/bin/pg_restore.exe',
    'postgres/bin/vcruntime140.dll',
    'postgres/bin/vcruntime140_1.dll',
    'postgres/server_license.txt',
    'postgres/commandlinetools_3rd_party_licenses.txt',
    'postgres/Microsoft-VC-REDIST.txt',
    'THIRD-PARTY-NOTICES.txt',
  ])
    if (!found.has(required)) throw new Error('Required standalone resource missing: ' + required);
  const migrations = resolve(desktop, '../../database/migrations');
  const names = (await readdir(migrations)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name));
  for (const name of names) {
    const hash = createHash('sha256')
      .update(await readFile(join(migrations, name)))
      .digest('hex');
    if (manifest.files['migrations/' + name] !== hash)
      throw new Error('Migration staging is stale: ' + name);
  }
  if ([...found].filter((name) => name.startsWith('migrations/')).length !== names.length)
    throw new Error('Unexpected migration in standalone package');
  console.log('Standalone runtime manifest and migration audit passed.');
};
