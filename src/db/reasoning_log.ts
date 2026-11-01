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

/** This group's agent decisions, newest first (`/siren why` takes 1, the dashboard more). */
export async function recentReasoningLogs(db: SupabaseClient, groupId: number, limit: number): Promise<ReasoningLogEntry[]> {
  const { data, error } = await db
    .from('reasoning_log')
    .select('trigger, created_at, thoughts, final_response')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`recentReasoningLogs(${groupId}) failed: ${error.message}`);
  return data.map((r) => ({ trigger: r.trigger, createdAt: r.created_at, thoughts: r.thoughts, finalResponse: r.final_response }));
}

/** Most recent agent decision in this group (for `/siren why`). */
export async function lastReasoningLog(db: SupabaseClient, groupId: number): Promise<ReasoningLogEntry | null> {
  return (await recentReasoningLogs(db, groupId, 1))[0] ?? null;
}
