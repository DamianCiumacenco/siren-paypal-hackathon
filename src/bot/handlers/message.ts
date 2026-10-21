import { APICallError, RetryError } from 'ai';
import { InlineKeyboard } from 'grammy';
import { findSplitProposal, type AgentOutput } from '../../agent/run.js';
import type { AgentInput } from '../../agent/types.js';
import { logError, type Logger } from '../../lib/safe-error.js';
import type { SirenContext } from '../context.js';

export interface MessageHandlerDeps {
  runAgent: (input: AgentInput) => Promise<AgentOutput>;
  log: Logger;
  /**
   * Agent runs take 5–60s. Telegram webhooks must be answered fast (grammy times out
   * at 10s), so the run happens in the background. Tests pass a collector to await it.
   */
  background?: (work: Promise<void>) => void;
}

/** Commands that go to the agent. /start and /help are answered directly. */
export const AGENT_COMMANDS = ['split', 'status', 'nag'] as const;

/**
 * In groups the bot sees every message (privacy mode off), but only these reach the
 * agent — running it on all chatter would burn the 8k tokens/min Groq budget:
 * agent commands, @mentions of the bot, and replies to the bot.
 */
export function agentPrompt(ctx: SirenContext): string | undefined {
  const msg = ctx.message;
  const text = msg?.text?.trim();
  if (!msg || !text) return undefined;
  const me = ctx.me.username;

  const command = /^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text);
  if (command) {
    const [, name, target, args] = command;
    if (target && target.toLowerCase() !== me.toLowerCase()) return undefined; // another bot's command
    return (AGENT_COMMANDS as readonly string[]).includes(name!.toLowerCase()) ? `/${name} ${args ?? ''}`.trim() : undefined;
  }
  const mention = new RegExp(`@${me}\\b`, 'i');
  if (mention.test(text)) return text.replace(mention, '').trim() || 'hi';
  if (msg.reply_to_message?.from?.id === ctx.me.id) return text;
  return undefined;
}

function isRateLimit(err: unknown): boolean {
  const e = RetryError.isInstance(err) ? err.lastError : err;
  return APICallError.isInstance(e) && e.statusCode === 429;
}

/** Card under the agent's reply. Text comes from the tool result (code), not the LLM. */
export function splitCard(
  output: AgentOutput,
  creatorName: string,
): { text: string; keyboard: InlineKeyboard } | undefined {
  const proposal = findSplitProposal(output.thoughts);
  if (!proposal) return undefined;
  const result = output.thoughts
    .flatMap((t) => t.toolResults)
    .find((r) => (r.output as { split_id?: string })?.split_id === proposal.splitId)?.output as {
    per_person: string;
    people: number;
    invoices_to: string[];
    not_in_group: string[];
  };
  const lines = [
    `New split: ${result.per_person} each, ${result.people} people (incl. ${creatorName})`,
    `PayPal requests to: ${result.invoices_to.join(', ')}`,
  ];
  if (result.not_in_group.length) {
    lines.push(`Not seen in this group yet: ${result.not_in_group.join(', ')} — I can't DM them, so their link will be posted here.`);
  }
  lines.push('', `${creatorName}, tap ✅ to send the requests.`);
  return {
    text: lines.join('\n'),
    keyboard: new InlineKeyboard()
      .text('✅ Send requests', `split:confirm:${proposal.splitId}`)
      .text('❌ Cancel', `split:cancel:${proposal.splitId}`),
  };
}

export function createAgentMessageHandler(deps: MessageHandlerDeps) {
  const busy = new Set<number>(); // one agent run per chat at a time
  const background = deps.background ?? ((p) => void p);

  return async (ctx: SirenContext, prompt: string): Promise<void> => {
    const chatId = ctx.chat!.id;
    const groupId = ctx.siren?.groupId;
    if (groupId === undefined || !ctx.from || !ctx.siren) {
      await ctx.reply('I work in group chats — add me to a group and use /split there.');
      return;
    }
    if (busy.has(chatId)) {
      await ctx.reply('Still working on the last request — give me a few seconds.');
      return;
    }
    busy.add(chatId);
    const sender = {
      telegramUserId: ctx.from.id,
      firstName: ctx.from.first_name,
      username: ctx.from.username,
      userId: ctx.siren.userId,
    };

    background(
      (async () => {
        try {
          await ctx.replyWithChatAction('typing').catch(() => {});
          const output = await deps.runAgent({
            trigger: 'user_message',
            userMessage: prompt,
            context: { groupId, chatId, sender },
          });
          await ctx.reply(output.response, { reply_parameters: { message_id: ctx.message!.message_id } });
          const card = splitCard(output, sender.firstName);
          if (card) await ctx.reply(card.text, { reply_markup: card.keyboard });
        } catch (err) {
          // Ids only — never the prompt, names or the raw SDK error (see lib/safe-error.ts).
          logError(deps.log, err, 'agent run failed', { chatId, updateId: ctx.update.update_id });
          await ctx
            .reply(
              isRateLimit(err)
                ? "I'm over my AI rate limit right now — try again in a minute."
                : 'Sorry, something went wrong on my side. Try again in a minute.',
            )
            .catch(() => {});
        } finally {
          busy.delete(chatId);
        }
      })(),
    );
  };
}
