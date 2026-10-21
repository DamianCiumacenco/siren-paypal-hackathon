import { tool } from 'ai';
import { z } from 'zod';
import type { HistoryStore } from '../../db/history.js';
import type { AgentContext } from '../types.js';

const hoursBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 3_600_000);

/** fetch_group_history: past splits in THIS group (read-only), optionally for one member. */
export function createFetchGroupHistoryTool(deps: { context: AgentContext; store: HistoryStore }) {
  return tool({
    description: 'Past splits in this group, newest first, with who paid and how fast. Optionally only splits one member was in.',
    inputSchema: z.object({
      user_id: z.number().int().optional().describe('Only splits this member was in (user_id from the group context)'),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    execute: async ({ user_id, limit }) => {
      const splits = await deps.store.splits(deps.context.groupId, { limit, userId: user_id });
      return {
        ok: true,
        splits: splits.map((s) => ({
          split_id: s.id,
          description: s.description,
          status: s.status,
          each: `${s.perPersonAmount.toFixed(2)} ${s.currency}`,
          created: s.createdAt.slice(0, 10),
          paid_by: s.creator.name,
          members: s.members
            .filter((m) => user_id === undefined || m.userId === user_id)
            .map((m) => ({
              name: m.name,
              status: m.status,
              hours_to_pay: m.paidAt ? hoursBetween(s.createdAt, m.paidAt) : null,
              reminders: m.remindersSent,
            })),
        })),
      };
    },
  });
}
