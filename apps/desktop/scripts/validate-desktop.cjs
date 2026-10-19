/* global module */

module.exports = async function validateDesktop(context) {
  const { readFile, access } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = context.packager.projectDir;
  const stage = join(root, 'build', 'runtime');
  const manifest = JSON.parse(await readFile(join(stage, 'package-manifest.json'), 'utf8'));
  if (
    manifest.application !== 'Hex Payroll' ||
    manifest.architecture !== 'x64' ||
    manifest.version !== context.packager.appInfo.version
  )
    throw new Error('Desktop staging manifest does not match this application');
  for (const file of [
    'api/dist/desktop/api.js',
    'api/dist/desktop/database.js',
    'api/node_modules/express/package.json',
    'api/node_modules/pg/package.json',
    'postgres/bin/postgres.exe',
    'postgres/share/postgresql.conf.sample',
    'migrations/0036_central_synchronization.sql',
    'notices/README.txt',
  ])
    await access(join(stage, file));
  await access(join(root, '../web/dist/index.html'));
};
