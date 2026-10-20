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
