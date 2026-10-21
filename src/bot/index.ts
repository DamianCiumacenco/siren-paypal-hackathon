import { createHash } from 'node:crypto';
import { Bot, type BotConfig } from 'grammy';
import type { ChatRegistry } from '../db/chats.js';
import { logError, type Logger } from '../lib/safe-error.js';
import { registerBasicCommands } from './commands.js';
import type { SirenContext } from './context.js';
import { createSplitCallbackHandler, SPLIT_CALLBACK, type CallbackDeps } from './handlers/callback.js';
import { agentPrompt, createAgentMessageHandler, type MessageHandlerDeps } from './handlers/message.js';
import { registerChat } from './middleware.js';

export interface BotDeps extends MessageHandlerDeps, CallbackDeps {
  registry: ChatRegistry;
  log: Logger;
}

const consoleLog: Logger = {
  info: (o, m) => console.log(m, o),
  warn: (o, m) => console.warn(m, o),
  error: (o, m) => console.error(m, o),
};

/**
 * Build the bot. Without `deps` only /start and /help work (no DB) — used by tests that
 * only check webhook wiring. Registration order matters: the chat-registration
 * middleware must run before any command so /start in a DM links the user.
 */
export function createBot(token: string, options?: BotConfig<SirenContext>, deps?: BotDeps): Bot<SirenContext> {
  const bot = new Bot<SirenContext>(token, options);
  const log = deps?.log ?? consoleLog;

  // Error boundary FIRST. grammy only calls bot.catch() in long-polling mode; with a
  // webhook, handleUpdate throws a BotError up to Fastify, whose error logger prints the
  // error's properties (an ai-sdk error's requestBodyValues = the whole prompt) and
  // answers 500, so Telegram re-delivers the same update. Catching here covers both modes.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      logError(log, err, 'bot update failed', { updateId: ctx.update.update_id, chatId: ctx.chat?.id });
    }
  });

  if (deps) bot.use(registerChat(deps.registry));
  registerBasicCommands(bot);

  if (deps) {
    const handleAgent = createAgentMessageHandler(deps);
    bot.on('message:text', async (ctx) => {
      const prompt = agentPrompt(ctx);
      if (prompt) await handleAgent(ctx, prompt);
    });
    bot.callbackQuery(SPLIT_CALLBACK, createSplitCallbackHandler(deps));
  }

  bot.catch((err) => {
    // Never log err.error raw or the update — both can contain message text and names.
    logError(log, err.error, 'bot update failed', { updateId: err.ctx.update.update_id });
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
