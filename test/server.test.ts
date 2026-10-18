import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBot, telegramWebhookSecret } from '../src/bot/index.js';
import { buildServer } from '../src/server.js';

const TOKEN = '123456:TEST_TOKEN';
const SECRET = telegramWebhookSecret(TOKEN);

// Pre-supplied botInfo stops grammy calling getMe; the API transformer below
// captures outgoing calls instead of hitting api.telegram.org.
const botInfo: UserFromGetMe = {
  id: 123456,
  is_bot: true,
  first_name: 'Siren',
  username: 'siren_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function startUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private', first_name: 'Damian' },
      from: { id: 42, is_bot: false, first_name: 'Damian' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
    },
  };
}

describe('server', () => {
  let app: FastifyInstance;
  let apiCalls: { method: string; payload: Record<string, unknown> }[];

  beforeEach(async () => {
    apiCalls = [];
    const bot = createBot(TOKEN, { botInfo });
    bot.api.config.use(async (_prev, method, payload) => {
      apiCalls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: true } as never;
    });
    app = await buildServer({ bot, telegramSecret: SECRET });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: 'siren' });
  });

  it('rejects Telegram webhook calls without the secret header', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhook/telegram', payload: startUpdate('/start') });
    expect(res.statusCode).toBe(401);
    expect(apiCalls).toHaveLength(0);
  });

  it('rejects Telegram webhook calls with the wrong secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      payload: startUpdate('/start'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('routes a /start update to the bot, which replies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: startUpdate('/start'),
    });
    expect(res.statusCode).toBe(200);
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]!.method).toBe('sendMessage');
    expect(apiCalls[0]!.payload).toMatchObject({ chat_id: 42 });
    expect(String(apiCalls[0]!.payload.text)).toContain('Siren');
  });

  it('webhook secret is deterministic and Telegram-safe', () => {
    expect(SECRET).toBe(telegramWebhookSecret(TOKEN));
    expect(SECRET).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
  });
});
