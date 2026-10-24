import { createHash } from 'node:crypto';
import { Bot, type BotConfig } from 'grammy';
import type { ChatRegistry } from '../db/chats.js';
import type { HistorySplit } from '../db/history.js';
import type { ReasoningLogEntry } from '../db/reasoning_log.js';
import { logError, type Logger } from '../lib/safe-error.js';
import { registerBasicCommands } from './commands.js';
import type { SirenContext } from './context.js';
import { createSplitCallbackHandler, SPLIT_CALLBACK, type CallbackDeps } from './handlers/callback.js';
import { agentPrompt, createAgentMessageHandler, SOMETHING_WENT_WRONG, type MessageHandlerDeps } from './handlers/message.js';
import { formatStatus, isStatusCommand } from './handlers/status.js';
import { formatWhy, isWhyCommand } from './handlers/why.js';
import { registerChat } from './middleware.js';

export interface BotDeps extends MessageHandlerDeps, CallbackDeps {
  registry: ChatRegistry;
  /** Latest reasoning_log row for a group (`/siren why`, no LLM). */
  lastReasoning: (groupId: number) => Promise<ReasoningLogEntry | null>;
  /** This group's recent splits, newest first (`/status`, no LLM). */
  groupSplits: (groupId: number) => Promise<HistorySplit[]>;
  log: Logger;
}

const consoleLog: Logger = {
  info: (o, m) => console.log(m, o),
  warn: (o, m) => console.warn(m, o),
  error: (o, m) => console.error(m, o),
};

/** A DM, a /command, an @mention or a reply to the bot: someone is waiting for an answer. */
export function addressedToBot(ctx: SirenContext): boolean {
  const msg = ctx.message;
  if (!msg) return false;
  if (ctx.chat?.type === 'private') return true;
  const text = msg.text ?? '';
  if (text.startsWith('/')) return true;
  if (ctx.me && new RegExp(`@${ctx.me.username}\\b`, 'i').test(text)) return true;
  return msg.reply_to_message?.from?.id === ctx.me?.id;
}

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
      // Never fail silently (milestone 13: a DB error left the bot mute while Telegram saw 200s).
      // Only answer what was aimed at the bot, so an outage doesn't reply to every group message.
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: SOMETHING_WENT_WRONG, show_alert: true }).catch(() => {});
      } else if (addressedToBot(ctx)) {
        await ctx.reply(SOMETHING_WENT_WRONG).catch(() => {});
      }
    }
  });

  if (deps) bot.use(registerChat(deps.registry));
  registerBasicCommands(bot);

  if (deps) {
    const handleAgent = createAgentMessageHandler(deps);
    bot.on('message:text', async (ctx) => {
      if (isWhyCommand(ctx)) {
        const groupId = ctx.siren?.groupId;
        await ctx.reply(groupId === undefined ? 'Ask me that in the group chat.' : formatWhy(await deps.lastReasoning(groupId)));
        return;
      }
      if (isStatusCommand(ctx)) {
        const groupId = ctx.siren?.groupId;
        await ctx.reply(groupId === undefined ? 'Ask me that in the group chat.' : formatStatus(await deps.groupSplits(groupId)));
        return;
      }
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
