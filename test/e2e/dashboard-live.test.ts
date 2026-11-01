import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, World } from './harness.js';

// Milestone 15 (not a SCOPE criterion): /siren dashboard → DM'd signed link → that group's data.
describe('dashboard — /siren dashboard link opens this group only (live)', () => {
  let w: World;
  let other: World;
  beforeAll(async () => {
    w = await World.create('Siren e2e dash', ['Damian', 'Jay']);
    other = await World.create('Siren e2e dash other', ['Damian', 'Sean']);
    await w.openSplitViaCard('kebabs', 20, ['Jay']);
  });
  afterAll(async () => {
    await w?.cleanup();
    await other?.cleanup();
  });

  it('DMs a link (never posted in the group); the link shows this group and nothing else', async () => {
    const before = await w.groupMessageCount();
    const dmsBefore = (await w.dms('Damian')).length;
    await w.say('Damian', '/siren dashboard');
    const confirm = await w.groupMessage(/dashboard link in a DM/, 'group confirmation', before, 20_000);
    expect(confirm.text).not.toContain('/dashboard#t=');

    const dm = (await w.dms('Damian')).slice(dmsBefore).find((m) => /\/dashboard#t=/.test(m.text ?? ''))!;
    expect(dm).toBeDefined();
    const url = /(https?:\/\/\S+\/dashboard)#t=(\S+)/.exec(dm.text!)!;
    expect(url[1]).toBe(`${BASE_URL}/dashboard`);

    const page = await fetch(url[1]!);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('ag-grid-community@32.3.3');

    const res = await fetch(`${BASE_URL}/dashboard/api`, { headers: { 'x-dashboard-token': url[2]! } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { group: { title: string }; splits: { description: string; owing: string; paidBy: string }[]; members: { name: string; owes: string }[] };
    expect(data.group.title).toBe('Siren e2e dash');
    expect(data.splits).toEqual([expect.objectContaining({ description: 'kebabs', owing: 'Jay', paidBy: 'Damian' })]);
    expect(data.members.find((m) => m.name === 'Jay')!.owes).toBe('€10.00');
    expect(data.members.find((m) => m.name === 'Damian')!.owes).toBe(''); // creator-share rule
    expect(data.members.some((m) => m.name === 'Sean')).toBe(false); // the other group's member
    expect(JSON.stringify(data)).not.toMatch(/sandbox\.paypal\.com|INV2-/);

    // The token can't be bent to the other group.
    const [, exp, sig] = url[2]!.split('.');
    const forged = await fetch(`${BASE_URL}/dashboard/api`, { headers: { 'x-dashboard-token': `${other.groupId}.${exp}.${sig}` } });
    expect(forged.status).toBe(403);
  });
});
