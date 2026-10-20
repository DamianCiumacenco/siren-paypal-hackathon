import type { SupabaseClient } from '@supabase/supabase-js';
import type { InvoiceStore } from '../paypal/webhooks.js';

/**
 * Invoice status updates driven by PayPal webhooks. The status filters make these
 * idempotent: PayPal retries deliveries, and a repeat PAID event changes 0 rows.
 */
export function createInvoiceStore(db: SupabaseClient): InvoiceStore {
  return {
    async markInvoicePaid(invoiceId, paidAt) {
      const { data, error } = await db
        .from('split_members')
        .update({ status: 'paid', paid_at: paidAt.toISOString() })
        .eq('paypal_invoice_id', invoiceId)
        .neq('status', 'paid')
        .select('id');
      if (error) throw new Error(`markInvoicePaid(${invoiceId}) failed: ${error.message}`);
      return data.length;
    },

    async markInvoiceCancelled(invoiceId) {
      const { data, error } = await db
        .from('split_members')
        .update({ status: 'cancelled' })
        .eq('paypal_invoice_id', invoiceId)
        .not('status', 'in', '(paid,cancelled)')
        .select('id');
      if (error) throw new Error(`markInvoiceCancelled(${invoiceId}) failed: ${error.message}`);
      return data.length;
    },
  };
}
