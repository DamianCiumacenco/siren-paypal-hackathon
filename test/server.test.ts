import type { FastifyInstance } from 'fastify';
import { APICallError } from 'ai';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBot, telegramWebhookSecret } from '../src/bot/index.js';
import type { InvoiceStore } from '../src/paypal/webhooks.js';
import { acceptedWebhookIds, buildServer, localTelegramMode } from '../src/server.js';
import { invoiceEvent, signedWebhookHeaders, TEST_CERT_PEM } from './helpers/paypal-signing.js';

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
  let paidInvoices: string[];
  const WEBHOOK_ID = 'WH-REAL-123';

  beforeEach(async () => {
    apiCalls = [];
    paidInvoices = [];
    const bot = createBot(TOKEN, { botInfo });
    bot.api.config.use(async (_prev, method, payload) => {
      apiCalls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: true } as never;
    });
    const store: InvoiceStore = {
      markInvoicePaid: async (id) => (paidInvoices.push(id), 1),
      markInvoiceCancelled: async () => 0,
    };
    app = await buildServer({
      telegram: { bot, secretToken: SECRET },
      paypal: { webhookIds: [WEBHOOK_ID], store, fetchCertPem: async () => TEST_CERT_PEM },
    });
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

  describe('POST /webhook/paypal', () => {
    const body = invoiceEvent('INVOICING.INVOICE.PAID', 'INV2-AAAA');
    const post = (payload: string, headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/webhook/paypal',
        headers: { 'content-type': 'application/json', ...headers },
        payload,
      });

    it('processes a correctly signed INVOICE.PAID event', async () => {
      const res = await post(body, signedWebhookHeaders(body, WEBHOOK_ID));
      expect(res.statusCode).toBe(200);
      expect(paidInvoices).toEqual(['INV2-AAAA']);
    });

    it('rejects a bad signature with 400 and changes nothing', async () => {
      const res = await post(body, signedWebhookHeaders(body, 'WH-SOMEONE-ELSE'));
      expect(res.statusCode).toBe(400);
      expect(paidInvoices).toEqual([]);
    });

    it('rejects a request with no signature headers', async () => {
      const res = await post(body, {});
      expect(res.statusCode).toBe(400);
    });

    it('answers 503 when no webhook id is configured', async () => {
      const bare = await buildServer({
        paypal: { webhookIds: [], store: { markInvoicePaid: async () => 0, markInvoiceCancelled: async () => 0 } },
      });
      const res = await bare.inject({
        method: 'POST',
        url: '/webhook/paypal',
        headers: { 'content-type': 'application/json', ...signedWebhookHeaders(body, WEBHOOK_ID) },
        payload: body,
      });
      expect(res.statusCode).toBe(503);
      await bare.close();
    });
  });
});

describe('polling mode (no PUBLIC_URL)', () => {
  it('does not mount the Telegram webhook route, so bot.start() still works', async () => {
    const bot = createBot(TOKEN, { botInfo });
    const app = await buildServer({
      paypal: { webhookIds: [], store: { markInvoicePaid: async () => 0, markInvoiceCancelled: async () => 0 } },
    });
    const res = await app.inject({ method: 'POST', url: '/webhook/telegram', payload: {} });
    expect(res.statusCode).toBe(404);
    // grammy replaces bot.start with a throwing stub once webhookCallback is created.
    expect(bot.start.toString()).not.toContain('already started the bot via webhooks');
    await app.close();
  });
});

describe('Telegram webhook mode: errors never reach Fastify', () => {
  it('a failing update returns 200 (no Telegram re-delivery) and logs no PII', async () => {
    const logs: string[] = [];
    const capture = (o: object, m?: string) => void logs.push(JSON.stringify({ ...o, msg: m }));
    const bot = createBot(TOKEN, { botInfo }, {
      registry: {
        registerUser: async () => {
          throw new APICallError({
            message: 'boom',
            url: 'https://api.groq.com',
            requestBodyValues: { prompt: 'Members: Jay Murphy owes €60 for football' },
            statusCode: 500,
          });
        },
        registerGroup: async () => 1,
        registerMembership: async () => {},
      },
      runAgent: async () => ({ response: '', thoughts: [] }),
      splits: {} as never,
      sendSplit: async () => ({ dmed: [], linkInGroup: [], failed: [] }),
      lastReasoning: async () => null,
      log: { info: capture, warn: capture, error: capture },
    });
    bot.api.config.use(async () => ({ ok: true, result: true }) as never);
    const app = await buildServer({
      telegram: { bot, secretToken: SECRET },
      paypal: { webhookIds: [], store: { markInvoicePaid: async () => 0, markInvoiceCancelled: async () => 0 } },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: startUpdate('/start'),
    });
    expect(res.statusCode).toBe(200);
    expect(logs.join()).toContain('bot update failed');
    for (const pii of ['Jay', 'Murphy', '€60', 'football']) expect(logs.join()).not.toContain(pii);
    await app.close();
  });
});

describe('acceptedWebhookIds', () => {
  it('only includes the simulator id when explicitly allowed', () => {
    expect(acceptedWebhookIds({ PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_WEBHOOK_ALLOW_SIMULATOR: false })).toEqual(['WH-1']);
    expect(acceptedWebhookIds({ PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_WEBHOOK_ALLOW_SIMULATOR: true })).toEqual([
      'WH-1',
      'WEBHOOK_ID',
    ]);
    expect(acceptedWebhookIds({ PAYPAL_WEBHOOK_ID: undefined, PAYPAL_WEBHOOK_ALLOW_SIMULATOR: false })).toEqual([]);
  });
});

describe('localTelegramMode (local run while production is deployed)', () => {
  it('goes passive when a production webhook is live — never deletes it', () => {
    expect(localTelegramMode('https://siren-x7k2.onrender.com/webhook/telegram', false)).toBe('passive');
  });
  it('polls when no webhook is set (pre-deploy local dev, mates test)', () => {
    expect(localTelegramMode('', false)).toBe('polling');
  });
  it('TELEGRAM_FORCE_POLLING=true takes over deliberately', () => {
    expect(localTelegramMode('https://siren-x7k2.onrender.com/webhook/telegram', true)).toBe('polling');
  });
});
