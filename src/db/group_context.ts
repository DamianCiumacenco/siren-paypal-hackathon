import type { SupabaseClient } from '@supabase/supabase-js';
import type { GroupContext } from '../agent/types.js';

interface SplitRow {
  id: string;
  description: string | null;
  currency: string;
  total_amount: number | null;
  per_person_amount: number | null;
  created_at: string;
  split_members: {
    id: string;
    display_name: string;
    user_id: number | null;
    status: string;
    paypal_invoice_id: string | null;
    payment_link: string | null;
    reminders_sent: number | null;
    last_reminded_at: string | null;
  }[];
}

interface MemoryRow {
  user_id: number;
  reliability_score: number | null;
  preferred_tone: 'chill' | 'neutral' | 'direct' | null;
  avg_hours_to_pay: number | null;
  notes: string | null;
  users: { first_name: string | null; username: string | null } | null;
}

/** Load the per-call snapshot the system prompt shows the agent. Scoped to one group. */
export async function loadGroupContext(db: SupabaseClient, groupId: number): Promise<GroupContext> {
  const [group, splits, memory, reasoning] = await Promise.all([
    db.from('groups').select('chat_title').eq('id', groupId).maybeSingle(),
    db
      .from('splits')
      .select(
        'id, description, currency, total_amount, per_person_amount, created_at, ' +
          'split_members(id, display_name, user_id, status, paypal_invoice_id, payment_link, reminders_sent, last_reminded_at)',
      )
      .eq('group_id', groupId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(10)
      .returns<SplitRow[]>(),
    db
      .from('user_memory')
      .select('user_id, reliability_score, preferred_tone, avg_hours_to_pay, notes, users(first_name, username)')
      .eq('group_id', groupId)
      .returns<MemoryRow[]>(),
    db
      .from('reasoning_log')
      .select('trigger, final_response, created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(3),
  ]);
  for (const [name, res] of Object.entries({ group, splits, memory, reasoning })) {
    if (res.error) throw new Error(`loadGroupContext(${groupId}) ${name} query failed: ${res.error.message}`);
  }

  return {
    chatTitle: group.data?.chat_title ?? undefined,
    members: (memory.data ?? []).map((m) => ({
      userId: m.user_id,
      name: m.users?.first_name ?? `user ${m.user_id}`,
      username: m.users?.username ?? undefined,
      reliabilityScore: m.reliability_score === null ? null : Number(m.reliability_score),
      preferredTone: m.preferred_tone,
      avgHoursToPay: m.avg_hours_to_pay === null ? null : Number(m.avg_hours_to_pay),
      notes: m.notes,
    })),
    openSplits: (splits.data ?? []).map((s) => ({
      id: s.id,
      description: s.description,
      currency: s.currency,
      // Postgres numeric comes back from PostgREST as a string-ish value; normalise.
      totalAmount: s.total_amount === null ? null : Number(s.total_amount),
      perPersonAmount: s.per_person_amount === null ? null : Number(s.per_person_amount),
      createdAt: s.created_at,
      members: s.split_members.map((m) => ({
        splitMemberId: m.id,
        name: m.display_name,
        userId: m.user_id,
        status: m.status,
        invoiceId: m.paypal_invoice_id,
        paymentLink: m.payment_link,
        remindersSent: m.reminders_sent ?? 0,
        lastRemindedAt: m.last_reminded_at,
      })),
    })),
    recentReasoning: (reasoning.data ?? []).map((r) => ({
      trigger: r.trigger,
      finalResponse: r.final_response,
      createdAt: r.created_at,
    })),
  };
}
