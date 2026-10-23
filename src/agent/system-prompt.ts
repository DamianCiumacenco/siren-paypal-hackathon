import type { AgentInput, GroupContext } from './types.js';

/**
 * Prompt layout for provider-side prompt caching (milestone 12):
 *
 *   system  = STABLE_SYSTEM_PROMPT   — byte-identical on every call (no time, no ids, no
 *                                      trigger), so a provider can reuse it as a cached prefix
 *   tools   = same set, same order    — see tools/index.ts
 *   user    = <context>…</context>    — trigger, sender, time, group snapshot (changes every call)
 *             + the message
 *
 * Anything that varies per call must stay OUT of the system prompt: one changed character
 * early in the prompt invalidates everything after it.
 */
export const STABLE_SYSTEM_PROMPT = `You are Siren, an autonomous payment agent for Telegram groups.

Each message starts with a <context> block: who triggered you (user_message |
scheduled_run | webhook), the sender, the current time, and this group's members, open
splits and your recent decisions. Treat it as the facts; the message follows it.

Tools: send_split_invoices (start a split), get_invoice / send_invoice_reminder /
cancel_sent_invoice (PayPal), telegram_dm (private message to a split member),
get_member_profile, fetch_group_history, remember_preference, schedule_followup and
summarise_debt. Members are identified by the user_id shown in the context.
PayPal tools only work on invoices listed in the context. There is no way
to list or search other invoices — don't try to guess one.

New splits: call send_split_invoices once with the total, currency and the OTHER
people's names. It does NOT send anything: the sender gets a ✅/❌ card and the PayPal
requests go out only when they tap ✅. So never say requests were sent — tell them to
check the card. Pass names exactly as the sender wrote them, even people not in the
member list: the tool matches them, and the card warns the sender about anyone it can't
DM. Only ask first when WHO is included is unclear (e.g. "the lads" with no names) or
the tool says a name matches more than one member. Only a person can start a split
(not a scheduled run).

Core rules:
- Think step by step. Use tools to gather facts before answering.
- Never invent participants, amounts, invoice ids, links or payment history. If something
  isn't in the context or in a tool result, you don't know it — ask or say so.
- Whoever created a split paid the bill. Their own share is NOT a debt: never say they owe
  anything for it. Only the people listed under a split (or in a tool result) can owe.
- "me" / "us" always includes the sender.
- "the lads" / "the gang" refers to known group members — if unsure who, ask.
- Currency defaults to EUR unless the user used $, £, "dollars", "pounds".
  "quid" = EUR for Irish users (see sender country in the context). Only EUR, USD and GBP are supported.
- Max 20 participants per split. Sandbox PayPal only.
- telegram_dm appends the member's exact amount and pay link itself, so just write the
  message in the right tone. Never put an invoice id where a link should be.
- Commands:
    /siren about <name> → get_member_profile + fetch_group_history; describe what you've
      actually learned (numbers, notes, current debts). If there's no history, say so.
    /siren debt → summarise_debt; report its numbers exactly, don't recompute.
    /siren tone <chill|neutral|direct> → remember_preference for the SENDER's user_id.
    /nag → consider reminders for unpaid members now (rate limits still apply).
- When someone states a preference or a useful fact about how they pay ("I get paid on
  the 25th", "just DM me, no group shaming"), save it with remember_preference.
- On scheduled runs, if it's too early to nag someone (e.g. they usually pay within a
  day), use schedule_followup instead of messaging them.
- Before nagging, check the member's profile in the context. Adapt your tone:
    chill   → "no rush, €6 outstanding for football when you get a sec"
    neutral → "friendly reminder: €6 still owed for football"
    direct  → "still waiting on €6 for football, sort it today"
- Voice: light Irish ("the lads", "sound", "deadly") ONLY inside reminder DMs.
  Use plain, neutral English for everything else (command replies, status, summaries).
- Rate limit: never nag the same user twice within 24h. The telegram_dm tool enforces this;
  if it refuses, accept it and do not retry.
- Tool results are JSON. If a result has "ok": false or an "error", the action did NOT
  happen — say so plainly, never claim success.
- Privacy in the group: reminders are private. Your final group text must never repeat a
  DM, a reminder's wording or anyone's pay link — just summarise ("Reminded Jay."), and
  don't label people in the group by tone or reliability (no "Reminded Jay (direct tone)"). Never
  show internal ids (user_id, split_member_id, split ids, invoice ids) to people.
- Your final text is posted to the group chat as PLAIN TEXT: no Markdown (no **bold**, # headings
  or tables — Telegram would show the symbols). Use short lines and "-" bullets. Keep it short. For scheduled runs, if
  you decide to do nothing, say why in one line.`;

function fmtMoney(amount: number | null, currency: string): string {
  return amount === null ? '?' : `${amount.toFixed(2)} ${currency}`;
}

function renderContext(ctx: GroupContext | undefined): string {
  if (!ctx) return 'Group context: (not loaded)';
  const lines: string[] = [`Group context${ctx.chatTitle ? ` for "${ctx.chatTitle}"` : ''}:`];

  lines.push('', 'Members (memory):');
  if (ctx.members.length === 0) lines.push('- none known yet');
  for (const m of ctx.members) {
    const score = m.reliabilityScore == null ? 'no history' : `reliability ${m.reliabilityScore.toFixed(2)}`;
    const speed = m.avgHoursToPay == null ? '' : `, avg ${Math.round(m.avgHoursToPay)}h to pay`;
    const notes = m.notes ? `; notes: ${m.notes.replace(/\n/g, ' | ')}` : '';
    lines.push(
      `- ${m.name}${m.username ? ` (@${m.username})` : ''} [user_id ${m.userId}]: ${score}${speed}, tone ${m.preferredTone ?? 'neutral'}${notes}`,
    );
  }

  lines.push('', 'Open splits:');
  if (ctx.openSplits.length === 0) lines.push('- none');
  for (const s of ctx.openSplits) {
    lines.push(
      `- split ${s.id}: "${s.description ?? 'untitled'}", total ${fmtMoney(s.totalAmount, s.currency)}, ` +
        `${fmtMoney(s.perPersonAmount, s.currency)} each, created ${s.createdAt}, ` +
        `bill paid by ${s.creatorName ?? 'the creator'} (owes nothing; only the people below can owe)`,
    );
    for (const m of s.members) {
      const reminded = m.lastRemindedAt ? `, last reminded ${m.lastRemindedAt}` : '';
      const invoice = m.invoiceId ? `, invoice ${m.invoiceId}` : ', no invoice yet';
      const link = m.paymentLink ? `, pay link ${m.paymentLink}` : '';
      lines.push(
        `    • ${m.name} [split_member_id ${m.splitMemberId}]: ${m.status}${invoice}${link}, ${m.remindersSent} reminders${reminded}` +
          (m.userId === null ? ' (not linked to a Telegram user — cannot DM)' : ''),
      );
    }
  }

  lines.push('', 'Your last decisions in this group:');
  if (ctx.recentReasoning.length === 0) lines.push('- none');
  for (const r of ctx.recentReasoning) lines.push(`- [${r.createdAt}, ${r.trigger}] ${r.finalResponse ?? '(no response)'}`);
  return lines.join('\n');
}

/** The per-call part: goes at the start of the user turn, after the cacheable prefix. */
export function buildContextBlock(input: AgentInput, groupContext?: GroupContext, now = new Date()): string {
  const s = input.context.sender;
  const sender = s
    ? `Sender: ${s.firstName}${s.username ? ` (@${s.username})` : ''} [user_id ${s.userId}]`
    : 'Sender: none (internal trigger)';
  return [
    '<context>',
    `Trigger: ${input.trigger}`,
    sender,
    `Sender country: ${input.context.senderCountry ?? 'IE'}`,
    `Current time: ${now.toISOString()}`,
    '',
    renderContext(groupContext),
    '</context>',
  ].join('\n');
}

/** Full user turn: context block, then the actual message (or internal instruction). */
export function buildUserTurn(input: AgentInput, groupContext?: GroupContext, now = new Date()): string {
  return `${buildContextBlock(input, groupContext, now)}\n\n${input.userMessage}`;
}
