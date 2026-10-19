import { spawnSync } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import 'dotenv/config';
import pg from 'pg';
// Machine generation includes deterministic ESM/strict-TypeScript compatibility fixes.
const result = spawnSync(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'pull'], {
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
const path = 'src/db/generated/schema.ts';
const generated = await readFile(path, 'utf8');
// drizzle-kit can reorder composite referenced columns during introspection.
// Restore PostgreSQL's actual constraint order as part of machine generation.
const database = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const constraints = await database.query<{ conname: string; target: string; columns: string[] }>(`
 SELECT c.conname,r.relname target,array_agg(a.attname::text ORDER BY u.ordinality) columns
 FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid
 JOIN pg_namespace ns ON ns.oid=c.connamespace
 CROSS JOIN LATERAL unnest(c.confkey) WITH ORDINALITY u(attnum,ordinality)
 JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=u.attnum
 WHERE c.contype='f' AND ns.nspname='public' GROUP BY c.oid,c.conname,r.relname`);
await database.end();
const camel = (value: string) => value.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const corrected = generated.replace(/foreignKey\(\{[\s\S]*?\}\)/g, (block) => {
  const name = /name:\s*"([^"]+)"/.exec(block)?.[1];
  const constraint = constraints.rows.find((c) => c.conname === name);
  if (!constraint) return block;
  return block.replace(
    /foreignColumns:\s*\[[^\]]+\]/,
    `foreignColumns: [${constraint.columns.map((column) => `${camel(constraint.target)}.${camel(column)}`).join(', ')}]`,
  );
});
await writeFile(
  path,
  corrected
    .replace('type AnyPgColumn', 'type PgTableExtraConfigValue')
    // Preserve PostgreSQL bigint identity bounds without JS numeric rounding.
    .replace(/(maxValue: )9223372036854775807/g, '$1"9223372036854775807"')
    .replace(
      /export const sync(?:Nodes|Changes|Inbox|Outbox|Checkpoints)[\s\S]*?\n\]\);/g,
      (block) =>
        block
          .replace(/mode: "number"/g, 'mode: "bigint"')
          .replace(/(bigint\([^\n]*?)\.default\(0\)/g, '$1.default(0n)'),
    )
    .replaceAll('}, (table) => [', '}, (table): PgTableExtraConfigValue[] => ['),
);
await unlink('src/db/generated/relations.ts');
