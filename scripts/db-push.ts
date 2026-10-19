// Apply src/db/schema.sql to the hosted Supabase database via the Supabase CLI.
// Needs SUPABASE_DB_URL in .env.local. Alternative: paste schema.sql into the
// Supabase dashboard → SQL Editor and run it. Then `npm run db:check`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';

const { SUPABASE_DB_URL } = loadConfig();
if (!SUPABASE_DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set in .env.local.\n' +
      'Get it from Supabase dashboard → Connect → Session pooler (URI), with your DB password filled in.\n' +
      'Or paste src/db/schema.sql into the SQL Editor instead.',
  );
  process.exit(1);
}

// `supabase db query` runs a single prepared statement, so send schema.sql one
// statement at a time. Splitting on `;` at end of line is safe: the schema has no
// functions or string literals containing semicolons. Re-running is safe (idempotent DDL).
const statements = readFileSync('src/db/schema.sql', 'utf8')
  .split(/;\s*$/m)
  .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(Boolean);

for (const [i, sql] of statements.entries()) {
  const label = sql.split('\n')[0]!.slice(0, 70);
  process.stdout.write(`[${i + 1}/${statements.length}] ${label} ... `);
  try {
    execFileSync('supabase', ['db', 'query', '--db-url', SUPABASE_DB_URL, sql], { stdio: 'pipe' });
    console.log('ok');
  } catch (err) {
    console.log('FAILED');
    // stderr/stdout from the CLI hold the Postgres error; the DB URL is never echoed back.
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    console.error(`${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim());
    process.exit(1);
  }
}
console.log('Schema applied. Run `npm run db:check` to verify.');
