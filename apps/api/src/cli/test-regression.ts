import { config } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Explicit test configuration; never load the normal runtime/production .env.
config({ path: fileURLToPath(new URL('../../.env.test', import.meta.url)), quiet: true });
function parseTestConnection(value: string) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    // Validate percent encoding here so parser errors cannot echo a credential URL.
    decodeURIComponent(url.pathname);
    decodeURIComponent(url.username);
    return url;
  } catch {
    throw new Error('Invalid dedicated test connection configuration');
  }
}
const names = ['TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL'] as const;
const connections = names.map((name) => {
  const value = process.env[name];
  if (!value) throw new Error('Dedicated hexpayroll_test connections are required');
  const parsed = parseTestConnection(value);
  if (decodeURIComponent(parsed.pathname.slice(1)) !== 'hexpayroll_test')
    throw new Error('Regression runner only permits hexpayroll_test');
  return parsed;
});
if (
  connections[0]!.hostname !== connections[1]!.hostname ||
  connections[0]!.port !== connections[1]!.port
)
  throw new Error('Regression connections must target the same test database');
const args = process.argv.slice(2);
const allowMissing = args.includes('--allow-missing-writer');
if (!process.env.TEST_ACCEPTANCE_WRITER_DATABASE_URL && !allowMissing)
  throw new Error(
    'Dedicated test acceptance writer configuration required; --allow-missing-writer is an explicitly incomplete diagnostic run',
  );
if (process.env.TEST_ACCEPTANCE_WRITER_DATABASE_URL) {
  const writer = parseTestConnection(process.env.TEST_ACCEPTANCE_WRITER_DATABASE_URL);
  if (
    decodeURIComponent(writer.pathname.slice(1)) !== 'hexpayroll_test' ||
    decodeURIComponent(writer.username) !== 'hexpayroll_acceptance_test_writer' ||
    writer.hostname !== connections[0]!.hostname ||
    writer.port !== connections[0]!.port
  )
    throw new Error(
      'Dedicated acceptance writer must target the same isolated hexpayroll_test environment',
    );
}
const directory = fileURLToPath(new URL('../../test/', import.meta.url));
const files = (await readdir(directory)).filter((name) => name.endsWith('.test.ts')).sort();
const selected = args.filter((name) => name !== '--allow-missing-writer');
if (selected.some((name) => !files.includes(name)))
  throw new Error('Unknown regression test filename');
const tests = (selected.length ? selected : files).map((name) =>
  fileURLToPath(new URL(name, new URL('../../test/', import.meta.url))),
);
// Health/config imports need a runtime URL. It must be the dedicated test URL,
// irrespective of any inherited production DATABASE_URL. Fixtures isolate all DML.
const result = spawnSync(
  process.execPath,
  [
    '--import',
    new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href,
    '--test',
    '--test-concurrency=1',
    ...tests,
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      NODE_ENV: 'test',
      SYNC_MODE: 'disabled',
    },
  },
);
process.exitCode = result.status ?? 1;
