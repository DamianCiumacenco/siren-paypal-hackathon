import type { FastifyInstance } from 'fastify';
import { webhookCallback, type Bot } from 'grammy';
import type { SirenContext } from '../bot/context.js';

export interface TelegramRouteOptions {
  bot: Bot<SirenContext>;
  secretToken: string;
}

// POST /webhook/telegram — Telegram pushes each update here as JSON (only when PUBLIC_URL is set).
// grammy's fastify adapter checks the secret header and replies 401 if it doesn't match.
export async function telegramRoutes(app: FastifyInstance, opts: TelegramRouteOptions): Promise<void> {
  app.post('/webhook/telegram', webhookCallback(opts.bot, 'fastify', { secretToken: opts.secretToken }));
}
