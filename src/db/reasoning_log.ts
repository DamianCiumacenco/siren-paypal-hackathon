import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReasoningRecord } from '../agent/reasoning-log.js';

export async function insertReasoningLog(db: SupabaseClient, record: ReasoningRecord): Promise<void> {
  const { error } = await db.from('reasoning_log').insert({
    group_id: record.groupId,
    split_id: record.splitId ?? null,
    trigger: record.trigger,
    thoughts: record.thoughts,
    final_response: record.finalResponse,
  });
  if (error) throw new Error(`insertReasoningLog failed: ${error.message}`);
}

export interface ReasoningLogEntry {
  trigger: string | null;
  createdAt: string;
  thoughts: unknown;
  finalResponse: string | null;
}

/** Most recent agent decision in this group (for `/siren why`). */
export async function lastReasoningLog(db: SupabaseClient, groupId: number): Promise<ReasoningLogEntry | null> {
  const { data, error } = await db
    .from('reasoning_log')
    .select('trigger, created_at, thoughts, final_response')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`lastReasoningLog(${groupId}) failed: ${error.message}`);
  return data ? { trigger: data.trigger, createdAt: data.created_at, thoughts: data.thoughts, finalResponse: data.final_response } : null;
}
