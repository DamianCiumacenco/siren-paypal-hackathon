// Incoming PayPal webhooks — the one place we talk to PayPal without the Agent Toolkit
// (the toolkit only makes outbound calls). See CLAUDE.md.
//
// We use PayPal's "self verification" rather than the verify-webhook-signature postback:
// no extra API call, and it's the only method that works for Webhook Simulator events.
// Docs: https://developer.paypal.com/api/rest/webhooks/rest/
//
//   signed message = `${transmission_id}|${transmission_time}|${webhook_id}|${crc32(rawBody)}`
//   signature      = base64 SHA256withRSA over that message, checked with the public key
//                    in the cert at `paypal-cert-url`
import { X509Certificate, verify as cryptoVerify } from 'node:crypto';
import { crc32 } from 'node:zlib';

/** Webhook ID PayPal uses when signing Webhook Simulator (mock) events. */
export const SIMULATOR_WEBHOOK_ID = 'WEBHOOK_ID';

export interface PayPalWebhookHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

/** Pull the signature headers out of a request. Returns null if any are missing. */
export function readWebhookHeaders(headers: Record<string, unknown>): PayPalWebhookHeaders | null {
  const get = (name: string) => {
    const v = headers[name];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  const transmissionId = get('paypal-transmission-id');
  const transmissionTime = get('paypal-transmission-time');
  const transmissionSig = get('paypal-transmission-sig');
  const certUrl = get('paypal-cert-url');
  const authAlgo = get('paypal-auth-algo') ?? 'SHA256withRSA';
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl) return null;
  return { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo };
}

/**
 * Only fetch certs from PayPal over HTTPS. Without this check an attacker could
 * point `paypal-cert-url` at their own cert and sign forged events with it.
 */
export function isTrustedCertUrl(certUrl: string): boolean {
  try {
    const url = new URL(certUrl);
    return url.protocol === 'https:' && (url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com'));
  } catch {
    return false;
  }
}

export type CertFetcher = (url: string) => Promise<string>;

const certCache = new Map<string, string>();

/** Download a PayPal signing cert (PEM). Certs are long-lived, so cache by URL. */
export const fetchCert: CertFetcher = async (url) => {
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download PayPal cert (${res.status})`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
};

export interface VerifyOptions {
  headers: PayPalWebhookHeaders;
  /** The body exactly as received — re-serialising parsed JSON changes the CRC32. */
  rawBody: string;
  /** Webhook IDs to accept (our real one, plus SIMULATOR_WEBHOOK_ID if enabled). */
  webhookIds: string[];
  fetchCertPem?: CertFetcher;
  now?: Date;
}

export type VerifyResult = { ok: true; webhookId: string } | { ok: false; reason: string };

export async function verifyWebhookSignature(opts: VerifyOptions): Promise<VerifyResult> {
  const { headers, rawBody, webhookIds } = opts;
  if (webhookIds.length === 0) return { ok: false, reason: 'no webhook id configured' };
  if (headers.authAlgo !== 'SHA256withRSA') return { ok: false, reason: `unsupported auth algo ${headers.authAlgo}` };
  if (!isTrustedCertUrl(headers.certUrl)) return { ok: false, reason: 'untrusted cert url' };

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(await (opts.fetchCertPem ?? fetchCert)(headers.certUrl));
  } catch (err) {
    return { ok: false, reason: `cert error: ${(err as Error).message}` };
  }
  const now = opts.now ?? new Date();
  if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) {
    return { ok: false, reason: 'cert expired or not yet valid' };
  }

  // zlib.crc32 returns an unsigned 32-bit int; PayPal wants it as a decimal string.
  const checksum = crc32(Buffer.from(rawBody, 'utf8'));
  const signature = Buffer.from(headers.transmissionSig, 'base64');

  for (const webhookId of webhookIds) {
    const message = `${headers.transmissionId}|${headers.transmissionTime}|${webhookId}|${checksum}`;
    if (cryptoVerify('sha256', Buffer.from(message), cert.publicKey, signature)) {
      return { ok: true, webhookId };
    }
  }
  return { ok: false, reason: 'signature mismatch' };
}

// --- Event dispatch -------------------------------------------------------------

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  create_time?: string;
  resource?: Record<string, unknown>;
}

/** Invoicing events carry the invoice under `resource.invoice`; fall back to `resource.id`. */
export function invoiceIdFromEvent(event: PayPalWebhookEvent): string | undefined {
  const invoice = event.resource?.invoice as { id?: unknown } | undefined;
  const id = invoice?.id ?? event.resource?.id;
  return typeof id === 'string' ? id : undefined;
}

export interface InvoiceStore {
  /** Mark members with this invoice paid. Returns how many rows changed (0 = unknown or already paid). */
  markInvoicePaid(invoiceId: string, paidAt: Date): Promise<number>;
  markInvoiceCancelled(invoiceId: string): Promise<number>;
}

export type DispatchResult =
  | { handled: true; eventType: string; invoiceId: string; updated: number }
  | { handled: false; eventType: string; reason: string };

export async function dispatchWebhookEvent(event: PayPalWebhookEvent, store: InvoiceStore): Promise<DispatchResult> {
  const eventType = event.event_type;
  if (eventType !== 'INVOICING.INVOICE.PAID' && eventType !== 'INVOICING.INVOICE.CANCELLED') {
    return { handled: false, eventType, reason: 'event type not handled' };
  }
  const invoiceId = invoiceIdFromEvent(event);
  if (!invoiceId) return { handled: false, eventType, reason: 'no invoice id in event' };

  const updated =
    eventType === 'INVOICING.INVOICE.PAID'
      ? await store.markInvoicePaid(invoiceId, event.create_time ? new Date(event.create_time) : new Date())
      : await store.markInvoiceCancelled(invoiceId);
  // Memory update + group post happen in the route's onInvoicePaid hook (src/memory/on-payment.ts).
  return { handled: true, eventType, invoiceId, updated };
}
