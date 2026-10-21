import type { SupabaseClient } from '@supabase/supabase-js';
import type { InvoiceScopeStore } from '../agent/tools/paypal_scoped.js';
import type { DmMember, DmStore } from '../agent/tools/telegram_dm.js';
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

interface DmMemberRow {
  id: string;
  display_name: string;
  status: DmMember['status'];
  reminders_sent: number | null;
  user_id: number | null;
  payment_link: string | null;
  splits: { group_id: number; description: string | null; per_person_amount: unknown; currency: string };
  users: { telegram_user_id: number } | null;
}

const MEMBER_SELECT =
  'id, display_name, status, reminders_sent, user_id, payment_link, ' +
  'splits!inner(group_id, description, per_person_amount, currency), users(telegram_user_id)';

function toDmMember(row: DmMemberRow): DmMember {
  return {
    splitMemberId: row.id,
    displayName: row.display_name,
    status: row.status,
    remindersSent: row.reminders_sent ?? 0,
    userId: row.user_id,
    telegramUserId: row.users ? Number(row.users.telegram_user_id) : null,
    share: {
      amount: Number(row.splits.per_person_amount),
      currency: row.splits.currency,
      description: row.splits.description ?? 'split',
      paymentLink: row.payment_link,
    },
  };
}

/** Lookups + writes for the agent's guarded tools (telegram_dm, scoped PayPal tools). */
export function createDmStore(db: SupabaseClient): DmStore & InvoiceScopeStore {
  return {
    async getMember(splitMemberId, groupId) {
      // `splits!inner` + the group filter means a member from another group is simply
      // not found — the agent can never act outside the group it was called for.
      const { data, error } = await db
        .from('split_members')
        .select(MEMBER_SELECT)
        .eq('id', splitMemberId)
        .eq('splits.group_id', groupId)
        .returns<DmMemberRow[]>()
        .maybeSingle();
      if (error) throw new Error(`getMember(${splitMemberId}) failed: ${error.message}`);
      return data ? toDmMember(data) : null;
    },

    async getMemberByInvoice(invoiceId, groupId) {
      const { data, error } = await db
        .from('split_members')
        .select(MEMBER_SELECT)
        .eq('paypal_invoice_id', invoiceId)
        .eq('splits.group_id', groupId)
        .limit(1)
        .returns<DmMemberRow[]>();
      if (error) throw new Error(`getMemberByInvoice(${invoiceId}) failed: ${error.message}`);
      return data[0] ? toDmMember(data[0]) : null;
    },

    async lastReminderAt(userId) {
      const { data, error } = await db
        .from('split_members')
        .select('last_reminded_at')
        .eq('user_id', userId)
        .not('last_reminded_at', 'is', null)
        .order('last_reminded_at', { ascending: false })
        .limit(1);
      if (error) throw new Error(`lastReminderAt(${userId}) failed: ${error.message}`);
      const at = data[0]?.last_reminded_at as string | undefined;
      return at ? new Date(at) : null;
    },

    async recordReminder(splitMemberId, remindersSent, at) {
      const { error } = await db
        .from('split_members')
        .update({ reminders_sent: remindersSent, last_reminded_at: at.toISOString() })
        .eq('id', splitMemberId);
      if (error) throw new Error(`recordReminder(${splitMemberId}) failed: ${error.message}`);
    },

    async markLinkSent(splitMemberId) {
      const { error } = await db
        .from('split_members')
        .update({ status: 'sent' })
        .eq('id', splitMemberId)
        .eq('status', 'pending');
      if (error) throw new Error(`markLinkSent(${splitMemberId}) failed: ${error.message}`);
    },
  };
}
