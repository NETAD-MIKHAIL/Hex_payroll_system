import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readMigrations } from '../db/migrate.js';

// Offline comparison only. Input is the metadata-only ledger JSON described in
// the readiness runbook. Never reads dotenv, database URLs or connects to a DB.
const filename = process.argv[2];
if (!filename) throw new Error('Provide the metadata-only ledger JSON filename');
const input: unknown =
  filename === '--manifest'
    ? []
    : JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
if (!Array.isArray(input)) throw new Error('Expected a ledger array');
for (const [ledger, dir] of [
  ['shared', 'migrations'],
  ['central', 'central-migrations'],
] as const) {
  const sources = await readMigrations(
    fileURLToPath(new URL('../../../../database/' + dir + '/', import.meta.url)),
  );
  if (filename === '--manifest') {
    console.log(
      JSON.stringify({
        ledger,
        migrations: sources.map((s) => ({ name: s.name, checksum: s.checksum })),
      }),
    );
    continue;
  }
  const rows = input.filter(
    (r): r is { ledger: string; name: string; checksum: string } =>
      typeof r === 'object' &&
      r !== null &&
      r.ledger === ledger &&
      typeof r.name === 'string' &&
      typeof r.checksum === 'string',
  );
  const drift = rows.filter(
    (r) => !sources.some((s) => s.name === r.name && s.checksum === r.checksum),
  );
  const missing = sources.filter((s) => !rows.some((r) => r.name === s.name));
  console.log(
    JSON.stringify({
      ledger,
      repositoryCount: sources.length,
      appliedCount: rows.length,
      drift: drift.map((r) => r.name),
      notApplied: missing.map((r) => ({ name: r.name, checksum: r.checksum })),
    }),
  );
  if (drift.length) process.exitCode = 1;
}
