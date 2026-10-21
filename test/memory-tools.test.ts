import { describe, expect, it, vi } from 'vitest';
import { createFetchGroupHistoryTool } from '../src/agent/tools/fetch_group_history.js';
import { createGetMemberProfileTool } from '../src/agent/tools/get_member_profile.js';
import { appendNote, createRememberPreferenceTool, MAX_NOTES_CHARS } from '../src/agent/tools/remember_preference.js';
import { createScheduleFollowupTool } from '../src/agent/tools/schedule_followup.js';
import { computeDebts, createSummariseDebtTool } from '../src/agent/tools/summarise_debt.js';
import type { HistorySplit, HistoryStore } from '../src/db/history.js';
import type { MemberProfile, MemoryStore } from '../src/db/memory.js';

const GROUP = 7;
const context = { groupId: GROUP, chatId: -100 };
const NOW = new Date('2026-10-21T12:00:00Z');
const opts = { toolCallId: 't', messages: [] } as never;
// ai@7 tool execute() returns a union with AsyncIterable; these tools return plain objects.
const run = async <T = Record<string, unknown>>(t: { execute?: unknown }, input: unknown) =>
  (await (t.execute as (i: unknown, o: unknown) => Promise<T>)(input, opts)) as T;

const split = (over: Partial<HistorySplit> & Pick<HistorySplit, 'members'>): HistorySplit => ({
  id: 's1',
  description: 'football',
  status: 'open',
  currency: 'EUR',
  perPersonAmount: 6,
  createdAt: '2026-10-19T10:00:00Z',
  creator: { userId: 1, name: 'Damian' },
  ...over,
});
const m = (name: string, userId: number | null, status: string, paidAt: string | null = null) => ({
  name,
  userId,
  status,
  paidAt,
  remindersSent: 0,
});

describe('computeDebts', () => {
  it('each unpaid share is owed to the split creator; paid/cancelled shares are not', () => {
    const debts = computeDebts([
      split({ members: [m('Jay', 2, 'sent'), m('Sean', 3, 'paid'), m('Mike', 4, 'cancelled')] }),
    ]);
    expect(debts).toEqual([{ from: 'Jay', to: 'Damian', amount: '6.00', currency: 'EUR', splits: 1 }]);
  });

  it('adds up across splits and nets opposite debts between the same two people', () => {
    const debts = computeDebts([
      split({ id: 'a', members: [m('Jay', 2, 'sent')] }), // Jay → Damian 6
      split({ id: 'b', perPersonAmount: 10, members: [m('Jay', 2, 'pending')] }), // Jay → Damian 10
      split({ id: 'c', perPersonAmount: 4.5, creator: { userId: 2, name: 'Jay' }, members: [m('Damian', 1, 'sent')] }), // Damian → Jay 4.50
    ]);
    expect(debts).toEqual([{ from: 'Jay', to: 'Damian', amount: '11.50', currency: 'EUR', splits: 3 }]);
  });

  it('keeps currencies separate and avoids float drift (integer cents)', () => {
    const debts = computeDebts([
      split({ id: 'a', perPersonAmount: 0.1, members: [m('Jay', 2, 'sent')] }),
      split({ id: 'b', perPersonAmount: 0.2, members: [m('Jay', 2, 'sent')] }),
      split({ id: 'c', currency: 'GBP', perPersonAmount: 5, members: [m('Jay', 2, 'sent')] }),
    ]);
    expect(debts).toContainEqual({ from: 'Jay', to: 'Damian', amount: '0.30', currency: 'EUR', splits: 2 });
    expect(debts).toContainEqual({ from: 'Jay', to: 'Damian', amount: '5.00', currency: 'GBP', splits: 1 });
  });

  it('fully cancelled-out debts disappear; unlinked members are tracked by name', () => {
    expect(
      computeDebts([
        split({ id: 'a', members: [m('Jay', 2, 'sent')] }),
        split({ id: 'b', creator: { userId: 2, name: 'Jay' }, members: [m('Damian', 1, 'sent')] }),
      ]),
    ).toEqual([]);
    expect(computeDebts([split({ members: [m('Bob', null, 'sent')] })])).toEqual([
      { from: 'Bob', to: 'Damian', amount: '6.00', currency: 'EUR', splits: 1 },
    ]);
  });
});

function historyStore(splits: HistorySplit[] = []) {
  return {
    splits: vi.fn(async () => splits),
    setNextNagAt: vi.fn(async (_id: string, groupId: number) => groupId === GROUP),
  } satisfies HistoryStore;
}

describe('summarise_debt tool', () => {
  it('reads only open splits of this group and reports netted debts', async () => {
    const store = historyStore([split({ members: [m('Jay', 2, 'sent')] })]);
    const res = await run(createSummariseDebtTool({ context, store }), {});
    expect(store.splits).toHaveBeenCalledWith(GROUP, { limit: 50, openOnly: true });
    expect(res).toEqual({ ok: true, open_splits: 1, debts: [{ from: 'Jay', to: 'Damian', amount: '6.00 EUR', splits: 1 }] });
  });
});

describe('fetch_group_history tool', () => {
  it('returns compact history with hours-to-pay, optionally for one member', async () => {
    const store = historyStore([
      split({ members: [m('Jay', 2, 'paid', '2026-10-19T17:00:00Z'), m('Sean', 3, 'sent')] }),
    ]);
    const res = await run<{ splits: { members: unknown[] }[] }>(createFetchGroupHistoryTool({ context, store }), { user_id: 2, limit: 5 });
    expect(store.splits).toHaveBeenCalledWith(GROUP, { limit: 5, userId: 2 });
    expect(res.splits[0]!.members).toEqual([{ name: 'Jay', status: 'paid', hours_to_pay: 7, reminders: 0 }]);
  });
});

const profile: MemberProfile = {
  userId: 2,
  name: 'Jay',
  username: null,
  reliabilityScore: 0.9412,
  preferredTone: 'chill',
  avgHoursToPay: 5.6,
  totalSplits: 17,
  totalPaidOnTime: 16,
  notes: '2026-10-01: payday is the 25th',
  updatedAt: null,
  outstanding: [{ splitId: 's1', description: 'football', amount: '6.00 EUR', status: 'sent', remindersSent: 0 }],
};

function memoryStore(p: MemberProfile | null = profile) {
  return {
    getProfile: vi.fn(async (_u: number, g: number) => (g === GROUP ? p : null)),
    updatePreference: vi.fn(async () => true),
  } satisfies MemoryStore;
}

describe('get_member_profile tool', () => {
  it('returns the learned profile (real numbers, not a template)', async () => {
    const res = await run(createGetMemberProfileTool({ context, store: memoryStore() }), { user_id: 2 });
    expect(res).toEqual({
      ok: true,
      name: 'Jay',
      reliability: 0.94,
      avg_hours_to_pay: 6,
      preferred_tone: 'chill',
      splits: 17,
      paid_on_time: 16,
      notes: '2026-10-01: payday is the 25th',
      owes_now: [{ description: 'football', amount: '6.00 EUR', status: 'sent', reminders: 0 }],
    });
  });

  it('refuses members of other groups', async () => {
    const res = await run(createGetMemberProfileTool({ context, store: memoryStore(null) }), { user_id: 99 });
    expect(res).toEqual({ ok: false, error: 'not a member of this group' });
  });
});

describe('remember_preference tool', () => {
  it('saves a tone and a dated note', async () => {
    const store = memoryStore();
    const res = await run(createRememberPreferenceTool({ context, store, now: () => NOW }), {
      user_id: 2,
      preferred_tone: 'direct',
      note: 'asked to be reminded on payday',
    });
    expect(store.updatePreference).toHaveBeenCalledWith(2, GROUP, {
      preferredTone: 'direct',
      notes: '2026-10-01: payday is the 25th\n2026-10-21: asked to be reminded on payday',
    });
    expect(res).toMatchObject({ ok: true, preferred_tone: 'direct' });
  });

  it('never writes for non-members', async () => {
    const store = memoryStore(null);
    expect(await run(createRememberPreferenceTool({ context, store }), { user_id: 99, preferred_tone: 'chill' })).toMatchObject({ ok: false });
    expect(store.updatePreference).not.toHaveBeenCalled();
  });

  it('schema: tone limited to chill/neutral/direct, and something must be given', () => {
    const schema = createRememberPreferenceTool({ context, store: memoryStore() }).inputSchema as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ user_id: 2, preferred_tone: 'aggressive' }).success).toBe(false);
    expect(schema.safeParse({ user_id: 2 }).success).toBe(false);
    expect(schema.safeParse({ user_id: 2, note: 'ok' }).success).toBe(false); // too short
  });

  it('notes are capped, dropping the oldest lines first', () => {
    let notes: string | null = null;
    for (let i = 0; i < 50; i++) notes = appendNote(notes, `note number ${i} ${'x'.repeat(20)}`, NOW);
    expect(notes!.length).toBeLessThanOrEqual(MAX_NOTES_CHARS);
    expect(notes).toContain('note number 49');
    expect(notes).not.toContain('note number 0 ');
  });
});

describe('schedule_followup tool', () => {
  it('sets the next follow-up time on an open split in this group', async () => {
    const store = historyStore();
    const res = await run(createScheduleFollowupTool({ context, store, now: () => NOW }), {
      split_id: '22222222-2222-4222-8222-222222222222',
      hours: 18,
      reason: 'Sean usually pays within a day',
    });
    expect(store.setNextNagAt).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', GROUP, new Date('2026-10-22T06:00:00Z'));
    expect(res).toEqual({ ok: true, split_id: '22222222-2222-4222-8222-222222222222', next_followup_at: '2026-10-22T06:00:00.000Z' });
  });

  it('reports failure when the split is not open / not in this group', async () => {
    const store = { ...historyStore(), setNextNagAt: vi.fn(async () => false) };
    const res = await run(createScheduleFollowupTool({ context, store }), {
      split_id: '22222222-2222-4222-8222-222222222222',
      hours: 5,
      reason: 'later',
    });
    expect(res).toMatchObject({ ok: false });
  });
});
