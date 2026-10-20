import { describe, expect, it, vi } from 'vitest';
import {
  dispatchWebhookEvent,
  isTrustedCertUrl,
  readWebhookHeaders,
  SIMULATOR_WEBHOOK_ID,
  verifyWebhookSignature,
  type InvoiceStore,
} from '../src/paypal/webhooks.js';
import { invoiceEvent, signedWebhookHeaders, TEST_CERT_PEM } from './helpers/paypal-signing.js';

const WEBHOOK_ID = 'WH-REAL-123';
const fetchCertPem = async () => TEST_CERT_PEM;

async function verify(rawBody: string, signedFor: string, accept: string[], extra: Record<string, string> = {}) {
  const headers = readWebhookHeaders({ ...signedWebhookHeaders(rawBody, signedFor), ...extra })!;
  return verifyWebhookSignature({ headers, rawBody, webhookIds: accept, fetchCertPem });
}

describe('verifyWebhookSignature', () => {
  const body = invoiceEvent('INVOICING.INVOICE.PAID', 'INV2-AAAA');

  it('accepts a correctly signed event', async () => {
    expect(await verify(body, WEBHOOK_ID, [WEBHOOK_ID])).toEqual({ ok: true, webhookId: WEBHOOK_ID });
  });

  it('rejects a tampered body (CRC32 changes)', async () => {
    const headers = readWebhookHeaders(signedWebhookHeaders(body, WEBHOOK_ID))!;
    const tampered = body.replace('INV2-AAAA', 'INV2-BBBB');
    const res = await verifyWebhookSignature({ headers, rawBody: tampered, webhookIds: [WEBHOOK_ID], fetchCertPem });
    expect(res).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects re-serialised JSON (whitespace differs from what was signed)', async () => {
    const headers = readWebhookHeaders(signedWebhookHeaders(body, WEBHOOK_ID))!;
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    const res = await verifyWebhookSignature({ headers, rawBody: reserialised, webhookIds: [WEBHOOK_ID], fetchCertPem });
    expect(res.ok).toBe(false);
  });

  it('rejects an event signed for a different webhook id', async () => {
    expect(await verify(body, 'WH-SOMEONE-ELSE', [WEBHOOK_ID])).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects simulator events unless the simulator id is accepted', async () => {
    expect((await verify(body, SIMULATOR_WEBHOOK_ID, [WEBHOOK_ID])).ok).toBe(false);
    expect(await verify(body, SIMULATOR_WEBHOOK_ID, [WEBHOOK_ID, SIMULATOR_WEBHOOK_ID])).toEqual({
      ok: true,
      webhookId: SIMULATOR_WEBHOOK_ID,
    });
  });

  it('refuses to fetch certs from non-PayPal hosts', async () => {
    const fetcher = vi.fn(fetchCertPem);
    const headers = readWebhookHeaders({
      ...signedWebhookHeaders(body, WEBHOOK_ID),
      'paypal-cert-url': 'https://evil.example.com/cert.pem',
    })!;
    const res = await verifyWebhookSignature({ headers, rawBody: body, webhookIds: [WEBHOOK_ID], fetchCertPem: fetcher });
    expect(res).toEqual({ ok: false, reason: 'untrusted cert url' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unsupported auth algorithms', async () => {
    const res = await verify(body, WEBHOOK_ID, [WEBHOOK_ID], { 'paypal-auth-algo': 'SHA1withRSA' });
    expect(res.ok).toBe(false);
  });

  it('rejects an expired cert', async () => {
    const headers = readWebhookHeaders(signedWebhookHeaders(body, WEBHOOK_ID))!;
    const res = await verifyWebhookSignature({
      headers,
      rawBody: body,
      webhookIds: [WEBHOOK_ID],
      fetchCertPem,
      now: new Date('2200-01-01'),
    });
    expect(res).toEqual({ ok: false, reason: 'cert expired or not yet valid' });
  });

  it('fails closed with no webhook ids configured', async () => {
    expect(await verify(body, WEBHOOK_ID, [])).toEqual({ ok: false, reason: 'no webhook id configured' });
  });
});

describe('isTrustedCertUrl', () => {
  it.each([
    ['https://api.paypal.com/v1/notifications/certs/CERT-1', true],
    ['https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', true],
    ['http://api.paypal.com/cert', false],
    ['https://paypal.com.evil.com/cert', false],
    ['https://evilpaypal.com/cert', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isTrustedCertUrl(url)).toBe(expected);
  });
});

describe('readWebhookHeaders', () => {
  it('returns null when a signature header is missing', () => {
    const { 'paypal-transmission-sig': _sig, ...rest } = signedWebhookHeaders('{}', WEBHOOK_ID);
    expect(readWebhookHeaders(rest)).toBeNull();
  });
});

describe('dispatchWebhookEvent', () => {
  function fakeStore(): InvoiceStore & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      markInvoicePaid: async (id, paidAt) => (calls.push(`paid:${id}:${paidAt.toISOString()}`), 1),
      markInvoiceCancelled: async (id) => (calls.push(`cancelled:${id}`), 1),
    };
  }

  it('marks the member paid on INVOICING.INVOICE.PAID', async () => {
    const store = fakeStore();
    const res = await dispatchWebhookEvent(JSON.parse(invoiceEvent('INVOICING.INVOICE.PAID', 'INV2-AAAA')), store);
    expect(res).toEqual({ handled: true, eventType: 'INVOICING.INVOICE.PAID', invoiceId: 'INV2-AAAA', updated: 1 });
    expect(store.calls).toEqual(['paid:INV2-AAAA:2026-10-19T10:00:00.000Z']);
  });

  it('marks the member cancelled on INVOICING.INVOICE.CANCELLED', async () => {
    const store = fakeStore();
    await dispatchWebhookEvent(JSON.parse(invoiceEvent('INVOICING.INVOICE.CANCELLED', 'INV2-CCCC')), store);
    expect(store.calls).toEqual(['cancelled:INV2-CCCC']);
  });

  it('ignores other event types without touching the store', async () => {
    const store = fakeStore();
    const res = await dispatchWebhookEvent({ id: 'x', event_type: 'PAYMENT.CAPTURE.COMPLETED' }, store);
    expect(res.handled).toBe(false);
    expect(store.calls).toEqual([]);
  });

  it('accepts the invoice id at resource.id too', async () => {
    const store = fakeStore();
    await dispatchWebhookEvent({ id: 'x', event_type: 'INVOICING.INVOICE.CANCELLED', resource: { id: 'INV2-DDDD' } }, store);
    expect(store.calls).toEqual(['cancelled:INV2-DDDD']);
  });
});
