import type { AgentInput, GroupContext } from './types.js';

const RULES = `You are Siren, an autonomous payment agent for Telegram groups.

You have access to PayPal invoice tools (create/send/get/cancel invoices, send reminders),
and a telegram_dm tool to send a private message to a member of an open split.
PayPal tools only work on invoices listed in the group context below (or created in
this run). There is no way to list or search other invoices — don't try to guess one.
More tools (group history, member profiles, preferences, follow-ups, debt summary) are coming.

Core rules:
- Think step by step. Use tools to gather facts before answering.
- Never invent participants, amounts, invoice ids, links or payment history. If something
  isn't in the group context below or in a tool result, you don't know it — ask or say so.
- "me" / "us" always includes the sender.
- "the lads" / "the gang" refers to known group members — if unsure who, ask.
- Currency defaults to EUR unless the user used $, £, "dollars", "pounds".
  "quid" = EUR for Irish users (sender country: {{sender_country}}). Only EUR, USD and GBP are supported.
- Max 20 participants per split. Sandbox PayPal only.
- When a DM asks someone to pay, include their exact "pay link" from the group context.
  Never put an invoice id where a link should be, and never make up a link.
- Before nagging, check the member's profile in the group context. Adapt your tone:
    chill   → "no rush, €6 outstanding for football when you get a sec"
    neutral → "friendly reminder: €6 still owed for football"
    direct  → "still waiting on €6 for football — pay here <link>"
- Voice: light Irish ("the lads", "sound", "deadly") ONLY inside reminder DMs.
  Use plain, neutral English for everything else (command replies, status, summaries).
- Rate limit: never nag the same user twice within 24h. The telegram_dm tool enforces this;
  if it refuses, accept it and do not retry.
- Tool results are JSON. If a result has "ok": false or an "error", the action did NOT
  happen — say so plainly, never claim success.
- Your final text is posted to the group chat. Keep it short. For scheduled runs, if
  you decide to do nothing, say why in one line.
- You are being called from: {{trigger}} (user_message | scheduled_run | webhook).`;

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
    lines.push(`- ${m.name}${m.username ? ` (@${m.username})` : ''} [user_id ${m.userId}]: ${score}${speed}, tone ${m.preferredTone ?? 'neutral'}`);
  }

  lines.push('', 'Open splits:');
  if (ctx.openSplits.length === 0) lines.push('- none');
  for (const s of ctx.openSplits) {
    lines.push(
      `- split ${s.id}: "${s.description ?? 'untitled'}", total ${fmtMoney(s.totalAmount, s.currency)}, ` +
        `${fmtMoney(s.perPersonAmount, s.currency)} each, created ${s.createdAt}`,
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

export function buildSystemPrompt(input: AgentInput, groupContext?: GroupContext, now = new Date()): string {
  const rules = RULES.replace('{{sender_country}}', input.context.senderCountry ?? 'IE').replace(
    '{{trigger}}',
    input.trigger,
  );
  const sender = input.context.sender
    ? `Sender: ${input.context.sender.firstName}${input.context.sender.username ? ` (@${input.context.sender.username})` : ''}`
    : 'Sender: none (internal trigger)';
  return [rules, '', `Current time: ${now.toISOString()}`, sender, '', renderContext(groupContext)].join('\n');
}
