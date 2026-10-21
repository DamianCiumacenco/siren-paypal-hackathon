import type { SupabaseClient } from '@supabase/supabase-js';

export interface PaymentContext {
  member: { id: string; userId: number | null; displayName: string };
  split: { id: string; description: string; perPersonAmount: number; currency: string; status: string; groupId: number };
  telegramChatId: number;
  /** Status of every member of the split (after this payment). */
  memberStatuses: string[];
}

export interface PaymentStore {
  /** Everything needed to react to a paid invoice, or null if it isn't a Siren invoice. */
  paymentContext(invoiceId: string): Promise<PaymentContext | null>;
  /** open → settled. Returns true only for the call that settled it. */
  settleSplit(splitId: string): Promise<boolean>;
}

interface Row {
  id: string;
  user_id: number | null;
  display_name: string;
  splits: {
    id: string;
    description: string | null;
    per_person_amount: unknown;
    currency: string;
    status: string;
    group_id: number;
    groups: { telegram_chat_id: number | string };
    split_members: { status: string }[];
  };
}

export function createPaymentStore(db: SupabaseClient): PaymentStore {
  return {
    async paymentContext(invoiceId) {
      const { data, error } = await db
        .from('split_members')
        .select(
          'id, user_id, display_name, splits!inner(id, description, per_person_amount, currency, status, group_id, ' +
            'groups!inner(telegram_chat_id), split_members(status))',
        )
        .eq('paypal_invoice_id', invoiceId)
        .limit(1)
        .returns<Row[]>();
      if (error) throw new Error(`paymentContext(${invoiceId}) failed: ${error.message}`);
      const r = data[0];
      if (!r) return null;
      return {
        member: { id: r.id, userId: r.user_id === null ? null : Number(r.user_id), displayName: r.display_name },
        split: {
          id: r.splits.id,
          description: r.splits.description ?? 'split',
          perPersonAmount: Number(r.splits.per_person_amount),
          currency: r.splits.currency,
          status: r.splits.status,
          groupId: Number(r.splits.group_id),
        },
        telegramChatId: Number(r.splits.groups.telegram_chat_id),
        memberStatuses: r.splits.split_members.map((m) => m.status),
      };
    },

    async settleSplit(splitId) {
      const { data, error } = await db.from('splits').update({ status: 'settled' }).eq('id', splitId).eq('status', 'open').select('id');
      if (error) throw new Error(`settleSplit(${splitId}) failed: ${error.message}`);
      return data.length > 0;
    },
  };
}
