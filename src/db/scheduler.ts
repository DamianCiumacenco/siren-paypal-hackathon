import type { SupabaseClient } from '@supabase/supabase-js';

export interface SplitToCheck {
  id: string;
  groupId: number;
  telegramChatId: number;
  description: string;
  perPersonAmount: number;
  currency: string;
  createdAt: string;
  /** Set by the agent's schedule_followup tool. */
  nextNagAt: string | null;
  unpaid: { name: string; userId: number | null; lastRemindedAt: string | null; remindersSent: number }[];
}

export interface SchedulerStore {
  /** Open splits (optionally only these groups), oldest first, with their unpaid members. */
  openSplits(opts?: { groupIds?: number[] }): Promise<SplitToCheck[]>;
}

const UNPAID = ['pending', 'sent', 'failed'];

interface Row {
  id: string;
  group_id: number;
  description: string | null;
  per_person_amount: unknown;
  currency: string;
  created_at: string;
  next_nag_at: string | null;
  groups: { telegram_chat_id: number | string };
  split_members: {
    display_name: string;
    user_id: number | null;
    status: string;
    last_reminded_at: string | null;
    reminders_sent: number | null;
  }[];
}

export function createSchedulerStore(db: SupabaseClient): SchedulerStore {
  return {
    async openSplits(opts = {}) {
      let q = db
        .from('splits')
        .select(
          'id, group_id, description, per_person_amount, currency, created_at, next_nag_at, ' +
            'groups!inner(telegram_chat_id), split_members(display_name, user_id, status, last_reminded_at, reminders_sent)',
        )
        .eq('status', 'open')
        .order('created_at', { ascending: true })
        .limit(100);
      if (opts.groupIds) q = q.in('group_id', opts.groupIds);
      const { data, error } = await q.returns<Row[]>();
      if (error) throw new Error(`openSplits failed: ${error.message}`);
      return data.map((s) => ({
        id: s.id,
        groupId: Number(s.group_id),
        telegramChatId: Number(s.groups.telegram_chat_id),
        description: s.description ?? 'split',
        perPersonAmount: Number(s.per_person_amount),
        currency: s.currency,
        createdAt: s.created_at,
        nextNagAt: s.next_nag_at,
        unpaid: s.split_members
          .filter((m) => UNPAID.includes(m.status))
          .map((m) => ({
            name: m.display_name,
            userId: m.user_id === null ? null : Number(m.user_id),
            lastRemindedAt: m.last_reminded_at,
            remindersSent: m.reminders_sent ?? 0,
          })),
      }));
    },
  };
}
