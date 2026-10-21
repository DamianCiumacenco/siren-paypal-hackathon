// Wipe ALL Siren data (dev/sandbox only) for a clean manual test run:
// 1. cancels every unpaid sandbox invoice Siren created (so old pay links stop working),
// 2. deletes every row (groups → splits/members/memory/reasoning_log cascade, then users).
// Usage: npm run db:reset -- --yes
import { getDb } from '../src/db/client.js';
import { safeErrorMessage } from '../src/lib/safe-error.js';
import { loadConfig } from '../src/config.js';
import { executeToolkit, getPayPalTools } from '../src/paypal/toolkit.js';

if (!process.argv.includes('--yes')) {
  console.error('This deletes ALL Siren data in Supabase and cancels open sandbox invoices.\nRe-run with: npm run db:reset -- --yes');
  process.exit(1);
}

const config = loadConfig();
const db = getDb();
const paypal = getPayPalTools(config);

const { data: open, error } = await db
  .from('split_members')
  .select('paypal_invoice_id')
  .not('paypal_invoice_id', 'is', null)
  .not('status', 'in', '(paid,cancelled)');
if (error) throw new Error(`read invoices failed: ${error.message}`);

let cancelled = 0;
for (const { paypal_invoice_id: id } of open as { paypal_invoice_id: string }[]) {
  try {
    await executeToolkit(paypal.cancel_sent_invoice!, { invoice_id: id, send_to_invoicer: false, send_to_recipient: false });
    cancelled++;
  } catch (err) {
    console.warn(`could not cancel ${id}: ${safeErrorMessage(err)}`);
  }
}

// Deleting groups cascades to splits, split_members, user_memory and reasoning_log.
for (const table of ['groups', 'users'] as const) {
  const { error: delErr } = await db.from(table).delete().not('id', 'is', null);
  if (delErr) throw new Error(`delete ${table} failed: ${delErr.message}`);
}
console.log(`Reset done: cancelled ${cancelled} sandbox invoice(s), deleted all groups, users, splits, memory and logs.`);
