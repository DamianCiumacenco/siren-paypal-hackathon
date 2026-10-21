import { describe, expect, it, vi } from 'vitest';
import type { AgentOutput } from '../src/agent/run.js';
import type { AgentInput } from '../src/agent/types.js';
import { parseConfig } from '../src/config.js';
import type { MemoryStore } from '../src/db/memory.js';
import type { SplitToCheck } from '../src/db/scheduler.js';
import { ChatLock } from '../src/lib/chat-lock.js';
import type { Logger } from '../src/lib/safe-error.js';
import { AllProvidersExhaustedError } from '../src/llm/failover.js';
import { runScheduledPass, skipReason, startScheduler } from '../src/scheduler/runner.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const split = (over: Partial<SplitToCheck> = {}): SplitToCheck => ({
  id: 'split-golf',
  groupId: 7,
  telegramChatId: -1007,
  description: 'golf',
  perPersonAmount: 10,
  currency: 'EUR',
  createdAt: hoursAgo(50),
  nextNagAt: null,
  unpaid: [{ name: 'Jay Murphy', userId: 2, lastRemindedAt: null, remindersSent: 0 }],
  ...over,
});

const acted: AgentOutput = {
  response: 'Reminded Jay Murphy. (user_id 2)',
  thoughts: [
    {
      step: 1,
      toolCalls: [{ tool: 'telegram_dm', input: {} }],
      toolResults: [{ tool: 'telegram_dm', output: { ok: true, sent_to: 'Jay Murphy', kind: 'reminder' } }],
      toolErrors: [],
      tokens: {},
    },
  ],
};
const waited: AgentOutput = {
  response: 'Too early — checking again tomorrow.',
  thoughts: [
    {
      step: 1,
      toolCalls: [{ tool: 'schedule_followup', input: {} }],
      toolResults: [{ tool: 'schedule_followup', output: { ok: true } }],
      toolErrors: [],
      tokens: {},
    },
  ],
};

function setup(splits: SplitToCheck[], runAgent: (i: AgentInput) => Promise<AgentOutput> = async () => acted) {
  const logs: string[] = [];
  const log: Logger = {
    info: (o, m) => logs.push(JSON.stringify({ ...o, msg: m })),
    warn: (o, m) => logs.push(JSON.stringify({ ...o, msg: m })),
    error: (o, m) => logs.push(JSON.stringify({ ...o, msg: m })),
  };
  const posts: { chat: number; text: string }[] = [];
  const memory = {
    getProfile: vi.fn(),
    updatePreference: vi.fn(),
    paymentRecord: vi.fn(async () => []),
    saveStats: vi.fn(async (_userId: number, _groupId: number, _stats: unknown, _tone?: string) => {}),
    isToneLocked: vi.fn(async () => false),
  } satisfies MemoryStore;
  const lock = new ChatLock();
  const deps = {
    store: { openSplits: vi.fn(async () => splits) },
    memory,
    runAgent: vi.fn(runAgent),
    postToGroup: async (chat: number, text: string) => void posts.push({ chat, text }),
    lock,
    log,
    now: () => NOW,
  };
  return { deps, posts, logs, lock, memory };
}

describe('skipReason (decided without an LLM call)', () => {
  it('runs the agent for an overdue split nobody has been reminded about', () => {
    expect(skipReason(split(), NOW)).toBeUndefined();
  });
  it('respects a follow-up the agent scheduled for later', () => {
    expect(skipReason(split({ nextNagAt: hoursAgo(-3) }), NOW)).toBe('followup_scheduled');
    expect(skipReason(split({ nextNagAt: hoursAgo(1) }), NOW)).toBeUndefined(); // due now
  });
  it('skips when every unpaid member was reminded in the last 24h (nothing it could do)', () => {
    expect(skipReason(split({ unpaid: [{ name: 'Jay', userId: 2, lastRemindedAt: hoursAgo(5), remindersSent: 1 }] }), NOW)).toBe(
      'all_recently_reminded',
    );
    expect(
      skipReason(
        split({
          unpaid: [
            { name: 'Jay', userId: 2, lastRemindedAt: hoursAgo(5), remindersSent: 1 },
            { name: 'Sean', userId: 3, lastRemindedAt: hoursAgo(30), remindersSent: 1 },
          ],
        }),
        NOW,
      ),
    ).toBeUndefined();
  });
  it('nobody unpaid → nothing to do', () => {
    expect(skipReason(split({ unpaid: [] }), NOW)).toBe('nobody_unpaid');
  });
});

describe('runScheduledPass', () => {
  it("runs the agent as 'scheduled_run', scoped to each split's own group", async () => {
    const { deps } = setup([split(), split({ id: 'split-b', groupId: 9, telegramChatId: -1009 })]);
    const r = await runScheduledPass(deps);
    expect(r).toMatchObject({ checked: 2, agentRuns: 2 });
    const [first, second] = deps.runAgent.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({ trigger: 'scheduled_run', context: { groupId: 7, chatId: -1007, splitId: 'split-golf' } });
    expect(second).toMatchObject({ trigger: 'scheduled_run', context: { groupId: 9, chatId: -1009, splitId: 'split-b' } });
    expect(first!.userMessage).toContain('[internal] Scheduled check. Split "golf"');
    expect(first!.context.sender).toBeUndefined(); // no sender → no send_split_invoices tool
  });

  it('tells the group only when the agent actually reminded someone — sanitised', async () => {
    const { deps, posts } = setup([split()]);
    await runScheduledPass(deps);
    expect(posts).toEqual([{ chat: -1007, text: 'Reminded Jay Murphy.' }]);
  });

  it('quiet decisions (wait / do nothing) post nothing — no spam on a 5-minute cron', async () => {
    const { deps, posts } = setup([split()], async () => waited);
    const r = await runScheduledPass(deps);
    expect(r.posted).toBe(0);
    expect(posts).toEqual([]);
  });

  it('skips skippable splits without calling the agent', async () => {
    const { deps } = setup([
      split({ id: 'a', nextNagAt: hoursAgo(-2) }),
      split({ id: 'b', unpaid: [{ name: 'Jay', userId: 2, lastRemindedAt: hoursAgo(1), remindersSent: 3 }] }),
    ]);
    const r = await runScheduledPass(deps);
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(r.skipped).toEqual({ followup_scheduled: 1, all_recently_reminded: 1 });
  });

  it('skips a group that is busy with a user request, and releases the lock after its own runs', async () => {
    const { deps, lock } = setup([split()]);
    lock.tryAcquire(-1007);
    expect((await runScheduledPass(deps)).skipped).toEqual({ group_busy: 1 });
    lock.release(-1007);
    await runScheduledPass(deps);
    expect(lock.tryAcquire(-1007)).toBe(true); // released after the scheduled run
  });

  it('recomputes memory for unpaid linked members each pass (overdue → lower reliability)', async () => {
    const { deps, memory } = setup([split({ unpaid: [{ name: 'Jay', userId: 2, lastRemindedAt: null, remindersSent: 0 }, { name: 'Bob', userId: null, lastRemindedAt: null, remindersSent: 0 }] })]);
    await runScheduledPass(deps);
    expect(memory.saveStats).toHaveBeenCalledTimes(1);
    expect(memory.saveStats.mock.calls[0]![0]).toBe(2);
  });

  it('all providers out of quota → stops the pass quietly: no group message, logged', async () => {
    const { deps, posts, logs } = setup([split(), split({ id: 'b', telegramChatId: -1009 })], async () => {
      throw new AllProvidersExhaustedError(3_600_000);
    });
    const r = await runScheduledPass(deps);
    expect(r.stoppedForQuota).toBe(true);
    expect(deps.runAgent).toHaveBeenCalledTimes(1); // second split not attempted
    expect(posts).toEqual([]);
    expect(logs.join()).toContain('scheduled pass stopped: LLM quota exhausted');
  });

  it('one failing split does not stop the others; the failure is logged without PII', async () => {
    let n = 0;
    const { deps, logs } = setup([split(), split({ id: 'b', telegramChatId: -1009 })], async () => {
      if (n++ === 0) throw new Error('db timeout');
      return acted;
    });
    const r = await runScheduledPass(deps);
    expect(r).toMatchObject({ failed: 1, agentRuns: 2, posted: 1 });
    expect(logs.join()).not.toContain('Jay');
    expect(logs.join()).not.toContain('Murphy');
  });
});

describe('NAG_CRON_INTERVAL', () => {
  const env = {
    PAYPAL_CLIENT_ID: 'x',
    PAYPAL_CLIENT_SECRET: 'x',
    TELEGRAM_BOT_TOKEN: '1:x',
    GROQ_API_KEY: 'x',
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_KEY: 'x',
  };
  it('defaults to every 6 hours; accepts the */5 demo override', () => {
    expect(parseConfig(env).NAG_CRON_INTERVAL).toBe('0 */6 * * *');
    expect(parseConfig({ ...env, NAG_CRON_INTERVAL: '*/5 * * * *' }).NAG_CRON_INTERVAL).toBe('*/5 * * * *');
  });
  it('rejects an invalid cron expression with a clear error', () => {
    expect(() => parseConfig({ ...env, NAG_CRON_INTERVAL: 'every 5 minutes' })).toThrow(/NAG_CRON_INTERVAL: is not a valid cron/);
  });
  it('startScheduler schedules the pass and can be stopped', async () => {
    const logs: string[] = [];
    const log: Logger = { info: (o, m) => logs.push(`${m} ${JSON.stringify(o)}`), warn: () => {}, error: () => {} };
    const task = startScheduler('*/5 * * * *', async () => {}, log);
    expect(task.getNextRun()).toBeInstanceOf(Date);
    expect(logs[0]).toContain('autonomous scheduler started');
    await task.stop();
    await task.destroy();
  });
});
