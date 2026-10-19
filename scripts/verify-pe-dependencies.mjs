import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

const windowsLibraries = new Set(
  'd3d11.dll dxgi.dll dxcore.dll pdh.dll advapi32.dll bcrypt.dll comctl32.dll comdlg32.dll crypt32.dll gdi32.dll iphlpapi.dll kernel32.dll msimg32.dll msvcrt.dll ncrypt.dll normaliz.dll ntdll.dll ole32.dll oleacc.dll oleaut32.dll powrprof.dll psapi.dll rpcrt4.dll secur32.dll setupapi.dll shell32.dll shlwapi.dll user32.dll userenv.dll ucrtbase.dll uxtheme.dll version.dll winhttp.dll winmm.dll winspool.drv wldap32.dll ws2_32.dll'.split(
    ' ',
  ),
);
export async function verifyPeDependencies(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(dll|exe)$/i.test(entry.name)) files.push(path);
    }
  }
  await visit(join(root, 'bin'));
  await visit(join(root, 'lib'));
  const bundled = new Set(files.map((path) => basename(path).toLowerCase()));
  const dependencies = {};
  const missing = new Set();
  for (const file of files) {
    const b = await readFile(file),
      pe = b.readUInt32LE(60),
      opt = pe + 24;
    if (
      b.toString('ascii', 0, 2) !== 'MZ' ||
      b.readUInt16LE(pe + 4) !== 0x8664 ||
      b.readUInt16LE(opt) !== 0x20b
    )
      throw new Error('Runtime contains a non-x64 PE file');
    const count = b.readUInt16LE(pe + 6),
      size = b.readUInt16LE(pe + 20),
      sections = [];
    for (let i = 0; i < count; i++) {
      const p = opt + size + i * 40;
      sections.push({
        rva: b.readUInt32LE(p + 12),
        length: Math.max(b.readUInt32LE(p + 8), b.readUInt32LE(p + 16)),
        file: b.readUInt32LE(p + 20),
      });
    }
    const offset = (rva) => {
      const section = sections.find((s) => rva >= s.rva && rva < s.rva + s.length);
      return section ? section.file + rva - section.rva : 0;
    };
    const imported = [];
    for (const [index, stride, nameOffset] of [
      [1, 20, 12],
      [13, 32, 4],
    ]) {
      let cursor = offset(b.readUInt32LE(opt + 112 + index * 8));
      if (!cursor) continue;
      while (b.readUInt32LE(cursor + nameOffset)) {
        const start = offset(b.readUInt32LE(cursor + nameOffset));
        const name = b.toString('ascii', start, b.indexOf(0, start)).toLowerCase();
        if (
          !bundled.has(name) &&
          !windowsLibraries.has(name) &&
          !/^(api-ms-win-|ext-ms-win-)/.test(name)
        )
          missing.add(name);
        imported.push(name);
        cursor += stride;
      }
    }
    dependencies[basename(file)] = imported;
  }
  if (missing.size)
    throw new Error('Unbundled runtime dependencies: ' + [...missing].sort().join(', '));
  return dependencies;
}
