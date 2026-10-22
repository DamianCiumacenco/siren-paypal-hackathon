// Read-only checks against the deployed service. Usage: npm run verify:live -- https://siren-xxxx.onrender.com
// Uses .env.local only for the bot token (to ask Telegram where it delivers updates).
import { Api } from 'grammy';
import { loadConfig } from '../src/config.js';

const base = (process.argv[2] ?? loadConfig().PUBLIC_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('Usage: npm run verify:live -- https://<your-service>.onrender.com');
  process.exit(1);
}

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. Health (first hit may take ~50s if the free instance was asleep)
const t0 = Date.now();
const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(90_000) }).catch((e: Error) => e);
if (health instanceof Error) check('GET /health', false, health.message);
else {
  const body = (await health.json().catch(() => ({}))) as { ok?: boolean; uptimeSeconds?: number };
  check('GET /health', health.ok && body.ok === true, `${health.status} in ${Date.now() - t0}ms, uptime ${body.uptimeSeconds}s`);
}

// 2. Telegram delivers to this deployment, with no recent delivery errors
const info = await new Api(loadConfig().TELEGRAM_BOT_TOKEN).getWebhookInfo();
check('Telegram webhook points at this deployment', info.url === `${base}/webhook/telegram`, info.url || '(none — bot is in polling mode)');
check(
  'Telegram has no recent delivery error',
  !info.last_error_date || Date.now() / 1000 - info.last_error_date > 3600,
  info.last_error_message ? `last error: ${info.last_error_message}` : `pending updates: ${info.pending_update_count}`,
);

// 3. Webhook endpoints refuse unauthenticated requests
const tg = await fetch(`${base}/webhook/telegram`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"update_id":1}' });
check('Telegram webhook rejects requests without the secret header', tg.status === 401, `HTTP ${tg.status}`);
const pp = await fetch(`${base}/webhook/paypal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event_type":"INVOICING.INVOICE.PAID"}' });
check(
  'PayPal webhook rejects unsigned requests (and is configured)',
  pp.status === 400,
  `HTTP ${pp.status}${pp.status === 503 ? ' — PAYPAL_WEBHOOK_ID not set on Render yet' : ''}`,
);

console.log(failed === 0 ? '\nLIVE CHECKS PASSED' : `\n${failed} LIVE CHECK(S) FAILED`);
process.exit(failed ? 1 : 0);
