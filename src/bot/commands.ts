import type { Bot } from 'grammy';
import type { SirenContext } from './context.js';

export const START_TEXT =
  "Hi, I'm Siren. I split bills with PayPal and chase up who still owes. Type /help to see what I can do.";

export const HELP_TEXT = [
  'Siren commands:',
  '/split — start a new bill split, e.g. /split €60 football with Jay, Sean and Mike',
  '/status — who has paid and who has not',
  '/nag — remind unpaid members',
  '/siren about <name> — what I have learned about someone',
  '/siren why — why I did what I did last',
  '/siren debt — who owes whom overall',
  '/siren tone <chill|neutral|direct> — how you want to be reminded',
  '',
  'You can also mention me or reply to me in the group.',
  'Open a private chat with me and press Start so I can DM you your pay links.',
].join('\n');

/** Direct replies that don't need the agent. */
export function registerBasicCommands(bot: Bot<SirenContext>): void {
  bot.command('start', (ctx) => ctx.reply(START_TEXT));
  bot.command('help', (ctx) => ctx.reply(HELP_TEXT));
}
