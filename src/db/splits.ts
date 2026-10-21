import type { SupabaseClient } from '@supabase/supabase-js';

export type Currency = 'EUR' | 'USD' | 'GBP';

export interface GroupMember {
  userId: number;
  telegramUserId: number;
  firstName: string;
  username: string | null;
  paypalEmail: string | null;
}

export interface DraftSplit {
  groupId: number;
  creatorUserId: number;
  description: string;
  totalAmount: number;
  perPersonAmount: number;
  currency: Currency;
  members: { displayName: string; userId: number | null }[];
}

export interface SplitForSending {
  id: string;
  groupId: number;
  description: string;
  currency: Currency;
  perPersonAmount: number;
  members: {
    id: string;
    displayName: string;
    userId: number | null;
    telegramUserId: number | null;
    paypalEmail: string | null;
  }[];
}

export interface SplitStore {
  groupMembers(groupId: number): Promise<GroupMember[]>;
  createDraft(split: DraftSplit): Promise<string>;
  /**
   * draft → open, only if `creatorTelegramId` created it. Atomic: a double tap on ✅
   * confirms once; the second call gets null. Returns the split ready for sending.
   */
  confirmDraft(splitId: string, creatorTelegramId: number): Promise<SplitForSending | null>;
  /** draft → cancelled, creator only. Returns false if not a draft or not the creator. */
  cancelDraft(splitId: string, creatorTelegramId: number): Promise<boolean>;
  setMemberInvoice(memberId: string, invoiceId: string, paymentLink: string): Promise<void>;
  setMemberStatus(memberId: string, status: 'sent' | 'failed'): Promise<void>;
}

interface SplitRow {
  id: string;
  group_id: number;
  description: string | null;
  currency: Currency;
  per_person_amount: number | string;
  creator: { telegram_user_id: number | string } | null;
  split_members: {
    id: string;
    display_name: string;
    user_id: number | null;
    users: { telegram_user_id: number | string; paypal_email: string | null } | null;
  }[];
}

export function createSplitStore(db: SupabaseClient): SplitStore {
  const loadSplit = async (splitId: string): Promise<SplitRow | null> => {
    const { data, error } = await db
      .from('splits')
      .select(
        'id, group_id, description, currency, per_person_amount, creator:users!creator_user_id(telegram_user_id), ' +
          'split_members(id, display_name, user_id, users(telegram_user_id, paypal_email))',
      )
      .eq('id', splitId)
      .returns<SplitRow[]>()
      .maybeSingle();
    if (error) throw new Error(`loadSplit(${splitId}) failed: ${error.message}`);
    return data;
  };

  const isCreator = (row: SplitRow, telegramId: number) => Number(row.creator?.telegram_user_id) === telegramId;

  return {
    async groupMembers(groupId) {
      const { data, error } = await db
        .from('user_memory')
        .select('users(id, telegram_user_id, first_name, username, paypal_email)')
        .eq('group_id', groupId)
        .returns<
          {
            users: {
              id: number;
              telegram_user_id: number | string;
              first_name: string | null;
              username: string | null;
              paypal_email: string | null;
            } | null;
          }[]
        >();
      if (error) throw new Error(`groupMembers(${groupId}) failed: ${error.message}`);
      return data.flatMap((r) =>
        r.users
          ? [
              {
                userId: Number(r.users.id),
                telegramUserId: Number(r.users.telegram_user_id),
                firstName: r.users.first_name ?? 'unknown',
                username: r.users.username,
                paypalEmail: r.users.paypal_email,
              },
            ]
          : [],
      );
    },

    async createDraft(split) {
      const { data, error } = await db
        .from('splits')
        .insert({
          group_id: split.groupId,
          creator_user_id: split.creatorUserId,
          description: split.description,
          total_amount: split.totalAmount,
          per_person_amount: split.perPersonAmount,
          currency: split.currency,
          status: 'draft',
        })
        .select('id')
        .single();
      if (error) throw new Error(`createDraft failed: ${error.message}`);
      const splitId = String(data.id);
      const members = await db.from('split_members').insert(
        split.members.map((m) => ({ split_id: splitId, display_name: m.displayName, user_id: m.userId, status: 'pending' })),
      );
      if (members.error) {
        await db.from('splits').delete().eq('id', splitId);
        throw new Error(`createDraft members failed: ${members.error.message}`);
      }
      return splitId;
    },

    async confirmDraft(splitId, creatorTelegramId) {
      const row = await loadSplit(splitId);
      if (!row || !isCreator(row, creatorTelegramId)) return null;
      // The status filter makes this the atomic gate: only one caller flips draft → open.
      const { data, error } = await db
        .from('splits')
        .update({ status: 'open' })
        .eq('id', splitId)
        .eq('status', 'draft')
        .select('id');
      if (error) throw new Error(`confirmDraft(${splitId}) failed: ${error.message}`);
      if (data.length === 0) return null;
      return {
        id: row.id,
        groupId: Number(row.group_id),
        description: row.description ?? 'split',
        currency: row.currency,
        perPersonAmount: Number(row.per_person_amount),
        members: row.split_members.map((m) => ({
          id: m.id,
          displayName: m.display_name,
          userId: m.user_id === null ? null : Number(m.user_id),
          telegramUserId: m.users ? Number(m.users.telegram_user_id) : null,
          paypalEmail: m.users?.paypal_email ?? null,
        })),
      };
    },

    async cancelDraft(splitId, creatorTelegramId) {
      const row = await loadSplit(splitId);
      if (!row || !isCreator(row, creatorTelegramId)) return false;
      const { data, error } = await db
        .from('splits')
        .update({ status: 'cancelled' })
        .eq('id', splitId)
        .eq('status', 'draft')
        .select('id');
      if (error) throw new Error(`cancelDraft(${splitId}) failed: ${error.message}`);
      return data.length > 0;
    },

    async setMemberInvoice(memberId, invoiceId, paymentLink) {
      const { error } = await db
        .from('split_members')
        .update({ paypal_invoice_id: invoiceId, payment_link: paymentLink })
        .eq('id', memberId);
      if (error) throw new Error(`setMemberInvoice(${memberId}) failed: ${error.message}`);
    },

    async setMemberStatus(memberId, status) {
      const { error } = await db.from('split_members').update({ status }).eq('id', memberId);
      if (error) throw new Error(`setMemberStatus(${memberId}) failed: ${error.message}`);
    },
  };
}
