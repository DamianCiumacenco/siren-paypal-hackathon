import type { HistorySplit } from '../../db/history.js';
import type { SirenContext } from '../context.js';

/**
 * `/status` — who has paid, straight from the database. No LLM: when the agent wrote
 * this, it read "€2 total, €1 each" and told the group the creator still owed €1. The
 * creator paid the bill; their own share is never a debt, and only split_members rows
 * (the people they invoiced) can owe anything.
 */

const SYMBOL: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' };
const UNPAID = new Set(['pending', 'sent', 'failed']);
const MAX_SPLITS = 5;

export function money(amount: number, currency: string): string {
  const sym = SYMBOL[currency];
  return sym ? `${sym}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
}

function formatSplit(s: HistorySplit): string[] {
  const paid = s.members.filter((m) => m.status === 'paid').length;
  const owing = s.members.filter((m) => UNPAID.has(m.status)).length;
  const state =
    s.status === 'settled' ? 'settled 🎉' : s.status === 'cancelled' ? 'cancelled' : `${paid}/${paid + owing} paid`;
  const total = s.totalAmount === null ? '' : `${money(s.totalAmount, s.currency)} total, `;
  const lines = [`"${s.description}" — ${total}${money(s.perPersonAmount, s.currency)} each · ${state}`];

  for (const m of s.members) {
    const what =
      m.status === 'paid'
        ? 'paid ✅'
        : m.status === 'cancelled'
          ? 'cancelled'
          : `owes ${money(s.perPersonAmount, s.currency)}${m.status === 'failed' ? " (pay request didn't go out)" : ''}`;
    lines.push(`- ${m.name} — ${what}`);
  }
  // Only if the creator isn't also an invoiced member (send_split_invoices never does that).
  const creatorInvoiced = s.creator.userId !== null && s.members.some((m) => m.userId === s.creator.userId);
  if (!creatorInvoiced) lines.push(`- ${s.creator.name} — paid the bill (own share, nothing owed)`);
  return lines;
}

/** `splits` = this group's splits, newest first (drafts excluded). */
export function formatStatus(splits: HistorySplit[]): string {
  const open = splits.filter((s) => s.status === 'open').slice(0, MAX_SPLITS);
  if (open.length > 0) return open.map((s) => formatSplit(s).join('\n')).join('\n\n');
  const last = splits[0];
  if (!last) return 'No splits in this group yet. Start one with /split, e.g. /split €60 football with Jay and Sean';
  return ['No open splits — nobody owes anything.', '', 'Most recent:', ...formatSplit(last)].join('\n');
}

export function isStatusCommand(ctx: SirenContext): boolean {
  const m = /^\/status(?:@(\w+))?(?:\s|$)/i.exec(ctx.message?.text?.trim() ?? '');
  return Boolean(m && (!m[1] || m[1].toLowerCase() === ctx.me.username.toLowerCase()));
}
