import { tool } from 'ai';
import { z } from 'zod';
import type { HistoryStore } from '../../db/history.js';
import type { AgentContext } from '../types.js';

/** schedule_followup: the agent decides when it next wants to look at an open split. */
export function createScheduleFollowupTool(deps: { context: AgentContext; store: HistoryStore; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return tool({
    description: 'Decide when to check an open split again (sets its next follow-up time). Use instead of nagging early.',
    inputSchema: z.object({
      split_id: z.string().uuid(),
      hours: z.number().int().min(1).max(168).describe('Hours from now, 1–168'),
      reason: z.string().min(3).max(120),
    }),
    execute: async ({ split_id, hours }) => {
      const at = new Date(now().getTime() + hours * 3_600_000);
      const ok = await deps.store.setNextNagAt(split_id, deps.context.groupId, at);
      return ok ? { ok: true, split_id, next_followup_at: at.toISOString() } : { ok: false, error: 'no open split with that id in this group' };
    },
  });
}
