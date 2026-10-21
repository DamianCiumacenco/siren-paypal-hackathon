import { tool } from 'ai';
import { z } from 'zod';
import type { MemoryStore } from '../../db/memory.js';
import type { AgentContext } from '../types.js';

/** get_member_profile: what Siren has learned about one member of THIS group. */
export function createGetMemberProfileTool(deps: { context: AgentContext; store: MemoryStore }) {
  return tool({
    description: "A member's payment profile in this group: reliability, usual speed, preferred tone, notes, what they owe now.",
    inputSchema: z.object({ user_id: z.number().int().describe('user_id from the group context') }),
    execute: async ({ user_id }) => {
      const p = await deps.store.getProfile(user_id, deps.context.groupId);
      if (!p) return { ok: false, error: 'not a member of this group' };
      return {
        ok: true,
        name: p.name,
        reliability: p.reliabilityScore === null ? 'no history yet' : Number(p.reliabilityScore.toFixed(2)),
        avg_hours_to_pay: p.avgHoursToPay === null ? null : Math.round(p.avgHoursToPay),
        preferred_tone: p.preferredTone,
        splits: p.totalSplits,
        paid_on_time: p.totalPaidOnTime,
        notes: p.notes,
        owes_now: p.outstanding.map((o) => ({ description: o.description, amount: o.amount, status: o.status, reminders: o.remindersSent })),
      };
    },
  });
}
