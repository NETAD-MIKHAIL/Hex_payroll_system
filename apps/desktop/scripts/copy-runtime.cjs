/* global module */
module.exports = async function copyRuntime(context) {
  const { cp, access, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  // electron-builder's application dependency exclusions also affect nested node_modules
  // under extraResources. Copy the validated standalone production tree explicitly.
  const source = join(context.packager.projectDir, 'build/runtime/api/node_modules');
  const target = join(context.appOutDir, 'resources/api/node_modules');
  async function rejectLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Portable runtime contains a filesystem link');
      if (entry.isDirectory()) await rejectLinks(join(directory, entry.name));
    }
  }
  await rejectLinks(source);
  await cp(source, target, { recursive: true });
  for (const name of [
    'pg',
    'express',
    'pino',
    'zod',
    '@hexpayroll/shared',
    '@hexpayroll/payroll-engine',
  ])
    await access(join(target, name, 'package.json'));
};
