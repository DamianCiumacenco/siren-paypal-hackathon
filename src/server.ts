import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import type { SirenContext } from './bot/context.js';
import { createBot, telegramWebhookSecret } from './bot/index.js';
import { loadConfig, type Config } from './config.js';
import { getDb } from './db/client.js';
import { runAgent } from './agent/run.js';
import { createChatRegistry } from './db/chats.js';
import { createHistoryStore } from './db/history.js';
import { createMemoryStore } from './db/memory.js';
import { createPaymentStore } from './db/payments.js';
import { createSchedulerStore } from './db/scheduler.js';
import { ChatLock } from './lib/chat-lock.js';
import { runScheduledPass, startScheduler } from './scheduler/runner.js';
import { lastReasoningLog } from './db/reasoning_log.js';
import { createInvoiceStore } from './db/split_members.js';
import { createSplitStore } from './db/splits.js';
import { logError, safeErrorMessage, type Logger } from './lib/safe-error.js';
import { telegramStatus } from './lib/telegram-status.js';
import { setLlmLogger } from './llm/providers.js';
import { handleInvoicePaid } from './memory/on-payment.js';
import { sendSplitInvoices } from './paypal/split_invoices.js';
import { getPayPalTools } from './paypal/toolkit.js';
import { SIMULATOR_WEBHOOK_ID, type InvoiceStore } from './paypal/webhooks.js';
import { healthRoutes } from './routes/health.js';
import { paypalRoutes, type PayPalRouteOptions } from './routes/paypal.js';
import { telegramRoutes } from './routes/telegram.js';

export interface ServerDeps {
  /**
   * Webhook mode only. Leave undefined for long polling: grammy's webhookCallback
   * disables bot.start(), so mounting the route in polling mode crashes startup.
   */
  telegram?: { bot: Bot<SirenContext>; secretToken: string };
  paypal: PayPalRouteOptions;
}

/** Webhook IDs whose signatures /webhook/paypal accepts. */
export function acceptedWebhookIds(config: Pick<Config, 'PAYPAL_WEBHOOK_ID' | 'PAYPAL_WEBHOOK_ALLOW_SIMULATOR'>): string[] {
  const ids = config.PAYPAL_WEBHOOK_ID ? [config.PAYPAL_WEBHOOK_ID] : [];
  if (config.PAYPAL_WEBHOOK_ALLOW_SIMULATOR) ids.push(SIMULATOR_WEBHOOK_ID);
  return ids;
}

/**
 * What a LOCAL instance (no PUBLIC_URL) should do about Telegram.
 * Once Siren is deployed, Telegram has a webhook pointing at production. If a local
 * `npm run dev` / `npm run test:startup` deleted it to start polling, the deployed bot
 * would silently stop receiving messages; and both instances would run the scheduler
 * against the same database. So locally we go 'passive' (HTTP only: no polling, no
 * scheduler) unless the production webhook is absent or TELEGRAM_FORCE_POLLING=true.
 */
export function localTelegramMode(existingWebhookUrl: string, forcePolling: boolean): 'polling' | 'passive' {
  return existingWebhookUrl && !forcePolling ? 'passive' : 'polling';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wire the bot to Telegram without ever taking the server down.
 * - Production (webhookUrl set): setWebhook, retried with backoff (2s → 60s cap) forever in
 *   the background until it succeeds. The scheduler and /health run meanwhile.
 * - Local: ask Telegram whether production owns the bot (getWebhookInfo, retried a few
 *   times). If that can't be answered, stay passive: never risk deleting prod's webhook.
 */
export async function setupTelegram(opts: {
  bot: Bot<SirenContext>;
  webhookUrl?: string;
  secretToken: string;
  forcePolling: boolean;
  log: Logger;
  retryDelayMs?: (attempt: number) => number;
}): Promise<'webhook' | 'polling' | 'passive'> {
  const delay = opts.retryDelayMs ?? ((n) => Math.min(60_000, 2000 * 2 ** n));

  if (opts.webhookUrl) {
    const register = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await opts.bot.api.setWebhook(opts.webhookUrl!, { secret_token: opts.secretToken });
          telegramStatus.state = 'webhook';
          opts.log.info({ attempt }, 'Telegram webhook registered');
          return;
        } catch (err) {
          telegramStatus.state = 'retrying';
          logError(opts.log, err, 'Telegram setWebhook failed — retrying', { attempt });
          await sleep(delay(attempt));
        }
      }
    };
    void register(); // background: the server keeps serving while Telegram is unreachable
    return 'webhook';
  }

  let existing: string | undefined;
  for (let attempt = 0; attempt < 4 && existing === undefined; attempt++) {
    try {
      existing = (await opts.bot.api.getWebhookInfo()).url ?? '';
    } catch (err) {
      logError(opts.log, err, 'Telegram getWebhookInfo failed', { attempt });
      if (attempt < 3) await sleep(delay(attempt));
    }
  }
  if (existing === undefined) {
    telegramStatus.state = 'passive';
    opts.log.warn({}, 'Telegram unreachable — staying PASSIVE (no polling, no scheduler) rather than risk the production webhook');
    return 'passive';
  }
  if (localTelegramMode(existing, opts.forcePolling) === 'passive') {
    telegramStatus.state = 'passive';
    opts.log.warn(
      { webhookHost: new URL(existing).host },
      'Production Telegram webhook is live — local instance is PASSIVE (no polling, no scheduler). ' +
        'Set TELEGRAM_FORCE_POLLING=true to take over; the next deploy/restart re-registers the webhook.',
    );
    return 'passive';
  }
  // Local dev: deleteWebhook first because Telegram refuses getUpdates while one is set.
  await opts.bot.api.deleteWebhook().catch((err) => logError(opts.log, err, 'Telegram deleteWebhook failed'));
  telegramStatus.state = 'polling';
  opts.bot
    .start({ onStart: (me) => opts.log.info({}, `Telegram long polling as @${me.username}`) })
    .catch((err) => {
      // Polling died (e.g. another instance took over → 409). Log it; keep serving HTTP.
      telegramStatus.state = 'passive';
      logError(opts.log, err, 'Telegram long polling stopped');
    });
  return 'polling';
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
  const db = getDb();

  // The bot is built before Fastify (the webhook route needs it), so its logger forwards
  // to app.log once the app exists. Bot log calls only happen after startup.
  let app: FastifyInstance | undefined;
  const log: Logger = {
    info: (o, m) => app?.log.info(o, m),
    warn: (o, m) => app?.log.warn(o, m),
    error: (o, m) => app?.log.error(o, m),
  };

  setLlmLogger(log);
  const lock = new ChatLock(); // shared by user messages and the scheduler
  const splits = createSplitStore(db);
  const history = createHistoryStore(db);
  const paypalTools = getPayPalTools(config);
  const bot = createBot(config.TELEGRAM_BOT_TOKEN, undefined, {
    registry: createChatRegistry(db),
    lock,
    lastReasoning: (groupId) => lastReasoningLog(db, groupId),
    groupSplits: (groupId) => history.splits(groupId, { limit: 10 }),
    runAgent: (input) => runAgent(input),
    splits,
    sendSplit: (split) =>
      sendSplitInvoices(split, {
        paypal: paypalTools,
        store: splits,
        sendDm: async (to, text) => void (await bot.api.sendMessage(to, text)),
        log,
      }),
    log,
  });
  const telegramSecret = telegramWebhookSecret(config.TELEGRAM_BOT_TOKEN);

  const store: InvoiceStore = createInvoiceStore(db);
  const webhookIds = acceptedWebhookIds(config);
  const webhookMode = Boolean(config.PUBLIC_URL);
  app = await buildServer({
    telegram: webhookMode ? { bot, secretToken: telegramSecret } : undefined,
    paypal: {
      webhookIds,
      store,
      onInvoicePaid: (invoiceId) =>
        handleInvoicePaid(invoiceId, {
          payments: createPaymentStore(db),
          memory: createMemoryStore(db),
          postToGroup: async (chatId, text) => void (await bot.api.sendMessage(chatId, text)),
        }),
    },
  });
  if (config.PAYPAL_WEBHOOK_ALLOW_SIMULATOR) app.log.warn('Accepting PayPal Webhook Simulator events (testing only)');
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  // Telegram setup runs AFTER the server is listening and can never crash it: a network
  // blip at boot (seen on Render's first deploy) used to exit(1). setupTelegram retries
  // with backoff and reports its state on /health.
  const mode = await setupTelegram({
    bot,
    webhookUrl: webhookMode ? `${config.PUBLIC_URL}/webhook/telegram` : undefined,
    secretToken: telegramSecret,
    forcePolling: config.TELEGRAM_FORCE_POLLING,
    log,
  });
  const passive = mode === 'passive';

  // Autonomous nag flow (Flow C): the agent checks open splits on NAG_CRON_INTERVAL.
  // Only on the instance that owns Telegram (see localTelegramMode).
  const schedulerStore = createSchedulerStore(db);
  const memory = createMemoryStore(db);
  const scheduler = passive
    ? undefined
    : startScheduler(
    config.NAG_CRON_INTERVAL,
    () =>
      runScheduledPass({
        store: schedulerStore,
        memory,
        runAgent: (input) => runAgent(input),
        postToGroup: async (chatId, text) => void (await bot.api.sendMessage(chatId, text)),
        lock,
        log,
      }),
    log,
  );

  const shutdown = async () => {
    await scheduler?.stop();
    if (bot.isRunning()) await bot.stop();
    await app?.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// Only start when run directly (`tsx src/server.ts`), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(safeErrorMessage(err));
    process.exit(1);
  });
}
