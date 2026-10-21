import { tool, type ToolSet } from 'ai';
import { GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SplitForSending, SplitStore } from '../src/db/splits.js';
import type { Logger } from '../src/lib/safe-error.js';
import { formatSendSummary, sendSplitInvoices } from '../src/paypal/split_invoices.js';
import { executeToolkit } from '../src/paypal/toolkit.js';

const silentLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function fakePaypal(failFor?: string) {
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  let n = 0;
  const make = (name: string, out: (input: Record<string, unknown>) => string) =>
    tool({
      description: name,
      inputSchema: z.object({}).loose(),
      execute: async (input: Record<string, unknown>) => (calls.push({ tool: name, input }), out(input)),
    });
  const paypal: ToolSet = {
    create_invoice: make('create_invoice', (input) => {
      const who = JSON.stringify(input.primary_recipients);
      if (failFor && who.includes(failFor)) return '{"ok":false,"status":422,"code":"PAYPAL_API_HTTP_ERROR","message":"bad"}';
      return `{"rel":"self","href":"https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-${++n}"}`;
    }),
    send_invoice: make('send_invoice', (input) => `{"href":"https://www.sandbox.paypal.com/invoice/p/#${input.invoice_id}","rel":"payer-view"}`),
  };
  return { paypal, calls };
}

const split: SplitForSending = {
  id: '22222222-2222-4222-8222-222222222222',
  groupId: 7,
  description: 'football',
  currency: 'EUR',
  perPersonAmount: 6,
  members: [
    { id: 'm-jay', displayName: 'Jay', userId: 2, telegramUserId: 1002, paypalEmail: 'jay@sandbox.test' },
    { id: 'm-sean', displayName: 'Sean', userId: 3, telegramUserId: 1003, paypalEmail: null },
    { id: 'm-bob', displayName: 'Bob', userId: null, telegramUserId: null, paypalEmail: null },
  ],
};

function store() {
  return {
    setMemberInvoice: vi.fn(async () => {}),
    setMemberStatus: vi.fn(async () => {}),
  } as unknown as SplitStore & { setMemberInvoice: ReturnType<typeof vi.fn>; setMemberStatus: ReturnType<typeof vi.fn> };
}

describe('sendSplitInvoices (after ✅)', () => {
  it('creates + sends one invoice per member via the toolkit, stores links, DMs who it can', async () => {
    const { paypal, calls } = fakePaypal();
    const s = store();
    const sendDm = vi.fn(async () => {});
    const r = await sendSplitInvoices(split, { paypal, store: s, sendDm, log: silentLog });

    expect(calls.map((c) => c.tool)).toEqual(['create_invoice', 'send_invoice', 'create_invoice', 'send_invoice', 'create_invoice', 'send_invoice']);
    expect(calls[0]!.input).toMatchObject({
      currency_code: 'EUR',
      primary_recipients: [{ billing_info: { email_address: 'jay@sandbox.test' } }],
      items: [{ name: 'football', quantity: '1', unit_amount: { currency_code: 'EUR', value: '6.00' } }],
    });
    // No PayPal email known → name-only recipient (verified against sandbox).
    expect(calls[2]!.input).toMatchObject({ primary_recipients: [{ billing_info: { name: { given_name: 'Sean' } } }] });
    expect(calls[1]!.input).toEqual({ invoice_id: 'INV2-1', send_to_recipient: false });

    expect(s.setMemberInvoice).toHaveBeenCalledWith('m-jay', 'INV2-1', 'https://www.sandbox.paypal.com/invoice/p/#INV2-1');
    expect(sendDm).toHaveBeenCalledWith(1002, expect.stringContaining('https://www.sandbox.paypal.com/invoice/p/#INV2-1'));
    expect(sendDm).toHaveBeenCalledTimes(2);
    expect(r).toEqual({
      dmed: ['Jay', 'Sean'],
      linkInGroup: [{ name: 'Bob', link: 'https://www.sandbox.paypal.com/invoice/p/#INV2-3' }],
      failed: [],
    });
  });

  it('falls back to posting the link in the group when Telegram refuses the DM (403)', async () => {
    const { paypal } = fakePaypal();
    const sendDm = vi.fn(async (to: number) => {
      if (to === 1003) throw new GrammyError('x', { ok: false, error_code: 403, description: 'Forbidden' }, 'sendMessage', {});
    });
    const r = await sendSplitInvoices(split, { paypal, store: store(), sendDm, log: silentLog });
    expect(r.dmed).toEqual(['Jay']);
    expect(r.linkInGroup.map((l) => l.name)).toEqual(['Sean', 'Bob']);
  });

  it("a PayPal failure for one member doesn't stop the others", async () => {
    const { paypal } = fakePaypal('Sean');
    const s = store();
    const r = await sendSplitInvoices(split, { paypal, store: s, sendDm: async () => {}, log: silentLog });
    expect(r.failed).toEqual(['Sean']);
    expect(r.dmed).toEqual(['Jay']);
    expect(s.setMemberStatus).toHaveBeenCalledWith('m-sean', 'failed');
  });

  it('summary lists DMs, group links and failures in neutral English', () => {
    const text = formatSendSummary('football', {
      dmed: ['Jay'],
      linkInGroup: [{ name: 'Bob', link: 'https://pay/bob' }],
      failed: ['Sean'],
    });
    expect(text).toContain('PayPal requests for "football" are out (2).');
    expect(text).toContain('• Bob: https://pay/bob');
    expect(text).toContain('PayPal failed for: Sean');
  });
});

describe('rate-limit retries', () => {
  it('executeToolkit retries PayPal 429s with backoff, then succeeds', async () => {
    let n = 0;
    const t = { execute: async () => (++n < 3 ? '{"ok":false,"status":429,"code":"RATE_LIMIT_REACHED","message":"slow down"}' : '{"id":"INV2-1"}') };
    expect(await executeToolkit(t, {}, { baseDelayMs: 1 })).toEqual({ id: 'INV2-1' });
    expect(n).toBe(3);
  });

  it('executeToolkit gives up after its retries and throws the 429', async () => {
    const t = { execute: async () => '{"ok":false,"status":429,"code":"RATE_LIMIT_REACHED","message":"slow down"}' };
    await expect(executeToolkit(t, {}, { retries: 2, baseDelayMs: 1 })).rejects.toThrow(/429/);
  });

});
