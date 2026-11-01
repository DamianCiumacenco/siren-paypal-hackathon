import { tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolOutcome, withToolLogging } from '../src/agent/tools/logged.js';
import type { Logger } from '../src/lib/safe-error.js';

function capture() {
  const lines: string[] = [];
  const log: Logger = {
    info: (o, m) => lines.push(`INFO ${m} ${JSON.stringify(o)}`),
    warn: (o, m) => lines.push(`WARN ${m} ${JSON.stringify(o)}`),
    error: (o, m) => lines.push(`ERROR ${m} ${JSON.stringify(o)}`),
  };
  return { log, lines };
}

const input = z.object({ message: z.string() });
const tools = {
  telegram_dm: tool({ inputSchema: input, execute: async () => ({ ok: true, sent_to: 'Jay Murphy', kind: 'reminder' }) }),
  limited: tool({ inputSchema: input, execute: async () => ({ ok: false, error: 'rate limited: Jay Murphy was reminded at 2026-10-21' }) }),
  refused: tool({ inputSchema: input, execute: async () => ({ ok: false, error: 'Jay Murphy is already paid — no DM sent' }) }),
  broken: tool({
    inputSchema: input,
    execute: async (): Promise<{ ok: boolean }> => {
      throw new Error('getMember(11111111) failed: timeout');
    },
  }),
};
const call = (t: unknown) =>
  (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({ message: 'still waiting on €60 for football, Jay Murphy' }, {});

describe('agent tool logging', () => {
  it('logs one structured line per call: tool, outcome, ms and ids', async () => {
    const { log, lines } = capture();
    const wrapped = withToolLogging(tools, log, { groupId: 7, splitId: 'split-1' });
    expect(await call(wrapped.telegram_dm)).toMatchObject({ ok: true });
    await call(wrapped.limited);
    await call(wrapped.refused);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^INFO agent tool call .*"tool":"telegram_dm","outcome":"ok","ms":\d+,"groupId":7,"splitId":"split-1"/);
    expect(lines[1]).toContain('"outcome":"rate_limited"');
    expect(lines[2]).toContain('"outcome":"refused"');
  });

  it('a throwing tool is logged (safe message) and rethrown so the model still sees the error', async () => {
    const { log, lines } = capture();
    const wrapped = withToolLogging(tools, log, { groupId: 7 });
    await expect(call(wrapped.broken)).rejects.toThrow('timeout');
    expect(lines).toEqual([expect.stringMatching(/^ERROR agent tool failed .*"tool":"broken".*"error":"Error: getMember\(11111111\) failed: timeout"/)]);
  });

  it('PII: never logs tool inputs or results (DM wording, names, amounts)', async () => {
    const { log, lines } = capture();
    const wrapped = withToolLogging(tools, log, { groupId: 7 });
    for (const t of Object.values(wrapped)) await call(t).catch(() => {});
    const out = lines.join('\n');
    for (const pii of ['Jay Murphy', 'Murphy', '€60', 'football', 'still waiting']) expect(out, pii).not.toContain(pii);
  });

  it('toolOutcome', () => {
    expect(toolOutcome({ ok: true })).toBe('ok');
    expect(toolOutcome([{ id: 1 }])).toBe('ok');
    expect(toolOutcome({ ok: false, error: 'rate limited: x' })).toBe('rate_limited');
    expect(toolOutcome({ ok: false, error: 'nope' })).toBe('refused');
  });
});
