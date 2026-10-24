import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bot, db, World } from './harness.js';

// SCOPE criterion 1: a natural-language group message is parsed correctly.
describe('criterion 1 — natural-language message → split (live)', () => {
  let w: World;
  beforeAll(async () => {
    w = await World.create('Siren e2e c1', ['Damian', 'Jay', 'Sean', 'Mike']);
  });
  afterAll(async () => w?.cleanup());

  it('"@bot split €36 for pizza between me, Jay, Sean and Mike" → draft split, members resolved, €9 each, card', async () => {
    const before = await w.groupMessageCount();
    await w.say('Damian', `@${bot()} can you split €36 for pizza between me, Jay, Sean and Mike`);
    const card = await w.card(before);

    const { data: splits } = await db
      .from('splits')
      .select('id, status, total_amount, per_person_amount, currency, creator_user_id, split_members(display_name, user_id, status, paypal_invoice_id)')
      .eq('group_id', w.groupId);
    expect(splits).toHaveLength(1);
    const s = splits![0]!;
    expect(s.status).toBe('draft'); // nothing goes out before ✅
    expect(Number(s.total_amount)).toBe(36);
    expect(Number(s.per_person_amount)).toBe(9); // 4 people incl. the sender
    expect(s.currency).toBe('EUR');
    expect(Number(s.creator_user_id)).toBe(w.p('Damian').userId);

    // Members resolved to the real registered users (not just names), creator not invoiced.
    const members = s.split_members as { display_name: string; user_id: number; status: string; paypal_invoice_id: string | null }[];
    expect(members.map((m) => [m.display_name, Number(m.user_id)]).sort()).toEqual(
      ['Jay', 'Mike', 'Sean'].map((n) => [n, w.p(n).userId]).sort(),
    );
    expect(members.every((m) => m.status === 'pending' && m.paypal_invoice_id === null)).toBe(true);

    // The card is wired to this split and shows the right share.
    expect(card.buttons).toEqual([`split:confirm:${s.id}`, `split:cancel:${s.id}`]);
    expect(card.text).toMatch(/9\.00|€9\b/);
    expect(card.text).toMatch(/Jay/);
  });
});
