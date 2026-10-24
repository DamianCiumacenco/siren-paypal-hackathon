import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, World } from './harness.js';

// SCOPE criterion 6: /siren about <name> returns a real learned profile, not a template.
describe('criterion 6 — /siren about <name> uses learned memory (live)', () => {
  let w: World;
  beforeAll(async () => {
    w = await World.create('Siren e2e c6', ['Damian', 'Jay', 'Sean']);
    // What Siren has learned about each of them in this group (different on purpose).
    await db.from('user_memory').update({ reliability_score: 0.94, avg_hours_to_pay: 6, total_splits: 17, total_paid_ontime: 16, preferred_tone: 'chill', notes: '2026-10-01: gets paid on the 25th' })
      .eq('group_id', w.groupId).eq('user_id', w.p('Jay').userId);
    await db.from('user_memory').update({ reliability_score: 0.31, avg_hours_to_pay: 70, total_splits: 9, total_paid_ontime: 3, preferred_tone: 'direct', notes: '2026-09-12: prefers reminders by DM only' })
      .eq('group_id', w.groupId).eq('user_id', w.p('Sean').userId);
    const { data: past } = await db.from('splits')
      .insert({ group_id: w.groupId, creator_user_id: w.p('Damian').userId, description: 'bowling', total_amount: 30, per_person_amount: 10, currency: 'EUR', status: 'settled', created_at: '2026-10-10T18:00:00Z' })
      .select('id').single();
    await db.from('split_members').insert([
      { split_id: past!.id, user_id: w.p('Jay').userId, display_name: 'Jay', status: 'paid', paid_at: '2026-10-11T00:00:00Z' },
      { split_id: past!.id, user_id: w.p('Sean').userId, display_name: 'Sean', status: 'paid', paid_at: '2026-10-13T16:00:00Z' },
    ]);
  });
  afterAll(async () => w?.cleanup());

  it("Jay's profile cites what was learned about Jay (and not Sean's)", async () => {
    const before = await w.groupMessageCount();
    await w.say('Damian', `/siren about Jay`);
    const reply = await w.groupMessage(/Jay/, '/siren about reply', before);
    const text = reply.text!;
    expect(text).toMatch(/0\.94|94\s?%/); // his reliability
    expect(text).toMatch(/25th/); // his note
    expect(text).not.toMatch(/0\.31|31\s?%|DM only/); // not Sean's data → not a template
    expect(text).not.toMatch(/user_id|split_member_id|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
