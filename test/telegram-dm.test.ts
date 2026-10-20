import { GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import {
  createTelegramDmTool,
  REMINDER_COOLDOWN_MS,
  telegramDmInput,
  type DmMember,
  type DmStore,
} from '../src/agent/tools/telegram_dm.js';

const GROUP_ID = 7;
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-21T12:00:00Z');

const jay: DmMember = {
  splitMemberId: MEMBER_ID,
  displayName: 'Jay',
  status: 'sent',
  remindersSent: 1,
  userId: 3,
  telegramUserId: 555,
};

function setup(member: DmMember | null = jay, lastReminder: Date | null = null) {
  const store = {
    getMember: vi.fn(async (_id: string, groupId: number) => (groupId === GROUP_ID ? member : null)),
    lastReminderAt: vi.fn(async () => lastReminder),
    recordReminder: vi.fn(async () => {}),
    markLinkSent: vi.fn(async () => {}),
  } satisfies DmStore;
  const sendDm = vi.fn(async () => {});
  const dm = createTelegramDmTool({ context: { groupId: GROUP_ID, chatId: -100 }, store, sendDm, now: () => NOW });
  const run = (kind: 'payment_link' | 'reminder', message = 'hi') =>
    dm.execute!({ split_member_id: MEMBER_ID, kind, message }, { toolCallId: 't', messages: [] } as never);
  return { store, sendDm, run };
}

describe('telegram_dm tool', () => {
  it('delivers a payment link and marks the member sent', async () => {
    const { store, sendDm, run } = setup({ ...jay, status: 'pending' });
    expect(await run('payment_link', 'Pay here: https://pp/x')).toEqual({ ok: true, sent_to: 'Jay', kind: 'payment_link' });
    expect(sendDm).toHaveBeenCalledWith(555, 'Pay here: https://pp/x');
    expect(store.markLinkSent).toHaveBeenCalledWith(MEMBER_ID);
    expect(store.recordReminder).not.toHaveBeenCalled();
  });

  it('sends a reminder when none in the last 24h and records it', async () => {
    const { store, sendDm, run } = setup(jay, new Date(NOW.getTime() - REMINDER_COOLDOWN_MS - 1));
    expect((await run('reminder')) as { ok: boolean }).toMatchObject({ ok: true });
    expect(sendDm).toHaveBeenCalledOnce();
    expect(store.lastReminderAt).toHaveBeenCalledWith(3);
    expect(store.recordReminder).toHaveBeenCalledWith(MEMBER_ID, 2, NOW);
  });

  it('refuses a second reminder within 24h — enforced in code, nothing sent', async () => {
    const { store, sendDm, run } = setup(jay, new Date(NOW.getTime() - 2 * 3_600_000));
    const res = (await run('reminder')) as { ok: boolean; error: string; hint: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/rate limited/);
    expect(res.hint).toMatch(/22h/);
    expect(sendDm).not.toHaveBeenCalled();
    expect(store.recordReminder).not.toHaveBeenCalled();
  });

  it('does not rate-limit first delivery of a payment link', async () => {
    const { sendDm, run } = setup({ ...jay, status: 'pending' }, new Date(NOW.getTime() - 60_000));
    expect((await run('payment_link')) as { ok: boolean }).toMatchObject({ ok: true });
    expect(sendDm).toHaveBeenCalledOnce();
  });

  it.each(['paid', 'cancelled'] as const)('never DMs a member who is %s', async (status) => {
    const { sendDm, run } = setup({ ...jay, status });
    expect((await run('reminder')) as { ok: boolean }).toMatchObject({ ok: false });
    expect(sendDm).not.toHaveBeenCalled();
  });

  it('cannot reach members outside the calling group', async () => {
    const store = {
      getMember: vi.fn(async () => null),
      lastReminderAt: vi.fn(),
      recordReminder: vi.fn(),
      markLinkSent: vi.fn(),
    };
    const sendDm = vi.fn();
    const dm = createTelegramDmTool({ context: { groupId: 99, chatId: -1 }, store, sendDm });
    const res = await dm.execute!({ split_member_id: MEMBER_ID, kind: 'reminder', message: 'x' }, {} as never);
    expect(res).toEqual({ ok: false, error: 'split member not found in this group' });
    expect(store.getMember).toHaveBeenCalledWith(MEMBER_ID, 99);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it('explains members not linked to Telegram', async () => {
    const { sendDm, run } = setup({ ...jay, telegramUserId: null, userId: null });
    expect((await run('reminder')) as { hint: string }).toMatchObject({ ok: false, hint: expect.stringMatching(/start/i) });
    expect(sendDm).not.toHaveBeenCalled();
  });

  it('turns Telegram 403 (bot not started/blocked) into an ok:false result, nothing recorded', async () => {
    const { store, sendDm, run } = setup(jay);
    sendDm.mockRejectedValueOnce(
      new GrammyError(
        'Call to sendMessage failed',
        { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
        'sendMessage',
        {},
      ),
    );
    const res = (await run('reminder')) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/can't initiate/);
    expect(store.recordReminder).not.toHaveBeenCalled();
  });

  it('rethrows unexpected send errors', async () => {
    const { sendDm, run } = setup(jay);
    sendDm.mockRejectedValueOnce(new Error('network down'));
    await expect(run('reminder')).rejects.toThrow('network down');
  });

  it('input schema rejects bad ids, unknown kinds and over-long messages', () => {
    expect(telegramDmInput.safeParse({ split_member_id: 'jay', kind: 'reminder', message: 'x' }).success).toBe(false);
    expect(telegramDmInput.safeParse({ split_member_id: MEMBER_ID, kind: 'spam', message: 'x' }).success).toBe(false);
    expect(
      telegramDmInput.safeParse({ split_member_id: MEMBER_ID, kind: 'reminder', message: 'x'.repeat(1001) }).success,
    ).toBe(false);
  });
});
