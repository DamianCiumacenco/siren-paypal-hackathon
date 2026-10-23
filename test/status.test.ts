import { describe, expect, it } from 'vitest';
import { buildContextBlock, STABLE_SYSTEM_PROMPT } from '../src/agent/system-prompt.js';
import { computeDebts } from '../src/agent/tools/summarise_debt.js';
import type { AgentInput, GroupContext } from '../src/agent/types.js';
import { formatStatus } from '../src/bot/handlers/status.js';
import type { HistorySplit } from '../src/db/history.js';

const split = (over: Partial<HistorySplit> = {}): HistorySplit => ({
  id: 's1',
  description: 'e2e test',
  status: 'open',
  currency: 'EUR',
  totalAmount: 2,
  perPersonAmount: 1,
  createdAt: '2026-10-23T10:46:57Z',
  creator: { userId: 1, name: 'Demo' },
  members: [{ name: 'Jay', userId: 2, status: 'sent', paidAt: null, remindersSent: 0 }],
  ...over,
});
const paidJay = { name: 'Jay', userId: 2, status: 'paid', paidAt: '2026-10-23T10:56:39Z', remindersSent: 0 };

/** "Demo still owes €1", "Demo — owes", "Demo owes €1.00 (you)"… — the production bug. */
const creatorOwes = (text: string) => /Demo\b[^\n]*\bowes?\b(?! nothing)/i.test(text);

describe('/status (deterministic)', () => {
  it('open split: unpaid members owe their share, progress counts invoiced members only', () => {
    const text = formatStatus([split()]);
    expect(text).toContain('"e2e test" — €2.00 total, €1.00 each · 0/1 paid');
    expect(text).toContain('- Jay — owes €1.00');
  });

  it('settled split (the live e2e case): no open splits, most recent shown as settled', () => {
    const text = formatStatus([split({ status: 'settled', members: [paidJay] })]);
    expect(text).toMatch(/^No open splits — nobody owes anything\./);
    expect(text).toContain('· settled 🎉');
    expect(text).toContain('- Jay — paid ✅');
  });

  it('shows only open splits when there are any, newest first', () => {
    const text = formatStatus([
      split({ id: 'a', description: 'pizza' }),
      split({ id: 'b', description: 'golf', status: 'settled', members: [paidJay] }),
    ]);
    expect(text).toContain('"pizza"');
    expect(text).not.toContain('"golf"');
  });

  it('failed pay requests and cancellations are labelled, other currencies formatted', () => {
    const text = formatStatus([
      split({
        currency: 'GBP',
        members: [
          { name: 'Sean', userId: 3, status: 'failed', paidAt: null, remindersSent: 0 },
          { name: 'Mike', userId: 4, status: 'cancelled', paidAt: null, remindersSent: 0 },
        ],
      }),
    ]);
    expect(text).toContain("- Sean — owes £1.00 (pay request didn't go out)");
    expect(text).toContain('- Mike — cancelled');
    expect(text).toContain('0/1 paid');
  });

  it('empty group', () => {
    expect(formatStatus([])).toMatch(/No splits in this group yet/);
  });
});

describe('creator share is never a debt', () => {
  it('/status: the creator is shown as having paid the bill, never as owing', () => {
    for (const s of [split(), split({ status: 'settled', members: [paidJay] }), split({ members: [] })]) {
      const text = formatStatus([s]);
      expect(text).toContain('- Demo — paid the bill (own share, nothing owed)');
      expect(creatorOwes(text)).toBe(false);
    }
  });

  it('/status: a creator who is (unusually) also an invoiced member is listed once, from their row', () => {
    const text = formatStatus([split({ members: [{ name: 'Demo', userId: 1, status: 'paid', paidAt: null, remindersSent: 0 }] })]);
    expect(text.match(/Demo/g)).toHaveLength(1);
  });

  it('summarise_debt: the creator never appears as owing, even with a row for themselves', () => {
    const debts = computeDebts([
      split(),
      split({ id: 's2', members: [{ name: 'Demo', userId: 1, status: 'sent', paidAt: null, remindersSent: 0 }] }),
    ]);
    expect(debts).toEqual([{ from: 'Jay', to: 'Demo', amount: '1.00', currency: 'EUR', splits: 1 }]);
    expect(debts.some((d) => d.from === 'Demo')).toBe(false);
  });

  it('agent context + prompt state that the bill payer owes nothing', () => {
    const ctx: GroupContext = {
      members: [],
      openSplits: [
        {
          id: 's1', description: 'e2e test', currency: 'EUR', totalAmount: 2, perPersonAmount: 1,
          createdAt: '2026-10-23T10:46:57Z', creatorName: 'Demo', members: [],
        },
      ],
      recentReasoning: [],
    };
    const input: AgentInput = { trigger: 'user_message', userMessage: 'who still owes?', context: { groupId: 1, chatId: -1 } };
    expect(buildContextBlock(input, ctx)).toContain('bill paid by Demo (owes nothing; only the people below can owe)');
    expect(STABLE_SYSTEM_PROMPT).toMatch(/Their own share is NOT a debt/);
  });

  it('the detector catches the production wording', () => {
    expect(creatorOwes('Demo – still owes €1 (you)')).toBe(true);
    expect(creatorOwes('Demo still owes €1')).toBe(true);
    expect(creatorOwes('- Demo — paid the bill (own share, nothing owed)')).toBe(false);
  });
});
