import { readFile, cp, mkdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, basename } from 'node:path';

/** Convert pnpm's locked dependency graph to ordinary portable directories, without junctions. */
export async function materializeRuntime(source, target) {
  const boundary = (await realpath(source)).toLowerCase();
  async function install(packageSource, destination, ancestors = []) {
    const canonical = await realpath(packageSource);
    if (
      canonical.toLowerCase() !== boundary &&
      !canonical.toLowerCase().startsWith(boundary + '\\')
    )
      throw new Error('Runtime dependency escaped deployment');
    const manifest = JSON.parse(await readFile(join(canonical, 'package.json'), 'utf8'));
    await mkdir(destination, { recursive: true });
    await cp(canonical, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => path === canonical || !['node_modules', '.env'].includes(basename(path)),
    });
    const require = createRequire(join(canonical, 'package.json'));
    const nextAncestors = [...ancestors, canonical];
    const dependencies = {
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    for (const name of Object.keys(dependencies)) {
      let dependency;
      for (const directory of require.resolve.paths(name) ?? []) {
        const candidate = join(directory, name);
        if (
          await stat(join(candidate, 'package.json')).then(
            () => true,
            () => false,
          )
        ) {
          const resolved = await realpath(candidate);
          if (resolved.toLowerCase().startsWith(boundary + '\\')) {
            dependency = resolved;
            break;
          }
        }
      }
      if (!dependency) {
        if (
          name in (manifest.optionalDependencies ?? {}) ||
          (name in (manifest.peerDependencies ?? {}) && !(name in (manifest.dependencies ?? {})))
        )
          continue;
        throw new Error(`Required production dependency missing: ${name}`);
      }
      // Node resolves a dependency already installed in an ancestor's node_modules naturally.
      if (nextAncestors.includes(dependency)) continue;
      await install(dependency, join(destination, 'node_modules', name), nextAncestors);
    }
  }
  await install(source, target);
}
