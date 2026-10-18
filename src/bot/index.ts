import { createHash } from 'node:crypto';
import { Bot, type BotConfig, type Context } from 'grammy';

/**
 * Create the grammy bot. Milestone 1 only wires /start and /help so we can see
 * the bot is alive; the real command set + agent hand-off lands in milestone 7.
 */
export function createBot(token: string, options?: BotConfig<Context>): Bot {
  const bot = new Bot(token, options);

  bot.command('start', (ctx) =>
    ctx.reply(
      "Hi, I'm Siren. I split bills with PayPal and chase up who still owes. Type /help to see what I can do.",
    ),
  );

  bot.command('help', (ctx) =>
    ctx.reply(
      [
        'Siren commands:',
        '/split — start a new bill split',
        '/status — who has paid and who has not',
        '/nag — remind unpaid members',
        '/siren about <name> | why | debt | tone <chill|neutral|direct>',
        '',
        'Most of these are still being built.',
      ].join('\n'),
    ),
  );

  bot.catch((err) => {
    // Log the error only — never the full update (it can contain user messages).
    console.error(`[bot] error handling update ${err.ctx.update.update_id}:`, err.error);
  });

  return bot;
}

/**
 * Secret Telegram sends back in the `X-Telegram-Bot-Api-Secret-Token` header on
 * every webhook call, so we can reject forged requests. Derived from the bot token
 * so there's no extra env var to manage. Telegram allows only [A-Za-z0-9_-], 1–256 chars.
 */
export function telegramWebhookSecret(token: string): string {
  return createHash('sha256').update(`siren-webhook:${token}`).digest('hex');
}
