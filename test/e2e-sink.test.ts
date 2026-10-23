import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { REGISTRATION_TTL_MS, TelegramSink } from '../src/e2e/sink.js';
import { e2eRoutes } from '../src/routes/e2e.js';
import { buildServer } from '../src/server.js';

const SECRET = 'x'.repeat(40);
const GROUP = -1009999123456;
const USER = 999123456;

function call(sink: TelegramSink, method: string, payload: Record<string, unknown>) {
  const prev = vi.fn(async () => ({ ok: true, result: 'REAL' }));
  const result = sink.transformer()(prev as never, method as never, payload as never);
  return { prev, result: result as Promise<{ ok: boolean; result: unknown }> };
}

describe('TelegramSink', () => {
  it('captures calls to registered chats, passes everything else to Telegram', async () => {
    const sink = new TelegramSink();
    sink.register([GROUP, USER]);

    const dm = call(sink, 'sendMessage', { chat_id: USER, text: 'pay here' });
    expect((await dm.result).result).toMatchObject({ chat: { id: USER, type: 'private' }, text: 'pay here' });
    expect(dm.prev).not.toHaveBeenCalled();

    const real = call(sink, 'sendMessage', { chat_id: -100123, text: 'real group' });
    expect((await real.result).result).toBe('REAL');
    expect(real.prev).toHaveBeenCalledOnce();

    expect(sink.outbox(USER)).toEqual([expect.objectContaining({ method: 'sendMessage', chatId: USER, text: 'pay here' })]);
    expect(sink.outbox(-100123)).toEqual([]); // never recorded
  });

  it('records card buttons and captures e2e callback answers', async () => {
    const sink = new TelegramSink();
    sink.register([GROUP]);
    await call(sink, 'sendMessage', {
      chat_id: GROUP,
      text: 'card',
      reply_markup: { inline_keyboard: [[{ text: '✅', callback_data: 'split:confirm:abc' }, { text: '❌', callback_data: 'split:cancel:abc' }]] },
    }).result;
    expect(sink.outbox(GROUP)[0]!.buttons).toEqual(['split:confirm:abc', 'split:cancel:abc']);

    const answer = call(sink, 'answerCallbackQuery', { callback_query_id: `e2e:${GROUP}:1`, text: 'Sending…' });
    expect((await answer.result).result).toBe(true);
    const realAnswer = call(sink, 'answerCallbackQuery', { callback_query_id: '4382910' });
    await realAnswer.result;
    expect(realAnswer.prev).toHaveBeenCalledOnce();
  });

  it('registrations expire, and their messages go with them', async () => {
    let now = 1_000_000;
    const sink = new TelegramSink(() => now);
    sink.register([USER]);
    await call(sink, 'sendMessage', { chat_id: USER, text: 'hi' }).result;
    now += REGISTRATION_TTL_MS + 1;
    expect(sink.isRegistered(USER)).toBe(false);
    expect(sink.outbox(USER)).toEqual([]);
    const after = call(sink, 'sendMessage', { chat_id: USER, text: 'hi' });
    await after.result;
    expect(after.prev).toHaveBeenCalledOnce();
  });
});

describe('/e2e routes', () => {
  async function app(schedulerPass = vi.fn(async () => null as never)) {
    const sink = new TelegramSink();
    const a = Fastify();
    await a.register(e2eRoutes, { secret: SECRET, sink, schedulerPass });
    a.get('/other', async () => 'ok');
    return { a, sink, schedulerPass };
  }
  const h = { 'x-e2e-secret': SECRET };

  it('every route needs the secret; other routes are unaffected', async () => {
    const { a } = await app();
    expect((await a.inject({ method: 'POST', url: '/e2e/register', payload: { chatIds: [GROUP] } })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: `/e2e/outbox?chat=${GROUP}`, headers: { 'x-e2e-secret': 'wrong' } })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/other' })).statusCode).toBe(200);
  });

  it('register → outbox; unregistered chats are refused (no access to real groups)', async () => {
    const { a, sink } = await app();
    expect((await a.inject({ method: 'GET', url: `/e2e/outbox?chat=${GROUP}`, headers: h })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/e2e/register', headers: h, payload: { chatIds: [GROUP] } })).json()).toEqual({ ok: true, registered: 1 });
    await sink.transformer()(vi.fn() as never, 'sendMessage' as never, { chat_id: GROUP, text: 'x' } as never);
    expect((await a.inject({ method: 'GET', url: `/e2e/outbox?chat=${GROUP}`, headers: h })).json().messages).toHaveLength(1);
  });

  it('scheduler-pass only for registered chats', async () => {
    const pass = vi.fn(async () => ({ checked: 1, agentRuns: 1, posted: 1, skipped: {}, failed: 0, stoppedForQuota: false }));
    const { a } = await app(pass as never);
    expect((await a.inject({ method: 'POST', url: '/e2e/scheduler-pass', headers: h, payload: { chatId: GROUP } })).statusCode).toBe(404);
    expect(pass).not.toHaveBeenCalled();
    await a.inject({ method: 'POST', url: '/e2e/register', headers: h, payload: { chatIds: [GROUP] } });
    const res = await a.inject({ method: 'POST', url: '/e2e/scheduler-pass', headers: h, payload: { chatId: GROUP } });
    expect(res.json()).toMatchObject({ agentRuns: 1 });
    expect(pass).toHaveBeenCalledWith(GROUP);
  });

  it('without E2E_SECRET the routes do not exist', async () => {
    const server = await buildServer({ paypal: { webhookIds: [], store: { markInvoicePaid: async () => 0, markInvoiceCancelled: async () => 0 } } });
    expect((await server.inject({ method: 'POST', url: '/e2e/register', headers: h, payload: { chatIds: [GROUP] } })).statusCode).toBe(404);
    await server.close();
  });
});
