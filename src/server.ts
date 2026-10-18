import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { createBot, telegramWebhookSecret } from './bot/index.js';
import { loadConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { telegramRoutes } from './routes/telegram.js';

export interface ServerDeps {
  bot: Bot;
  telegramSecret: string;
}

/** Build the Fastify app without listening — tests use `app.inject()` against this. */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  await app.register(healthRoutes);
  await app.register(telegramRoutes, { bot: deps.bot, secretToken: deps.telegramSecret });
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bot = createBot(config.TELEGRAM_BOT_TOKEN);
  const telegramSecret = telegramWebhookSecret(config.TELEGRAM_BOT_TOKEN);

  const app = await buildServer({ bot, telegramSecret });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  if (config.PUBLIC_URL) {
    // Deployed: tell Telegram to push updates to us.
    await bot.api.setWebhook(`${config.PUBLIC_URL}/webhook/telegram`, { secret_token: telegramSecret });
    app.log.info('Telegram webhook registered');
  } else {
    // Local dev: no public URL, so pull updates instead. deleteWebhook first because
    // Telegram refuses getUpdates while a webhook is set.
    await bot.api.deleteWebhook();
    void bot.start({ onStart: (me) => app.log.info(`Telegram long polling as @${me.username}`) });
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
