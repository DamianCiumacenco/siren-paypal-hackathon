import type { Thought } from '../agent/reasoning-log.js';
import { formatWhySteps, redact, TRIGGER_LABEL } from '../bot/handlers/why.js';
import type { DashboardMemberRow } from '../db/dashboard.js';
import type { HistorySplit } from '../db/history.js';
import type { ReasoningLogEntry } from '../db/reasoning_log.js';
import { money } from '../lib/money.js';

/**
 * JSON behind /dashboard: one group's splits, members and agent decisions. Same facts and
 * the same redaction as the bot's own replies:
 * - amounts and statuses come from the database, never the LLM
 * - the creator's own share is never a debt (milestone 13)
 * - reasoning goes through formatWhy/redact: no pay links, invoice numbers, ids or DM text
 * - no memory notes (stated preferences people told Siren), no Telegram ids
 */

export interface DashboardSources {
  groupTitle: (groupId: number) => Promise<string | null | undefined>;
  splits: (groupId: number) => Promise<HistorySplit[]>;
  members: (groupId: number) => Promise<DashboardMemberRow[]>;
  reasoning: (groupId: number) => Promise<ReasoningLogEntry[]>;
}

const UNPAID = new Set(['pending', 'sent', 'failed']);
const SUMMARY_CHARS = 160;

export interface DashboardData {
  group: { title: string };
  generatedAt: string;
  splits: {
    description: string;
    status: string;
    created: string;
    total: string;
    each: string;
    paid: string;
    owing: string;
    paidBy: string;
  }[];
  members: {
    name: string;
    reliability: number | null;
    tone: string;
    toneSource: 'stated' | 'learned' | 'default';
    avgHoursToPay: number | null;
    onTime: string;
    owes: string;
  }[];
  reasoning: {
    at: string;
    trigger: string;
    models: string;
    tools: string;
    summary: string;
    detail: string;
  }[];
}

/** undefined = the group doesn't exist (deleted since the link was made). */
export async function buildDashboardData(groupId: number, src: DashboardSources, now = new Date()): Promise<DashboardData | undefined> {
  const title = await src.groupTitle(groupId);
  if (title === undefined) return undefined;
  const [splits, members, reasoning] = await Promise.all([src.splits(groupId), src.members(groupId), src.reasoning(groupId)]);

  // What each member still owes across open splits, per currency (in cents).
  const owed = new Map<number, Map<string, number>>();
  for (const s of splits.filter((x) => x.status === 'open')) {
    for (const m of s.members) {
      if (m.userId === null || !UNPAID.has(m.status) || m.userId === s.creator.userId) continue;
      const byCurrency = owed.get(m.userId) ?? new Map<string, number>();
      byCurrency.set(s.currency, (byCurrency.get(s.currency) ?? 0) + Math.round(s.perPersonAmount * 100));
      owed.set(m.userId, byCurrency);
    }
  }

  return {
    group: { title: title ?? 'Untitled group' },
    generatedAt: now.toISOString(),
    splits: splits.map((s) => {
      const counted = s.members.filter((m) => m.status !== 'cancelled');
      const paid = counted.filter((m) => m.status === 'paid').length;
      return {
        description: s.description,
        status: s.status,
        created: s.createdAt,
        total: s.totalAmount === null ? '' : money(s.totalAmount, s.currency),
        each: money(s.perPersonAmount, s.currency),
        paid: `${paid}/${counted.length}`,
        owing: s.status === 'open' ? counted.filter((m) => UNPAID.has(m.status)).map((m) => m.name).join(', ') : '',
        paidBy: s.creator.name,
      };
    }),
    members: members
      .map((m) => ({
        name: m.name,
        reliability: m.reliabilityScore,
        tone: m.preferredTone ?? 'neutral',
        toneSource: (m.toneLocked ? 'stated' : m.preferredTone ? 'learned' : 'default') as 'stated' | 'learned' | 'default',
        avgHoursToPay: m.avgHoursToPay,
        onTime: m.totalSplits ? `${m.totalPaidOnTime}/${m.totalSplits}` : '',
        owes: [...(owed.get(m.userId) ?? new Map<string, number>())].map(([cur, cents]) => money(cents / 100, cur)).join(' + '),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    reasoning: reasoning.map((r) => {
      const thoughts = (Array.isArray(r.thoughts) ? r.thoughts : []) as Thought[];
      const summary = redact((r.finalResponse ?? '').replace(/\s+/g, ' ').trim());
      return {
        at: r.createdAt,
        trigger: TRIGGER_LABEL[r.trigger ?? ''] ?? r.trigger ?? 'unknown',
        models: [...new Set(thoughts.map((t) => t.model).filter(Boolean))].join(', '),
        tools: thoughts.flatMap((t) => t.toolCalls.map((c) => c.tool)).join(' → '),
        summary: summary.length > SUMMARY_CHARS ? `${summary.slice(0, SUMMARY_CHARS - 1)}…` : summary,
        // Same redacted step view as /siren why, without its header (the grid row shows that).
        detail: formatWhySteps(r),
      };
    }),
  };
}
