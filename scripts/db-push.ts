// Apply src/db/schema.sql to the hosted Supabase database via the Supabase CLI.
// Needs SUPABASE_DB_URL in .env.local. Alternative: paste schema.sql into the
// Supabase dashboard → SQL Editor and run it. Then `npm run db:check`.
import { execFileSync } from 'node:child_process';
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

execFileSync('supabase', ['db', 'query', '--db-url', SUPABASE_DB_URL, '--file', 'src/db/schema.sql'], {
  stdio: 'inherit',
});
console.log('Schema applied. Run `npm run db:check` to verify.');
