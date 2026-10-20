import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { createBot, telegramWebhookSecret } from './bot/index.js';
import { loadConfig, type Config } from './config.js';
import { getDb } from './db/client.js';
import { createInvoiceStore } from './db/split_members.js';
import { SIMULATOR_WEBHOOK_ID, type InvoiceStore } from './paypal/webhooks.js';
import { healthRoutes } from './routes/health.js';
import { paypalRoutes, type PayPalRouteOptions } from './routes/paypal.js';
import { telegramRoutes } from './routes/telegram.js';

export interface ServerDeps {
  /**
   * Webhook mode only. Leave undefined for long polling: grammy's webhookCallback
   * disables bot.start(), so mounting the route in polling mode crashes startup.
   */
  telegram?: { bot: Bot; secretToken: string };
  paypal: PayPalRouteOptions;
}

/** Webhook IDs whose signatures /webhook/paypal accepts. */
export function acceptedWebhookIds(config: Pick<Config, 'PAYPAL_WEBHOOK_ID' | 'PAYPAL_WEBHOOK_ALLOW_SIMULATOR'>): string[] {
  const ids = config.PAYPAL_WEBHOOK_ID ? [config.PAYPAL_WEBHOOK_ID] : [];
  if (config.PAYPAL_WEBHOOK_ALLOW_SIMULATOR) ids.push(SIMULATOR_WEBHOOK_ID);
  return ids;
}

/** Build the Fastify app without listening — tests use `app.inject()` against this. */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  await app.register(healthRoutes);
  if (deps.telegram) await app.register(telegramRoutes, deps.telegram);
  await app.register(paypalRoutes, deps.paypal);
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bot = createBot(config.TELEGRAM_BOT_TOKEN);
  const telegramSecret = telegramWebhookSecret(config.TELEGRAM_BOT_TOKEN);

  const store: InvoiceStore = createInvoiceStore(getDb());
  const webhookIds = acceptedWebhookIds(config);
  const webhookMode = Boolean(config.PUBLIC_URL);
  const app = await buildServer({
    telegram: webhookMode ? { bot, secretToken: telegramSecret } : undefined,
    paypal: { webhookIds, store },
  });
  if (config.PAYPAL_WEBHOOK_ALLOW_SIMULATOR) app.log.warn('Accepting PayPal Webhook Simulator events (testing only)');
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  if (webhookMode) {
    // Deployed: tell Telegram to push updates to us.
    await bot.api.setWebhook(`${config.PUBLIC_URL}/webhook/telegram`, { secret_token: telegramSecret });
    app.log.info('Telegram webhook registered');
  } else {
    // Local dev: no public URL, so pull updates instead. deleteWebhook first because
    // Telegram refuses getUpdates while a webhook is set.
    await bot.api.deleteWebhook();
    bot.start({ onStart: (me) => app.log.info(`Telegram long polling as @${me.username}`) }).catch((err) => {
      app.log.error(err, 'Telegram long polling stopped');
      process.exit(1);
    });
  }

  const shutdown = async () => {
    if (bot.isRunning()) await bot.stop();
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// Only start when run directly (`tsx src/server.ts`), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
