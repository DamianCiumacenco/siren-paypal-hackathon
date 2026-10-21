import type { MemoryStore } from '../db/memory.js';
import type { PaymentStore } from '../db/payments.js';
import { recomputeMemory } from './profile.js';

export interface OnPaymentDeps {
  payments: PaymentStore;
  memory: MemoryStore;
  /** Post a message in a Telegram group chat. */
  postToGroup: (telegramChatId: number, text: string) => Promise<void>;
  now?: () => Date;
}

export interface OnPaymentResult {
  memberId: string;
  splitId: string;
  /** New reliability, or undefined when the member isn't linked to a Telegram user. */
  reliability?: number | null;
  settled: boolean;
}

/**
 * Flow B, after the webhook has marked the member paid (first delivery only):
 * recompute their memory → settle the split if nobody still owes → tell the group.
 * Deterministic, no LLM: it's a fixed message, costs no Groq tokens, can't misstate amounts.
 */
export async function handleInvoicePaid(invoiceId: string, deps: OnPaymentDeps): Promise<OnPaymentResult | null> {
  const ctx = await deps.payments.paymentContext(invoiceId);
  if (!ctx) return null;
  const now = deps.now?.() ?? new Date();

  let reliability: number | null | undefined;
  if (ctx.member.userId !== null) {
    reliability = (await recomputeMemory(deps.memory, ctx.member.userId, ctx.split.groupId, now)).stats.reliabilityScore;
  }

  const counted = ctx.memberStatuses.filter((s) => s !== 'cancelled');
  const paid = counted.filter((s) => s === 'paid').length;
  const everyonePaid = counted.length > 0 && paid === counted.length;
  const settled = everyonePaid && ctx.split.status === 'open' ? await deps.payments.settleSplit(ctx.split.id) : false;

  const amount = `${ctx.split.perPersonAmount.toFixed(2)} ${ctx.split.currency}`;
  const lines = [`✅ ${ctx.member.displayName} paid ${amount} for "${ctx.split.description}" — ${paid}/${counted.length} paid.`];
  if (settled) lines.push(`🎉 Everyone has paid — "${ctx.split.description}" is settled.`);
  await deps.postToGroup(ctx.telegramChatId, lines.join('\n'));

  return { memberId: ctx.member.id, splitId: ctx.split.id, reliability, settled };
}
