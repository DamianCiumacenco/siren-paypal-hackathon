import { describe, expect, it, vi } from 'vitest';
import type { Thought } from '../src/agent/reasoning-log.js';
import { formatWhy, redact } from '../src/bot/handlers/why.js';
import type { MemoryStore } from '../src/db/memory.js';
import type { PaymentContext, PaymentStore } from '../src/db/payments.js';
import { handleInvoicePaid } from '../src/memory/on-payment.js';
import { recomputeMemory } from '../src/memory/profile.js';
import { computeStats, type Share } from '../src/memory/scoring.js';
import { pickTone } from '../src/memory/tone.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const paid = (createdHoursAgo: number, tookHours: number): Share => ({
  createdAt: hoursAgo(createdHoursAgo),
  paidAt: hoursAgo(createdHoursAgo - tookHours),
  status: 'paid',
});
const unpaid = (createdHoursAgo: number): Share => ({ createdAt: hoursAgo(createdHoursAgo), paidAt: null, status: 'sent' });

describe('computeStats (reliability formula)', () => {
  it('matches ARCHITECTURE: 0.6·on_time_ratio + 0.4·clamp(1 − avg/168)', () => {
    // 3 paid: 6h, 12h, 96h (late) → on_time 2/3, avg 38h → speed 1 − 38/168
    const s = computeStats([paid(500, 6), paid(400, 12), paid(300, 96)], NOW);
    expect(s.totalSplits).toBe(3);
    expect(s.totalPaidOnTime).toBe(2);
    expect(s.avgHoursToPay).toBe(38);
    expect(s.reliabilityScore).toBeCloseTo(0.6 * (2 / 3) + 0.4 * (1 - 38 / 168), 3);
  });

  it('a fast, always-on-time payer scores > 0.8', () => {
    expect(computeStats([paid(300, 5), paid(200, 6), paid(100, 4)], NOW).reliabilityScore).toBeGreaterThan(0.8);
  });

  it('overdue unpaid shares (>72h) count as late; recent unpaid ones do not count yet', () => {
    const s = computeStats([paid(300, 10), unpaid(100), unpaid(5)], NOW);
    expect(s.totalSplits).toBe(2); // the 5h-old share is still inside its window
    expect(s.totalPaidOnTime).toBe(1);
  });

  it('never paid but overdue → speed 0, reliability 0', () => {
    expect(computeStats([unpaid(200), unpaid(100)], NOW)).toEqual({
      totalSplits: 2,
      totalPaidOnTime: 0,
      avgHoursToPay: null,
      reliabilityScore: 0,
    });
  });

  it('no resolved shares yet → no score (not a fake 0)', () => {
    expect(computeStats([unpaid(3)], NOW).reliabilityScore).toBeNull();
    expect(computeStats([], NOW).reliabilityScore).toBeNull();
  });

  it('cancelled shares are ignored; speed clamps at 0 beyond a week', () => {
    const s = computeStats([paid(1000, 400), { ...unpaid(500), status: 'cancelled' }], NOW);
    expect(s.totalSplits).toBe(1);
    expect(s.reliabilityScore).toBe(0); // late (0.6·0) + slower than a week (0.4·0)
  });
});

describe('pickTone', () => {
  it.each([
    [0.95, 'chill'],
    [0.81, 'chill'],
    [0.8, 'neutral'],
    [0.4, 'neutral'],
    [0.39, 'direct'],
    [0, 'direct'],
    [null, 'neutral'],
  ] as const)('%s → %s', (score, tone) => expect(pickTone(score)).toBe(tone));
});

function memoryStore(shares: Share[], locked = false) {
  return {
    getProfile: vi.fn(),
    updatePreference: vi.fn(),
    paymentRecord: vi.fn(async () => shares),
    saveStats: vi.fn(async () => {}),
    isToneLocked: vi.fn(async () => locked),
  } satisfies MemoryStore;
}

describe('recomputeMemory', () => {
  it('writes stats and the auto tone', async () => {
    const store = memoryStore([unpaid(200), unpaid(100)]);
    const r = await recomputeMemory(store, 2, 7, NOW);
    expect(r.autoTone).toBe('direct');
    expect(store.saveStats).toHaveBeenCalledWith(2, 7, expect.objectContaining({ reliabilityScore: 0 }), 'direct');
  });

  it('never overrides a tone set explicitly (/siren tone)', async () => {
    const store = memoryStore([unpaid(200)], true);
    const r = await recomputeMemory(store, 2, 7, NOW);
    expect(r.autoTone).toBeUndefined();
    expect(store.saveStats).toHaveBeenCalledWith(2, 7, expect.anything(), undefined);
  });
});

describe('handleInvoicePaid (webhook → memory → group)', () => {
  const ctx = (statuses: string[], status = 'open'): PaymentContext => ({
    member: { id: 'm-jay', userId: 2, displayName: 'Jay' },
    split: { id: 's1', description: 'pizza', perPersonAmount: 8, currency: 'EUR', status, groupId: 7 },
    telegramChatId: -1001,
    memberStatuses: statuses,
  });

  function setup(c: PaymentContext | null) {
    const payments = { paymentContext: vi.fn(async () => c), settleSplit: vi.fn(async () => true) } satisfies PaymentStore;
    const memory = memoryStore([paid(10, 3)]);
    const posts: { chat: number; text: string }[] = [];
    const deps = { payments, memory, postToGroup: async (chat: number, text: string) => void posts.push({ chat, text }), now: () => NOW };
    return { payments, memory, posts, deps };
  }

  it('recomputes the payer’s memory and posts progress in the group', async () => {
    const { deps, memory, posts, payments } = setup(ctx(['paid', 'sent', 'cancelled']));
    const r = await handleInvoicePaid('INV2-1', deps);
    expect(memory.saveStats).toHaveBeenCalledWith(2, 7, expect.objectContaining({ totalSplits: 1, totalPaidOnTime: 1 }), 'chill');
    expect(payments.settleSplit).not.toHaveBeenCalled();
    expect(posts).toEqual([{ chat: -1001, text: '✅ Jay paid 8.00 EUR for "pizza" — 1/2 paid.' }]);
    expect(r).toMatchObject({ settled: false });
  });

  it('settles the split when the last person pays', async () => {
    const { deps, posts, payments } = setup(ctx(['paid', 'paid']));
    const r = await handleInvoicePaid('INV2-1', deps);
    expect(payments.settleSplit).toHaveBeenCalledWith('s1');
    expect(posts[0]!.text).toContain('2/2 paid.\n🎉 Everyone has paid — "pizza" is settled.');
    expect(r?.settled).toBe(true);
  });

  it('ignores invoices Siren does not know', async () => {
    const { deps, posts } = setup(null);
    expect(await handleInvoicePaid('INV2-UNKNOWN', deps)).toBeNull();
    expect(posts).toEqual([]);
  });

  it('members not linked to Telegram still count, but have no memory to update', async () => {
    const c = ctx(['paid', 'sent']);
    c.member.userId = null;
    const { deps, memory, posts } = setup(c);
    await handleInvoicePaid('INV2-1', deps);
    expect(memory.saveStats).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
  });
});

describe('/siren why (no LLM, redacted for the group)', () => {
  const thoughts: Thought[] = [
    {
      step: 1,
      reasoning: 'Jay [user_id 23] has reliability 0.3 and owes €6, link https://www.sandbox.paypal.com/invoice/p/#INV2-AB12-CD34',
      toolCalls: [
        {
          tool: 'telegram_dm',
          input: { split_member_id: '11111111-1111-4111-8111-111111111111', kind: 'reminder', message: 'still waiting on €6 — pay here https://pay/x' },
        },
      ],
      toolResults: [{ tool: 'telegram_dm', output: { ok: true, sent_to: 'Jay', kind: 'reminder' } }],
      toolErrors: [],
      tokens: { input: 3100, cached: 2048 },
      model: 'openai/gpt-oss-120b',
    },
    {
      step: 2,
      toolCalls: [{ tool: 'send_invoice_reminder', input: { invoice_id: 'INV2-AB12-CD34' } }],
      toolResults: [{ tool: 'send_invoice_reminder', output: { ok: false, error: 'rate limited: Jay was reminded at 2026-10-21' } }],
      toolErrors: [],
      tokens: {},
    },
  ];
  const text = formatWhy({ trigger: 'scheduled_run', createdAt: '2026-10-21T14:02:00Z', thoughts, finalResponse: 'Reminded Jay.' });

  it('shows the real steps: thought → tool call → result', () => {
    expect(text).toContain('My last decision (scheduled check, 21 Oct 14:02 UTC)');
    expect(text).toContain('Step 1 (openai/gpt-oss-120b · 3.1k in, 2.0k cached)\nthought: Jay [id] has reliability 0.3 and owes €6, link [link]');
    expect(text).toContain('→ telegram_dm (kind: reminder)\n← ✓ sent_to: Jay, kind: reminder');
    expect(text).toContain('→ send_invoice_reminder\n← ✗ rate limited: Jay was reminded at 2026-10-21');
    expect(text).toContain('Result: Reminded Jay.');
  });

  it('never shows DM wording, pay links, invoice numbers or internal ids', () => {
    for (const secret of ['still waiting', 'https://', 'INV2-', '11111111-', 'user_id 23', 'split_member_id']) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('handles a group with no decisions yet', () => {
    expect(formatWhy(null)).toMatch(/haven't made any decisions/);
  });

  it('redact() covers uuids, invoice ids, links and id labels', () => {
    expect(redact('see https://x.y/z INV2-AAAA-BBBB 22222222-2222-4222-8222-222222222222 user_id: 5')).toBe(
      'see [link] [invoice] [id] [id]',
    );
  });
});
