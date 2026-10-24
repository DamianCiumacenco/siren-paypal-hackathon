import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberRows, waitFor, World } from './harness.js';

// SCOPE criterion 2: each named person gets a working PayPal payment link in DM.
describe('criterion 2 — ✅ → real sandbox invoice + pay link DMed to each member (live)', () => {
  let w: World;
  beforeAll(async () => {
    w = await World.create('Siren e2e c2', ['Damian', 'Jay', 'Sean', 'Mike']);
  });
  afterAll(async () => w?.cleanup());

  it('only the creator can confirm; then each member gets their own link by DM', async () => {
    const splitId = await w.seedDraft('football', 24, ['Jay', 'Sean', 'Mike']);
    const card = { method: 'sendMessage', chatId: w.chatId, text: 'New split: football', at: new Date().toISOString() };

    // Jay taps ✅ on Damian's card: refused, nothing sent.
    await w.tap('Jay', `split:confirm:${splitId}`, card);
    await new Promise((r) => setTimeout(r, 3_000));
    expect((await memberRows(splitId)).every((m) => m.paypal_invoice_id === null)).toBe(true);

    await w.tap('Damian', `split:confirm:${splitId}`, card);
    const rows = await waitFor(
      'invoices for all 3 members',
      async () => {
        const r = await memberRows(splitId);
        return r.every((m) => m.paypal_invoice_id && m.status === 'sent') ? r : undefined;
      },
      120_000,
    );

    for (const m of rows) {
      expect(m.paypal_invoice_id).toMatch(/^INV2-/);
      expect(m.payment_link).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/invoice\/p\/#INV2-/);
      const dms = await waitFor(`DM to ${m.display_name}`, async () => {
        const d = await w.dms(m.display_name);
        return d.length ? d : undefined;
      });
      expect(dms).toHaveLength(1);
      // Their own link and exact share (€24 / 4 = €6.00), nobody else's link.
      expect(dms[0]!.text).toContain(m.payment_link!);
      expect(dms[0]!.text).toContain('€6.00');
      for (const other of rows.filter((o) => o.id !== m.id)) expect(dms[0]!.text).not.toContain(other.payment_link!);
    }
    // The creator is never invoiced or DMed a link.
    expect(await w.dms('Damian')).toHaveLength(0);

    // The pay link is a real, reachable sandbox invoice page.
    const page = await fetch(rows[0]!.payment_link!, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    expect(page.status).toBe(200);

    const summary = await w.groupMessage(/PayPal requests for "football" are out \(3\)/, 'group summary');
    expect(summary.text).not.toMatch(/sandbox\.paypal\.com/); // links went by DM, not to the group
  });
});
