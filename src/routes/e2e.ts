import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TelegramSink } from '../e2e/sink.js';
import type { PassResult } from '../scheduler/runner.js';

export interface E2ERouteOptions {
  secret: string;
  sink: TelegramSink;
  /** One scheduler pass limited to this Telegram chat's group; null if the group doesn't exist. */
  schedulerPass: (telegramChatId: number) => Promise<PassResult | null>;
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const registerBody = z.object({ chatIds: z.array(z.number().int()).min(1).max(50) });
const chatQuery = z.object({ chat: z.coerce.number().int() });
const passBody = z.object({ chatId: z.number().int() });

/**
 * /e2e/* — test hooks for `npm run test:e2e` (milestone 14). Mounted only when
 * E2E_SECRET is set; every call needs it in `x-e2e-secret`. They can only touch chats
 * the suite registered, never a real group. See src/e2e/sink.ts.
 */
export async function e2eRoutes(app: FastifyInstance, opts: E2ERouteOptions): Promise<void> {
  const expected = sha(opts.secret);
  app.addHook('onRequest', async (req, reply) => {
    const given = req.headers['x-e2e-secret'];
    if (typeof given !== 'string' || !timingSafeEqual(sha(given), expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.post('/e2e/register', async (req, reply) => {
    const body = registerBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'chatIds: 1–50 integers' });
    opts.sink.register(body.data.chatIds);
    return { ok: true, registered: body.data.chatIds.length };
  });

  app.get('/e2e/outbox', async (req, reply) => {
    const q = chatQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'chat must be an integer' });
    if (!opts.sink.isRegistered(q.data.chat)) return reply.code(404).send({ error: 'chat not registered' });
    return { messages: opts.sink.outbox(q.data.chat) };
  });

  app.post('/e2e/scheduler-pass', async (req, reply) => {
    const body = passBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'chatId must be an integer' });
    if (!opts.sink.isRegistered(body.data.chatId)) return reply.code(404).send({ error: 'chat not registered' });
    const result = await opts.schedulerPass(body.data.chatId);
    if (!result) return reply.code(404).send({ error: 'no group for this chat' });
    return result;
  });
}
