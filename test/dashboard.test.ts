import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createBot, type BotDeps } from '../src/bot/index.js';
import { buildDashboardData, type DashboardSources } from '../src/dashboard/data.js';
import { DASHBOARD_LINK_TTL_MS, dashboardKey, dashboardUrl, signDashboardToken, verifyDashboardToken } from '../src/dashboard/link.js';
import type { HistorySplit } from '../src/db/history.js';
import { dashboardRoutes } from '../src/routes/dashboard.js';
import { botInfo, DAMIAN, GROUP, textUpdate } from './helpers/telegram.js';

const KEY = dashboardKey('123456:TEST');
const NOW = Date.parse('2026-11-01T12:00:00Z');

describe('dashboard links (signed, per group, 24h)', () => {
  it('round-trips for the group it was made for', () => {
    const token = signDashboardToken(56, KEY, NOW);
    expect(verifyDashboardToken(token, KEY, NOW + 1000)).toEqual({ ok: true, groupId: 56, expiresAt: new Date(Math.floor((NOW + DASHBOARD_LINK_TTL_MS) / 1000) * 1000) });
  });

  it('cannot be edited to open another group', () => {
    const [, exp, sig] = signDashboardToken(56, KEY, NOW).split('.');
    expect(verifyDashboardToken(`57.${exp}.${sig}`, KEY, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('cannot be extended', () => {
    const [g, exp, sig] = signDashboardToken(56, KEY, NOW).split('.');
    expect(verifyDashboardToken(`${g}.${Number(exp) + 86_400}.${sig}`, KEY, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('expires after 24h', () => {
    const token = signDashboardToken(56, KEY, NOW);
    expect(verifyDashboardToken(token, KEY, NOW + DASHBOARD_LINK_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('is tied to the bot token (rotating it kills every link)', () => {
    expect(verifyDashboardToken(signDashboardToken(56, KEY, NOW), dashboardKey('999:OTHER'), NOW).ok).toBe(false);
  });

  it('rejects garbage', () => {
    for (const t of ['', 'abc', '56.1', '56.1.xyz', `56.1.${'g'.repeat(64)}`]) expect(verifyDashboardToken(t, KEY, NOW).ok).toBe(false);
  });

  it('travels in the URL fragment, which browsers never send to the server (stays out of logs)', () => {
    expect(dashboardUrl('https://siren.example', 'T')).toBe('https://siren.example/dashboard#t=T');
  });
});

const split = (over: Partial<HistorySplit> = {}): HistorySplit => ({
  id: '11111111-2222-3333-4444-555555555555',
  description: 'pizza',
  status: 'open',
  currency: 'EUR',
  totalAmount: 30,
  perPersonAmount: 10,
  createdAt: '2026-10-30T18:00:00Z',
  creator: { userId: 1, name: 'Damian' },
  members: [
    { name: 'Jay', userId: 2, status: 'sent', paidAt: null, remindersSent: 1 },
    { name: 'Sean', userId: 3, status: 'paid', paidAt: '2026-10-30T20:00:00Z', remindersSent: 0 },
  ],
  ...over,
});

function sources(over: Partial<DashboardSources> = {}): DashboardSources {
  return {
    groupTitle: async () => 'Five-a-side',
    splits: async () => [split(), split({ description: 'golf', status: 'settled', members: [{ name: 'Jay', userId: 2, status: 'paid', paidAt: null, remindersSent: 0 }] })],
    members: async () => [
      { userId: 1, name: 'Damian', reliabilityScore: 0.9, avgHoursToPay: 5, totalSplits: 4, totalPaidOnTime: 4, preferredTone: 'chill', toneLocked: false },
      { userId: 2, name: 'Jay', reliabilityScore: 0.21, avgHoursToPay: 120, totalSplits: 3, totalPaidOnTime: 0, preferredTone: 'direct', toneLocked: false },
      { userId: 3, name: 'Sean', reliabilityScore: null, avgHoursToPay: null, totalSplits: 0, totalPaidOnTime: 0, preferredTone: 'chill', toneLocked: true },
    ],
    reasoning: async () => [
      {
        trigger: 'scheduled_run',
        createdAt: '2026-11-01T06:00:00Z',
        finalResponse: 'Reminded Jay. Link: https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA-BBBB (split 11111111-2222-3333-4444-555555555555)',
        thoughts: [
          {
            step: 1,
            model: 'openai/gpt-oss-120b',
            tokens: { input: 3000 },
            reasoning: 'Jay is 50h overdue',
            toolCalls: [{ tool: 'telegram_dm', input: { split_member_id: 'abc', kind: 'reminder', message: 'still waiting on €10, sort it today' } }],
            toolResults: [{ tool: 'telegram_dm', output: { ok: true, sent_to: 'Jay', kind: 'reminder' } }],
          },
        ],
      },
    ],
    ...over,
  };
}

describe('dashboard data', () => {
  it('splits: amounts from the DB, owing names, the creator as bill payer', async () => {
    const d = (await buildDashboardData(56, sources(), new Date(NOW)))!;
    expect(d.group.title).toBe('Five-a-side');
    expect(d.splits[0]).toEqual({ description: 'pizza', status: 'open', created: '2026-10-30T18:00:00Z', total: '€30.00', each: '€10.00', paid: '1/2', owing: 'Jay', paidBy: 'Damian' });
    expect(d.splits[1]).toMatchObject({ status: 'settled', owing: '' });
  });

  it('members: learned vs stated tone, on-time record, and what they owe now (creator owes nothing)', async () => {
    const d = (await buildDashboardData(56, sources(), new Date(NOW)))!;
    const by = Object.fromEntries(d.members.map((m) => [m.name, m]));
    expect(by.Jay).toMatchObject({ reliability: 0.21, tone: 'direct', toneSource: 'learned', onTime: '0/3', owes: '€10.00' });
    expect(by.Sean).toMatchObject({ reliability: null, toneSource: 'stated', owes: '' });
    expect(by.Damian!.owes).toBe(''); // creator-share rule
  });

  it('creator-share rule holds even if a creator row slipped into members', async () => {
    const d = (await buildDashboardData(56, sources({ splits: async () => [split({ members: [{ name: 'Damian', userId: 1, status: 'sent', paidAt: null, remindersSent: 0 }] })] }), new Date(NOW)))!;
    expect(d.members.find((m) => m.name === 'Damian')!.owes).toBe('');
  });

  it('PII/privacy: reasoning is redacted like /siren why — no pay links, invoice numbers, ids or DM wording', async () => {
    const d = (await buildDashboardData(56, sources(), new Date(NOW)))!;
    const r = d.reasoning[0]!;
    expect(r).toMatchObject({ trigger: 'scheduled check', tools: 'telegram_dm', models: 'openai/gpt-oss-120b' });
    const all = JSON.stringify(d);
    expect(all).not.toMatch(/sandbox\.paypal\.com|INV2-|11111111-2222|still waiting on/);
    expect(r.detail).toMatch(/telegram_dm/);
    expect(r.detail).not.toMatch(/^My last decision/);
  });

  it('PII/privacy: no memory notes and no Telegram/user ids in the payload', async () => {
    const all = JSON.stringify(await buildDashboardData(56, sources(), new Date(NOW)));
    expect(all).not.toMatch(/"userId"|"notes"|telegram_?user|chat_?id/i);
  });

  it('a deleted group → undefined', async () => {
    expect(await buildDashboardData(56, sources({ groupTitle: async () => undefined }))).toBeUndefined();
  });
});

describe('dashboard routes', () => {
  async function app(src = sources()) {
    const logs: string[] = [];
    const a = Fastify({ logger: { level: 'info', stream: { write: (l: string) => void logs.push(l) } } });
    const spy = { ...src, splits: vi.fn(src.splits), members: vi.fn(src.members) };
    await a.register(dashboardRoutes, { key: KEY, sources: spy });
    return { a, spy, logs };
  }

  it('serves the page and its assets with strict headers', async () => {
    const { a } = await app();
    const page = await a.inject({ method: 'GET', url: '/dashboard' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toMatch(/default-src 'none'.*script-src 'self' https:\/\/cdn\.jsdelivr\.net;/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toContain('ag-grid-community@32.3.3');
    expect((await a.inject({ method: 'GET', url: '/dashboard/app.js' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/dashboard/app.css' })).statusCode).toBe(200);
  });

  it('API: 401 without a token, 403 with a bad or expired one', async () => {
    const { a, spy } = await app();
    expect((await a.inject({ method: 'GET', url: '/dashboard/api' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/dashboard/api', headers: { 'x-dashboard-token': 'nope' } })).statusCode).toBe(403);
    const expired = signDashboardToken(56, KEY, Date.now() - DASHBOARD_LINK_TTL_MS - 1000);
    const res = await a.inject({ method: 'GET', url: '/dashboard/api', headers: { 'x-dashboard-token': expired } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/expired.*\/siren dashboard/);
    expect(spy.splits).not.toHaveBeenCalled();
  });

  it("API: a valid token loads exactly that group's data (isolation)", async () => {
    const { a, spy } = await app();
    const res = await a.inject({ method: 'GET', url: '/dashboard/api', headers: { 'x-dashboard-token': signDashboardToken(56, KEY) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ group: { title: 'Five-a-side' }, expiresAt: expect.any(String) });
    expect(spy.splits).toHaveBeenCalledWith(56);
    expect(spy.members).toHaveBeenCalledWith(56);
  });

  it('PII: a failing load answers 500 and logs ids only; the token never reaches the logs', async () => {
    const { a, logs } = await app(sources({ members: async () => { throw new Error('members(56) failed: timeout'); } }));
    const token = signDashboardToken(56, KEY);
    const res = await a.inject({ method: 'GET', url: '/dashboard/api', headers: { 'x-dashboard-token': token } });
    expect(res.statusCode).toBe(500);
    const out = logs.join('\n');
    expect(out).toContain('dashboard data failed');
    expect(out).not.toContain(token.split('.')[2]!);
    for (const pii of ['Jay', 'Sean', 'pizza', '€10']) expect(out).not.toContain(pii);
  });
});

describe('/siren dashboard command', () => {
  function bot(opts: { dmFails?: boolean } = {}) {
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const deps = {
      registry: { registerUser: async () => 1, registerGroup: async () => 56, registerMembership: async () => {} },
      runAgent: vi.fn(),
      splits: {} as never,
      sendSplit: vi.fn(),
      lastReasoning: async () => null,
      groupSplits: async () => [],
      dashboardLink: (g: number) => `https://siren.test/dashboard#t=${g}.9.sig`,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as BotDeps;
    const b = createBot('123456:TEST', { botInfo }, deps);
    b.api.config.use(async (_prev, method, payload) => {
      const p = payload as Record<string, unknown>;
      calls.push({ method, payload: p });
      if (opts.dmFails && p.chat_id === DAMIAN.id) return { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" } as never;
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: p.chat_id, type: 'private' } } } as never;
    });
    return { b, calls, deps };
  }

  it('DMs the requester a link for THIS group and confirms in the group, without the link', async () => {
    const { b, calls, deps } = bot();
    await b.handleUpdate(textUpdate('/siren dashboard') as never);
    expect(deps.runAgent).not.toHaveBeenCalled(); // no LLM
    const [dm, groupReply] = calls.filter((c) => c.method === 'sendMessage');
    expect(dm!.payload).toMatchObject({ chat_id: DAMIAN.id });
    expect(dm!.payload.text).toContain('https://siren.test/dashboard#t=56.9.sig');
    expect(dm!.payload.text).toContain('"Five-a-side"');
    expect(groupReply!.payload).toMatchObject({ chat_id: GROUP.id });
    expect(groupReply!.payload.text).toMatch(/sent you this group's dashboard link in a DM/);
    expect(groupReply!.payload.text).not.toContain('dashboard#t=');
  });

  it("can't DM yet → tells them to press Start; the link is never posted in the group", async () => {
    const { b, calls } = bot({ dmFails: true });
    await b.handleUpdate(textUpdate('/siren dashboard') as never);
    const groupReplies = calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === GROUP.id);
    expect(groupReplies).toHaveLength(1);
    expect(groupReplies[0]!.payload.text).toMatch(/press Start/);
    expect(JSON.stringify(groupReplies)).not.toContain('dashboard#t=');
  });

  it('in a DM it asks for the group (a dashboard is per group)', async () => {
    const { b, calls } = bot();
    await b.handleUpdate(textUpdate('/siren dashboard', { chat: { id: DAMIAN.id, type: 'private', first_name: 'Damian' } }) as never);
    const sent = calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.text).toMatch(/group chat/);
  });
});
