import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, llmBreather, memberRows, World } from './harness.js';

// SCOPE criterion 5: the agent autonomously decides to nag, and the reasoning is visible
// via /siren why. Also: the 1-reminder-per-user-per-24h rate limit and group isolation.
describe('criterion 5 — scheduled run → autonomous nag → reasoning_log → /siren why (live)', () => {
  let a: World;
  let b: World;
  let aSplit: string;
  let bSplit: string;
  beforeAll(async () => {
    a = await World.create('Siren e2e c5 A', ['Damian', 'Jay', 'Sean']);
    b = await World.create('Siren e2e c5 B', ['Damian', 'Mike']);
    aSplit = (await a.openSplitViaCard('golf', 30, ['Jay', 'Sean'])).splitId;
    bSplit = (await b.openSplitViaCard('karting', 20, ['Mike'])).splitId;
    // Make both overdue (opened 50h ago). In A, Sean was already reminded 2h ago.
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    for (const id of [aSplit, bSplit]) await db.from('splits').update({ created_at: ago(50) }).eq('id', id);
    await db.from('split_members').update({ reminders_sent: 1, last_reminded_at: ago(2) }).eq('split_id', aSplit).eq('display_name', 'Sean');
    await db.from('user_memory').update({ reliability_score: 0.4, preferred_tone: 'neutral' }).eq('group_id', a.groupId).eq('user_id', a.p('Jay').userId);
  });
  afterAll(async () => {
    await a?.cleanup();
    await b?.cleanup();
  });

  const dmCounts = async () => ({
    jay: (await a.dms('Jay')).length,
    sean: (await a.dms('Sean')).length,
    mike: (await b.dms('Mike')).length,
  });

  it("group A's scheduled pass: agent reminds overdue Jay on its own; Sean (reminded 2h ago) is not; group B untouched", async () => {
    const base = await dmCounts(); // the ✅ pay-link DMs
    const groupBBefore = await b.groupMessageCount();

    const pass = await a.schedulerPass();
    expect(pass).toMatchObject({ checked: 1, agentRuns: 1, failed: 0, stoppedForQuota: false });

    const after = await dmCounts();
    expect(after.jay).toBe(base.jay + 1); // the autonomous reminder
    expect(after.sean).toBe(base.sean); // 24h cap: no second reminder within 24h
    expect(after.mike).toBe(base.mike); // isolation: A's run never touches B's members
    expect(await b.groupMessageCount()).toBe(groupBBefore);

    const jayRow = (await memberRows(aSplit)).find((m) => m.display_name === 'Jay')!;
    const reminder = (await a.dms('Jay')).at(-1)!;
    expect(reminder.text).toContain(jayRow.payment_link!); // his own link, from the DB
    expect(reminder.text).toContain('€10.00');
    expect(jayRow.reminders_sent).toBe(1);
    expect(jayRow.last_reminded_at).not.toBeNull();

    const post = await a.groupMessage(/Jay/, 'group post about the reminder');
    expect(post.text).not.toMatch(/sandbox\.paypal\.com|INV2-/); // the DM stays private

    const { data: logs } = await db.from('reasoning_log').select('trigger, thoughts').eq('group_id', a.groupId).eq('trigger', 'scheduled_run');
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs![0]!.thoughts)).toContain('telegram_dm');
  });

  it('/siren why in group A surfaces that scheduled decision (no LLM)', async () => {
    const before = await a.groupMessageCount();
    await a.say('Damian', '/siren why');
    const why = await a.groupMessage(/My last decision/, '/siren why reply', before, 20_000);
    expect(why.text).toMatch(/scheduled check/);
    expect(why.text).toMatch(/telegram_dm/);
    expect(why.text).not.toMatch(/sandbox\.paypal\.com|INV2-|[0-9a-f]{8}-[0-9a-f]{4}-/); // redacted
  });

  it('rate limit: an immediate second pass makes no LLM call and sends nothing', async () => {
    const base = await dmCounts();
    const pass = await a.schedulerPass();
    expect(pass.agentRuns).toBe(0);
    expect(await dmCounts()).toEqual(base);
  });

  it("group B's pass reminds only Mike; A's members get nothing", async () => {
    await llmBreather();
    const base = await dmCounts();
    const pass = await b.schedulerPass();
    expect(pass).toMatchObject({ checked: 1, agentRuns: 1, failed: 0 });
    const after = await dmCounts();
    expect(after.mike).toBe(base.mike + 1);
    expect([after.jay, after.sean]).toEqual([base.jay, base.sean]);
    expect((await memberRows(bSplit))[0]!.reminders_sent).toBe(1);
    const { data: aLogs } = await db.from('reasoning_log').select('id').eq('group_id', a.groupId);
    expect(aLogs).toHaveLength(1); // B's run was logged under B, not A
  });
});
