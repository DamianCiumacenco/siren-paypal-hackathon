import { describe, expect, it, vi } from 'vitest';
import {
  createSendSplitInvoicesTool,
  resolveParticipants,
  sendSplitInvoicesInput,
  type SplitProposal,
} from '../src/agent/tools/send_split_invoices.js';
import type { DraftSplit, GroupMember, SplitStore } from '../src/db/splits.js';

const member = (userId: number, firstName: string, username: string | null = null): GroupMember => ({
  userId,
  telegramUserId: 1000 + userId,
  firstName,
  username,
  paypalEmail: null,
});
const DAMIAN = member(1, 'Damian', 'damianc');
const MEMBERS = [DAMIAN, member(2, 'Jay', 'jayo'), member(3, 'Sean'), member(4, 'Mike', 'mikey'), member(5, 'Mike', 'mike_b')];

describe('resolveParticipants', () => {
  it('matches first names and @usernames case-insensitively', () => {
    const r = resolveParticipants(['jay', '@SEAN', '@mikey'], MEMBERS, DAMIAN.userId);
    expect(r).toEqual({
      ok: true,
      senderListed: false,
      notInGroup: [],
      members: [
        { displayName: 'Jay', userId: 2 },
        { displayName: 'Sean', userId: 3 },
        { displayName: 'Mike', userId: 4 },
      ],
    });
  });

  it('asks instead of guessing when a first name matches two members', () => {
    const r = resolveParticipants(['Mike'], MEMBERS, DAMIAN.userId);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/matches 2 members/) });
  });

  it('never invoices the sender ("me", their name or @username)', () => {
    for (const names of [['me', 'Jay'], ['Damian', 'Jay'], ['@damianc', 'Jay']]) {
      const r = resolveParticipants(names, MEMBERS, DAMIAN.userId);
      expect(r).toMatchObject({ ok: true, senderListed: true, members: [{ displayName: 'Jay', userId: 2 }] });
    }
  });

  it('keeps unknown names (no Telegram link) and dedupes repeats', () => {
    const r = resolveParticipants(['Bob', 'jay', 'Jay'], MEMBERS, DAMIAN.userId);
    expect(r).toMatchObject({
      ok: true,
      notInGroup: ['Bob'],
      members: [
        { displayName: 'Bob', userId: null },
        { displayName: 'Jay', userId: 2 },
      ],
    });
  });
});

function setup() {
  const drafts: DraftSplit[] = [];
  const store = {
    groupMembers: vi.fn(async () => MEMBERS),
    createDraft: vi.fn(async (d: DraftSplit) => (drafts.push(d), '22222222-2222-4222-8222-222222222222')),
  } as unknown as SplitStore;
  const t = createSendSplitInvoicesTool({ context: { groupId: 7, chatId: -100 }, store, senderUserId: DAMIAN.userId });
  const run = (input: Record<string, unknown>) =>
    t.execute!(sendSplitInvoicesInput.parse(input), { toolCallId: 't', messages: [] } as never) as Promise<SplitProposal>;
  return { drafts, run };
}

describe('send_split_invoices tool', () => {
  it('refuses on scheduled/webhook runs (no sender) — offered anyway so the tool list never changes', async () => {
    const store = { groupMembers: vi.fn(), createDraft: vi.fn() } as unknown as SplitStore;
    const t = createSendSplitInvoicesTool({ context: { groupId: 7, chatId: -100 }, store });
    const res = await t.execute!(
      sendSplitInvoicesInput.parse({ description: 'x', total_amount: 10, currency: 'EUR', participants: ['Jay'] }),
      { toolCallId: 't', messages: [] } as never,
    );
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/only a person/) });
    expect(store.createDraft).not.toHaveBeenCalled();
  });

  it('saves a DRAFT with equal shares incl. the sender, and invoices only the others', async () => {
    const { drafts, run } = setup();
    const res = await run({ description: 'football', total_amount: 60, currency: 'EUR', participants: ['Jay', 'Sean', '@mikey'] });
    expect(res).toMatchObject({
      ok: true,
      status: 'awaiting_confirmation',
      split_id: '22222222-2222-4222-8222-222222222222',
      per_person: '15.00 EUR',
      people: 4,
      invoices_to: ['Jay', 'Sean', 'Mike'],
      not_in_group: [],
    });
    expect(drafts[0]).toMatchObject({ groupId: 7, creatorUserId: 1, totalAmount: 60, perPersonAmount: 15, currency: 'EUR' });
    expect(drafts[0]!.members.map((m) => m.userId)).toEqual([2, 3, 4]);
  });

  it('splits only among the others when the sender had no share', async () => {
    const { run } = setup();
    const res = await run({ description: 'gift', total_amount: 20, currency: 'GBP', participants: ['Jay', 'Sean'], include_sender: false });
    expect(res).toMatchObject({ ok: true, per_person: '10.00 GBP', people: 2 });
  });

  it('rounds shares to the cent', async () => {
    const { run } = setup();
    expect(await run({ description: 'pizza', total_amount: 10, currency: 'USD', participants: ['Jay', 'Sean'] })).toMatchObject({
      per_person: '3.33 USD',
    });
  });

  it('only one proposal per agent run', async () => {
    const { run, drafts } = setup();
    await run({ description: 'a', total_amount: 10, currency: 'EUR', participants: ['Jay'] });
    expect(await run({ description: 'b', total_amount: 10, currency: 'EUR', participants: ['Jay'] })).toMatchObject({ ok: false });
    expect(drafts).toHaveLength(1);
  });

  it('refuses a split with nobody else to invoice', async () => {
    const { run, drafts } = setup();
    expect(await run({ description: 'a', total_amount: 10, currency: 'EUR', participants: ['me'] })).toMatchObject({ ok: false });
    expect(drafts).toHaveLength(0);
  });

  it('schema enforces SCOPE limits: EUR/USD/GBP only, max 20 people, positive amounts', () => {
    const base = { description: 'x', total_amount: 10, currency: 'EUR', participants: ['Jay'] };
    expect(sendSplitInvoicesInput.safeParse({ ...base, currency: 'JPY' }).success).toBe(false);
    expect(sendSplitInvoicesInput.safeParse({ ...base, total_amount: -5 }).success).toBe(false);
    expect(sendSplitInvoicesInput.safeParse({ ...base, participants: Array(20).fill('x') }).success).toBe(false);
    expect(sendSplitInvoicesInput.safeParse({ ...base, participants: Array(19).fill('x') }).success).toBe(true);
  });
});
