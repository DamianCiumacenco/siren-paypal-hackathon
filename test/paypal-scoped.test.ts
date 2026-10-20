import { tool, type ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { scopePayPalTools, type InvoiceScopeStore } from '../src/agent/tools/paypal_scoped.js';
import type { DmMember } from '../src/agent/tools/telegram_dm.js';
import { getPayPalTools, PAYPAL_TOOL_NAMES } from '../src/paypal/toolkit.js';

const GROUP_ID = 7;
const NOW = new Date('2026-10-21T12:00:00Z');
const jay: DmMember = {
  splitMemberId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Jay',
  status: 'sent',
  remindersSent: 1,
  userId: 3,
  telegramUserId: 555,
};

// Fake toolkit tools that return what the real toolkit returns: JSON strings, errors as JSON.
function fakeToolkit(overrides: Record<string, () => string> = {}) {
  const calls: { tool: string; input: unknown }[] = [];
  const make = (name: string, out: () => string) =>
    tool({
      description: `toolkit ${name}`,
      inputSchema: z.object({}).loose(),
      execute: async (input: unknown) => {
        calls.push({ tool: name, input });
        return out();
      },
    });
  const tools: ToolSet = {
    create_invoice: make('create_invoice', overrides.create_invoice ?? (() => '{"rel":"self","href":"https://api/v2/invoicing/invoices/INV2-NEW"}')),
    get_invoice: make('get_invoice', overrides.get_invoice ?? (() => '{"id":"INV2-JAY","status":"UNPAID"}')),
    send_invoice: make('send_invoice', overrides.send_invoice ?? (() => '{"href":"https://pay/x"}')),
    send_invoice_reminder: make('send_invoice_reminder', overrides.send_invoice_reminder ?? (() => '""')),
    cancel_sent_invoice: make('cancel_sent_invoice', overrides.cancel_sent_invoice ?? (() => '""')),
  };
  return { tools, calls };
}

function setup(opts: { member?: DmMember | null; lastReminder?: Date | null; toolkit?: Record<string, () => string> } = {}) {
  const store = {
    getMemberByInvoice: vi.fn(async (id: string, groupId: number) =>
      id === 'INV2-JAY' && groupId === GROUP_ID ? (opts.member === undefined ? jay : opts.member) : null,
    ),
    lastReminderAt: vi.fn(async () => opts.lastReminder ?? null),
    recordReminder: vi.fn(async () => {}),
  } satisfies InvoiceScopeStore;
  const { tools, calls } = fakeToolkit(opts.toolkit);
  const scoped = scopePayPalTools(tools, { context: { groupId: GROUP_ID, chatId: -1 }, store, now: () => NOW });
  const run = (name: string, input: Record<string, unknown>) =>
    scoped[name]!.execute!(input, { toolCallId: 't', messages: [] } as never) as Promise<Record<string, unknown>>;
  return { store, calls, run, scoped };
}

describe('scoped PayPal tools', () => {
  it('the agent never gets list_invoices or orders tools', () => {
    const real = getPayPalTools({ PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'y' });
    expect(Object.keys(real)).not.toContain('list_invoices');
    expect(Object.keys(real).some((n) => n.includes('order'))).toBe(false);
    expect(PAYPAL_TOOL_NAMES).toHaveLength(5);
  });

  it('refuses invoices that are not in this group — toolkit never called', async () => {
    const { run, calls } = setup();
    for (const name of ['get_invoice', 'send_invoice', 'cancel_sent_invoice', 'send_invoice_reminder']) {
      const res = await run(name, { invoice_id: 'INV2-SOMEONE-ELSES' });
      expect(res.ok, name).toBe(false);
      expect(String(res.error), name).toMatch(/not part of any split in this group/);
    }
    expect(calls).toEqual([]);
  });

  it('allows invoices that belong to a member of this group', async () => {
    const { run, calls } = setup();
    expect(await run('get_invoice', { invoice_id: 'INV2-JAY' })).toMatchObject({ ok: true, id: 'INV2-JAY', status: 'UNPAID' });
    expect(calls).toEqual([{ tool: 'get_invoice', input: { invoice_id: 'INV2-JAY' } }]);
  });

  it('allows send_invoice on an invoice created earlier in the same run', async () => {
    const { run, calls } = setup();
    const created = await run('create_invoice', { currency_code: 'EUR' });
    expect(created).toMatchObject({ ok: true, invoice_id: 'INV2-NEW' });
    expect(await run('send_invoice', { invoice_id: 'INV2-NEW' })).toMatchObject({ ok: true });
    expect(calls.map((c) => c.tool)).toEqual(['create_invoice', 'send_invoice']);
  });

  it('normalises toolkit errors (which arrive as JSON, not exceptions) to ok:false', async () => {
    const { run } = setup({
      toolkit: { get_invoice: () => '{"ok":false,"status":404,"code":"PAYPAL_API_HTTP_ERROR","message":"not found"}' },
    });
    const res = await run('get_invoice', { invoice_id: 'INV2-JAY' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/404.*not found/);
  });

  it('turns PayPal’s empty 204 body into ok:true and records the reminder', async () => {
    const { run, store } = setup();
    expect(await run('send_invoice_reminder', { invoice_id: 'INV2-JAY' })).toEqual({ ok: true });
    expect(store.recordReminder).toHaveBeenCalledWith(jay.splitMemberId, 2, NOW);
  });

  it('PayPal reminders share the 1-per-24h limit with Telegram reminders', async () => {
    const { run, calls, store } = setup({ lastReminder: new Date(NOW.getTime() - 3 * 3_600_000) });
    const res = await run('send_invoice_reminder', { invoice_id: 'INV2-JAY' });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/rate limited/) });
    expect(calls).toEqual([]);
    expect(store.recordReminder).not.toHaveBeenCalled();
  });

  it('does not remind members who already paid', async () => {
    const { run, calls } = setup({ member: { ...jay, status: 'paid' } });
    expect(await run('send_invoice_reminder', { invoice_id: 'INV2-JAY' })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it('does not record a reminder PayPal rejected', async () => {
    const { run, store } = setup({ toolkit: { send_invoice_reminder: () => '{"error":{"message":"bad"}}' } });
    expect(await run('send_invoice_reminder', { invoice_id: 'INV2-JAY' })).toMatchObject({ ok: false });
    expect(store.recordReminder).not.toHaveBeenCalled();
  });

  it('get_invoice returns a compact summary, not the multi-KB PayPal invoice', async () => {
    const big = {
      id: 'INV2-JAY',
      status: 'PARTIALLY_PAID',
      amount: { value: '6.00', currency_code: 'EUR' },
      due_amount: { value: '2.00', currency_code: 'EUR' },
      payments: { paid_amount: { value: '4.00', currency_code: 'EUR' }, transactions: Array(20).fill({ x: 'y'.repeat(200) }) },
      detail: { metadata: { recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#JAY' }, note: 'z'.repeat(2000) },
      primary_recipients: [{ billing_info: { email_address: 'jay@sandbox.test' } }],
    };
    const { run } = setup({ toolkit: { get_invoice: () => JSON.stringify(big) } });
    const res = await run('get_invoice', { invoice_id: 'INV2-JAY' });
    expect(res).toEqual({
      ok: true,
      id: 'INV2-JAY',
      status: 'PARTIALLY_PAID',
      amount: '6.00 EUR',
      due: '2.00 EUR',
      paid: '4.00 EUR',
      payer_email: 'jay@sandbox.test',
      pay_link: 'https://www.sandbox.paypal.com/invoice/p/#JAY',
    });
    expect(JSON.stringify(res).length).toBeLessThan(300);
  });
});
