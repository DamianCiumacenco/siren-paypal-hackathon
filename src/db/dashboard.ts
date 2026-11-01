import type { SupabaseClient } from '@supabase/supabase-js';

export interface DashboardMemberRow {
  userId: number;
  name: string;
  reliabilityScore: number | null;
  avgHoursToPay: number | null;
  totalSplits: number;
  totalPaidOnTime: number;
  preferredTone: string | null;
  toneLocked: boolean;
}

interface Row {
  user_id: number;
  reliability_score: unknown;
  avg_hours_to_pay: unknown;
  total_splits: number | null;
  total_paid_ontime: number | null;
  preferred_tone: string | null;
  tone_locked: boolean | null;
  users: { first_name: string | null } | null;
}

/** Group title + what Siren has learned about each member. One group only. */
export function createDashboardStore(db: SupabaseClient) {
  return {
    async groupTitle(groupId: number): Promise<string | null | undefined> {
      const { data, error } = await db.from('groups').select('chat_title').eq('id', groupId).maybeSingle();
      if (error) throw new Error(`dashboard groupTitle(${groupId}) failed: ${error.message}`);
      return data ? (data.chat_title ?? null) : undefined; // undefined = no such group
    },

    async members(groupId: number): Promise<DashboardMemberRow[]> {
      const { data, error } = await db
        .from('user_memory')
        .select('user_id, reliability_score, avg_hours_to_pay, total_splits, total_paid_ontime, preferred_tone, tone_locked, users(first_name)')
        .eq('group_id', groupId)
        .returns<Row[]>();
      if (error) throw new Error(`dashboard members(${groupId}) failed: ${error.message}`);
      return data.map((m) => ({
        userId: Number(m.user_id),
        name: m.users?.first_name ?? 'unknown',
        reliabilityScore: m.reliability_score === null ? null : Number(m.reliability_score),
        avgHoursToPay: m.avg_hours_to_pay === null ? null : Number(m.avg_hours_to_pay),
        totalSplits: m.total_splits ?? 0,
        totalPaidOnTime: m.total_paid_ontime ?? 0,
        preferredTone: m.preferred_tone,
        toneLocked: Boolean(m.tone_locked),
      }));
    },
  };
}
