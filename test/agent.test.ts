import { tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MAX_AGENT_STEPS, runAgent } from '../src/agent/run.js';
import type { ReasoningRecord } from '../src/agent/reasoning-log.js';
import { buildSystemPrompt } from '../src/agent/system-prompt.js';
import type { AgentInput, GroupContext } from '../src/agent/types.js';
import { scriptedModel, textStep, toolCallStep } from './helpers/mock-model.js';

const MEMBER_ID = '11111111-1111-4111-8111-111111111111';

const input: AgentInput = {
  trigger: 'scheduled_run',
  userMessage: '[internal] Split "football" has 1 unpaid member. Decide what to do.',
  context: { groupId: 7, chatId: -100, splitId: 'split-1' },
};

const groupContext: GroupContext = {
  chatTitle: 'Five-a-side',
  members: [{ userId: 3, name: 'Mike', reliabilityScore: 0.3, preferredTone: 'direct', avgHoursToPay: 70 }],
  openSplits: [
    {
      id: 'split-1',
      description: 'football',
      currency: 'EUR',
      totalAmount: 60,
      perPersonAmount: 6,
      createdAt: '2026-10-19T10:00:00Z',
      members: [
        {
          splitMemberId: MEMBER_ID,
          name: 'Mike',
          userId: 3,
          status: 'sent',
          invoiceId: 'INV2-MIKE',
          paymentLink: 'https://www.sandbox.paypal.com/invoice/p/#MIKE',
          remindersSent: 2,
          lastRemindedAt: null,
        },
      ],
    },
  ],
  recentReasoning: [],
};

function fakeDmTool(result: unknown = { ok: true, sent_to: 'Mike', kind: 'reminder' }) {
  const execute = vi.fn(async (_input: unknown) => result);
  return {
    execute,
    tool: tool({
      description: 'dm',
      inputSchema: z.object({ split_member_id: z.string(), kind: z.string(), message: z.string() }),
      execute,
    }),
  };
}

describe('runAgent', () => {
  it('runs the tool loop: telegram_dm then a final reply, and persists the reasoning', async () => {
    const dm = fakeDmTool();
    const persisted: ReasoningRecord[] = [];
    const model = scriptedModel([
      toolCallStep(
        'telegram_dm',
        { split_member_id: MEMBER_ID, kind: 'reminder', message: 'Third reminder — €6 still owed for football.' },
        'Mike is unreliable and prefers direct tone.',
      ),
      textStep('Reminded Mike about the €6 for football.'),
    ]);

    const out = await runAgent(input, {
      model,
      tools: { telegram_dm: dm.tool },
      groupContext,
      persist: async (r) => void persisted.push(r),
    });

    expect(out.response).toBe('Reminded Mike about the €6 for football.');
    expect(dm.execute).toHaveBeenCalledOnce();
    expect(dm.execute.mock.calls[0]![0]).toMatchObject({ split_member_id: MEMBER_ID, kind: 'reminder' });

    expect(persisted).toHaveLength(1);
    const record = persisted[0]!;
    expect(record).toMatchObject({ groupId: 7, splitId: 'split-1', trigger: 'scheduled_run' });
    expect(record.thoughts).toHaveLength(2);
    expect(record.thoughts[0]).toMatchObject({
      step: 1,
      reasoning: 'Mike is unreliable and prefers direct tone.',
      toolCalls: [{ tool: 'telegram_dm' }],
      toolResults: [{ tool: 'telegram_dm', output: { ok: true, sent_to: 'Mike', kind: 'reminder' } }],
    });
    expect(record.thoughts[1]).toMatchObject({ step: 2, text: 'Reminded Mike about the €6 for football.' });
  });

  it('sends the system prompt with group context to the model', async () => {
    const model = scriptedModel([textStep('Nothing to do.')]);
    await runAgent(input, { model, tools: {}, groupContext, persist: async () => {} });
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain('You are Siren');
    expect(prompt).toContain(`split_member_id ${MEMBER_ID}`);
    expect(prompt).toContain('invoice INV2-MIKE, pay link https://www.sandbox.paypal.com/invoice/p/#MIKE');
    expect(prompt).toContain('scheduled_run');
  });

  it(`stops after ${MAX_AGENT_STEPS} steps even if the model keeps calling tools`, async () => {
    const dm = fakeDmTool({ ok: false, error: 'rate limited' });
    const model = scriptedModel(
      Array.from({ length: 10 }, () => toolCallStep('telegram_dm', { split_member_id: MEMBER_ID, kind: 'reminder', message: 'x' })),
    );
    const persisted: ReasoningRecord[] = [];
    const out = await runAgent(input, {
      model,
      tools: { telegram_dm: dm.tool },
      groupContext,
      persist: async (r) => void persisted.push(r),
    });
    expect(model.doGenerateCalls).toHaveLength(MAX_AGENT_STEPS);
    expect(dm.execute).toHaveBeenCalledTimes(MAX_AGENT_STEPS);
    expect(out.response).toMatch(/ran out of steps/);
    expect(persisted[0]!.thoughts).toHaveLength(MAX_AGENT_STEPS);
  });

  it('records tool errors in the reasoning log instead of crashing the run', async () => {
    const execute = vi.fn(async (_input: unknown): Promise<unknown> => {
      throw new Error('DB unavailable');
    });
    const model = scriptedModel([
      toolCallStep('telegram_dm', { split_member_id: MEMBER_ID, kind: 'reminder', message: 'x' }),
      textStep("Couldn't send the reminder."),
    ]);
    const persisted: ReasoningRecord[] = [];
    const out = await runAgent(input, {
      model,
      tools: {
        telegram_dm: tool({
          description: 'dm',
          inputSchema: z.object({ split_member_id: z.string(), kind: z.string(), message: z.string() }),
          execute,
        }),
      },
      groupContext,
      persist: async (r) => void persisted.push(r),
    });
    expect(out.response).toBe("Couldn't send the reminder.");
    expect(persisted[0]!.thoughts[0]!.toolErrors).toEqual([{ tool: 'telegram_dm', error: 'DB unavailable' }]);
  });
});

describe('buildSystemPrompt', () => {
  it('fills in trigger, sender country and the group snapshot', () => {
    const prompt = buildSystemPrompt(
      { ...input, trigger: 'user_message', context: { ...input.context, sender: { telegramUserId: 1, firstName: 'Damian', userId: 1 } } },
      groupContext,
      new Date('2026-10-21T12:00:00Z'),
    );
    expect(prompt).toContain('You are being called from: user_message');
    expect(prompt).toContain('sender country: IE');
    expect(prompt).toContain('Sender: Damian');
    expect(prompt).toContain('Current time: 2026-10-21T12:00:00.000Z');
    expect(prompt).toContain('Mike [user_id 3]: reliability 0.30, avg 70h to pay, tone direct');
    expect(prompt).toContain('6.00 EUR each');
    expect(prompt).not.toContain('{{');
  });

  it('keeps the Irish voice confined to reminders', () => {
    const prompt = buildSystemPrompt(input, undefined);
    expect(prompt).toMatch(/light Irish .* ONLY inside reminder DMs/);
    expect(prompt).toContain('neutral English for everything else');
    expect(prompt).toContain('Group context: (not loaded)');
  });

  it('flags split members that cannot be DMed', () => {
    const ctx: GroupContext = {
      ...groupContext,
      openSplits: [{ ...groupContext.openSplits[0]!, members: [{ ...groupContext.openSplits[0]!.members[0]!, userId: null }] }],
    };
    expect(buildSystemPrompt(input, ctx)).toContain('not linked to a Telegram user — cannot DM');
  });
});
