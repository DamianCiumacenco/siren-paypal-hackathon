// Verify every Siren table exists and is reachable with the service key, and (when
// SUPABASE_DB_URL is set) that each table has every column schema.sql defines.
// The column check exists because the live tables pre-dated schema.sql, so
// `create table if not exists` silently skipped later columns (splits.next_nag_at).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { getDb, TABLES } from '../src/db/client.js';

const db = getDb();
let failed = false;
for (const table of TABLES) {
  const { error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) {
    failed = true;
    console.error(`✗ ${table}: ${error.message}`);
  } else {
    console.log(`✓ ${table}`);
  }
}

const { SUPABASE_DB_URL } = loadConfig();
if (!SUPABASE_DB_URL) {
  console.log('\n(SUPABASE_DB_URL not set — skipping column check)');
} else {
  const out = execFileSync(
    'supabase',
    [
      'db', 'query', '--db-url', SUPABASE_DB_URL, '--output', 'json',
      "select table_name, column_name from information_schema.columns where table_schema = 'public'",
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();
  const live = new Map<string, Set<string>>();
  for (const r of (JSON.parse(out) as { rows: { table_name: string; column_name: string }[] }).rows) {
    if (!live.has(r.table_name)) live.set(r.table_name, new Set());
    live.get(r.table_name)!.add(r.column_name);
  }
  const sql = readFileSync('src/db/schema.sql', 'utf8');
  for (const [, table, body] of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
    const columns = body!
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0] ?? '')
      .filter((c) => /^[a-z_]+$/.test(c) && c !== 'unique' && c !== 'primary');
    const missing = columns.filter((c) => !live.get(table!)?.has(c));
    if (missing.length) {
      failed = true;
      console.error(`✗ ${table} is missing column(s): ${missing.join(', ')}`);
    }
  }
  if (!failed) console.log('✓ all columns from schema.sql present');
}

if (failed) {
  console.error('\nSchema out of date — run `npm run db:push` (or paste src/db/schema.sql into the SQL Editor).');
  process.exit(1);
}
console.log('\nAll tables present.');
