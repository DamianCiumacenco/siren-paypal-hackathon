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
  const body = (await health.json().catch(() => ({}))) as { ok?: boolean; uptimeSeconds?: number; telegram?: string; db?: string };
  check('GET /health', health.ok && body.ok === true, `${health.status} in ${Date.now() - t0}ms, uptime ${body.uptimeSeconds}s`);
  // A broken DB used to leave the bot mute while /health stayed green (milestone 13).
  check('Database reachable from the deployment', body.db === 'ok', `db: ${body.db ?? '(not reported — deploy predates the DB ping)'}`);
  check('Telegram wired up (webhook mode)', body.telegram === 'webhook', `telegram: ${body.telegram ?? '(not reported)'}`);
}

// 2. Telegram delivers to this deployment, with no recent delivery errors
const info = await new Api(loadConfig().TELEGRAM_BOT_TOKEN).getWebhookInfo();
check('Telegram webhook points at this deployment', info.url === `${base}/webhook/telegram`, info.url || '(none — bot is in polling mode)');
check(
  'Telegram has no recent delivery error',
  !info.last_error_date || Date.now() / 1000 - info.last_error_date > 3600,
  info.last_error_message ? `last error: ${info.last_error_message}` : `pending updates: ${info.pending_update_count}`,
);

// 3. Webhook endpoints refuse unauthenticated requests. A local network error is reported
//    as a failed check, not a crash.
const post = async (path: string, body: string): Promise<{ status: number; error?: string }> => {
  try {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    return { status: r.status };
  } catch (e) {
    const cause = (e as Error & { cause?: Error }).cause?.message;
    return { status: 0, error: `${(e as Error).message}${cause ? ` (${cause})` : ''}` };
  }
};
const describe = (r: { status: number; error?: string }) => r.error ?? `HTTP ${r.status}`;

const tg = await post('/webhook/telegram', '{"update_id":1}');
check(
  'Telegram webhook rejects requests without the secret header',
  tg.status === 401,
  tg.status === 404 ? 'HTTP 404 — route only exists in webhook mode (is PUBLIC_URL set on Render?)' : describe(tg),
);
const pp = await post('/webhook/paypal', '{"event_type":"INVOICING.INVOICE.PAID"}');
check(
  'PayPal webhook rejects unsigned requests (and is configured)',
  pp.status === 400,
  pp.status === 503 ? 'HTTP 503 — PAYPAL_WEBHOOK_ID not set on Render yet' : describe(pp),
);

console.log(failed === 0 ? '\nLIVE CHECKS PASSED' : `\n${failed} LIVE CHECK(S) FAILED`);
process.exit(failed ? 1 : 0);
