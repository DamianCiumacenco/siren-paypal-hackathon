import type { FastifyInstance } from 'fastify';
import { logError } from '../lib/safe-error.js';
import {
  dispatchWebhookEvent,
  readWebhookHeaders,
  verifyWebhookSignature,
  type CertFetcher,
  type InvoiceStore,
  type PayPalWebhookEvent,
} from '../paypal/webhooks.js';

export interface PayPalRouteOptions {
  /** Webhook IDs whose signatures we accept. Empty → route answers 503. */
  webhookIds: string[];
  store: InvoiceStore;
  fetchCertPem?: CertFetcher;
  /**
   * Runs once per invoice, on the delivery that first marked it paid (memory update,
   * settle, group post). Failures are logged and still answered 200: the member is
   * already marked paid, so a PayPal retry would update 0 rows and skip this anyway.
   */
  onInvoicePaid?: (invoiceId: string) => Promise<unknown>;
}

// POST /webhook/paypal. Status codes matter: PayPal retries any non-2xx for up to 3 days,
// so we only return an error when a retry could actually help.
export async function paypalRoutes(app: FastifyInstance, opts: PayPalRouteOptions): Promise<void> {
  // Keep the raw body: the signature covers the exact bytes PayPal sent, so we must not
  // let Fastify parse and re-serialise it. Scoped to this plugin only.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post('/webhook/paypal', async (request, reply) => {
    if (opts.webhookIds.length === 0) {
      request.log.error('PayPal webhook received but PAYPAL_WEBHOOK_ID is not set');
      return reply.code(503).send({ error: 'webhook not configured' });
    }

    const headers = readWebhookHeaders(request.headers);
    const rawBody = typeof request.body === 'string' ? request.body : '';
    if (!headers || !rawBody) return reply.code(400).send({ error: 'missing signature headers or body' });

    const verdict = await verifyWebhookSignature({
      headers,
      rawBody,
      webhookIds: opts.webhookIds,
      fetchCertPem: opts.fetchCertPem,
    });
    if (!verdict.ok) {
      // Log why + transmission id only — never the payload (CLAUDE.md).
      request.log.warn({ transmissionId: headers.transmissionId, reason: verdict.reason }, 'PayPal webhook rejected');
      return reply.code(400).send({ error: 'invalid signature' });
    }

    let event: PayPalWebhookEvent;
    try {
      event = JSON.parse(rawBody) as PayPalWebhookEvent;
    } catch {
      return reply.code(400).send({ error: 'invalid json' });
    }

    const result = await dispatchWebhookEvent(event, opts.store); // throws → 500 → PayPal retries
    if (result.handled && result.eventType === 'INVOICING.INVOICE.PAID' && result.updated > 0 && opts.onInvoicePaid) {
      try {
        await opts.onInvoicePaid(result.invoiceId);
      } catch (err) {
        logError(request.log, err, 'post-payment update failed', { eventId: event.id, invoiceId: result.invoiceId });
      }
    }
    request.log.info(
      { eventId: event.id, simulator: verdict.webhookId === 'WEBHOOK_ID', ...result },
      'PayPal webhook processed',
    );
    return reply.code(200).send({ received: true });
  });
}
