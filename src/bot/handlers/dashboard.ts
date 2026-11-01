import type { SirenContext } from '../context.js';

/**
 * `/siren dashboard` (milestone 15): DM the requester a signed link to THIS group's
 * read-only dashboard (src/dashboard/link.ts). The link is never posted in the group, so
 * it can't be forwarded from there; it opens one group only and expires after 24h.
 */
export function isDashboardCommand(ctx: SirenContext): boolean {
  const m = /^\/siren(?:@(\w+))?\s+dashboard\b/i.exec(ctx.message?.text?.trim() ?? '');
  return Boolean(m && (!m[1] || m[1].toLowerCase() === ctx.me.username.toLowerCase()));
}

export async function handleDashboardCommand(ctx: SirenContext, linkFor: (groupId: number) => string): Promise<void> {
  const groupId = ctx.siren?.groupId;
  if (groupId === undefined || !ctx.from) {
    await ctx.reply('Ask me that in the group chat: the dashboard shows one group.');
    return;
  }
  const title = ctx.chat && 'title' in ctx.chat ? ctx.chat.title : 'your group';
  try {
    await ctx.api.sendMessage(ctx.from.id, `Dashboard for "${title}" (read-only, valid 24h, don't share it):\n${linkFor(groupId)}`);
  } catch {
    // Telegram refuses DMs until the person has pressed Start in a private chat with the bot.
    await ctx.reply(`${ctx.from.first_name}, I can't DM you yet. Open a private chat with me, press Start, then send /siren dashboard here again.`);
    return;
  }
  await ctx.reply(`${ctx.from.first_name}, I've sent you this group's dashboard link in a DM (valid 24h).`);
}
