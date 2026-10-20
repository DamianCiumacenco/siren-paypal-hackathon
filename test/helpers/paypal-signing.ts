// Sign fake PayPal webhooks the same way PayPal does, with a test-only key pair
// (test/fixtures — generated locally, not a real PayPal cert).
import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';
import { crc32 } from 'node:zlib';

export const TEST_CERT_PEM = readFileSync(new URL('../fixtures/webhook-test-cert.pem', import.meta.url), 'utf8');
const TEST_KEY_PEM = readFileSync(new URL('../fixtures/webhook-test-key.pem', import.meta.url), 'utf8');
export const TEST_CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST';

export function signedWebhookHeaders(rawBody: string, webhookId: string, transmissionId = 'tx-123') {
  const transmissionTime = '2026-10-19T10:00:00Z';
  const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(Buffer.from(rawBody))}`;
  return {
    'paypal-transmission-id': transmissionId,
    'paypal-transmission-time': transmissionTime,
    'paypal-transmission-sig': sign('sha256', Buffer.from(message), TEST_KEY_PEM).toString('base64'),
    'paypal-cert-url': TEST_CERT_URL,
    'paypal-auth-algo': 'SHA256withRSA',
  };
}

export function invoiceEvent(eventType: string, invoiceId: string) {
  return JSON.stringify({
    id: 'WH-TEST-1',
    event_type: eventType,
    create_time: '2026-10-19T10:00:00Z',
    resource: { invoice: { id: invoiceId, status: 'PAID' } },
  });
}
