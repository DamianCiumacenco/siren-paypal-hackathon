import { tool } from 'ai';
import { z } from 'zod';
import type { HistorySplit, HistoryStore } from '../../db/history.js';
import type { AgentContext } from '../types.js';

const UNPAID = new Set(['pending', 'sent', 'failed']);

export interface Debt {
  from: string;
  to: string;
  amount: string;
  currency: string;
  splits: number;
}

/**
 * Net balances across open splits, per currency. Each unpaid share is a debt from the
 * member to the split's creator; opposite debts between the same two people cancel
 * out. Done in code (cents, integers) so the LLM never does the arithmetic.
 */
export function computeDebts(openSplits: HistorySplit[]): Debt[] {
  type Edge = { cents: number; splits: number; fromName: string; toName: string };
  const edges = new Map<string, Edge>(); // `${currency}|${from}|${to}`
  const key = (id: number | null, name: string) => (id === null ? `name:${name.toLowerCase()}` : `user:${id}`);

  for (const s of openSplits) {
    const to = key(s.creator.userId, s.creator.name);
    const cents = Math.round(s.perPersonAmount * 100);
    for (const m of s.members) {
      if (!UNPAID.has(m.status)) continue;
      const from = key(m.userId, m.name);
      if (from === to) continue;
      const k = `${s.currency}|${from}|${to}`;
      const e = edges.get(k) ?? { cents: 0, splits: 0, fromName: m.name, toName: s.creator.name };
      e.cents += cents;
      e.splits += 1;
      edges.set(k, e);
    }
  }

  const debts: Debt[] = [];
  const done = new Set<string>();
  for (const [k, e] of edges) {
    if (done.has(k)) continue;
    const [currency, from, to] = k.split('|') as [string, string, string];
    const reverseKey = `${currency}|${to}|${from}`;
    const reverse = edges.get(reverseKey);
    done.add(k);
    done.add(reverseKey);
    const net = e.cents - (reverse?.cents ?? 0);
    const splits = e.splits + (reverse?.splits ?? 0);
    if (net > 0) debts.push({ from: e.fromName, to: e.toName, amount: (net / 100).toFixed(2), currency, splits });
    else if (net < 0 && reverse) debts.push({ from: reverse.fromName, to: reverse.toName, amount: (-net / 100).toFixed(2), currency, splits });
  }
  return debts.sort((a, b) => Number(b.amount) - Number(a.amount));
}

/** summarise_debt: who owes whom across this group's open splits (read-only). */
export function createSummariseDebtTool(deps: { context: AgentContext; store: HistoryStore }) {
  return tool({
    description: 'Net balances (who owes whom, after cancelling out) across all open splits in this group. Report these numbers as-is.',
    inputSchema: z.object({}),
    execute: async () => {
      const open = await deps.store.splits(deps.context.groupId, { limit: 50, openOnly: true });
      const debts = computeDebts(open);
      return {
        ok: true,
        open_splits: open.length,
        debts: debts.map((d) => ({ from: d.from, to: d.to, amount: `${d.amount} ${d.currency}`, splits: d.splits })),
      };
    },
  });
}
