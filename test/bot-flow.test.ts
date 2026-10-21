import { APICallError, RetryError } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInput } from '../src/agent/types.js';
import type { AgentOutput } from '../src/agent/run.js';
import { createBot, type BotDeps } from '../src/bot/index.js';
import { agentPrompt } from '../src/bot/handlers/message.js';
import { plainText, toGroupText } from '../src/lib/group-text.js';
import type { SplitForSending, SplitStore } from '../src/db/splits.js';
import { safeErrorMessage, type Logger } from '../src/lib/safe-error.js';
import { botInfo, callbackUpdate, captureApi, DAMIAN, GROUP, JAY, textUpdate } from './helpers/telegram.js';

const SPLIT_ID = '22222222-2222-4222-8222-222222222222';

function proposalOutput(): AgentOutput {
  return {
    response: 'Got it — €60 for football, split 4 ways. Check the card below.',
    thoughts: [
      {
        step: 1,
        toolCalls: [{ tool: 'send_split_invoices', input: {} }],
        toolResults: [
          {
            tool: 'send_split_invoices',
            output: {
              ok: true,
              status: 'awaiting_confirmation',
              split_id: SPLIT_ID,
              per_person: '15.00 EUR',
              people: 4,
              invoices_to: ['Jay', 'Sean', 'Mike'],
              not_in_group: [],
            },
          },
        ],
        toolErrors: [],
        tokens: {},
      },
    ],
  };
}

function setup(overrides: Partial<BotDeps> = {}) {
  const logs: string[] = [];
  const log: Logger = {
    info: (o, m) => logs.push(JSON.stringify({ level: 'info', ...o, msg: m })),
    warn: (o, m) => logs.push(JSON.stringify({ level: 'warn', ...o, msg: m })),
    error: (o, m) => logs.push(JSON.stringify({ level: 'error', ...o, msg: m })),
  };
  const pending: Promise<void>[] = [];
  let draftStatus: 'draft' | 'open' | 'cancelled' = 'draft';
  const splitForSending: SplitForSending = {
    id: SPLIT_ID,
    groupId: 7,
    description: 'football',
    currency: 'EUR',
    perPersonAmount: 15,
    members: [],
  };
  const splits = {
    confirmDraft: vi.fn(async (_id: string, tg: number) => {
      if (tg !== DAMIAN.id || draftStatus !== 'draft') return null;
      draftStatus = 'open';
      return splitForSending;
    }),
    cancelDraft: vi.fn(async (_id: string, tg: number) => {
      if (tg !== DAMIAN.id || draftStatus !== 'draft') return false;
      draftStatus = 'cancelled';
      return true;
    }),
  } as unknown as SplitStore;
  const deps: BotDeps = {
    registry: {
      registerUser: vi.fn(async (u) => (u.telegramUserId === DAMIAN.id ? 1 : 2)),
      registerGroup: vi.fn(async () => 7),
      registerMembership: vi.fn(async () => {}),
    },
    runAgent: vi.fn(async (_input: AgentInput) => proposalOutput()),
    splits,
    sendSplit: vi.fn(async () => ({ dmed: ['Jay'], linkInGroup: [], failed: [] })),
    lastReasoning: vi.fn(async () => null),
    log,
    background: (p) => void pending.push(p),
    ...overrides,
  };
  const bot = createBot('123456:TEST', { botInfo }, deps);
  const api = captureApi(bot);
  const send = async (update: object) => {
    await bot.handleUpdate(update as never);
    await Promise.all(pending.splice(0));
  };
  const sent = () => api.filter((c) => c.method === 'sendMessage').map((c) => c.payload);
  return { deps, api, sent, send, logs };
}

describe('which messages reach the agent', () => {
  const ctxFor = (update: ReturnType<typeof textUpdate>) =>
    ({ message: update.message, me: botInfo }) as unknown as Parameters<typeof agentPrompt>[0];

  it.each([
    ['/split €60 football with Jay', '/split €60 football with Jay'],
    ['/split@siren_test_bot €10 pizza', '/split €10 pizza'],
    ['/status', '/status'],
    ['/nag', '/nag'],
    ['/siren about Jay', '/siren about Jay'],
    ['/siren why', '/siren why'],
    ['@siren_test_bot who owes what?', 'who owes what?'],
  ])('%s → agent', (text, expected) => {
    expect(agentPrompt(ctxFor(textUpdate(text)))).toBe(expected);
  });

  it.each(['lads are we on for Thursday?', '/split@other_bot €5', '/help', '/start'])('%s → ignored', (text) => {
    expect(agentPrompt(ctxFor(textUpdate(text)))).toBeUndefined();
  });

  it('replies to the bot reach the agent', () => {
    expect(agentPrompt(ctxFor(textUpdate('yes include Mike', { replyToBot: true })))).toBe('yes include Mike');
  });
});

describe('plainText', () => {
  it('strips Markdown Telegram would show literally, keeps links and bullets', () => {
    expect(plainText('**About Jay**\n## Profile\n- reliability `0.94`\n- pay: https://www.sandbox.paypal.com/invoice/p/#INV2_A__B')).toBe(
      'About Jay\nProfile\n- reliability 0.94\n- pay: https://www.sandbox.paypal.com/invoice/p/#INV2_A__B',
    );
  });
});

describe('toGroupText (agent replies posted in the group)', () => {
  it('removes internal ids and invoice numbers, and keeps pay links out of the group', () => {
    expect(
      toGroupText(
        '**Jay** (user 23) owes €6 — invoice INV2-AB12-CD34, split 9cb06ec0-993b-44de-99c5-c9515a54a344.\nPay: https://www.sandbox.paypal.com/invoice/p/#INV2AB12CD34 [user_id 23]',
      ),
    ).toBe('Jay owes €6 — invoice , split.\nPay: [pay link sent by DM]');
  });

  it('drops tone / reliability labels about people (no group shaming)', () => {
    expect(toGroupText('Reminded Sean (chill tone) and Jay (direct tone, reliability 0.3).')).toBe('Reminded Sean and Jay.');
    expect(toGroupText('Reminded Sean (chill) and Jay (direct) about golf.')).toBe('Reminded Sean and Jay about golf.');
    expect(toGroupText('Pizza (Domino’s) was great')).toBe('Pizza (Domino’s) was great');
    expect(toGroupText('Sean was reminded 1 min ago (chill tone, typically pays within 5h) — follow-up in 4h.')).toBe(
      'Sean was reminded 1 min ago — follow-up in 4h.',
    );
  });

  it('leaves normal text, amounts, times and other links alone', () => {
    const text = 'Jay paid €6.00 in 5 hours (2 of 3 paid). Details: https://example.com/x';
    expect(toGroupText(text)).toBe(text);
  });
});

describe('message → runAgent → reply + confirmation card', () => {
  it('registers group/user, runs the agent with ids, replies, then posts the ✅/❌ card', async () => {
    const { deps, send, sent } = setup();
    await send(textUpdate('/split €60 football with Jay, Sean and Mike'));

    expect(deps.registry.registerGroup).toHaveBeenCalledWith(GROUP.id, 'Five-a-side', DAMIAN.id);
    expect(deps.registry.registerMembership).toHaveBeenCalledWith(1, 7);
    expect(deps.runAgent).toHaveBeenCalledWith({
      trigger: 'user_message',
      userMessage: '/split €60 football with Jay, Sean and Mike',
      context: {
        groupId: 7,
        chatId: GROUP.id,
        sender: { telegramUserId: DAMIAN.id, firstName: 'Damian', username: 'damianc', userId: 1 },
      },
    });

    const [reply, card] = sent();
    expect(reply!.text).toBe('Got it — €60 for football, split 4 ways. Check the card below.');
    expect(card!.text).toContain('New split: 15.00 EUR each, 4 people (incl. Damian)');
    expect(card!.text).toContain('PayPal requests to: Jay, Sean, Mike');
    expect(card!.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Send requests', callback_data: `split:confirm:${SPLIT_ID}` },
          { text: '❌ Cancel', callback_data: `split:cancel:${SPLIT_ID}` },
        ],
      ],
    });
  });

  it('no card when the agent did not propose a split', async () => {
    const { send, sent } = setup({ runAgent: vi.fn(async () => ({ response: 'Jay still owes €6.', thoughts: [] })) });
    await send(textUpdate('/status'));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.reply_markup).toBeUndefined();
  });

  it('ignores ordinary group chatter (no agent call, no Groq tokens spent)', async () => {
    const { deps, send, sent } = setup();
    await send(textUpdate('who is driving on Thursday?'));
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
    // ...but the sender is still registered as a group member.
    expect(deps.registry.registerMembership).toHaveBeenCalled();
  });

  it('only one agent run per group at a time', async () => {
    let release!: () => void;
    const runAgent = vi.fn(() => new Promise<AgentOutput>((r) => (release = () => r({ response: 'ok', thoughts: [] }))));
    const { send, sent, deps } = setup({ runAgent, background: () => {} });
    await send(textUpdate('/status'));
    await send(textUpdate('/nag'));
    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    expect(sent().at(-1)!.text).toMatch(/Still working/);
    release();
  });

  it('DMs explain that splits happen in groups', async () => {
    const { deps, send, sent } = setup();
    await send(textUpdate('/split €10 with Jay', { chat: { id: DAMIAN.id, type: 'private', first_name: 'Damian' } }));
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(sent()[0]!.text).toMatch(/group chats/);
  });

  it('/start in a DM links the user so Siren can DM them later', async () => {
    const { deps, send, sent } = setup();
    await send(textUpdate('/start', { from: JAY as typeof DAMIAN, chat: { id: JAY.id, type: 'private', first_name: 'Jay' } }));
    expect(deps.registry.registerUser).toHaveBeenCalledWith({ telegramUserId: JAY.id, firstName: 'Jay', username: undefined });
    expect(sent()[0]!.text).toMatch(/I'm Siren/);
  });
});

describe('/siren why', () => {
  it('reads reasoning_log directly — no agent run, no Groq tokens', async () => {
    const lastReasoning = vi.fn(async () => ({
      trigger: 'user_message',
      createdAt: '2026-10-21T14:02:00Z',
      thoughts: [],
      finalResponse: 'Drafted the pizza split.',
    }));
    const { deps, send, sent } = setup({ lastReasoning });
    await send(textUpdate('/siren why'));
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(lastReasoning).toHaveBeenCalledWith(7);
    expect(sent()[0]!.text).toContain('Result: Drafted the pizza split.');
  });

  it('other /siren commands still go to the agent', async () => {
    const { deps, send } = setup({ runAgent: vi.fn(async () => ({ response: 'ok', thoughts: [] })) });
    await send(textUpdate('/siren about Jay'));
    expect(deps.runAgent).toHaveBeenCalled();
  });
});

describe('✅ / ❌ confirmation card', () => {
  it('✅ by the creator sends the split once and posts the summary', async () => {
    const { deps, send, sent, api } = setup();
    await send(callbackUpdate(`split:confirm:${SPLIT_ID}`));
    expect(deps.sendSplit).toHaveBeenCalledTimes(1);
    expect(api.find((c) => c.method === 'answerCallbackQuery')!.payload.text).toMatch(/Sending/);
    expect(api.find((c) => c.method === 'editMessageText')!.payload.text).toMatch(/✅ Confirmed/);
    expect(sent().at(-1)!.text).toMatch(/PayPal requests for "football" are out/);
  });

  it('a double tap does not send twice', async () => {
    const { deps, send, api } = setup();
    await send(callbackUpdate(`split:confirm:${SPLIT_ID}`));
    await send(callbackUpdate(`split:confirm:${SPLIT_ID}`));
    expect(deps.sendSplit).toHaveBeenCalledTimes(1);
    expect(api.filter((c) => c.method === 'answerCallbackQuery').at(-1)!.payload).toMatchObject({ show_alert: true });
  });

  it('someone other than the creator cannot confirm or cancel', async () => {
    const { deps, send, api } = setup();
    await send(callbackUpdate(`split:confirm:${SPLIT_ID}`, JAY));
    await send(callbackUpdate(`split:cancel:${SPLIT_ID}`, JAY));
    expect(deps.sendSplit).not.toHaveBeenCalled();
    expect(api.filter((c) => c.method === 'answerCallbackQuery').every((c) => c.payload.show_alert === true)).toBe(true);
  });

  it('❌ cancels the draft and nothing is sent', async () => {
    const { deps, send, api } = setup();
    await send(callbackUpdate(`split:cancel:${SPLIT_ID}`));
    expect(deps.sendSplit).not.toHaveBeenCalled();
    expect(api.find((c) => c.method === 'editMessageText')!.payload.text).toMatch(/Cancelled — nothing was sent/);
  });
});

describe('logs never contain PII (hard rule)', () => {
  const PII = ['Jay Murphy', 'Murphy', 'Seán Ó Briain', 'Briain', '€60', 'football'];

  // What a real Groq failure looks like: the SDK error carries the full prompt and response.
  function groqError(status: number) {
    return new APICallError({
      message: 'Rate limit reached for model `openai/gpt-oss-120b` (TPM): Limit 8000',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      requestBodyValues: {
        messages: [
          { role: 'system', content: 'Members: Jay Murphy [user_id 2] reliability 0.30; Seán Ó Briain [user_id 3]' },
          { role: 'user', content: '/split €60 football with Jay Murphy and Seán Ó Briain' },
        ],
      },
      statusCode: status,
      responseHeaders: { 'retry-after': '9' },
      responseBody:
        '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000","type":"tokens"}}',
      isRetryable: true,
      data: { error: { message: 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000' } },
    });
  }

  it.each([
    ['APICallError', () => groqError(500)],
    ['RetryError wrapping APICallErrors', () => new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [groqError(429), groqError(429), groqError(429)] })],
    ['plain Error', () => new Error('db timeout')],
  ])('agent failure (%s) is logged without names, amounts or message text', async (_name, makeErr) => {
    const { send, logs, sent } = setup({
      runAgent: vi.fn(async () => {
        throw makeErr();
      }),
    });
    await send(textUpdate('/split €60 football with Jay Murphy and Seán Ó Briain'));

    expect(logs.length).toBeGreaterThan(0);
    const out = logs.join('\n');
    for (const pii of PII) expect(out, `log contains "${pii}"`).not.toContain(pii);
    expect(out).toContain('"msg":"agent run failed"');
    expect(out).toContain(`"chatId":${GROUP.id}`);
    // The user still gets an answer.
    expect(sent().at(-1)!.text).toMatch(/rate limit|went wrong/);
  });

  it('errors in middleware are caught and logged safely (polling AND webhook mode)', async () => {
    const { send, logs } = setup({
      registry: {
        registerUser: vi.fn(async () => {
          throw groqError(500);
        }),
        registerGroup: vi.fn(),
        registerMembership: vi.fn(),
      },
    });
    // Must not throw: in webhook mode a throw reaches Fastify's raw error logger and
    // Telegram re-delivers the update.
    await expect(send(textUpdate('/split €60 football with Jay Murphy'))).resolves.toBeUndefined();
    const out = logs.join('\n');
    expect(out).toContain('bot update failed');
    for (const pii of PII) expect(out).not.toContain(pii);
  });

  it('safeErrorMessage keeps the useful part (status + provider message)', () => {
    expect(safeErrorMessage(groqError(429))).toBe(
      'APICallError 429: Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000',
    );
    const retry = new RetryError({ message: 'x', reason: 'maxRetriesExceeded', errors: [groqError(429)] });
    expect(safeErrorMessage(retry)).toMatch(/^RetryError after 1 attempts \(maxRetriesExceeded\): APICallError 429/);
  });
});
