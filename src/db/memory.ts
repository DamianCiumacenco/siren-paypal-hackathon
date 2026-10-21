import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentStats, Share } from '../memory/scoring.js';

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
  /** Every share this user had in this group's confirmed splits (for scoring). */
  paymentRecord(userId: number, groupId: number): Promise<Share[]>;
  /** Write recomputed stats; tone only if given (caller checks tone_locked). */
  saveStats(userId: number, groupId: number, stats: PaymentStats, tone?: Tone): Promise<void>;
  isToneLocked(userId: number, groupId: number): Promise<boolean>;
  /** null if the user isn't a member of this group (no user_memory row). */
  getProfile(userId: number, groupId: number): Promise<MemberProfile | null>;
  updatePreference(userId: number, groupId: number, update: { preferredTone?: Tone; notes?: string }): Promise<boolean>;
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function createMemoryStore(db: SupabaseClient): MemoryStore {
  return {
    async paymentRecord(userId, groupId) {
      const { data, error } = await db
        .from('split_members')
        .select('status, paid_at, splits!inner(created_at, group_id, status)')
        .eq('user_id', userId)
        .eq('splits.group_id', groupId)
        .in('splits.status', ['open', 'settled'])
        .returns<{ status: string; paid_at: string | null; splits: { created_at: string } }[]>();
      if (error) throw new Error(`paymentRecord(${userId}) failed: ${error.message}`);
      return data.map((r) => ({ createdAt: r.splits.created_at, paidAt: r.paid_at, status: r.status }));
    },

    async saveStats(userId, groupId, stats, tone) {
      const { error } = await db
        .from('user_memory')
        .update({
          total_splits: stats.totalSplits,
          total_paid_ontime: stats.totalPaidOnTime,
          avg_hours_to_pay: stats.avgHoursToPay,
          reliability_score: stats.reliabilityScore,
          ...(tone ? { preferred_tone: tone } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('group_id', groupId);
      if (error) throw new Error(`saveStats(${userId}) failed: ${error.message}`);
    },

    async isToneLocked(userId, groupId) {
      const { data, error } = await db
        .from('user_memory')
        .select('tone_locked')
        .eq('user_id', userId)
        .eq('group_id', groupId)
        .maybeSingle();
      if (error) throw new Error(`isToneLocked(${userId}) failed: ${error.message}`);
      return Boolean(data?.tone_locked);
    },

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
      // An explicitly chosen tone wins over the reliability-based auto tone from now on.
      if (update.preferredTone) Object.assign(patch, { preferred_tone: update.preferredTone, tone_locked: true });
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
