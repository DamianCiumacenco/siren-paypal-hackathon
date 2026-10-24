import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, memberRows, World } from './harness.js';

// SCOPE criterion 7: at least 2 different reminder tones for 2 different profiles.
describe('criterion 7 — chill vs direct reminders from memory (live)', () => {
  let w: World;
  let splitId: string;
  beforeAll(async () => {
    w = await World.create('Siren e2e c7', ['Damian', 'Jay', 'Sean']);
    // Real payment history, no hand-set scores or tones: 3 settled past splits where Sean
    // paid within hours and Jay paid days late. The scheduler pass recomputes memory from
    // this record (scoring.ts) and pickTone derives chill for Sean, direct for Jay.
    const day = 24 * 3_600_000;
    const at = (ms: number) => new Date(ms).toISOString();
    for (const [i, [seanH, jayH]] of [[2, 100], [4, 120], [6, 150]].entries()) {
      const created = Date.now() - (30 - i * 7) * day;
      const { data: past, error } = await db
        .from('splits')
        .insert({ group_id: w.groupId, creator_user_id: w.p('Damian').userId, description: `past ${i + 1}`, total_amount: 30, per_person_amount: 10, currency: 'EUR', status: 'settled', created_at: at(created) })
        .select('id')
        .single();
      if (error) throw new Error(`seed past split: ${error.message}`);
      await db.from('split_members').insert([
        { split_id: past.id, user_id: w.p('Sean').userId, display_name: 'Sean', status: 'paid', paid_at: at(created + seanH! * 3_600_000) },
        { split_id: past.id, user_id: w.p('Jay').userId, display_name: 'Jay', status: 'paid', paid_at: at(created + jayH! * 3_600_000) },
      ]);
    }
    splitId = (await w.openSplitViaCard('golf', 30, ['Jay', 'Sean'])).splitId;
    // Opened 50h ago: overdue enough to remind, still inside the 72h on-time window, so it
    // doesn't change either score.
    await db.from('splits').update({ created_at: new Date(Date.now() - 50 * 3_600_000).toISOString() }).eq('id', splitId);
  });

  const memoryOf = async (name: string) =>
    (await db.from('user_memory').select('reliability_score, preferred_tone, tone_locked').eq('group_id', w.groupId).eq('user_id', w.p(name).userId).single()).data!;
  afterAll(async () => w?.cleanup());

  it('one scheduled pass learns chill (Sean) vs direct (Jay) from their record and DMs both in those tones, each with their own link and exact share', async () => {
    const base = { jay: (await w.dms('Jay')).length, sean: (await w.dms('Sean')).length };
    const pass = await w.schedulerPass();
    expect(pass).toMatchObject({ agentRuns: 1, failed: 0 });

    // Tones were learned from the payment record, not stated (tone_locked stays false).
    const jayMem = await memoryOf('Jay');
    const seanMem = await memoryOf('Sean');
    expect(seanMem).toMatchObject({ preferred_tone: 'chill', tone_locked: false });
    expect(Number(seanMem.reliability_score)).toBeGreaterThan(0.8);
    expect(jayMem).toMatchObject({ preferred_tone: 'direct', tone_locked: false });
    expect(Number(jayMem.reliability_score)).toBeLessThan(0.4);

    const jayDms = await w.dms('Jay');
    const seanDms = await w.dms('Sean');
    expect(jayDms.length).toBe(base.jay + 1);
    expect(seanDms.length).toBe(base.sean + 1);
    const rows = await memberRows(splitId);
    const jay = jayDms.at(-1)!.text!;
    const sean = seanDms.at(-1)!.text!;
    expect(jay).toContain(rows.find((m) => m.display_name === 'Jay')!.payment_link!);
    expect(sean).toContain(rows.find((m) => m.display_name === 'Sean')!.payment_link!);
    for (const t of [jay, sean]) {
      expect(t).toContain('€10.00');
      expect(t.match(/€\s?\d+(?:\.\d+)?/g)!.every((a) => a.replace(/\s/g, '') === '€10.00' || a.replace(/\s/g, '') === '€10')).toBe(true);
    }

    // Different wording once names/links/amounts are removed, and the direct one isn't the chill "no rush".
    const norm = (t: string) => t.replace(/https?:\/\/\S+/g, '').replace(/Jay|Sean/g, '').replace(/€\s?[\d.]+/g, '').toLowerCase().replace(/\W+/g, ' ').trim();
    expect(norm(jay)).not.toBe(norm(sean));
    expect(jay).not.toMatch(/no rush|whenever|no worries/i);
  });
});
