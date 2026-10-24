import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, memberRows, payInvoice, waitFor, World } from './harness.js';

// SCOPE criterion 3: sandbox payment → webhook fires → group status updates.
describe('criterion 3 — sandbox payment → real PayPal webhook → DB + group post (live)', () => {
  let w: World;
  beforeAll(async () => {
    w = await World.create('Siren e2e c3', ['Damian', 'Jay', 'Sean']);
  });
  afterAll(async () => w?.cleanup());

  it('Jay pays → "1/2 paid"; Sean pays → split settled + 🎉; memory recomputed', async () => {
    const { splitId, members } = await w.openSplitViaCard('cinema', 30, ['Jay', 'Sean']);
    const jay = members.find((m) => m.display_name === 'Jay')!;
    const sean = members.find((m) => m.display_name === 'Sean')!;
    const before = await w.groupMessageCount();

    await payInvoice(jay.paypal_invoice_id!, 10);
    await waitFor('Jay marked paid by the webhook', async () => ((await memberRows(splitId)).find((m) => m.id === jay.id)?.status === 'paid' ? true : undefined), 180_000, 3_000);
    const post1 = await w.groupMessage(/Jay paid/, 'group post for Jay', before, 30_000);
    expect(post1.text).toMatch(/1\/2 paid/);
    expect(post1.text).toContain('10.00');

    const { data: mem } = await db.from('user_memory').select('total_paid_ontime').eq('user_id', w.p('Jay').userId).eq('group_id', w.groupId).single();
    expect(mem!.total_paid_ontime).toBeGreaterThanOrEqual(1);

    await payInvoice(sean.paypal_invoice_id!, 10);
    await waitFor('split settled', async () => {
      const { data } = await db.from('splits').select('status').eq('id', splitId).single();
      return data?.status === 'settled' ? true : undefined;
    }, 180_000, 3_000);
    const post2 = await w.groupMessage(/🎉/, 'settled post', before, 30_000);
    expect(post2.text).toMatch(/settled/);
  });
});
