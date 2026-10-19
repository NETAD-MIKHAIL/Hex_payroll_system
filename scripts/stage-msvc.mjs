import { readFile, writeFile, mkdir, cp, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

export async function stageMsvc(workspace, stage, run) {
  const build = join(workspace, 'apps/desktop/build');
  const manifest = JSON.parse(
    await readFile(join(workspace, 'apps/desktop/msvc-runtime.json'), 'utf8'),
  );
  const archive = join(build, 'cache/vc_redist.x64.exe');
  try {
    await stat(archive);
  } catch {
    const response = await globalThis.fetch(manifest.source);
    if (!response.ok) throw new Error('Microsoft runtime download failed');
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }
  const binary = await readFile(archive);
  if (createHash('sha256').update(binary).digest('hex') !== manifest.sha256)
    throw new Error('Microsoft runtime checksum mismatch');
  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    join(workspace, 'scripts/verify-msvc.ps1'),
  ]);
  const ux = join(build, 'vc-ux'),
    payload = join(build, 'vc-payload'),
    minimum = join(build, 'vc-minimum');
  for (const directory of [ux, payload, minimum]) await mkdir(directory, { recursive: true });
  for (const [name, output] of [
    ['uxCabinet', ux],
    ['payloadCabinet', payload],
  ]) {
    const cabinet = manifest[name];
    const path = join(build, `cache/${name}.cab`);
    if (binary.toString('ascii', cabinet.offset, cabinet.offset + 4) !== 'MSCF')
      throw new Error('Unexpected Microsoft runtime format');
    await writeFile(path, binary.subarray(cabinet.offset, cabinet.offset + cabinet.size));
    run('tar.exe', ['-xf', path, '-C', output]);
  }
  run('tar.exe', ['-xf', join(payload, manifest.minimumRuntimeCabinet), '-C', minimum]);
  for (const name of await readdir(minimum)) {
    if (!/\.dll_amd64$/i.test(name)) throw new Error('Unexpected Microsoft runtime payload');
    if (!/^(concrt140|msvcp140[^/]*|vcruntime140[^/]*)\.dll_amd64$/i.test(name)) continue;
    const target = join(stage, 'postgres/bin', name.replace(/_amd64$/, ''));
    await cp(join(minimum, name), target);
  }
  for (const required of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])
    await stat(join(stage, 'postgres/bin', required));
  await cp(
    join(ux, manifest.license),
    join(stage, 'postgres/Microsoft-Visual-C-runtime-license.rtf'),
  );
  await cp(
    join(workspace, 'apps/desktop/msvc-runtime.json'),
    join(stage, 'postgres/msvc-runtime-manifest.json'),
  );
}
