import { tool } from 'ai';
import { z } from 'zod';
import type { GroupMember, SplitStore } from '../../db/splits.js';
import type { AgentContext } from '../types.js';

export const MAX_PARTICIPANTS = 20; // SCOPE.md hard limit, sender included

/**
 * Slim replacement for exposing the toolkit's create_invoice to the LLM (~2,700 tokens of
 * schema per step on an 8k-tokens/min budget). The agent only describes the split; this
 * saves it as a DRAFT and the bot asks the creator to confirm with a ✅ button. Nothing
 * is invoiced until then — the invoices are created by src/paypal/split_invoices.ts,
 * via the toolkit, after the tap.
 */
export const sendSplitInvoicesInput = z.object({
  description: z.string().min(1).max(60).describe('What it was for, e.g. "football"'),
  total_amount: z.number().positive().max(10_000).describe('Total bill, not per person'),
  currency: z.enum(['EUR', 'USD', 'GBP']),
  participants: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(MAX_PARTICIPANTS - 1)
    .describe('Names or @usernames of the OTHER people who owe a share. Not the sender.'),
  include_sender: z.boolean().default(true).describe('Sender had a share too ("me", "us"). Default true.'),
});

export type SplitProposal =
  | {
      ok: true;
      status: 'awaiting_confirmation';
      split_id: string;
      per_person: string;
      people: number;
      invoices_to: string[];
      not_in_group: string[];
      next_step: string;
    }
  | { ok: false; error: string };

const normalise = (s: string) => s.trim().replace(/^@/, '').toLowerCase();

export type Resolution =
  | { ok: true; members: { displayName: string; userId: number | null }[]; senderListed: boolean; notInGroup: string[] }
  | { ok: false; error: string };

/**
 * Map the names the agent extracted to known group members: exact @username first,
 * then first name. Two members with the same first name → ambiguous, ask. Names that
 * match nobody are kept (they still get an invoice; they just can't be DMed).
 */
export function resolveParticipants(names: string[], members: GroupMember[], senderUserId: number): Resolution {
  const resolved: { displayName: string; userId: number | null }[] = [];
  const notInGroup: string[] = [];
  let senderListed = false;
  const seen = new Set<string>();

  for (const raw of names) {
    const n = normalise(raw);
    if (!n || n === 'me' || n === 'i' || n === 'myself') {
      senderListed = true;
      continue;
    }
    const byUsername = members.filter((m) => m.username && m.username.toLowerCase() === n);
    const byName = members.filter((m) => m.firstName.toLowerCase() === n);
    const matches = byUsername.length > 0 ? byUsername : byName;
    if (matches.length > 1) {
      return { ok: false, error: `"${raw}" matches ${matches.length} members — ask the sender which one (use @username)` };
    }
    const match = matches[0];
    if (match?.userId === senderUserId) {
      senderListed = true;
      continue;
    }
    const key = match ? `u${match.userId}` : `n${n}`;
    if (seen.has(key)) continue; // same person listed twice
    seen.add(key);
    if (match) resolved.push({ displayName: match.firstName, userId: match.userId });
    else {
      const displayName = raw.trim().replace(/^@/, '');
      resolved.push({ displayName, userId: null });
      notInGroup.push(displayName);
    }
  }
  return { ok: true, members: resolved, senderListed, notInGroup };
}

export interface SendSplitInvoicesDeps {
  context: AgentContext;
  store: SplitStore;
  /** users.id of the sender (set by the bot middleware). */
  senderUserId: number;
}

export function createSendSplitInvoicesTool(deps: SendSplitInvoicesDeps) {
  let proposed = false; // one proposal per agent run → one confirmation card

  return tool({
    description:
      'Start a new bill split. Saves it as a draft and shows the sender a ✅/❌ confirmation card; ' +
      'PayPal requests go out only after they tap ✅. Call at most once.',
    inputSchema: sendSplitInvoicesInput,
    execute: async (input): Promise<SplitProposal> => {
      if (proposed) return { ok: false, error: 'a split was already proposed in this run' };

      const members = await deps.store.groupMembers(deps.context.groupId);
      const r = resolveParticipants(input.participants, members, deps.senderUserId);
      if (!r.ok) return r;
      if (r.members.length === 0) return { ok: false, error: 'nobody else to invoice — the sender can’t pay themselves' };

      const people = r.members.length + (input.include_sender || r.senderListed ? 1 : 0);
      if (people > MAX_PARTICIPANTS) return { ok: false, error: `max ${MAX_PARTICIPANTS} people per split` };

      // Equal shares rounded to the cent; any rounding difference stays with the sender.
      const perPerson = Math.round((input.total_amount / people) * 100) / 100;
      const splitId = await deps.store.createDraft({
        groupId: deps.context.groupId,
        creatorUserId: deps.senderUserId,
        description: input.description,
        totalAmount: input.total_amount,
        perPersonAmount: perPerson,
        currency: input.currency,
        members: r.members,
      });
      proposed = true;
      return {
        ok: true,
        status: 'awaiting_confirmation',
        split_id: splitId,
        per_person: `${perPerson.toFixed(2)} ${input.currency}`,
        people,
        invoices_to: r.members.map((m) => m.displayName),
        not_in_group: r.notInGroup,
        next_step:
          'Done — a ✅/❌ card is shown to the sender. Reply in 1–2 lines: summarise the split and tell them to tap ✅ on the card. ' +
          (r.notInGroup.length
            ? 'People in not_in_group still get an invoice; their pay link will be posted in the group. Do not ask about them.'
            : ''),
      };
    },
  });
}
