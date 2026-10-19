// Milestone 3 sanity check: drive the PayPal Agent Toolkit directly (no LLM) against
// the sandbox. Creates a draft invoice, sends it, fetches it back and prints the
// payer link. Usage: npm run paypal:sanity -- [recipient-email]
import { loadConfig } from '../src/config.js';
import { getPayPalTools, parseToolkitResult } from '../src/paypal/toolkit.js';

const recipient = process.argv[2] ?? 'jay@sandbox.test';
const tools = getPayPalTools(loadConfig());

// ai@7 tools take (input, options); the options are only used inside an agent loop.
async function call<T>(name: string, input: Record<string, unknown>): Promise<T> {
  const t = tools[name];
  if (!t?.execute) throw new Error(`Toolkit tool ${name} is not enabled`);
  const raw = await t.execute(input, { toolCallId: `sanity-${name}`, messages: [], context: {} } as never);
  return parseToolkitResult<T>(raw);
}

interface PayPalLink {
  href: string;
  rel: string;
}

// PayPal's create-invoice response is either the full invoice or just a link to it,
// depending on the Prefer header the toolkit sends — handle both.
function invoiceIdFrom(res: { id?: string; href?: string; links?: PayPalLink[] }): string {
  const href = res.href ?? res.links?.find((l) => l.rel === 'self')?.href;
  const id = res.id ?? href?.split('/').pop();
  if (!id) throw new Error(`Could not find invoice id in create_invoice response: ${JSON.stringify(res)}`);
  return id;
}

console.log(`Creating sandbox invoice for ${recipient} ...`);
const created = await call<{ id?: string; href?: string; links?: PayPalLink[] }>('create_invoice', {
  currency_code: 'EUR',
  note: 'Siren sanity test — safe to ignore',
  primary_recipients: [{ billing_info: { email_address: recipient } }],
  items: [{ name: 'Siren sanity test', quantity: '1', unit_amount: { currency_code: 'EUR', value: '6.00' } }],
});
const invoiceId = invoiceIdFrom(created);
console.log(`✓ create_invoice → ${invoiceId}`);

// send_to_recipient:false — mark the invoice payable without PayPal emailing the
// payer; Siren delivers the link itself via Telegram DM.
await call('send_invoice', { invoice_id: invoiceId, send_to_recipient: false });
console.log('✓ send_invoice');

const invoice = await call<{
  status?: string;
  amount?: { value?: string; currency_code?: string };
  detail?: { metadata?: { recipient_view_url?: string } };
  links?: PayPalLink[];
}>('get_invoice', { invoice_id: invoiceId });
const payLink =
  invoice.detail?.metadata?.recipient_view_url ?? invoice.links?.find((l) => l.rel === 'payer-view')?.href;
console.log(`✓ get_invoice → status ${invoice.status}, ${invoice.amount?.value} ${invoice.amount?.currency_code}`);
console.log(`\nPayer link: ${payLink ?? '(not found in response)'}`);
console.log('Open it while logged into a sandbox Personal account to pay.');
