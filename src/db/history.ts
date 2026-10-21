import type { SupabaseClient } from '@supabase/supabase-js';

/** One past or current split in a group, with each member's outcome. */
export interface HistorySplit {
  id: string;
  description: string;
  status: 'open' | 'settled' | 'cancelled';
  currency: string;
  perPersonAmount: number;
  createdAt: string;
  creator: { userId: number | null; name: string };
  members: {
    name: string;
    userId: number | null;
    status: string;
    paidAt: string | null;
    remindersSent: number;
  }[];
}

export interface HistoryStore {
  /** Newest first. Drafts (never confirmed) are excluded. */
  splits(groupId: number, opts: { limit: number; userId?: number; openOnly?: boolean }): Promise<HistorySplit[]>;
  /** Set when the agent next wants to follow up. Only on this group's open splits. */
  setNextNagAt(splitId: string, groupId: number, at: Date): Promise<boolean>;
}

interface Row {
  id: string;
  description: string | null;
  status: HistorySplit['status'];
  currency: string;
  per_person_amount: unknown;
  created_at: string;
  creator_user_id: number | null;
  creator: { first_name: string | null } | null;
  split_members: {
    display_name: string;
    user_id: number | null;
    status: string;
    paid_at: string | null;
    reminders_sent: number | null;
  }[];
}

export function createHistoryStore(db: SupabaseClient): HistoryStore {
  return {
    async splits(groupId, { limit, userId, openOnly }) {
      // Filtering by member needs an inner join on split_members; the second embed
      // (alias `split_members`) still returns every member of each matching split.
      let q = db
        .from('splits')
        .select(
          'id, description, status, currency, per_person_amount, created_at, creator_user_id, ' +
            'creator:users!creator_user_id(first_name), ' +
            'split_members(display_name, user_id, status, paid_at, reminders_sent)' +
            (userId !== undefined ? ', member_filter:split_members!inner(user_id)' : ''),
        )
        .eq('group_id', groupId)
        .neq('status', 'draft')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (userId !== undefined) q = q.eq('member_filter.user_id', userId);
      if (openOnly) q = q.eq('status', 'open');
      const { data, error } = await q.returns<Row[]>();
      if (error) throw new Error(`history(${groupId}) failed: ${error.message}`);
      return data.map((s) => ({
        id: s.id,
        description: s.description ?? 'split',
        status: s.status,
        currency: s.currency,
        perPersonAmount: Number(s.per_person_amount),
        createdAt: s.created_at,
        creator: { userId: s.creator_user_id === null ? null : Number(s.creator_user_id), name: s.creator?.first_name ?? 'unknown' },
        members: s.split_members.map((m) => ({
          name: m.display_name,
          userId: m.user_id === null ? null : Number(m.user_id),
          status: m.status,
          paidAt: m.paid_at,
          remindersSent: m.reminders_sent ?? 0,
        })),
      }));
    },

    async setNextNagAt(splitId, groupId, at) {
      const { data, error } = await db
        .from('splits')
        .update({ next_nag_at: at.toISOString() })
        .eq('id', splitId)
        .eq('group_id', groupId)
        .eq('status', 'open')
        .select('id');
      if (error) throw new Error(`setNextNagAt(${splitId}) failed: ${error.message}`);
      return data.length > 0;
    },
  };
}
