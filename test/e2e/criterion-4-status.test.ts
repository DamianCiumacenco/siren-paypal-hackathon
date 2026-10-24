import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberRows, payInvoice, waitFor, World } from './harness.js';

// SCOPE criterion 4: /status shows who paid / who hasn't. Deterministic (no LLM) since
// milestone 13, and the creator's own share is never shown as a debt.
describe('criterion 4 — /status from the database (live)', () => {
  let w: World;
  beforeAll(async () => {
    w = await World.create('Siren e2e c4', ['Damian', 'Jay', 'Sean']);
  });
  afterAll(async () => w?.cleanup());

  it('shows Jay paid, Sean owing, Damian (creator) owing nothing', async () => {
    const { splitId, members } = await w.openSplitViaCard('bowling', 30, ['Jay', 'Sean']);
    const jay = members.find((m) => m.display_name === 'Jay')!;
    await payInvoice(jay.paypal_invoice_id!, 10);
    await waitFor('Jay paid', async () => ((await memberRows(splitId)).find((m) => m.id === jay.id)?.status === 'paid' ? true : undefined), 180_000, 3_000);

    const before = await w.groupMessageCount();
    const asked = Date.now();
    await w.say('Sean', '/status');
    const status = await w.groupMessage(/"bowling"/, '/status reply', before, 20_000);
    expect(Date.now() - asked).toBeLessThan(20_000); // no LLM round trip

    const text = status.text!;
    expect(text).toContain('"bowling" — €30.00 total, €10.00 each · 1/2 paid');
    expect(text).toContain('- Jay — paid ✅');
    expect(text).toContain('- Sean — owes €10.00');
    expect(text).toContain('- Damian — paid the bill (own share, nothing owed)');
    expect(text).not.toMatch(/Damian\b[^\n]*\bowes?\b(?! nothing)/i); // creator-share rule
    expect(text).not.toMatch(/sandbox\.paypal\.com|INV2-/); // no links or invoice ids in the group
  });
});
