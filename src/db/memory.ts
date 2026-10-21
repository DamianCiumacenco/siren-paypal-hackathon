import type { SupabaseClient } from '@supabase/supabase-js';

export type Tone = 'chill' | 'neutral' | 'direct';

export interface MemberProfile {
  userId: number;
  name: string;
  username: string | null;
  reliabilityScore: number | null;
  preferredTone: Tone;
  avgHoursToPay: number | null;
  totalSplits: number;
  totalPaidOnTime: number;
  notes: string | null;
  updatedAt: string | null;
  /** Unpaid shares in this group's open splits. */
  outstanding: { splitId: string; description: string; amount: string; status: string; remindersSent: number }[];
}

export interface MemoryStore {
  /** null if the user isn't a member of this group (no user_memory row). */
  getProfile(userId: number, groupId: number): Promise<MemberProfile | null>;
  updatePreference(userId: number, groupId: number, update: { preferredTone?: Tone; notes?: string }): Promise<boolean>;
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function createMemoryStore(db: SupabaseClient): MemoryStore {
  return {
    async getProfile(userId, groupId) {
      const { data: row, error } = await db
        .from('user_memory')
        .select(
          'reliability_score, preferred_tone, avg_hours_to_pay, total_splits, total_paid_ontime, notes, updated_at, users(first_name, username)',
        )
        .eq('user_id', userId)
        .eq('group_id', groupId)
        .returns<
          {
            reliability_score: unknown;
            preferred_tone: Tone | null;
            avg_hours_to_pay: unknown;
            total_splits: number | null;
            total_paid_ontime: number | null;
            notes: string | null;
            updated_at: string | null;
            users: { first_name: string | null; username: string | null } | null;
          }[]
        >()
        .maybeSingle();
      if (error) throw new Error(`getProfile(${userId}) failed: ${error.message}`);
      if (!row) return null;

      const { data: owed, error: owedErr } = await db
        .from('split_members')
        .select('status, reminders_sent, splits!inner(id, description, currency, per_person_amount, status, group_id)')
        .eq('user_id', userId)
        .eq('splits.group_id', groupId)
        .eq('splits.status', 'open')
        .in('status', ['pending', 'sent', 'failed'])
        .returns<
          {
            status: string;
            reminders_sent: number | null;
            splits: { id: string; description: string | null; currency: string; per_person_amount: unknown };
          }[]
        >();
      if (owedErr) throw new Error(`getProfile(${userId}) outstanding failed: ${owedErr.message}`);

      return {
        userId,
        name: row.users?.first_name ?? `user ${userId}`,
        username: row.users?.username ?? null,
        reliabilityScore: n(row.reliability_score),
        preferredTone: row.preferred_tone ?? 'neutral',
        avgHoursToPay: n(row.avg_hours_to_pay),
        totalSplits: row.total_splits ?? 0,
        totalPaidOnTime: row.total_paid_ontime ?? 0,
        notes: row.notes,
        updatedAt: row.updated_at,
        outstanding: owed.map((o) => ({
          splitId: o.splits.id,
          description: o.splits.description ?? 'split',
          amount: `${Number(o.splits.per_person_amount).toFixed(2)} ${o.splits.currency}`,
          status: o.status,
          remindersSent: o.reminders_sent ?? 0,
        })),
      };
    },

    async updatePreference(userId, groupId, update) {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (update.preferredTone) patch.preferred_tone = update.preferredTone;
      if (update.notes !== undefined) patch.notes = update.notes;
      const { data, error } = await db
        .from('user_memory')
        .update(patch)
        .eq('user_id', userId)
        .eq('group_id', groupId)
        .select('id');
      if (error) throw new Error(`updatePreference(${userId}) failed: ${error.message}`);
      return data.length > 0;
    },
  };
}
