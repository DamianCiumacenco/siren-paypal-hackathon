// Verify every Siren table exists and is reachable with the service key.
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
if (failed) {
  console.error('\nSome tables are missing — run `npm run db:push` (or paste src/db/schema.sql into the SQL Editor).');
  process.exit(1);
}
console.log('\nAll tables present.');
